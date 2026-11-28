import type {
  ArpParams,
  SynthParamsInput,
  TrackInstrumentParams,
} from '@daw-browser/shared'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { DrumRackResolvedBuffers, GranularInstalledBuffer, SamplerResolvedBuffers } from './sampled-instrument-region'

export type ExportFx = {
  masterVolume?: number
  masterFxInstances: AudioEffectRuntimeInstance[]
  trackFx?: Record<string, {
    instances: AudioEffectRuntimeInstance[]
    arp?: ArpParams
    synth?: SynthParamsInput
    instrument?: TrackInstrumentParams
    drumRackBuffers?: DrumRackResolvedBuffers
    samplerBuffers?: SamplerResolvedBuffers
    granularBuffer?: GranularInstalledBuffer
    unavailableSampleAssetKeys?: readonly string[]
  }>
}
