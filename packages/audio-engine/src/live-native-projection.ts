import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioCoreGraphSnapshot, AudioCoreSampleSourceEventDto, PlanarPcm } from '../../audio-core-contract/src/index'
import { normalizeDelayParams, normalizeReverbParams, normalizeTrackInstrumentParams } from '@daw-browser/shared'
import { compilePortableExportSnapshot } from './portable-export-snapshot'
import { nativeAudioCoreProcessorKinds } from './backends/native-audio-core-capabilities'
import type { ExportFx } from './export-types'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ExternalNodeLatencyFrames } from './mixer/resolve-timing'

export type LiveNativePcmAsset = {
  asset: { assetId: string; frameCount: number; sampleRateHz: number; channelCount: number }
  pcm: PlanarPcm
}

export type LiveNativeProjection =
  | {
    supported: true
    graph: AudioCoreGraphSnapshot
    assets: readonly LiveNativePcmAsset[]
    events: readonly AudioCoreSampleSourceEventDto[]
  }
  | { supported: false; reasons: readonly string[] }

export type LiveNativeProjectionInput = {
  tracks: readonly Track<AudioBuffer>[]
  bpm: number
  sampleRateHz: number
  revision: number
  epoch: number
  firstSequence: number
  fx?: ExportFx
  externalLatencyFrames?: ExternalNodeLatencyFrames
}

export type LiveNativeCapabilityMatrix = {
  version: 1
  decodedRawSources: true
  routing: true
  midi: true
  instruments: true
  effects: false
  automation: false
  externalPlugins: false
}

export const liveNativeCapabilityMatrix = {
  version: 1,
  decodedRawSources: true,
  routing: true,
  midi: true,
  instruments: true,
  effects: false,
  automation: false,
  externalPlugins: false,
} satisfies LiveNativeCapabilityMatrix

const nativeProcessorIsEnabled = (instance: AudioEffectRuntimeInstance) => {
  if (instance.kind === 'delay') return normalizeDelayParams(instance.params).enabled
  if (instance.kind === 'reverb') return normalizeReverbParams(instance.params).enabled
  if (instance.kind === 'compressor' || instance.kind === 'eq' || instance.kind === 'saturator') {
    return instance.params.enabled
  }
  return instance.params.state.enabled
}

const normalizeNativeFx = (fx: ExportFx | undefined): ExportFx | undefined => {
  if (!fx) return fx
  let changed = false
  const trackFx = Object.fromEntries(Object.entries(fx.trackFx ?? {}).map(([trackId, entry]) => {
    let nextEntry = entry
    if (entry.instrument === undefined && entry.synth !== undefined) {
      const instrument = normalizeTrackInstrumentParams({
        kind: 'synth',
        instanceId: `legacy-synth:${trackId}`,
        params: entry.synth,
      })
      if (instrument) {
        changed = true
        nextEntry = { ...nextEntry, instrument }
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
  const masterFxInstances = fx.masterFxInstances.filter((instance) => (
    nativeAudioCoreProcessorKinds.has(instance.kind)
    || nativeProcessorIsEnabled(instance)
  ))
  if (masterFxInstances.length !== fx.masterFxInstances.length) changed = true
  return changed ? { ...fx, masterFxInstances, trackFx } : fx
}

/**
 * The live-native boundary keeps decoded audio, mixer topology, and instrument
 * state portable; active unsupported processors and external plug-ins remain
 * rejected. Native admission is evaluated against the native audio-core
 * contract rather than browser/Wasm fixture coverage.
 */
export const compileLiveNativeProjection = (input: LiveNativeProjectionInput): LiveNativeProjection => {
  const fx = normalizeNativeFx(input.fx)
  const tracks = input.tracks
  const instrumentReasons = tracks.flatMap((track) => (
    track.kind === 'instrument' && !fx?.trackFx?.[track.id]?.instrument
      ? [`${track.id}: native instrument state is unavailable.`]
      : []
  ))
  if (instrumentReasons.length > 0) return { supported: false, reasons: instrumentReasons }
  const compiled = compilePortableExportSnapshot({
    ...input,
    tracks,
    range: { mode: 'whole' },
    fx,
    sidechainRoutes: undefined,
    hasExternalPlugins: false,
    allowInstruments: true,
    capabilityTarget: 'native',
    externalLatencyFrames: input.externalLatencyFrames,
  })
  if (!compiled.supported) return compiled
  return {
    supported: true,
    graph: compiled.graph,
    assets: compiled.assets.map(({ asset, pcm }) => ({ asset, pcm })),
    events: compiled.events,
  }
}
