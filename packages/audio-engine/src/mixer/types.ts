import type { ArpParams, SynthParamsInput } from '@daw-browser/shared'
import type { MixerChannel } from './channels'
import type { Track, TrackSend } from '@daw-browser/timeline-core/types'
import type { AudioEffectRuntimeInstance } from '../effects/runtime-instance'

export type MixerTrackFx = {
  instances: AudioEffectRuntimeInstance[]
  arp?: ArpParams
  synth?: SynthParamsInput
}

export type ResolvedMixerSend = TrackSend
export type ChannelLayout = 'mono' | 'stereo'

export type ResolveMixerGraphOptions = {
  channels: MixerChannel[]
  masterVolume?: number
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
    instances: AudioEffectRuntimeInstance[]
    inputLayout: ChannelLayout
    outputLayout: ChannelLayout
  }
}
