import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'

import type { AudioSourceMetadata } from '~/lib/audio-source'

const metadataReadCacheBytes = 8 * 1024 * 1024
const maximumSampleRate = 384_000
const maximumChannelCount = 64

export class AudioFileMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioFileMetadataError'
  }
}

const fail = (message: string): never => {
  throw new AudioFileMetadataError(message)
}

export const readAudioFileMetadata = async (file: File): Promise<AudioSourceMetadata> => {
  if (file.size < 1) fail('Audio file is empty.')

  const input = new Input({
    source: new BlobSource(file, { maxCacheSize: metadataReadCacheBytes }),
    formats: ALL_FORMATS,
  })

  try {
    if (!(await input.canRead())) fail('Audio file has an unsupported or unrecognizable format.')
    const track = await input.getPrimaryAudioTrack()
    if (!track) fail('File does not contain an audio track.')

    const metadataDuration = await track.getDurationFromMetadata({ skipLiveWait: true })
    const durationSec = metadataDuration ?? await track.computeDuration({
      metadataOnly: true,
      skipLiveWait: true,
    })
    const [sampleRate, channelCount] = await Promise.all([
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ])

    if (!Number.isFinite(durationSec) || durationSec <= 0) fail('Audio file has invalid duration metadata.')
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > maximumSampleRate) {
      fail('Audio file has an unsupported sample rate.')
    }
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > maximumChannelCount) {
      fail('Audio file has an unsupported channel count.')
    }

    return { durationSec, sampleRate, channelCount }
  } finally {
    input.dispose()
  }
}
