import type { ArpParams, AudioEffectKind, CompressorParamsLite, DelayParamsLite, EqParamsLite, ReverbParamsLite, SaturatorParamsLite, SynthParamsInput } from '@daw-browser/shared'
import type { MixerChannel } from './channels'
import type { Track, TrackSend } from '@daw-browser/timeline-core/types'
import type { AudioEffectRuntimeInstance } from '../effects/runtime-instance'

export type MixerTrackFx = {
  order?: AudioEffectKind[]
  eq?: EqParamsLite
  compressor?: CompressorParamsLite
  saturator?: SaturatorParamsLite
  delay?: DelayParamsLite
  reverb?: ReverbParamsLite
  instances?: AudioEffectRuntimeInstance[]
  arp?: ArpParams
  synth?: SynthParamsInput
}

export type ResolvedMixerSend = TrackSend
export type ChannelLayout = 'mono' | 'stereo'

export type ResolveMixerGraphOptions = {
  channels: MixerChannel[]
  masterVolume?: number
  masterEq?: EqParamsLite
  masterCompressor?: CompressorParamsLite
  masterSaturator?: SaturatorParamsLite
  masterDelay?: DelayParamsLite
  masterReverb?: ReverbParamsLite
  masterFxOrder?: AudioEffectKind[]
  masterFxInstances?: AudioEffectRuntimeInstance[]
  trackFx?: Record<string, MixerTrackFx>
  sourceChannelCounts?: Readonly<Record<string, readonly number[]>>
}

export type ResolvedMixerChannel = {
  channel: MixerChannel
  gain: number
  outputGain: number
  outputTargetId?: Track['id']
  sends: ResolvedMixerSend[]
  fx?: MixerTrackFx
  sourceLayout?: ChannelLayout
  inputLayout: ChannelLayout
  outputLayout: ChannelLayout
}

export type ResolvedMixerGraph = {
  channels: ResolvedMixerChannel[]
  master: {
    volume: number
    eq?: EqParamsLite
    compressor?: CompressorParamsLite
    saturator?: SaturatorParamsLite
    delay?: DelayParamsLite
    reverb?: ReverbParamsLite
    order?: AudioEffectKind[]
    instances?: AudioEffectRuntimeInstance[]
    inputLayout: ChannelLayout
    outputLayout: ChannelLayout
  }
}
