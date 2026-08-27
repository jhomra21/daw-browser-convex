import { RECORDER_BLOCK_FRAMES } from "../../../packages/audio-engine/src/recording/recording-protocol"
import { z } from "zod"

const RECORDING_DIRECTORY = "recording-sessions"
const SESSION_METADATA_FILE = "session.json"
const SESSION_CREATED_AT_FILE = "created-at"
const PCM_FILE = "capture.pcm"
const BLOCK_HEADER_BYTES = Uint32Array.BYTES_PER_ELEMENT
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

type RecordingTempStorageFailure =
  | "invalid-session"
  | "session-exists"
  | "invalid-block"
  | "capacity-exceeded"
  | "permission-denied"
  | "quota-exceeded"
  | "write-failed"

export class RecordingTempStorageError extends Error {
  constructor(
    readonly failure: RecordingTempStorageFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RecordingTempStorageError"
  }
}

type RecordingTempSessionDescriptor = {
  version: 1
  sessionId: string
  format: "planar-float32-blocks"
  sampleRate: number
  channelCount: number
  capturedFrames: number
  byteLength: number
  createdAtMs: number
  finalizedAtMs: number | null
}

type PlanarPcmBlock = {
  frameCount: number
  channels: Float32Array[]
}

export type RecordingStorageWritable = {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

export type RecordingStorageFile = {
  createWritable: () => Promise<RecordingStorageWritable>
  text: () => Promise<string>
}

export type RecordingStorageDirectoryEntry = {
  name: string
  kind: "file" | "directory"
}

export type RecordingStorageDirectory = {
  getDirectory: (name: string, create: boolean) => Promise<RecordingStorageDirectory>
  getFile: (name: string, create: boolean) => Promise<RecordingStorageFile>
  entries: () => AsyncIterable<RecordingStorageDirectoryEntry>
  remove: (name: string, recursive: boolean) => Promise<void>
}

export type RecordingStorageFilesystem = {
  root: () => Promise<RecordingStorageDirectory>
}

type CreateRecordingTempStorageOptions = {
  filesystem?: RecordingStorageFilesystem
  maxBytes?: number
  now?: () => number
}

type CreateSessionInput = {
  sessionId: string
  sampleRate: number
  channelCount: number
}

type RecordingTempSession = {
  append: (channels: readonly Float32Array[]) => Promise<void>
  appendPlanar: (buffer: ArrayBuffer, frameCount: number) => Promise<void>
  finalize: () => Promise<RecordingTempSessionDescriptor>
  abort: () => Promise<void>
}

const isSafeName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)

export const recordingStorageLimitExceeded = (
  byteLength: number,
  appendBytes: number,
  maxBytes?: number,
): boolean => maxBytes !== undefined && byteLength + appendBytes > maxBytes

const classifyStorageFailure = (cause: unknown): RecordingTempStorageFailure => {
  if (cause instanceof DOMException) {
    if (cause.name === "QuotaExceededError") return "quota-exceeded"
    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") return "permission-denied"
  }
  return "write-failed"
}

const storageFailure = (message: string, cause: unknown): RecordingTempStorageError =>
  new RecordingTempStorageError(classifyStorageFailure(cause), message, { cause })

const encodeText = (value: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(value)
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength))
  bytes.set(encoded)
  return bytes
}

const encodeDescriptor = (descriptor: RecordingTempSessionDescriptor): Uint8Array<ArrayBuffer> =>
  encodeText(JSON.stringify(descriptor))

const encodeCreatedAt = (createdAtMs: number): Uint8Array<ArrayBuffer> =>
  encodeText(String(createdAtMs))

const parseCreatedAt = (value: string): number | null => {
  const createdAtMs = Number(value)
  return Number.isSafeInteger(createdAtMs) && createdAtMs >= 0 ? createdAtMs : null
}

const encodePlanarBlock = (channels: readonly Float32Array[], frameCount: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(new ArrayBuffer(
    BLOCK_HEADER_BYTES + channels.length * frameCount * Float32Array.BYTES_PER_ELEMENT,
  ))
  const view = new DataView(bytes.buffer)
  view.setUint32(0, frameCount, true)
  let offset = BLOCK_HEADER_BYTES
  for (const channel of channels) {
    for (const sample of channel) {
      view.setFloat32(offset, sample, true)
      offset += Float32Array.BYTES_PER_ELEMENT
    }
  }
  return bytes
}

export const decodePlanarPcmBlocks = (bytes: Uint8Array, channelCount: number): PlanarPcmBlock[] => {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32) {
    throw new RecordingTempStorageError("invalid-block", "Recording channel count is invalid.")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const blocks: PlanarPcmBlock[] = []
  let offset = 0
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < BLOCK_HEADER_BYTES) {
      throw new RecordingTempStorageError("invalid-block", "Recording block header is truncated.")
    }
    const frameCount = view.getUint32(offset, true)
    offset += BLOCK_HEADER_BYTES
    const payloadBytes = frameCount * channelCount * Float32Array.BYTES_PER_ELEMENT
    if (frameCount === 0 || !Number.isSafeInteger(payloadBytes) || bytes.byteLength - offset < payloadBytes) {
      throw new RecordingTempStorageError("invalid-block", "Recording block payload is invalid.")
    }
    const channels: Float32Array[] = []
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = new Float32Array(frameCount)
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        channel[frameIndex] = view.getFloat32(offset, true)
        offset += Float32Array.BYTES_PER_ELEMENT
      }
      channels.push(channel)
    }
    blocks.push({ frameCount, channels })
  }
  return blocks
}

const recordingTempSessionDescriptorSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  format: z.literal("planar-float32-blocks"),
  sampleRate: z.number(),
  channelCount: z.number(),
  capturedFrames: z.number(),
  byteLength: z.number(),
  createdAtMs: z.number(),
  finalizedAtMs: z.number().nullable(),
})

const parseDescriptor = (value: string): RecordingTempSessionDescriptor | null => {
  try {
    const descriptor = recordingTempSessionDescriptorSchema.safeParse(JSON.parse(value))
    return descriptor.success ? descriptor.data : null
  } catch {
    return null
  }
}

const browserFilesystem: RecordingStorageFilesystem = {
  root: async () => wrapDirectory(await navigator.storage.getDirectory())
}

const wrapDirectory = (directory: FileSystemDirectoryHandle): RecordingStorageDirectory => ({
  getDirectory: async (name, create) => wrapDirectory(await directory.getDirectoryHandle(name, { create })),
  getFile: async (name, create) => {
    const handle = await directory.getFileHandle(name, { create })
    return {
      createWritable: async () => {
        const createWritable = handle.createWritable
        if (!createWritable) {
          throw new DOMException("Origin-private file writes are unavailable.", "NotSupportedError")
        }
        const writable = await createWritable.call(handle)
        return {
          write: (data) => writable.write(data),
          close: () => writable.close(),
          abort: () => writable.abort()
        }
      },
      text: async () => (await handle.getFile()).text()
    }
  },
  entries: async function* () {
    for await (const [name, handle] of directory.entries()) {
      yield { name, kind: handle.kind }
    }
  },
  remove: (name, recursive) => directory.removeEntry(name, { recursive })
})

export const createRecordingTempStorage = (options: CreateRecordingTempStorageOptions = {}) => {
  const filesystem = options.filesystem ?? browserFilesystem
  const maxBytes = options.maxBytes
  const now = options.now ?? Date.now
  const ownedSessionIds = new Set<string>()

  const sessionsDirectory = async () => {
    const root = await filesystem.root()
    return root.getDirectory(RECORDING_DIRECTORY, true)
  }

  const writeDescriptor = async (
    directory: RecordingStorageDirectory,
    descriptor: RecordingTempSessionDescriptor,
  ) => {
    const writable = await (await directory.getFile(SESSION_METADATA_FILE, true)).createWritable()
    try {
      await writable.write(encodeDescriptor(descriptor))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw storageFailure("Could not write recording session metadata.", error)
    }
  }

  const writeCreatedAt = async (directory: RecordingStorageDirectory, createdAtMs: number) => {
    const writable = await (await directory.getFile(SESSION_CREATED_AT_FILE, true)).createWritable()
    try {
      await writable.write(encodeCreatedAt(createdAtMs))
      await writable.close()
    } catch (error) {
      await writable.abort().catch(() => undefined)
      throw storageFailure("Could not write recording session creation time.", error)
    }
  }

  const createSession = async (input: CreateSessionInput): Promise<RecordingTempSession> => {
    if (!isSafeName(input.sessionId)) {
      throw new RecordingTempStorageError("invalid-session", "Recording session ID is invalid.")
    }
    if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8000 || input.sampleRate > 384000) {
      throw new RecordingTempStorageError("invalid-session", "Recording sample rate is invalid.")
    }
    if (!Number.isInteger(input.channelCount) || input.channelCount < 1 || input.channelCount > 32) {
      throw new RecordingTempStorageError("invalid-session", "Recording channel count is invalid.")
    }

    if (ownedSessionIds.has(input.sessionId)) {
      throw new RecordingTempStorageError("session-exists", "Recording session ID already exists.")
    }
    ownedSessionIds.add(input.sessionId)

    const sessions = await sessionsDirectory().catch((error) => {
      ownedSessionIds.delete(input.sessionId)
      throw storageFailure("Could not access recording session storage.", error)
    })
    try {
      await sessions.getDirectory(input.sessionId, false)
      ownedSessionIds.delete(input.sessionId)
      throw new RecordingTempStorageError("session-exists", "Recording session ID already exists.")
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") {
        ownedSessionIds.delete(input.sessionId)
        throw error
      }
    }

    let directory: RecordingStorageDirectory
    let writable: RecordingStorageWritable
    try {
      directory = await sessions.getDirectory(input.sessionId, true)
      writable = await (await directory.getFile(PCM_FILE, true)).createWritable()
    } catch (error) {
      ownedSessionIds.delete(input.sessionId)
      throw storageFailure("Could not create recording session storage.", error)
    }

    const createdAtMs = now()
    let capturedFrames = 0
    let byteLength = 0
    let state: "open" | "finalized" | "aborted" = "open"
    let finalizedDescriptor: RecordingTempSessionDescriptor | null = null
    let appendQueue = Promise.resolve()

    try {
      await writeCreatedAt(directory, createdAtMs)
      await writeDescriptor(directory, {
        version: 1,
        sessionId: input.sessionId,
        format: "planar-float32-blocks",
        sampleRate: input.sampleRate,
        channelCount: input.channelCount,
        capturedFrames: 0,
        byteLength: 0,
        createdAtMs,
        finalizedAtMs: null
      })
    } catch (error) {
      await writable.abort().catch(() => undefined)
      if (ownedSessionIds.delete(input.sessionId)) {
        await sessions.remove(input.sessionId, true).catch(() => undefined)
      }
      throw error
    }

    const abortAndRemove = async () => {
      state = "aborted"
      await writable.abort().catch(() => undefined)
      if (ownedSessionIds.delete(input.sessionId)) {
        await sessions.remove(input.sessionId, true).catch(() => undefined)
      }
    }

    const appendEncodedBlock = (
      frameCount: number,
      writeSamples: () => Promise<void>,
    ): Promise<void> => {
      const operation = appendQueue.then(async () => {
        if (state !== "open") {
          throw new RecordingTempStorageError("write-failed", "Recording session is no longer writable.")
        }
        const blockBytes = BLOCK_HEADER_BYTES + frameCount * input.channelCount * Float32Array.BYTES_PER_ELEMENT
        const nextByteLength = byteLength + blockBytes
        if (!Number.isInteger(frameCount) || frameCount <= 0) {
          throw new RecordingTempStorageError("invalid-block", "Recording block frame count is invalid.")
        }
        if (!Number.isSafeInteger(blockBytes) || !Number.isSafeInteger(nextByteLength)) {
          throw new RecordingTempStorageError("write-failed", "Recording byte accounting exceeded the supported filesystem number range.")
        }
        if (recordingStorageLimitExceeded(byteLength, blockBytes, maxBytes)) {
          throw new RecordingTempStorageError("capacity-exceeded", "Recording session exceeded its configured test storage bound.")
        }
        try {
          const header = new Uint8Array(BLOCK_HEADER_BYTES)
          new DataView(header.buffer).setUint32(0, frameCount, true)
          await writable.write(header)
          await writeSamples()
        } catch (error) {
          throw storageFailure("Could not write recording audio.", error)
        }
        capturedFrames += frameCount
        byteLength = nextByteLength
      }).catch(async (error) => {
        if (state === "open") await abortAndRemove()
        throw error
      })
      appendQueue = operation.catch(() => undefined)
      return operation
    }

    const append = (channels: readonly Float32Array[]): Promise<void> => {
      const frameCount = channels[0]?.length ?? 0
      if (
        channels.length !== input.channelCount
        || frameCount === 0
        || channels.some((channel) => channel.length !== frameCount)
      ) {
        return Promise.reject(new RecordingTempStorageError("invalid-block", "Recording block shape does not match the session."))
      }
      return appendEncodedBlock(frameCount, async () => {
        await writable.write(encodePlanarBlock(channels, frameCount).subarray(BLOCK_HEADER_BYTES))
      })
    }

    const appendPlanar = (buffer: ArrayBuffer, frameCount: number): Promise<void> => {
      const sampleBytes = frameCount * input.channelCount * Float32Array.BYTES_PER_ELEMENT
      const requiredBufferBytes = input.channelCount * RECORDER_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT
      if (
        !Number.isInteger(frameCount)
        || frameCount <= 0
        || frameCount > RECORDER_BLOCK_FRAMES
        || !Number.isSafeInteger(sampleBytes)
        || buffer.byteLength < requiredBufferBytes
      ) {
        return Promise.reject(new RecordingTempStorageError("invalid-block", "Recording planar block shape is invalid."))
      }
      return appendEncodedBlock(frameCount, async () => {
        for (let channel = 0; channel < input.channelCount; channel += 1) {
          await writable.write(new Uint8Array(
            buffer,
            channel * RECORDER_BLOCK_FRAMES * Float32Array.BYTES_PER_ELEMENT,
            frameCount * Float32Array.BYTES_PER_ELEMENT,
          ))
        }
      })
    }

    const finalize = async (): Promise<RecordingTempSessionDescriptor> => {
      await appendQueue
      if (finalizedDescriptor) return finalizedDescriptor
      if (state === "aborted") {
        throw new RecordingTempStorageError("write-failed", "Aborted recording session cannot be finalized.")
      }
      if (state === "open") {
        try {
          await writable.close()
        } catch (error) {
          await abortAndRemove()
          throw storageFailure("Could not finalize recording audio.", error)
        }
        state = "finalized"
      }
      const descriptor: RecordingTempSessionDescriptor = {
        version: 1,
        sessionId: input.sessionId,
        format: "planar-float32-blocks",
        sampleRate: input.sampleRate,
        channelCount: input.channelCount,
        capturedFrames,
        byteLength,
        createdAtMs,
        finalizedAtMs: now()
      }
      try {
        await writeDescriptor(directory, descriptor)
      } catch (error) {
        if (ownedSessionIds.delete(input.sessionId)) {
          await sessions.remove(input.sessionId, true).catch(() => undefined)
        }
        throw error
      }
      finalizedDescriptor = descriptor
      return finalizedDescriptor
    }

    const abort = async (): Promise<void> => {
      await appendQueue
      if (state === "aborted") return
      if (state === "finalized") return
      await abortAndRemove()
    }

    return { append, appendPlanar, finalize, abort }
  }

  const open = async (sessionId: string): Promise<RecordingTempSessionDescriptor | null> => {
    if (!isSafeName(sessionId)) return null
    try {
      const directory = await (await sessionsDirectory()).getDirectory(sessionId, false)
      return parseDescriptor(await (await directory.getFile(SESSION_METADATA_FILE, false)).text())
    } catch {
      return null
    }
  }

  const cleanupStale = async (): Promise<number> => {
    const sessions = await sessionsDirectory()
    const cutoff = now() - STALE_AFTER_MS
    let removed = 0
    for await (const entry of sessions.entries()) {
      if (entry.kind !== "directory" || !isSafeName(entry.name)) continue
      const descriptor = await open(entry.name)
      let createdAtMs = descriptor?.createdAtMs ?? null
      if (createdAtMs === null) {
        try {
          const directory = await sessions.getDirectory(entry.name, false)
          createdAtMs = parseCreatedAt(await (await directory.getFile(SESSION_CREATED_AT_FILE, false)).text())
        } catch {
          createdAtMs = null
        }
      }
      if (createdAtMs === null || createdAtMs > cutoff) continue
      await sessions.remove(entry.name, true)
      removed += 1
    }
    return removed
  }

  const remove = async (sessionId: string): Promise<void> => {
    if (!isSafeName(sessionId)) return
    const sessions = await sessionsDirectory()
    await sessions.remove(sessionId, true)
    ownedSessionIds.delete(sessionId)
  }

  return { createSession, open, remove, cleanupStale }
}
