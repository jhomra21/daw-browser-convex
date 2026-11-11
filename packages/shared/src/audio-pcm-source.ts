export const defaultDecodedAudioPageFrames = 16_384

export type DecodedAudioPage = {
  startFrame: number
  frameCount: number
  sampleRate: number
  channelCount: number
  planes: Float32Array[]
}

export type RemoteMediaOperation = {
  readonly signal: AbortSignal
  readonly maximumBytes: number
  readonly transferredBytes: () => number
  readonly retryAttempts: () => number
  readonly remainingMs: () => number
  readonly abort: (reason?: Error | DOMException) => void
  readonly dispose: () => void
  readonly takeRetryDelay: () => number
  readonly consumeRetry: () => boolean
  readonly addBytes: (value: number) => void
}

export type AudioPcmSourceReadOptions = {
  startSec?: number
  endSec?: number
  startFrame?: number
  endFrame?: number
  signal?: AbortSignal
  remoteOperation?: RemoteMediaOperation
}

export type AudioPcmSourceDescriptor = {
  readonly identity: string
  readonly contentHash?: string
  readonly contentHashVerified?: boolean
  readonly persistable?: boolean
  readonly durationSec: number
  readonly frameCount: number
  readonly sampleRate: number
  readonly channelCount: number
  readonly readPages: (options?: AudioPcmSourceReadOptions) => AsyncGenerator<DecodedAudioPage>
}

const audioBufferSessionIds = new WeakMap<object, string>()

type AudioBufferSessionIdentityOwner = {
  readonly length: number
  readonly sampleRate: number
  readonly numberOfChannels: number
}

export const getAudioBufferSessionIdentity = (buffer: AudioBufferSessionIdentityOwner) => {
  const existing = audioBufferSessionIds.get(buffer)
  if (existing) return existing
  const identity = `buffer-session:${crypto.randomUUID()}`
  audioBufferSessionIds.set(buffer, identity)
  return identity
}

const validateDescriptorMetadata = (metadata: Pick<
  AudioPcmSourceDescriptor,
  'durationSec' | 'frameCount' | 'sampleRate' | 'channelCount'
>) => {
  if (!Number.isFinite(metadata.durationSec) || metadata.durationSec < 0) throw new Error('Audio source duration is invalid.')
  if (!Number.isSafeInteger(metadata.frameCount) || metadata.frameCount < 0) throw new Error('Audio source frame count is invalid.')
  if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate <= 0) throw new Error('Audio source sample rate is invalid.')
  if (!Number.isSafeInteger(metadata.channelCount) || metadata.channelCount <= 0) throw new Error('Audio source channel count is invalid.')
  const expectedDuration = metadata.frameCount / metadata.sampleRate
  if (Math.abs(metadata.durationSec - expectedDuration) > 0.5 / metadata.sampleRate) {
    throw new Error('Audio source duration does not match its frame metadata.')
  }
}

export const createAudioBufferPcmSourceDescriptor = (input: {
  identity: string
  contentHash?: string
  contentHashVerified?: boolean
  persistable?: boolean
  length: number
  sampleRate: number
  numberOfChannels: number
  copyFromChannel: (destination: Float32Array<ArrayBuffer>, channelNumber: number, bufferOffset: number) => void
}): AudioPcmSourceDescriptor => {
  const metadata = {
    durationSec: input.length / input.sampleRate,
    frameCount: input.length,
    sampleRate: input.sampleRate,
    channelCount: input.numberOfChannels,
  }
  validateDescriptorMetadata(metadata)
  return {
    identity: input.identity,
    contentHash: input.contentHash,
    contentHashVerified: input.contentHashVerified === true,
    persistable: input.persistable === true && input.contentHashVerified === true,
    ...metadata,
    readPages: async function* (options = {}) {
      const startFrame = Math.max(0, options.startFrame ?? Math.ceil((options.startSec ?? 0) * metadata.sampleRate))
      const endFrame = Math.min(metadata.frameCount, options.endFrame ?? Math.ceil((options.endSec ?? metadata.durationSec) * metadata.sampleRate))
      if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || endFrame < startFrame) {
        throw new Error('Audio source frame range is invalid.')
      }
      options.signal?.throwIfAborted()
      for (let frame = startFrame; frame < endFrame; frame += defaultDecodedAudioPageFrames) {
        options.signal?.throwIfAborted()
        const frameCount = Math.min(defaultDecodedAudioPageFrames, endFrame - frame)
        const planes = Array.from({ length: metadata.channelCount }, (_, channelIndex) => {
          const plane = new Float32Array(frameCount)
          input.copyFromChannel(plane, channelIndex, frame)
          return plane
        })
        yield { startFrame: frame, frameCount, sampleRate: metadata.sampleRate, channelCount: metadata.channelCount, planes }
      }
    },
  }
}
