import {
  audioCoreContractVersion,
  audioCoreMaxGraphProcessors,
  type AudioAssetRef,
  type AudioCoreGraphSnapshot,
  type AudioCoreSampleSourceEventDto,
  type PlanarPcm,
} from '../../audio-core-contract/src/index'
import type { ExportFx } from './export-types'
import { resolveExportMixerGraph } from './export-mixer-graph'
import type { ExportRange } from './export-range'
import { getExportRangeBounds } from './export-range'
import { createPortableGraphSnapshot } from './mixer/graph-contract'
import type { ExternalNodeLatencyFrames } from './mixer/resolve-timing'
import { projectPortableClipEvents } from './portable-clip-projector'
import { portableWasmCapabilityMatrix } from './backends/portable-wasm-capabilities'
import { nativeAudioCoreProcessorKinds } from './backends/native-audio-core-capabilities'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import {
  validatePortablePreparedStretchAsset,
  type PortablePreparedStretchAsset,
  type PortableStretchDiagnostic,
} from './portable-stretch-preparation'
import {
  compilePortableSessionInput,
  graphWithInstruments,
  instrumentConfigurations,
} from './portable-session-compiler'

export type PortableExportAsset = {
  asset: AudioAssetRef
  sourceAssetKey?: string
  pcm?: PlanarPcm
  transferables: readonly ArrayBuffer[]
}

export type PortableExportSnapshot =
  | {
    supported: true
    graph: AudioCoreGraphSnapshot
    assets: readonly PortableExportAsset[]
    events: readonly AudioCoreSampleSourceEventDto[]
  }
  | {
    supported: false
    reasons: readonly string[]
    diagnostics: readonly PortableStretchDiagnostic[]
  }

export type PortableExportSnapshotInput = {
  tracks: readonly Track<AudioBuffer | null>[]
  bpm: number
  range: ExportRange
  sampleRateHz: number
  revision: number
  epoch: number
  firstSequence: number
  fx?: ExportFx
  sidechainRoutes?: readonly ExternalSidechainRoute[]
  hasExternalPlugins?: boolean
  projectGeneration?: number
  preparedStretchAssets?: readonly PortablePreparedStretchAsset[]
  allowInstruments?: boolean
  externalLatencyFrames?: ExternalNodeLatencyFrames
  capabilityTarget?: 'portable-wasm' | 'native'
  metadataSourceAssets?: readonly {
    sourceAssetKey: string
    frameCount: number
    sampleRateHz: number
    channelCount: number
  }[]
}

type MetadataSourceAsset = NonNullable<PortableExportSnapshotInput['metadataSourceAssets']>[number]

const unsupported = (
  reasons: readonly string[],
  diagnostics: readonly PortableStretchDiagnostic[] = [],
): PortableExportSnapshot => ({
  supported: false,
  reasons,
  diagnostics,
})

const transientAssetId = (sourceAssetKey: string) => `portable-export:${sourceAssetKey}`

const createAsset = (sourceAssetKey: string, buffer: AudioBuffer): PortableExportAsset => {
  const planes = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => new Float32Array(buffer.getChannelData(channel)),
  )
  const asset: AudioAssetRef = {
    version: audioCoreContractVersion,
    assetId: transientAssetId(sourceAssetKey),
    frameCount: buffer.length,
    sampleRateHz: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
  }
  return {
    asset,
    sourceAssetKey,
    pcm: { frameCount: buffer.length, planes },
    transferables: planes.map((plane) => plane.buffer),
  }
}

const createMetadataAsset = (sourceAssetKey: string, input: {
  frameCount: number
  sampleRateHz: number
  channelCount: number
}): PortableExportAsset => ({
  asset: {
    version: audioCoreContractVersion,
    assetId: transientAssetId(sourceAssetKey),
    frameCount: input.frameCount,
    sampleRateHz: input.sampleRateHz,
    channelCount: input.channelCount,
  },
  sourceAssetKey,
  transferables: [],
})

type CollectedPortableAssets = {
  assets: readonly PortableExportAsset[]
  bySourceAssetKey: ReadonlyMap<string, AudioAssetRef>
  reasons: readonly string[]
}

const collectAssets = (
  tracks: readonly Track<AudioBuffer | null>[],
  fx: ExportFx | undefined,
  preparedStretchAssets: ReadonlyMap<string, PortablePreparedStretchAsset>,
  metadataSourceAssets: readonly MetadataSourceAsset[],
): CollectedPortableAssets => {
  const assets: PortableExportAsset[] = []
  const bySourceAssetKey = new Map<string, AudioAssetRef>()
  const reasons: string[] = []
  const addAsset = (sourceAssetKey: string, buffer: AudioBuffer) => {
    const existing = bySourceAssetKey.get(sourceAssetKey)
    if (existing) {
      const consistent = existing.frameCount === buffer.length
        && existing.sampleRateHz === buffer.sampleRate
        && existing.channelCount === buffer.numberOfChannels
      if (!consistent) {
        reasons.push(`Source asset "${sourceAssetKey}" resolves to inconsistent decoded audio.`)
      }
      const existingIndex = assets.findIndex((entry) => entry.asset.assetId === existing.assetId)
      if (consistent && existingIndex >= 0 && !assets[existingIndex]?.pcm) {
        assets[existingIndex] = createAsset(sourceAssetKey, buffer)
      }
      return
    }
    const exportAsset = createAsset(sourceAssetKey, buffer)
    const metadataIndex = assets.findIndex((entry) => entry.asset.assetId === exportAsset.asset.assetId)
    if (metadataIndex >= 0) assets[metadataIndex] = exportAsset
    else assets.push(exportAsset)
    bySourceAssetKey.set(sourceAssetKey, exportAsset.asset)
  }
  const addMetadataAsset = (sourceAssetKey: string, metadata: MetadataSourceAsset) => {
    const existing = bySourceAssetKey.get(sourceAssetKey)
    if (existing) {
      if (existing.frameCount !== metadata.frameCount
        || existing.sampleRateHz !== metadata.sampleRateHz
        || existing.channelCount !== metadata.channelCount) {
        reasons.push(`Source asset "${sourceAssetKey}" resolves to inconsistent audio metadata.`)
      }
      return
    }
    const exportAsset = createMetadataAsset(sourceAssetKey, metadata)
    assets.push(exportAsset)
    bySourceAssetKey.set(sourceAssetKey, exportAsset.asset)
  }
  for (const metadata of metadataSourceAssets) {
    if (!metadata.sourceAssetKey
      || !Number.isSafeInteger(metadata.frameCount) || metadata.frameCount <= 0
      || !Number.isSafeInteger(metadata.sampleRateHz) || metadata.sampleRateHz <= 0
      || !Number.isSafeInteger(metadata.channelCount) || metadata.channelCount <= 0) {
      reasons.push(`Source asset "${metadata.sourceAssetKey}" has invalid audio metadata.`)
      continue
    }
    addMetadataAsset(metadata.sourceAssetKey, metadata)
  }
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.audioWarp?.enabled === true) {
        if (clip.audioWarp.mode === 'stretch') {
          const preparedStretch = preparedStretchAssets.get(clip.id)
          if (preparedStretch) assets.push(preparedStretch)
        }
        continue
      }
      if (clip.midi || !clip.sourceAssetKey) continue
      if (clip.buffer) addAsset(clip.sourceAssetKey, clip.buffer)
    }
  }
  for (const entry of Object.values(fx?.trackFx ?? {})) {
    const instrument = entry.instrument
    if (instrument?.kind === 'sampler' && entry.samplerBuffers) {
      for (const zone of instrument.params.zones) {
        const buffer = entry.samplerBuffers.get(zone.id)
        if (buffer) addAsset(zone.sample.assetKey, buffer)
      }
    }
    if (instrument?.kind === 'drum-rack' && entry.drumRackBuffers) {
      for (const pad of instrument.params.pads) {
        const buffer = pad.sample ? entry.drumRackBuffers.get(pad.id) : undefined
        if (pad.sample && buffer) addAsset(pad.sample.assetKey, buffer)
      }
    }
    if (instrument?.kind === 'granular' && entry.granularBuffer && instrument.params.zone) {
      addAsset(instrument.params.zone.sample.assetKey, entry.granularBuffer.buffer)
    }
  }
  return { assets, bySourceAssetKey, reasons }
}

const unsupportedProcessorReasons = (
  fx: ExportFx | undefined,
  allowInstruments: boolean,
  capabilityTarget: NonNullable<PortableExportSnapshotInput['capabilityTarget']>,
): readonly string[] => {
  const instances = [
    ...(fx?.masterFxInstances ?? []),
    ...Object.values(fx?.trackFx ?? {}).flatMap((entry) => entry.instances),
  ]
  const supportedProcessor = capabilityTarget === 'native'
    ? (kind: string) => nativeAudioCoreProcessorKinds.has(kind)
    : (kind: string) => portableWasmCapabilityMatrix.processorKinds.includes(kind)
  const targetLabel = capabilityTarget === 'native' ? 'native audio core' : 'portable core'
  return [
    ...instances
    .filter((instance) => !supportedProcessor(instance.kind))
    .map((instance) => `${instance.id}: processor "${instance.kind}" is not supported by the ${targetLabel}.`),
    ...Object.entries(fx?.trackFx ?? {})
      .filter(([, entry]) => !allowInstruments && (entry.arp || entry.synth || entry.instrument))
      .map(([trackId]) => `${trackId}: instrument state is not supported by the portable core.`),
  ]
}

/**
 * Compiles a portable, in-memory export input without retaining runtime
 * AudioBuffers. It delegates scheduling and mixer topology to their existing
 * authorities, so portable export cannot diverge from timeline timing or
 * routing behavior.
 */
export const compilePortableExportSnapshot = (
  input: PortableExportSnapshotInput,
): PortableExportSnapshot => {
  const capabilityTarget = input.capabilityTarget ?? 'portable-wasm'
  const reasons = [
    ...(input.hasExternalPlugins ? ['Live external plugins must be frozen or bypassed before portable export.'] : []),
    ...(capabilityTarget === 'native' || portableWasmCapabilityMatrix.sampleRatesHz.includes(input.sampleRateHz)
      ? []
      : [`The portable core does not support ${input.sampleRateHz} Hz.`]),
    ...unsupportedProcessorReasons(input.fx, input.allowInstruments === true, capabilityTarget),
  ]
  const diagnostics: PortableStretchDiagnostic[] = []
  const preparedStretchAssets = new Map<string, PortablePreparedStretchAsset>()
  const portableAssetIds = new Set<string>()
  const stretchClipIds = new Set(input.tracks.flatMap((track) => track.clips.flatMap((clip) => (
    clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch' ? [clip.id] : []
  ))))
  for (const prepared of input.preparedStretchAssets ?? []) {
    const invalid = validatePortablePreparedStretchAsset(prepared)
    if (invalid) {
      reasons.push(invalid.message)
      diagnostics.push(invalid)
      continue
    }
    if (!stretchClipIds.has(prepared.clipId)) {
      const message = `${prepared.clipId}: pre-rendered Stretch asset has no matching warped clip.`
      reasons.push(message)
      diagnostics.push({
        code: 'stretch-metadata-mismatch',
        clipId: prepared.clipId,
        message,
      })
      continue
    }
    if (preparedStretchAssets.has(prepared.clipId) || portableAssetIds.has(prepared.portableAssetId)) {
      const message = `${prepared.clipId}: pre-rendered Stretch asset identity is ambiguous.`
      reasons.push(message)
      diagnostics.push({
        code: 'stretch-metadata-mismatch',
        clipId: prepared.clipId,
        message,
      })
      continue
    }
    if (input.projectGeneration !== undefined
      && prepared.projectGeneration !== input.projectGeneration) {
      const message = `${prepared.clipId}: pre-rendered Stretch asset belongs to a stale project generation.`
      reasons.push(message)
      diagnostics.push({
        code: 'stretch-asset-stale-generation',
        clipId: prepared.clipId,
        message,
      })
      continue
    }
    preparedStretchAssets.set(prepared.clipId, prepared)
    portableAssetIds.add(prepared.portableAssetId)
  }
  if (diagnostics.length > 0) return unsupported(reasons, diagnostics)
  const { assets, bySourceAssetKey, reasons: assetReasons } = collectAssets(
    input.tracks,
    input.fx,
    preparedStretchAssets,
    input.metadataSourceAssets ?? [],
  )
  reasons.push(...assetReasons)

  const range = getExportRangeBounds(input.tracks, input.range)
  const clips = projectPortableClipEvents({
    tracks: input.tracks,
    assets: bySourceAssetKey,
    preparedStretchAssets,
    projectGeneration: input.projectGeneration,
    warpContext: 'offline',
    bpm: input.bpm,
    sampleRateHz: input.sampleRateHz,
    rangeStartSec: range.startSec,
    rangeEndSec: range.endSec,
    epoch: input.epoch,
    firstSequence: input.firstSequence,
    allowInstruments: input.allowInstruments,
  })
  if (!clips.supported) {
    return unsupported(
      [...reasons, ...clips.reasons],
      [...diagnostics, ...clips.diagnostics],
    )
  }
  if (reasons.length > 0) return unsupported(reasons, diagnostics)
  const frameOffset = Math.round(range.startSec * input.sampleRateHz)
  const frameCount = Math.ceil((range.endSec - range.startSec) * input.sampleRateHz)
  const events = clips.events.flatMap((event) => {
    const startFrame = Math.max(0, event.startFrame - frameOffset)
    const stopFrame = Math.min(frameCount, event.stopFrame - frameOffset)
    if (stopFrame <= startFrame) return []
    return [{
      ...event,
      startFrame,
      stopFrame,
      fadeInStartFrame: event.fadeInStartFrame - frameOffset,
      fadeInEndFrame: event.fadeInEndFrame - frameOffset,
      fadeOutStartFrame: event.fadeOutStartFrame - frameOffset,
      fadeOutEndFrame: event.fadeOutEndFrame - frameOffset,
    }]
  })

  try {
    const instrumentCompilation = compilePortableSessionInput({
      mixer: resolveExportMixerGraph({
        tracks: [...input.tracks],
        fx: input.fx,
      }),
      fx: input.fx ?? { masterVolume: 1, masterFxInstances: [], trackFx: {} },
      automationEnvelopes: [],
      assetRegistry: {
        projectGeneration: 1,
        assets: [...bySourceAssetKey.entries()].flatMap(([projectAssetId, asset], slot) => {
          const exportAsset = assets.find((entry) => entry.asset.assetId === asset.assetId)
          return exportAsset ? [{
            projectAssetId,
            portableAssetId: asset.assetId,
            projectGeneration: 1,
            handle: { slot, generation: 1 },
            decoded: {
              sampleRateHz: exportAsset.asset.sampleRateHz,
              channelCount: exportAsset.asset.channelCount,
              frameCount: exportAsset.asset.frameCount,
            },
          }] : []
        }),
      },
    })
    if (instrumentCompilation.unsupportedInstruments.length > 0) {
      return unsupported([...reasons, ...instrumentCompilation.unsupportedInstruments], diagnostics)
    }
    const baseGraph = createPortableGraphSnapshot({
      graph: resolveExportMixerGraph({
        tracks: [...input.tracks],
        fx: input.fx,
      }),
      revision: input.revision,
      sampleRate: input.sampleRateHz,
      bpm: input.bpm,
      assets: assets.map((entry) => entry.asset),
      sidechainRoutes: input.sidechainRoutes,
      includeInstruments: false,
      externalLatencyFrames: input.externalLatencyFrames,
    })
    const instrumentGraph: ReturnType<typeof graphWithInstruments> = input.allowInstruments === true
      ? graphWithInstruments(baseGraph, instrumentConfigurations(instrumentCompilation))
      : { graph: baseGraph, reasons: [] }
    if (!instrumentGraph.graph) return unsupported([...reasons, ...instrumentGraph.reasons], diagnostics)
    const processorCount = instrumentGraph.graph.nodes.reduce(
      (total, node) => total + node.processorOrder.length,
      0,
    )
    if (processorCount > audioCoreMaxGraphProcessors) {
      const targetLabel = capabilityTarget === 'native' ? 'native audio core' : 'portable core'
      return unsupported([
        ...reasons,
        `The ${targetLabel} supports at most ${audioCoreMaxGraphProcessors} aggregate graph processors.`,
      ], diagnostics)
    }
    return {
      supported: true,
      graph: instrumentGraph.graph,
      assets,
      events,
    }
  } catch (error) {
    return unsupported(
      [error instanceof Error ? error.message : 'Portable export snapshot compilation failed.'],
      diagnostics,
    )
  }
}
