import type { AudioCoreGraphSnapshot, AudioCoreSampleSourceEventDto, PlanarPcm } from '../../audio-core-contract/src/index'
import type { Track } from '@daw-browser/timeline-core/types'
import { compilePortableExportSnapshot } from './portable-export-snapshot'
import { portableWasmCapabilityMatrix } from './backends/portable-wasm-capabilities'

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
}

export type LiveNativeCapabilityMatrix = {
  version: 1
  decodedRawSources: true
  routing: false
  midi: false
  instruments: false
  effects: false
  automation: false
  externalPlugins: false
}

export const liveNativeCapabilityMatrix = {
  version: 1,
  decodedRawSources: true,
  routing: false,
  midi: false,
  instruments: false,
  effects: false,
  automation: false,
  externalPlugins: false,
} satisfies LiveNativeCapabilityMatrix

/**
 * The live-native boundary currently proves only decoded, raw audio sources:
 * no Web Audio object leaves this projection, and all routing, MIDI,
 * instruments, processors, automation, and external plug-ins are rejected.
 */
export const compileLiveNativeProjection = (input: LiveNativeProjectionInput): LiveNativeProjection => {
  if (!portableWasmCapabilityMatrix.sampleRatesHz.includes(input.sampleRateHz)) {
    return { supported: false, reasons: [`The native source session does not support ${input.sampleRateHz} Hz.`] }
  }
  const sourceOnlyReasons = input.tracks.flatMap((track) => [
    ...(track.kind === 'instrument' ? [`${track.id}: instrument tracks are not supported.`] : []),
    ...(track.volume !== 1 || track.muted || track.soloed || track.channelRole || track.groupId || track.outputTargetId || (track.sends?.length ?? 0) > 0
      ? [`${track.id}: routing and mix state are not supported.`]
      : []),
  ])
  if (sourceOnlyReasons.length > 0) return { supported: false, reasons: sourceOnlyReasons }
  const compiled = compilePortableExportSnapshot({
    ...input,
    range: { mode: 'whole' },
    fx: undefined,
    sidechainRoutes: undefined,
    hasExternalPlugins: false,
  })
  if (!compiled.supported) return compiled
  return {
    supported: true,
    graph: compiled.graph,
    assets: compiled.assets.map(({ asset, pcm }) => ({ asset, pcm })),
    events: compiled.events,
  }
}
