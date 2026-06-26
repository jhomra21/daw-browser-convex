import type { ArpParams, AudioEffectKind, DelayParamsLite, EqParamsLite, ReverbParamsLite, SaturatorParamsLite, SynthParamsInput } from '@daw-browser/shared'
import type { MixerChannel } from './channels'
import type { Track, TrackSend } from '@daw-browser/timeline-core/types'

export type MixerTrackFx = {
  order?: AudioEffectKind[]
  eq?: EqParamsLite
  saturator?: SaturatorParamsLite
  delay?: DelayParamsLite
  reverb?: ReverbParamsLite
  arp?: ArpParams
  synth?: SynthParamsInput
}

export type ResolvedMixerSend = TrackSend

export type ResolveMixerGraphOptions = {
  channels: MixerChannel[]
  masterVolume?: number
  masterEq?: EqParamsLite
  masterSaturator?: SaturatorParamsLite
  masterDelay?: DelayParamsLite
  masterReverb?: ReverbParamsLite
  masterFxOrder?: AudioEffectKind[]
  trackFx?: Record<string, MixerTrackFx>
}

export type ResolvedMixerChannel = {
  channel: MixerChannel
  gain: number
  outputGain: number
  outputTargetId?: Track['id']
  sends: ResolvedMixerSend[]
  fx?: MixerTrackFx
}

export type ResolvedMixerGraph = {
  channels: ResolvedMixerChannel[]
  master: {
    volume: number
    eq?: EqParamsLite
    saturator?: SaturatorParamsLite
    delay?: DelayParamsLite
    reverb?: ReverbParamsLite
    order?: AudioEffectKind[]
  }
}
