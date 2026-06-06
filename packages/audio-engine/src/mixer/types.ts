import type { ArpParams, EqParamsLite, ReverbParamsLite, SynthParamsInput } from '@daw-browser/shared'
import type { MixerChannel } from './channels'
import type { Track, TrackSend } from '@daw-browser/timeline-core/types'

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
  outputTargetId?: Track['id']
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
