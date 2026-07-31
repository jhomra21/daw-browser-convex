import {
  audioCoreContractVersion,
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
  pcm: PlanarPcm
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
  tracks: readonly Track<AudioBuffer>[]
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
}

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
    pcm: { frameCount: buffer.length, planes },
    transferables: planes.map((plane) => plane.buffer),
  }
}

const collectAssets = (
  tracks: readonly Track<AudioBuffer>[],
  preparedStretchAssets: ReadonlyMap<string, PortablePreparedStretchAsset>,
): {
  assets: readonly PortableExportAsset[]
  bySourceAssetKey: ReadonlyMap<string, AudioAssetRef>
  reasons: readonly string[]
} => {
  const assets: PortableExportAsset[] = []
  const bySourceAssetKey = new Map<string, AudioAssetRef>()
  const reasons: string[] = []
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.audioWarp?.enabled === true) {
        if (clip.audioWarp.mode === 'stretch') {
          const preparedStretch = preparedStretchAssets.get(clip.id)
          if (preparedStretch) assets.push(preparedStretch)
        }
        continue
      }
      if (clip.midi || !clip.sourceAssetKey || !clip.buffer) continue
      const existing = bySourceAssetKey.get(clip.sourceAssetKey)
      if (existing) {
        if (existing.frameCount !== clip.buffer.length
          || existing.sampleRateHz !== clip.buffer.sampleRate
          || existing.channelCount !== clip.buffer.numberOfChannels) {
          reasons.push(`${clip.id}: source asset "${clip.sourceAssetKey}" resolves to inconsistent decoded audio.`)
        }
        continue
      }
      const asset = createAsset(clip.sourceAssetKey, clip.buffer)
      assets.push(asset)
      bySourceAssetKey.set(clip.sourceAssetKey, asset.asset)
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
    ...(fx?.masterVolume !== undefined && fx.masterVolume !== 1
      ? [`Master gain is not supported by the ${targetLabel}.`]
      : []),
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
    preparedStretchAssets,
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
      fadeInStartFrame: Math.max(0, event.fadeInStartFrame - frameOffset),
      fadeInEndFrame: Math.max(0, event.fadeInEndFrame - frameOffset),
      fadeOutStartFrame: Math.min(frameCount, event.fadeOutStartFrame - frameOffset),
      fadeOutEndFrame: Math.min(frameCount, event.fadeOutEndFrame - frameOffset),
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
    const instrumentGraph = input.allowInstruments === true
      ? graphWithInstruments(baseGraph, instrumentConfigurations(instrumentCompilation))
      : { graph: baseGraph, reasons: [] as readonly string[] }
    if (!instrumentGraph.graph) return unsupported([...reasons, ...instrumentGraph.reasons], diagnostics)
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
