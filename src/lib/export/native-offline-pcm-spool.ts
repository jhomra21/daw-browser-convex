import type { NativeOfflinePcmChunk } from '@daw-browser/audio-engine/native-host-wire'

const EXPORT_SPOOL_DIRECTORY = 'native-export-spools'
const PCM_FILE = 'render.f32'
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT
export const nativeOfflinePcmSpoolReplayFrames = 16_384

type NativeOfflinePcmSpoolFailure =
  | 'invalid-session'
  | 'invalid-chunk'
  | 'permission-denied'
  | 'quota-exceeded'
  | 'write-failed'
  | 'read-failed'

export class NativeOfflinePcmSpoolError extends Error {
  constructor(
    readonly failure: NativeOfflinePcmSpoolFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'NativeOfflinePcmSpoolError'
  }
}

export type NativeOfflinePcmSpoolWritable = {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

export type NativeOfflinePcmSpoolFile = {
  createWritable: () => Promise<NativeOfflinePcmSpoolWritable>
  read: (startByte: number, endByte: number) => Promise<ArrayBuffer>
}

export type NativeOfflinePcmSpoolDirectory = {
  getDirectory: (name: string, create: boolean) => Promise<NativeOfflinePcmSpoolDirectory>
  getFile: (name: string, create: boolean) => Promise<NativeOfflinePcmSpoolFile>
  remove: (name: string, recursive: boolean) => Promise<void>
}

export type NativeOfflinePcmSpoolFilesystem = {
  root: () => Promise<NativeOfflinePcmSpoolDirectory>
}

type CreateNativeOfflinePcmSpoolOptions = {
  filesystem?: NativeOfflinePcmSpoolFilesystem
  replayFrames?: number
}

type NativeOfflinePcmSpoolSessionInput = {
  sessionId: string
  sampleRate: number
  channelCount: number
  totalFrames: number
}

export type NativeOfflinePcmSpoolDescriptor = {
  sessionId: string
  sampleRate: number
  channelCount: number
  totalFrames: number
  byteLength: number
  samplePeak: number
}

export type NativeOfflinePcmSpoolReplayOptions = {
  endFrame?: number
  gain?: number
  signal?: AbortSignal
}

export type NativeOfflinePcmSpoolSession = {
  append: (chunk: NativeOfflinePcmChunk) => Promise<void>
  finalize: () => Promise<NativeOfflinePcmSpoolDescriptor>
  replay: (options?: NativeOfflinePcmSpoolReplayOptions) => AsyncGenerator<AudioBuffer>
  remove: () => Promise<void>
  abort: () => Promise<void>
}

const safeSessionName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
const validPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0

const classifyFailure = (cause: unknown): NativeOfflinePcmSpoolFailure => {
  if (cause instanceof DOMException) {
    if (cause.name === 'QuotaExceededError') return 'quota-exceeded'
    if (cause.name === 'NotAllowedError' || cause.name === 'SecurityError') return 'permission-denied'
  }
  return 'write-failed'
}

const wrapDirectory = (directory: FileSystemDirectoryHandle): NativeOfflinePcmSpoolDirectory => ({
  getDirectory: async (name, create) => wrapDirectory(await directory.getDirectoryHandle(name, { create })),
  getFile: async (name, create) => {
    const handle = await directory.getFileHandle(name, { create })
    return {
      createWritable: async () => {
        if (!handle.createWritable) {
          throw new Error('The native offline PCM spool filesystem cannot create writable files.')
        }
        const writable = await handle.createWritable()
        return {
          write: (data) => writable.write(data),
          close: () => writable.close(),
          abort: () => writable.abort(),
        }
      },
      read: async (startByte, endByte) => (await handle.getFile()).slice(startByte, endByte).arrayBuffer(),
    }
  },
  remove: (name, recursive) => directory.removeEntry(name, { recursive }),
})

const browserFilesystem: NativeOfflinePcmSpoolFilesystem = {
  root: async () => wrapDirectory(await navigator.storage.getDirectory()),
}

const encodeInterleaved = (chunk: NativeOfflinePcmChunk): Uint8Array<ArrayBuffer> => {
  const sampleCount = chunk.frameCount * chunk.channelCount
  if (!Number.isSafeInteger(sampleCount)) {
    throw new NativeOfflinePcmSpoolError('invalid-chunk', 'Native offline PCM chunk sample count is invalid.')
  }
  const interleaved = new Float32Array(sampleCount)
  let offset = 0
  for (let frame = 0; frame < chunk.frameCount; frame += 1) {
    for (let channel = 0; channel < chunk.channelCount; channel += 1) {
      interleaved[offset] = chunk.planes[channel]?.[frame] ?? 0
      offset += 1
    }
  }
  return new Uint8Array(interleaved.buffer)
}

const updateSamplePeak = (peak: number, chunk: NativeOfflinePcmChunk) => {
  let next = peak
  for (const plane of chunk.planes) {
    for (let frame = 0; frame < chunk.frameCount; frame += 1) {
      const sample = plane[frame] ?? 0
      if (Number.isFinite(sample)) next = Math.max(next, Math.abs(sample))
    }
  }
  return next
}

export const createNativeOfflinePcmSpool = (options: CreateNativeOfflinePcmSpoolOptions = {}) => {
  const filesystem = options.filesystem ?? browserFilesystem
  const replayFrames = options.replayFrames ?? nativeOfflinePcmSpoolReplayFrames
  if (!validPositiveInteger(replayFrames)) {
    throw new NativeOfflinePcmSpoolError('invalid-session', 'Native offline PCM replay block size is invalid.')
  }

  const spoolsDirectory = async () => {
    const root = await filesystem.root()
    // Do not sweep unknown sessions here: another renderer can own an active
    // session. Crash recovery needs an ownership/age policy rather than a
    // destructive startup-wide cleanup.
    return root.getDirectory(EXPORT_SPOOL_DIRECTORY, true)
  }

  const createSession = async (input: NativeOfflinePcmSpoolSessionInput): Promise<NativeOfflinePcmSpoolSession> => {
    if (!safeSessionName(input.sessionId)
      || !validPositiveInteger(input.sampleRate)
      || !validPositiveInteger(input.channelCount)
      || input.channelCount > 32
      || !validPositiveInteger(input.totalFrames)) {
      throw new NativeOfflinePcmSpoolError('invalid-session', 'Native offline PCM spool session metadata is invalid.')
    }

    const sessions = await spoolsDirectory()
    try {
      await sessions.getDirectory(input.sessionId, false)
      throw new NativeOfflinePcmSpoolError('invalid-session', 'Native offline PCM spool session already exists.')
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
    }

    let directory: NativeOfflinePcmSpoolDirectory
    let file: NativeOfflinePcmSpoolFile
    let writable: NativeOfflinePcmSpoolWritable
    try {
      directory = await sessions.getDirectory(input.sessionId, true)
      file = await directory.getFile(PCM_FILE, true)
      writable = await file.createWritable()
    } catch (error) {
      throw new NativeOfflinePcmSpoolError(
        classifyFailure(error),
        'Could not create native offline PCM spool.',
        { cause: error },
      )
    }

    let writtenFrames = 0
    let byteLength = 0
    let samplePeak = 0
    let state: 'open' | 'finalized' | 'aborted' | 'removed' = 'open'
    let descriptor: NativeOfflinePcmSpoolDescriptor | undefined
    let operation = Promise.resolve()

    const removeDirectory = async () => {
      if (state === 'removed') return
      try {
        await sessions.remove(input.sessionId, true)
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error
      }
      state = 'removed'
    }

    const abortWritable = async () => {
      if (state !== 'open') return
      state = 'aborted'
      await writable.abort().catch(() => undefined)
    }

    const append = (chunk: NativeOfflinePcmChunk): Promise<void> => {
      const task = operation.then(async () => {
        if (state !== 'open') {
          throw new NativeOfflinePcmSpoolError('write-failed', 'Native offline PCM spool is no longer writable.')
        }
        if (!validPositiveInteger(chunk.frameCount)
          || chunk.startFrame !== writtenFrames
          || chunk.channelCount !== input.channelCount
          || chunk.planes.length !== input.channelCount
          || chunk.planes.some((plane) => plane.length !== chunk.frameCount)
          || chunk.startFrame > input.totalFrames - chunk.frameCount) {
          throw new NativeOfflinePcmSpoolError('invalid-chunk', 'Native offline PCM chunk is invalid or noncontiguous.')
        }
        const bytes = encodeInterleaved(chunk)
        const nextByteLength = byteLength + bytes.byteLength
        if (!Number.isSafeInteger(nextByteLength)) {
          throw new NativeOfflinePcmSpoolError('write-failed', 'Native offline PCM spool byte accounting exceeded exact integer range.')
        }
        try {
          await writable.write(bytes)
        } catch (error) {
          throw new NativeOfflinePcmSpoolError(
            classifyFailure(error),
            'Could not write native offline PCM spool data.',
            { cause: error },
          )
        }
        writtenFrames += chunk.frameCount
        byteLength = nextByteLength
        samplePeak = updateSamplePeak(samplePeak, chunk)
      }).catch(async (error) => {
        await abortWritable()
        await removeDirectory()
        throw error
      })
      operation = task.catch(() => undefined)
      return task
    }

    const finalize = async (): Promise<NativeOfflinePcmSpoolDescriptor> => {
      await operation
      if (descriptor) return descriptor
      if (state !== 'open') {
        throw new NativeOfflinePcmSpoolError('write-failed', 'Native offline PCM spool cannot be finalized.')
      }
      if (writtenFrames !== input.totalFrames) {
        await abortWritable()
        await removeDirectory()
        throw new NativeOfflinePcmSpoolError('invalid-chunk', 'Native offline PCM spool is incomplete.')
      }
      try {
        await writable.close()
      } catch (error) {
        await abortWritable()
        await removeDirectory()
        throw new NativeOfflinePcmSpoolError(
          classifyFailure(error),
          'Could not finalize native offline PCM spool.',
          { cause: error },
        )
      }
      state = 'finalized'
      descriptor = {
        sessionId: input.sessionId,
        sampleRate: input.sampleRate,
        channelCount: input.channelCount,
        totalFrames: input.totalFrames,
        byteLength,
        samplePeak,
      }
      return descriptor
    }

    const replay = async function* (
      replayOptions: NativeOfflinePcmSpoolReplayOptions = {},
    ): AsyncGenerator<AudioBuffer> {
      if (state !== 'finalized' || !descriptor) {
        throw new NativeOfflinePcmSpoolError('read-failed', 'Native offline PCM spool must be finalized before replay.')
      }
      const requestedEndFrame = replayOptions.endFrame ?? descriptor.totalFrames
      if (!Number.isSafeInteger(requestedEndFrame)
        || requestedEndFrame <= 0
        || requestedEndFrame > descriptor.totalFrames) {
        throw new NativeOfflinePcmSpoolError('read-failed', 'Native offline PCM spool replay end frame is invalid.')
      }
      const gain = replayOptions.gain ?? 1
      if (!Number.isFinite(gain) || gain < 0) {
        throw new NativeOfflinePcmSpoolError('read-failed', 'Native offline PCM spool replay gain is invalid.')
      }

      for (let startFrame = 0; startFrame < requestedEndFrame; startFrame += replayFrames) {
        replayOptions.signal?.throwIfAborted()
        const frameCount = Math.min(replayFrames, requestedEndFrame - startFrame)
        const startByte = startFrame * descriptor.channelCount * FLOAT_BYTES
        const endByte = (startFrame + frameCount) * descriptor.channelCount * FLOAT_BYTES
        let bytes: ArrayBuffer
        try {
          bytes = await file.read(startByte, endByte)
        } catch (error) {
          throw new NativeOfflinePcmSpoolError('read-failed', 'Could not read native offline PCM spool data.', { cause: error })
        }
        if (bytes.byteLength !== endByte - startByte) {
          throw new NativeOfflinePcmSpoolError('read-failed', 'Native offline PCM spool data is truncated.')
        }
        replayOptions.signal?.throwIfAborted()
        const interleaved = new Float32Array(bytes)
        const buffer = new AudioBuffer({
          numberOfChannels: descriptor.channelCount,
          length: frameCount,
          sampleRate: descriptor.sampleRate,
        })
        for (let channel = 0; channel < descriptor.channelCount; channel += 1) {
          const destination = buffer.getChannelData(channel)
          for (let frame = 0; frame < frameCount; frame += 1) {
            destination[frame] = (interleaved[frame * descriptor.channelCount + channel] ?? 0) * gain
          }
        }
        yield buffer
      }
    }

    const abort = async () => {
      await operation
      if (state === 'removed') return
      await abortWritable()
      await removeDirectory()
    }

    const remove = async () => {
      await operation
      if (state === 'open') await abortWritable()
      await removeDirectory()
    }

    return { append, finalize, replay, remove, abort }
  }

  return { createSession }
}
