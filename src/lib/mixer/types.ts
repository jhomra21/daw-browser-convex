import type { ArpParams, EqParamsLite, ReverbParamsLite, SynthParamsInput } from '~/lib/effects/params'
import type { MixerChannel } from '~/lib/mixer/channels'
import type { TrackSend } from '~/types/timeline'

export type MixerTrackFx = {
  eq?: EqParamsLite
  reverb?: ReverbParamsLite
  arp?: ArpParams
  synth?: SynthParamsInput
}

export type ResolvedMixerSend = TrackSend

export type ResolveMixerGraphOptions = {
  channels: MixerChannel[]
  masterEq?: EqParamsLite
  masterReverb?: ReverbParamsLite
  trackFx?: Record<string, MixerTrackFx>
}

export type ResolvedMixerChannel = {
  channel: MixerChannel
  gain: number
  outputGain: number
  outputTargetId?: string
  sends: ResolvedMixerSend[]
  fx?: MixerTrackFx
}

export type ResolvedMixerGraph = {
  channels: ResolvedMixerChannel[]
  master: {
    eq?: EqParamsLite
    reverb?: ReverbParamsLite
  }
}
