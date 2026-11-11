import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioAssetRef, AudioCoreGraphSnapshot, PlanarPcm } from '../../audio-core-contract/src/index'
import {
  createDefaultSynthParams,
  normalizeDelayParams,
  normalizeReverbParams,
  normalizeSynthParams,
} from '@daw-browser/shared'
import { resolveLiveMixerGraph } from './live-mixer-runtime'
import { createPortableGraphSnapshot } from './mixer/graph-contract'
import {
  compilePortableSynthConfiguration,
  compilePortableSamplerConfiguration,
  compilePortableDrumRackConfiguration,
  compilePortableGranularConfiguration,
  graphWithInstruments,
} from './portable-session-compiler'
import { projectPortableClipEvents } from './portable-clip-projector'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { nativeAudioCoreProcessorKinds } from './backends/native-audio-core-capabilities'
import type { ExportFx } from './export-types'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ExternalNodeLatencyFrames } from './mixer/resolve-timing'
export { resolveMixerTiming } from './mixer/resolve-timing'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'
import type { NativePreparedStretchAsset } from './native-stretch-preparation'
import { validatePreparedStretchProjectionMetadata } from './prepared-stretch-artifact'
import type { NativePcmChunkDescriptor, NativeProjectedSourceEvent } from './native-pcm-chunking'

export type LiveNativePcmAsset = {
  asset: AudioAssetRef
  pcm?: PlanarPcm
  sourceAssetKey: string
  preparedStretchArtifactId?: string
}

export type NativeInstrumentRegionSource = {
  sourceAssetKey: string
  buffer: AudioBuffer
}

export type LiveNativeProjection =
  | {
    supported: true
    graph: AudioCoreGraphSnapshot
    assets: readonly LiveNativePcmAsset[]
    instrumentRegionSources?: readonly NativeInstrumentRegionSource[]
    events: readonly NativeProjectedSourceEvent[]
    nativePcmChunkDescriptors: readonly NativePcmChunkDescriptor[]
  }
  | { supported: false; reasons: readonly string[] }

export type LiveNativeProjectionInput = {
  tracks: readonly Track<AudioBuffer | null>[]
  bpm: number
  sampleRateHz: number
  revision: number
  epoch: number
  firstSequence: number
  /**
   * Instrument regions in this FX payload are already localized by the live
   * playback snapshot boundary.
   */
  fx?: ExportFx
  instrumentRegionMode?: 'metadata'
  externalLatencyFrames?: ExternalNodeLatencyFrames
  projectGeneration?: number
  preparedStretchAssets?: readonly (PortablePreparedStretchAsset | NativePreparedStretchAsset)[]
}

export type LiveNativeCapabilityMatrix = {
  version: 1
  decodedRawSources: true
  routing: true
  midi: true
  instruments: true
  effects: false
  automation: true
  externalPlugins: false
}

export const liveNativeCapabilityMatrix = {
  version: 1,
  decodedRawSources: true,
  routing: true,
  midi: true,
  instruments: true,
  effects: false,
  automation: true,
  externalPlugins: false,
} satisfies LiveNativeCapabilityMatrix

export const countLiveNativeInstalledAssetKeys = (
  tracks: readonly Track<AudioBuffer | null>[],
  fx?: ExportFx,
) => {
  const keys = new Set<string>()
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (!clip.midi
        && clip.sourceAssetKey
        && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')) {
        keys.add(clip.sourceAssetKey)
      }
    }
  }
  for (const entry of Object.values(fx?.trackFx ?? {})) {
    if (entry.instrument?.kind === 'sampler') {
      for (const zone of entry.instrument.params.zones) {
        if (entry.samplerBuffers?.has(zone.id)) keys.add(zone.sample.assetKey)
      }
    }
    if (entry.instrument?.kind === 'drum-rack') {
      for (const pad of entry.instrument.params.pads) {
        if (pad.sample && entry.drumRackBuffers?.has(pad.id)) keys.add(pad.sample.assetKey)
      }
    }
    if (entry.instrument?.kind === 'granular'
      && entry.instrument.params.zone
      && entry.granularBuffer) {
      keys.add(entry.instrument.params.zone.sample.assetKey)
    }
  }
  return keys.size
}

const nativeProcessorIsEnabled = (instance: AudioEffectRuntimeInstance) => {
  if (instance.kind === 'delay') return normalizeDelayParams(instance.params).enabled
  if (instance.kind === 'reverb') return normalizeReverbParams(instance.params).enabled
  if (instance.kind === 'compressor' || instance.kind === 'eq' || instance.kind === 'saturator') {
    return instance.params.enabled
  }
  return instance.params.state.enabled
}

const normalizeNativeFx = (
  fx: ExportFx | undefined,
  tracks: readonly Track<AudioBuffer | null>[],
): ExportFx | undefined => {
  if (!fx && !tracks.some((track) => track.kind === 'instrument' && track.clips.length > 0)) return fx
  const currentFx = fx ?? { masterVolume: 1, masterFxInstances: [], trackFx: {} }
  let changed = false
  const trackFx = Object.fromEntries(Object.entries(currentFx.trackFx ?? {}).map(([trackId, entry]) => {
    let nextEntry = entry
    if (entry.instrument === undefined && entry.synth !== undefined) {
      changed = true
      nextEntry = {
        ...nextEntry,
        instrument: {
          kind: 'synth',
          instanceId: `legacy-synth:${trackId}`,
          params: normalizeSynthParams(entry.synth),
        },
      }
    }
    const instances = nextEntry.instances.filter((instance) => (
      nativeAudioCoreProcessorKinds.has(instance.kind)
      || nativeProcessorIsEnabled(instance)
    ))
    if (instances.length !== nextEntry.instances.length) {
      changed = true
      nextEntry = { ...nextEntry, instances }
    }
    return [trackId, nextEntry]
  }))
  for (const track of tracks) {
    if (track.kind !== 'instrument' || track.clips.length === 0 || trackFx[track.id]?.instrument) continue
    trackFx[track.id] = {
      ...(trackFx[track.id] ?? { instances: [] }),
      instrument: {
        kind: 'synth',
        instanceId: `default-synth:${track.id}`,
        params: createDefaultSynthParams(),
      },
    }
    changed = true
  }
  const masterFxInstances = currentFx.masterFxInstances.filter((instance) => (
    nativeAudioCoreProcessorKinds.has(instance.kind)
    || nativeProcessorIsEnabled(instance)
  ))
  if (masterFxInstances.length !== currentFx.masterFxInstances.length) changed = true
  return changed ? { ...currentFx, masterFxInstances, trackFx } : fx
}

/** Instrument-only native compilation. Inputs already contain localized region facts.
 * No arrangement assets, clip projection, Stretch preparation or mixer graph is needed.
 * Keep failures per node so one unavailable instrument cannot hide another desired entry.
 */
export const compileLiveNativeInstrumentConfigurations = (
  tracks: readonly Track<AudioBuffer | null>[],
  inputFx?: ExportFx,
  projectGeneration = 1,
) => {
  const fx = normalizeNativeFx(inputFx, tracks)
  const instrumentAssets = new Map<string, AudioBuffer>()
  const reasons: string[] = []
  const configurations: Parameters<typeof graphWithInstruments>[1][number][] = []
  for (const [nodeId, entry] of Object.entries(fx?.trackFx ?? {})) {
    const assets = new Map<string, AudioBuffer>()
    const failures: string[] = []
    const add = (key: string, buffer: AudioBuffer | undefined) => {
      if (!buffer) {
        if (!unavailable.has(key)) failures.push(`${nodeId}: Sample asset "${key}" is missing its authoritative audio buffer.`)
        return
      }
      const existing = instrumentAssets.get(key)
      if (existing && (existing.length !== buffer.length || existing.sampleRate !== buffer.sampleRate
        || existing.numberOfChannels !== buffer.numberOfChannels)) {
        failures.push(`Instrument region "${key}" resolves inconsistently.`)
        return
      }
      assets.set(key, buffer)
      instrumentAssets.set(key, buffer)
    }
    const unavailable = new Set(entry.unavailableSampleAssetKeys ?? [])
    const instrument = entry.instrument
    if (instrument?.kind === 'sampler') for (const zone of instrument.params.zones) {
      add(zone.sample.assetKey, entry.samplerBuffers?.get(zone.id)?.buffer)
    }
    if (instrument?.kind === 'drum-rack') for (const pad of instrument.params.pads) {
      if (pad.sample) add(pad.sample.assetKey, entry.drumRackBuffers?.get(pad.id)?.buffer)
    }
    if (instrument?.kind === 'granular' && instrument.params.zone) {
      add(instrument.params.zone.sample.assetKey, entry.granularBuffer?.buffer)
    }
    const registry = {
      projectGeneration,
      unavailableProjectAssetIds: [...unavailable],
      assets: [...assets].map(([key, buffer], slot) => ({
        projectAssetId: key, portableAssetId: `portable-export:${key}`, projectGeneration,
        handle: { slot, generation: 1 },
        decoded: { sampleRateHz: buffer.sampleRate, channelCount: buffer.numberOfChannels, frameCount: buffer.length },
      })),
    }
    // Preserve the portable compiler's legacy synth fallback, including FX entries with sampled instruments.
    if (instrument?.kind === 'synth') configurations.push(compilePortableSynthConfiguration(nodeId, instrument.instanceId, instrument.params))
    else if (entry.synth !== undefined) configurations.push(compilePortableSynthConfiguration(nodeId, `legacy-synth:${nodeId}`, entry.synth))
    if (failures.length > 0) {
      reasons.push(...failures)
      continue
    }
    try {
      if (instrument?.kind === 'sampler') configurations.push(compilePortableSamplerConfiguration(nodeId, instrument.instanceId, instrument.params, registry))
      if (instrument?.kind === 'drum-rack') configurations.push(compilePortableDrumRackConfiguration(nodeId, instrument.instanceId, instrument.params, registry))
      if (instrument?.kind === 'granular') configurations.push(compilePortableGranularConfiguration(nodeId, instrument.instanceId, instrument.params, registry))
    } catch (error) {
      reasons.push(`${nodeId}: ${error instanceof Error ? error.message : 'portable instrument compilation failed.'}`)
    }
  }
  return { configurations, instrumentAssets, reasons }
}
/**
 * The live-native boundary keeps decoded audio, mixer topology, and instrument
 * state portable; active unsupported processors and external plug-ins remain
 * rejected. Native admission is evaluated against the native audio-core
 * contract rather than browser/Wasm fixture coverage.
 */
export const compileLiveNativeProjection = (input: LiveNativeProjectionInput): LiveNativeProjection => {
  const fx = normalizeNativeFx(input.fx, input.tracks)
  const tracks = input.tracks
  const reasons: string[] = []
  const sourceAssets = new Map<string, LiveNativePcmAsset>()
  const addAsset = (
    sourceAssetKey: string,
    source: { durationSec: number; sampleRate: number; channelCount: number },
    buffer?: AudioBuffer | null,
    retainPcm = false,
  ) => {
    const frameCount = buffer?.length ?? Math.max(1, Math.round(source.durationSec * source.sampleRate))
    const existing = sourceAssets.get(sourceAssetKey)
    if (existing) {
      if (existing.asset.frameCount !== frameCount
        || existing.asset.sampleRateHz !== source.sampleRate
        || existing.asset.channelCount !== source.channelCount) {
        reasons.push(`Audio asset "${sourceAssetKey}" resolves inconsistently.`)
      }
      if (!existing.pcm && buffer && retainPcm) {
        existing.pcm = {
          frameCount: buffer.length,
          planes: Array.from(
            { length: buffer.numberOfChannels },
            (_, channel) => new Float32Array(buffer.getChannelData(channel)),
          ),
        }
      }
      return
    }
    const asset: AudioAssetRef = {
      version: audioCoreContractVersion,
      assetId: `portable-export:${sourceAssetKey}`,
      frameCount,
      sampleRateHz: source.sampleRate,
      channelCount: source.channelCount,
    }
    const pcm = buffer && retainPcm
      ? {
        frameCount: buffer.length,
        planes: Array.from(
          { length: buffer.numberOfChannels },
          (_, channel) => new Float32Array(buffer.getChannelData(channel)),
        ),
      }
      : undefined
    sourceAssets.set(sourceAssetKey, { asset, pcm, sourceAssetKey })
  }
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.midi || !clip.sourceAssetKey
        || (clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')) continue
      const source = clip.buffer
        ? {
          durationSec: clip.buffer.duration,
          sampleRate: clip.buffer.sampleRate,
          channelCount: clip.buffer.numberOfChannels,
        }
        : clip.sourceDurationSec !== undefined
          && clip.sourceSampleRate !== undefined
          && clip.sourceChannelCount !== undefined
          ? {
            durationSec: clip.sourceDurationSec,
            sampleRate: clip.sourceSampleRate,
            channelCount: clip.sourceChannelCount,
          }
          : undefined
      if (!source) {
        reasons.push(`Audio clip "${clip.id}" is missing source metadata.`)
        continue
      }
      addAsset(clip.sourceAssetKey, source, clip.buffer, false)
    }
  }
  const instruments = compileLiveNativeInstrumentConfigurations(tracks, fx, input.projectGeneration)
  const { instrumentAssets } = instruments
  reasons.push(...instruments.reasons)
  for (const [assetId, buffer] of instrumentAssets) {
    addAsset(assetId, {
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
    }, buffer, input.instrumentRegionMode !== 'metadata')
  }
  const preparedStretchAssets = new Map<string, PortablePreparedStretchAsset | NativePreparedStretchAsset>()
  for (const prepared of input.preparedStretchAssets ?? []) {
    const invalid = validatePreparedStretchProjectionMetadata(prepared)
    if (invalid) {
      reasons.push(invalid)
      continue
    }
    preparedStretchAssets.set(prepared.clipId, prepared)
    const isNativeArtifact = 'manifest' in prepared
    const sourceKey = isNativeArtifact
      ? prepared.preparedStretchArtifactId ?? prepared.asset.assetId
      : prepared.portableAssetId
    const existing = sourceAssets.get(sourceKey)
    if (existing) {
      if (existing.asset.frameCount !== prepared.asset.frameCount
        || existing.asset.sampleRateHz !== prepared.asset.sampleRateHz
        || existing.asset.channelCount !== prepared.asset.channelCount) {
        reasons.push(`Prepared Stretch artifact "${sourceKey}" resolves inconsistently.`)
      }
      continue
    }
    sourceAssets.set(sourceKey, {
      asset: prepared.asset,
      pcm: isNativeArtifact ? undefined : prepared.pcm,
      sourceAssetKey: sourceKey,
      preparedStretchArtifactId: prepared.preparedStretchArtifactId ?? prepared.asset.assetId,
    })
  }
  if (reasons.length > 0) return { supported: false, reasons }
  const mixer = resolveLiveMixerGraph(tracks, fx?.trackFx ?? {}, {
    masterFxInstances: fx?.masterFxInstances,
    masterVolume: fx?.masterVolume,
  })
  const baseGraph = createPortableGraphSnapshot({
    graph: mixer,
    revision: input.revision,
    sampleRate: input.sampleRateHz,
    bpm: input.bpm,
    assets: [...sourceAssets.values()].map(({ asset }) => asset),
    includeInstruments: false,
    externalLatencyFrames: input.externalLatencyFrames,
  })
  const instrumentGraph = graphWithInstruments(baseGraph, instruments.configurations)
  if (!instrumentGraph.graph) return { supported: false, reasons: instrumentGraph.reasons }
  const clipProjection = projectPortableClipEvents({
    tracks,
    assets: new Map([...sourceAssets].map(([key, value]) => [key, value.asset])),
    bpm: input.bpm,
    sampleRateHz: input.sampleRateHz,
    rangeStartSec: 0,
    rangeEndSec: undefined,
    epoch: input.epoch,
    firstSequence: input.firstSequence,
    allowInstruments: true,
    includeStableIdentity: true,
    preparedStretchAssets,
    projectGeneration: input.projectGeneration,
    warpContext: 'offline',
    assetRatePolicy: 'asset-rate',
  })
  if (!clipProjection.supported) return clipProjection
  const projection = {
    supported: true,
    graph: instrumentGraph.graph,
    assets: [...sourceAssets.values()],
    events: clipProjection.events,
    nativePcmChunkDescriptors: [],
  } satisfies Extract<LiveNativeProjection, { supported: true }>
  if (input.instrumentRegionMode !== 'metadata') return projection
  return {
    ...projection,
    instrumentRegionSources: [...instrumentAssets].map(([sourceAssetKey, buffer]) => ({
      sourceAssetKey,
      buffer,
    })),
  }
}
