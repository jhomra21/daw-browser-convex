import { z } from 'zod'

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

export type RecorderOutboundMessage =
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
  returnedAtMs?: number
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
  | { type: 'boot'; generation: number; sessionId: string }
  | { type: 'ready'; generation: number; sessionId: string }
  | { type: 'finalized'; generation: number; sessionId: string; capturedFrames: number; timing?: WriterTiming }
  | { type: 'aborted'; generation: number; sessionId: string; timing?: WriterTiming }
  | { type: 'failure'; generation: number; sessionId: string; reason: string; timing?: WriterTiming }

export type WriterTiming = {
  append: { count: number; startDelayMs: { total: number; max: number }; durationMs: { total: number; max: number } }
  storage: {
    headerWriteMs: { count: number; total: number; max: number }
    channelWriteMs: { count: number; total: number; max: number }
  } | null
}

const durationSchema = z.object({
  total: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
}).strict()

const writeAggregateSchema = durationSchema.extend({
  count: z.number().int().nonnegative(),
}).strict()

const writerTimingSchema: z.ZodType<WriterTiming> = z.object({
  append: z.object({
    count: z.number().int().nonnegative(),
    startDelayMs: durationSchema,
    durationMs: durationSchema,
  }).strict(),
  storage: z.object({
    headerWriteMs: writeAggregateSchema,
    channelWriteMs: writeAggregateSchema,
  }).strict().nullable(),
}).strict()

type RecorderMessageFields = {
  type?: unknown
  generation?: unknown
  sessionId?: unknown
  blockId?: unknown
  sequence?: unknown
  frameCount?: unknown
  channelCount?: unknown
  buffer?: unknown
  returnedAtMs?: unknown
  rms?: unknown
  peak?: unknown
  capturedFrames?: unknown
  droppedFrames?: unknown
  droppedBlocks?: unknown
  reason?: unknown
  sampleRate?: unknown
  state?: unknown
  frameCounts?: unknown
  samples?: unknown
}

const isRecord = <Value>(value: Value): value is Value & RecorderMessageFields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isNumber = <Value>(value: Value): value is Value & number => typeof value === 'number'

const isString = <Value>(value: Value): value is Value & string => typeof value === 'string'

const isGeneration = <Value>(value: Value): value is Value & number =>
  isNumber(value) && Number.isSafeInteger(value) && value >= 0

const isSessionId = <Value>(value: Value): value is Value & string =>
  isString(value) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)

const isPositiveInteger = <Value>(value: Value): value is Value & number =>
  isNumber(value) && Number.isSafeInteger(value) && value > 0

const readRecorderBlockMessage = <Value>(value: Value): RecorderBlockMessage | null => {
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

export const readRecorderOutboundMessage = <Value>(value: Value): RecorderOutboundMessage | null => {
  const block = readRecorderBlockMessage(value)
  if (block) return block
  if (
    isRecord(value) &&
    value.type === 'meter' &&
    isGeneration(value.generation) &&
    isSessionId(value.sessionId) &&
    isNumber(value.rms) &&
    Number.isFinite(value.rms) &&
    value.rms >= 0 &&
    isNumber(value.peak) &&
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
  if (value.type === 'failure' && isString(value.reason) && value.reason.length > 0) {
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

const readRecorderReturnMessage = <Value>(value: Value): RecorderReturnMessage | null => {
  if (
    !isRecord(value) ||
    value.type !== 'return' ||
    !isGeneration(value.generation) ||
    !isSessionId(value.sessionId) ||
    !isGeneration(value.blockId) ||
    !(value.buffer instanceof ArrayBuffer) ||
    (value.returnedAtMs !== undefined && (!isNumber(value.returnedAtMs) || !Number.isFinite(value.returnedAtMs) || value.returnedAtMs < 0 || value.returnedAtMs > Number.MAX_SAFE_INTEGER))
  ) return null
  const result: RecorderReturnMessage = {
    type: 'return',
    generation: value.generation,
    sessionId: value.sessionId,
    blockId: value.blockId,
    buffer: value.buffer,
  }
  if (value.returnedAtMs !== undefined) result.returnedAtMs = value.returnedAtMs
  return result
}

export const readWriterInboundMessage = <Value>(value: Value): WriterInboundMessage | null => {
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

export const readWriterOutboundMessage = <Value>(value: Value): WriterOutboundMessage | null => {
  const returned = readRecorderReturnMessage(value)
  if (returned) return returned
  if (!isRecord(value) || !isGeneration(value.generation) || !isSessionId(value.sessionId)) return null
  const rawTiming = 'timing' in value ? value.timing : undefined
  const parsedTiming = writerTimingSchema.optional().safeParse(rawTiming)
  if (!parsedTiming.success) return null
  const timing = parsedTiming.data
  if (value.type === 'boot') return { type: 'boot', generation: value.generation, sessionId: value.sessionId }
  if (value.type === 'ready') return { type: 'ready', generation: value.generation, sessionId: value.sessionId }
  if (value.type === 'aborted') {
    const result: WriterOutboundMessage = { type: 'aborted', generation: value.generation, sessionId: value.sessionId }
    if (timing) result.timing = timing
    return result
  }
  if (value.type === 'finalized' && isGeneration(value.capturedFrames)) {
    const result: WriterOutboundMessage = {
      type: 'finalized',
      generation: value.generation,
      sessionId: value.sessionId,
      capturedFrames: value.capturedFrames,
    }
    if (timing) result.timing = timing
    return result
  }
  if (value.type === 'failure' && isString(value.reason)) {
    const result: WriterOutboundMessage = {
      type: 'failure',
      generation: value.generation,
      sessionId: value.sessionId,
      reason: value.reason,
    }
    if (timing) result.timing = timing
    return result
  }
  return null
}
