import { arrangementWaveformScheduler } from '@daw-browser/waveforms/arrangement-waveform'
import type { WaveformSourceData } from '@daw-browser/waveforms/types'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'

export const requestWaveformData = (input: {
  readonly assetKey: string
  readonly source: AudioPcmSourceDescriptor
  readonly sourceStartFrame: number
  readonly sourceEndFrame: number
  readonly framesPerInterval: number
  readonly priority?: number
  readonly signal?: AbortSignal
}): Promise<WaveformSourceData | null> => arrangementWaveformScheduler.request({
  assetKey: input.assetKey,
  sourceIdentity: input.source.identity,
  sourceIdentityMetadata: {
    assetKey: input.assetKey,
    identity: input.source.identity,
    durationSec: input.source.durationSec,
    frameCount: input.source.frameCount,
    sampleRate: input.source.sampleRate,
    channelCount: input.source.channelCount,
  },
  source: async (signal) => {
    signal.throwIfAborted()
    return input.source
  },
  sourceStartFrame: input.sourceStartFrame,
  sourceEndFrame: input.sourceEndFrame,
  framesPerInterval: input.framesPerInterval,
  priority: input.priority,
  signal: input.signal,
})
