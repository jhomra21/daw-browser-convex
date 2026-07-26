import type {
  ArpParams,
  SynthParamsInput,
  TrackInstrumentParams,
} from '@daw-browser/shared'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import type { DrumRackResolvedBuffers } from './drum-rack-runtime'
import type { GranularInstalledBuffer } from './granular-runtime'
import type { SamplerResolvedBuffers } from './sampler-runtime'

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
  }>
}
