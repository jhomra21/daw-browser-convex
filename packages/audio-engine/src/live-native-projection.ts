import type { Track } from '@daw-browser/timeline-core/types'
import type { AudioAssetRef, AudioCoreGraphSnapshot, PlanarPcm } from '../../audio-core-contract/src/index'
import { normalizeDelayParams, normalizeReverbParams, normalizeSynthParams } from '@daw-browser/shared'
import { resolveLiveMixerGraph } from './live-mixer-runtime'
import { createPortableGraphSnapshot } from './mixer/graph-contract'
import {
  compilePortableSessionInput,
  graphWithInstruments,
  instrumentConfigurations,
} from './portable-session-compiler'
import { projectPortableClipEvents } from './portable-clip-projector'
import { audioCoreContractVersion } from '../../audio-core-contract/src/index'
import { nativeAudioCoreProcessorKinds } from './backends/native-audio-core-capabilities'
import { nativeAudioHostMaximumAssetFramesForChannels } from '@daw-browser/desktop-protocol/native-audio-host'
import type { ExportFx } from './export-types'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { ExternalNodeLatencyFrames } from './mixer/resolve-timing'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'
import type { NativePcmChunkDescriptor, NativeProjectedSourceEvent } from './native-pcm-chunking'

export type LiveNativePcmAsset = {
  asset: AudioAssetRef
  pcm?: PlanarPcm
  sourceAssetKey: string
}

export type LiveNativeProjection =
  | {
    supported: true
    graph: AudioCoreGraphSnapshot
    assets: readonly LiveNativePcmAsset[]
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
  externalLatencyFrames?: ExternalNodeLatencyFrames
  projectGeneration?: number
  preparedStretchAssets?: readonly PortablePreparedStretchAsset[]
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

const normalizeNativeFx = (fx: ExportFx | undefined): ExportFx | undefined => {
  if (!fx) return fx
  let changed = false
  const trackFx = Object.fromEntries(Object.entries(fx.trackFx ?? {}).map(([trackId, entry]) => {
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
    track.kind === 'instrument'
      && track.clips.length > 0
      && !fx?.trackFx?.[track.id]?.instrument
      ? [`${track.id}: native instrument state is unavailable.`]
      : []
  ))
  if (instrumentReasons.length > 0) return { supported: false, reasons: instrumentReasons }
  const reasons: string[] = []
  const sourceAssets = new Map<string, LiveNativePcmAsset>()
  const registryAssets: {
    projectAssetId: string
    portableAssetId: string
    projectGeneration: number
    handle: { slot: number; generation: number }
    decoded: { sampleRateHz: number; channelCount: number; frameCount: number }
  }[] = []
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
    if (pcm && frameCount > nativeAudioHostMaximumAssetFramesForChannels(source.channelCount)) {
      reasons.push(`Instrument audio asset "${sourceAssetKey}" exceeds the bounded native instrument capacity.`)
      return
    }
    sourceAssets.set(sourceAssetKey, { asset, pcm, sourceAssetKey })
    registryAssets.push({
      projectAssetId: sourceAssetKey,
      portableAssetId: asset.assetId,
      projectGeneration: input.projectGeneration ?? 1,
      handle: { slot: registryAssets.length, generation: 1 },
      decoded: {
        sampleRateHz: asset.sampleRateHz,
        channelCount: asset.channelCount,
        frameCount: asset.frameCount,
      },
    })
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
  const instrumentAssets = new Map<string, AudioBuffer>()
  for (const entry of Object.values(fx?.trackFx ?? {})) {
    if (entry.instrument?.kind === 'sampler') {
      for (const zone of entry.instrument.params.zones) {
        const buffer = entry.samplerBuffers?.get(zone.id)
        if (buffer) instrumentAssets.set(zone.sample.assetKey, buffer.buffer)
      }
    }
    if (entry.instrument?.kind === 'drum-rack') {
      for (const pad of entry.instrument.params.pads) {
        const buffer = pad.sample ? entry.drumRackBuffers?.get(pad.id) : undefined
        if (buffer && pad.sample) instrumentAssets.set(pad.sample.assetKey, buffer.buffer)
      }
    }
    if (entry.instrument?.kind === 'granular' && entry.granularBuffer && entry.instrument.params.zone) {
      instrumentAssets.set(entry.instrument.params.zone.sample.assetKey, entry.granularBuffer.buffer)
    }
  }
  for (const [assetId, buffer] of instrumentAssets) {
    addAsset(assetId, {
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      channelCount: buffer.numberOfChannels,
    }, buffer, true)
  }
  const preparedStretchAssets = new Map<string, PortablePreparedStretchAsset>()
  for (const prepared of input.preparedStretchAssets ?? []) {
    preparedStretchAssets.set(prepared.clipId, prepared)
    const sourceKey = prepared.portableAssetId
    if (sourceAssets.has(sourceKey)) continue
    sourceAssets.set(sourceKey, {
      asset: prepared.asset,
      pcm: prepared.pcm,
      sourceAssetKey: sourceKey,
    })
    registryAssets.push({
      projectAssetId: sourceKey,
      portableAssetId: prepared.portableAssetId,
      projectGeneration: input.projectGeneration ?? 1,
      handle: { slot: registryAssets.length, generation: 1 },
      decoded: {
        sampleRateHz: prepared.asset.sampleRateHz,
        channelCount: prepared.asset.channelCount,
        frameCount: prepared.asset.frameCount,
      },
    })
  }
  if (reasons.length > 0) return { supported: false, reasons }
  const mixer = resolveLiveMixerGraph(tracks, fx?.trackFx ?? {}, {
    masterFxInstances: fx?.masterFxInstances,
    masterVolume: fx?.masterVolume,
  })
  const session = compilePortableSessionInput({
    mixer,
    fx: fx ?? { masterVolume: 1, masterFxInstances: [], trackFx: {} },
    automationEnvelopes: [],
    assetRegistry: {
      projectGeneration: input.projectGeneration ?? 1,
      assets: registryAssets,
    },
  })
  if (session.unsupportedInstruments.length > 0) return { supported: false, reasons: session.unsupportedInstruments }
  const baseGraph = createPortableGraphSnapshot({
    graph: mixer,
    revision: input.revision,
    sampleRate: input.sampleRateHz,
    bpm: input.bpm,
    assets: [...sourceAssets.values()].map(({ asset }) => asset),
    includeInstruments: false,
    externalLatencyFrames: input.externalLatencyFrames,
  })
  const instrumentGraph = graphWithInstruments(baseGraph, instrumentConfigurations(session))
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
  })
  if (!clipProjection.supported) return clipProjection
  return {
    supported: true,
    graph: instrumentGraph.graph,
    assets: [...sourceAssets.values()],
    events: clipProjection.events,
    nativePcmChunkDescriptors: [],
  }
}
