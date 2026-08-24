import {
  ADTS,
  ALL_FORMATS,
  BlobSource,
  FLAC,
  Input,
  MP3,
  MP4,
  OGG,
  WAVE,
  WEBM,
} from 'mediabunny'

const maxAssetUploadBytes = 10 * 1024 * 1024
const maxSampleRate = 384_000
const maxChannelCount = 64

const expectedFormats = new Map([
  ['audio/mpeg', MP3],
  ['audio/wav', WAVE],
  ['audio/x-wav', WAVE],
  ['audio/flac', FLAC],
  ['audio/ogg', OGG],
  ['audio/mp4', MP4],
  ['audio/aac', ADTS],
  ['audio/webm', WEBM],
])

export type TrustedAudioMetadata = {
  durationSec: number
  sampleRate: number
  channelCount: number
  detectedFormat: string
  detectedMimeType: string
  detectedCodec: string | null
}

const fail = (message: string): never => {
  throw new Error(message)
}

export const inspectControlUploadAudioMetadata = async (input: {
  file: File
  declaredMimeType: string
}): Promise<TrustedAudioMetadata> => {
  if (input.file.size < 1 || input.file.size > maxAssetUploadBytes) {
    fail('Asset upload exceeds the 10 MiB limit.')
  }
  const expectedFormat = expectedFormats.get(input.declaredMimeType)
  if (!expectedFormat) fail('Unsupported audio MIME type.')

  const mediaInput = new Input({
    source: new BlobSource(input.file, { maxCacheSize: maxAssetUploadBytes }),
    formats: ALL_FORMATS,
  })
  try {
    const detectedFormat = await mediaInput.getFormat()
    if (detectedFormat !== expectedFormat) {
      fail('Asset bytes do not match the declared audio MIME type.')
    }
    if (!(await mediaInput.canRead())) {
      fail('Uploaded audio could not be parsed.')
    }
    const audioTracks = await mediaInput.getAudioTracks()
    if (audioTracks.length !== 1) {
      fail('Uploaded audio must contain exactly one audio track.')
    }
    const audioTrack = audioTracks[0]
    if (!audioTrack) fail('Uploaded audio does not contain an audio track.')
    const [durationSec, sampleRate, channelCount, detectedCodec] = await Promise.all([
      audioTrack.getDurationFromMetadata({ skipLiveWait: true }),
      audioTrack.getSampleRate(),
      audioTrack.getNumberOfChannels(),
      audioTrack.getCodec(),
    ])
    const trustedDurationSec = durationSec ?? fail('Uploaded audio has invalid duration metadata.')
    if (!Number.isFinite(trustedDurationSec) || trustedDurationSec <= 0) {
      fail('Uploaded audio has invalid duration metadata.')
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > maxSampleRate) {
      fail('Uploaded audio has an unsupported sample rate.')
    }
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > maxChannelCount) {
      fail('Uploaded audio has an unsupported channel count.')
    }
    return {
      durationSec: trustedDurationSec,
      sampleRate,
      channelCount,
      detectedFormat: detectedFormat.name,
      detectedMimeType: detectedFormat.mimeType,
      detectedCodec,
    }
  } finally {
    mediaInput.dispose()
  }
}
