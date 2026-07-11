export const RECORDER_BLOCK_FRAMES = 2048
export const RECORDER_MAX_CHANNELS = 2
export const RECORDER_POOL_BLOCKS = 32
export const RECORDER_MAX_QUEUED_BLOCKS = 8
export const RECORDER_FATAL_DROPPED_FRAMES = 1
export const RECORDER_POOL_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024

export type RecorderBlockMessage = {
  type: 'block'
  generation: number
  sessionId: string
  blockId: number
  sequence: number
  frameCount: number
  channelCount: number
  buffer: ArrayBuffer
}

type RecorderCompleteMessage = {
  type: 'complete'
  generation: number
  sessionId: string
  capturedFrames: number
  droppedFrames: number
  droppedBlocks: number
}

type RecorderFailureMessage = {
  type: 'failure'
  generation: number
  sessionId: string
  reason: string
  capturedFrames: number
  droppedFrames: number
  droppedBlocks: number
}

type RecorderMeterMessage = {
  type: 'meter'
  generation: number
  sessionId: string
  rms: number
  peak: number
}

type RecorderOutboundMessage =
  | RecorderBlockMessage
  | RecorderMeterMessage
  | RecorderCompleteMessage
  | RecorderFailureMessage

export type RecorderReturnMessage = {
  type: 'return'
  generation: number
  sessionId: string
  blockId: number
  buffer: ArrayBuffer
}

export type WriterStartMessage = {
  type: 'start'
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
}

export type WriterSabStartMessage = Omit<WriterStartMessage, 'type'> & {
  type: 'start-sab'
  state: SharedArrayBuffer
  frameCounts: SharedArrayBuffer
  samples: SharedArrayBuffer
}

export type WriterWakeMessage = {
  type: 'wake'
  generation: number
  sessionId: string
}

export type WriterFinalizeMessage = {
  type: 'finalize'
  generation: number
  sessionId: string
  capturedFrames?: number
}

export type WriterAbortMessage = {
  type: 'abort'
  generation: number
  sessionId: string
}

export type WriterInboundMessage =
  | WriterStartMessage
  | WriterSabStartMessage
  | WriterWakeMessage
  | RecorderBlockMessage
  | WriterFinalizeMessage
  | WriterAbortMessage

export type WriterOutboundMessage =
  | RecorderReturnMessage
  | { type: 'ready'; generation: number; sessionId: string }
  | { type: 'finalized'; generation: number; sessionId: string; capturedFrames: number }
  | { type: 'aborted'; generation: number; sessionId: string }
  | { type: 'failure'; generation: number; sessionId: string; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isGeneration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const readRecorderBlockMessage = (value: unknown): RecorderBlockMessage | null => {
  if (
    !isRecord(value) ||
    value.type !== 'block' ||
    !isGeneration(value.generation) ||
    !isSessionId(value.sessionId) ||
    !isGeneration(value.blockId) ||
    !isGeneration(value.sequence) ||
    !isPositiveInteger(value.frameCount) ||
    value.frameCount > RECORDER_BLOCK_FRAMES ||
    !isPositiveInteger(value.channelCount) ||
    value.channelCount > RECORDER_MAX_CHANNELS ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.buffer.byteLength !== RECORDER_BLOCK_FRAMES * value.channelCount * Float32Array.BYTES_PER_ELEMENT
  ) return null
  return {
    type: 'block',
    generation: value.generation,
    sessionId: value.sessionId,
    blockId: value.blockId,
    sequence: value.sequence,
    frameCount: value.frameCount,
    channelCount: value.channelCount,
    buffer: value.buffer,
  }
}

export const readRecorderOutboundMessage = (value: unknown): RecorderOutboundMessage | null => {
  const block = readRecorderBlockMessage(value)
  if (block) return block
  if (
    isRecord(value) &&
    value.type === 'meter' &&
    isGeneration(value.generation) &&
    isSessionId(value.sessionId) &&
    typeof value.rms === 'number' &&
    Number.isFinite(value.rms) &&
    value.rms >= 0 &&
    typeof value.peak === 'number' &&
    Number.isFinite(value.peak) &&
    value.peak >= 0
  ) {
    return {
      type: 'meter',
      generation: value.generation,
      sessionId: value.sessionId,
      rms: value.rms,
      peak: value.peak,
    }
  }
  if (
    !isRecord(value) ||
    !isGeneration(value.generation) ||
    !isSessionId(value.sessionId) ||
    !isGeneration(value.capturedFrames) ||
    !isGeneration(value.droppedFrames) ||
    !isGeneration(value.droppedBlocks)
  ) return null
  if (value.type === 'complete') {
    return {
      type: 'complete',
      generation: value.generation,
      sessionId: value.sessionId,
      capturedFrames: value.capturedFrames,
      droppedFrames: value.droppedFrames,
      droppedBlocks: value.droppedBlocks,
    }
  }
  if (value.type === 'failure' && typeof value.reason === 'string' && value.reason.length > 0) {
    return {
      type: 'failure',
      generation: value.generation,
      sessionId: value.sessionId,
      reason: value.reason,
      capturedFrames: value.capturedFrames,
      droppedFrames: value.droppedFrames,
      droppedBlocks: value.droppedBlocks,
    }
  }
  return null
}

const readRecorderReturnMessage = (value: unknown): RecorderReturnMessage | null => {
  if (
    !isRecord(value) ||
    value.type !== 'return' ||
    !isGeneration(value.generation) ||
    !isSessionId(value.sessionId) ||
    !isGeneration(value.blockId) ||
    !(value.buffer instanceof ArrayBuffer)
  ) return null
  return {
    type: 'return',
    generation: value.generation,
    sessionId: value.sessionId,
    blockId: value.blockId,
    buffer: value.buffer,
  }
}

export const readWriterInboundMessage = (value: unknown): WriterInboundMessage | null => {
  const block = readRecorderBlockMessage(value)
  if (block) return block
  if (!isRecord(value) || !isGeneration(value.generation) || !isSessionId(value.sessionId)) return null
  if (
    (value.type === 'start' || value.type === 'start-sab') &&
    isPositiveInteger(value.sampleRate) &&
    value.sampleRate >= 8000 &&
    value.sampleRate <= 384000 &&
    isPositiveInteger(value.channelCount) &&
    value.channelCount <= RECORDER_MAX_CHANNELS
  ) {
    if (value.type === 'start-sab') {
      if (
        !(value.state instanceof SharedArrayBuffer) ||
        !(value.frameCounts instanceof SharedArrayBuffer) ||
        !(value.samples instanceof SharedArrayBuffer)
      ) return null
      return {
        type: 'start-sab',
        generation: value.generation,
        sessionId: value.sessionId,
        sampleRate: value.sampleRate,
        channelCount: value.channelCount,
        state: value.state,
        frameCounts: value.frameCounts,
        samples: value.samples,
      }
    }
    return {
      type: 'start',
      generation: value.generation,
      sessionId: value.sessionId,
      sampleRate: value.sampleRate,
      channelCount: value.channelCount,
    }
  }
  if (value.type === 'wake') {
    return { type: 'wake', generation: value.generation, sessionId: value.sessionId }
  }
  if (value.type === 'finalize') {
    if (value.capturedFrames !== undefined && !isGeneration(value.capturedFrames)) return null
    return value.capturedFrames === undefined
      ? { type: 'finalize', generation: value.generation, sessionId: value.sessionId }
      : {
          type: 'finalize',
          generation: value.generation,
          sessionId: value.sessionId,
          capturedFrames: value.capturedFrames,
        }
  }
  if (value.type === 'abort') {
    return { type: 'abort', generation: value.generation, sessionId: value.sessionId }
  }
  return null
}

export const readWriterOutboundMessage = (value: unknown): WriterOutboundMessage | null => {
  const returned = readRecorderReturnMessage(value)
  if (returned) return returned
  if (!isRecord(value) || !isGeneration(value.generation) || !isSessionId(value.sessionId)) return null
  if (value.type === 'ready') return { type: 'ready', generation: value.generation, sessionId: value.sessionId }
  if (value.type === 'aborted') return { type: 'aborted', generation: value.generation, sessionId: value.sessionId }
  if (value.type === 'finalized' && isGeneration(value.capturedFrames)) {
    return {
      type: 'finalized',
      generation: value.generation,
      sessionId: value.sessionId,
      capturedFrames: value.capturedFrames,
    }
  }
  if (value.type === 'failure' && typeof value.reason === 'string') {
    return {
      type: 'failure',
      generation: value.generation,
      sessionId: value.sessionId,
      reason: value.reason,
    }
  }
  return null
}
