import {
  ADTS,
  ALL_FORMATS,
  CustomSource,
  FLAC,
  Input,
  MP3,
  MP4,
  OGG,
  UnsupportedInputFormatError,
  WAVE,
  WEBM,
} from 'mediabunny'

const maxSampleRate = 384_000
const maxChannelCount = 64
const maxMetadataReadBytes = 8 * 1024 * 1024
const maxMetadataReadRequests = 32
const maxMetadataReadTotalBytes = 32 * 1024 * 1024

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

const inspectControlUploadAudioSource = async (input: {
  source: CustomSource
  size: number
  declaredMimeType: string
}): Promise<TrustedAudioMetadata> => {
  if (input.size < 1) fail('Asset upload is empty.')
  const expectedFormat = expectedFormats.get(input.declaredMimeType)
  if (!expectedFormat) fail('Unsupported audio MIME type.')

  const mediaInput = new Input({
    source: input.source,
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

export const inspectControlUploadAudioMetadata = async (input: {
  file: File
  declaredMimeType: string
}): Promise<TrustedAudioMetadata> => (
  inspectControlUploadAudioSource({
    source: new CustomSource({
      getSize: () => input.file.size,
      read: async (start, end) => {
        if (end - start > maxMetadataReadBytes) fail('Audio metadata inspection range is too large.')
        return new Uint8Array(await input.file.slice(start, end).arrayBuffer())
      },
      maxCacheSize: 2 * 1024 * 1024,
      prefetchProfile: 'none',
    }),
    size: input.file.size,
    declaredMimeType: input.declaredMimeType,
  })
)

export const createControlUploadR2MetadataReader = (input: {
  bucket: Pick<R2Bucket, 'get'>
  key: string
}) => {
  let readRequests = 0
  let readBytes = 0
  return async (start: number, end: number) => {
    const length = end - start
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || length <= 0
    ) {
      fail('Audio metadata inspection range is invalid.')
    }
    if (length > maxMetadataReadBytes) fail('Audio metadata inspection range is too large.')
    if (
      readRequests >= maxMetadataReadRequests
      || readBytes > maxMetadataReadTotalBytes - length
    ) {
      fail('Audio metadata inspection exceeded the R2 read budget.')
    }
    readRequests += 1
    readBytes += length
    const object = await input.bucket.get(input.key, { range: { offset: start, length } })
    if (!object) throw new Error('Uploaded audio object is temporarily unavailable.')
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (bytes.byteLength !== length) throw new Error('R2 returned an incomplete metadata range.')
    return bytes
  }
}

export const inspectControlUploadR2Metadata = async (input: {
  bucket: Pick<R2Bucket, 'get'>
  key: string
  size: number
  declaredMimeType: string
}): Promise<TrustedAudioMetadata> => (
  inspectControlUploadAudioSource({
    source: new CustomSource({
      getSize: () => input.size,
      read: createControlUploadR2MetadataReader(input),
      maxCacheSize: 2 * 1024 * 1024,
      prefetchProfile: 'none',
    }),
    size: input.size,
    declaredMimeType: input.declaredMimeType,
  })
)
