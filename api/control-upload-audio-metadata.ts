import {
  ADTS,
  ALL_FORMATS,
  BlobSource,
  FLAC,
  Input,
  MP3,
  MP4,
  OGG,
  UnsupportedInputFormatError,
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

export class AudioUploadValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioUploadValidationError'
  }
}

const fail = (message: string): never => {
  throw new AudioUploadValidationError(message)
}

const knownMediaValidationMessage = (error: Error) => {
  if (error instanceof UnsupportedInputFormatError) return error.message
  if (/^Invalid (?:RF64|WAVE) file(?:\b|:)/.test(error.message)) return error.message
  if (/^Unsupported WAVE (?:codec|PCM|float) /.test(error.message)) return error.message
  if (error.message === 'No valid MP3 frame found.') return error.message
  if (error.message === 'Missing STREAMINFO metadata block! Corrupted FLAC file.') return error.message
  if (/^(?:Metadata block|StreamInfo block) at position .* is too small! Corrupted FLAC file\.$/.test(error.message)) {
    return error.message
  }
  if (error.message === 'Invalid page with granule position: no packets end on this page.') return error.message
  return undefined
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
      fail('Uploaded audio has an unsupported or unrecognizable format.')
    }
    const audioTracks = await mediaInput.getAudioTracks()
    if (audioTracks.length !== 1) {
      fail('Uploaded audio must contain exactly one audio track.')
    }
    const audioTrack = audioTracks[0]
    if (!audioTrack) fail('Uploaded audio does not contain an audio track.')
    const metadataDuration = await audioTrack.getDurationFromMetadata({ skipLiveWait: true })
    const durationSec = metadataDuration ?? await audioTrack.computeDuration({
      metadataOnly: true,
      skipLiveWait: true,
    })
    const [sampleRate, channelCount, detectedCodec] = await Promise.all([
      audioTrack.getSampleRate(),
      audioTrack.getNumberOfChannels(),
      audioTrack.getCodec(),
    ])
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      fail('Uploaded audio has invalid duration metadata.')
    }
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > maxSampleRate) {
      fail('Uploaded audio has an unsupported sample rate.')
    }
    if (!Number.isInteger(channelCount) || channelCount <= 0 || channelCount > maxChannelCount) {
      fail('Uploaded audio has an unsupported channel count.')
    }
    return {
      durationSec,
      sampleRate,
      channelCount,
      detectedFormat: detectedFormat.name,
      detectedMimeType: detectedFormat.mimeType,
      detectedCodec,
    }
  } catch (error) {
    if (error instanceof AudioUploadValidationError) throw error
    if (error instanceof Error) {
      const message = knownMediaValidationMessage(error)
      if (message) fail(message)
    }
    throw error
  } finally {
    mediaInput.dispose()
  }
}
