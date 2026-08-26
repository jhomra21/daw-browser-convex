import { describe, expect, test } from 'bun:test'
import { createRecordingWriterHandler, type RecordingWriterStorage } from './recording-writer-core'
import type { WriterOutboundMessage } from '../../../packages/audio-engine/src/recording/recording-protocol'
import {
  createRecorderSabRingBuffers,
  createRecorderSabRingProducer,
} from '../../../packages/audio-engine/src/recording/sab-ring-buffer'

const block = (sequence: number, blockId = sequence) => ({
  type: 'block',
  generation: 1,
  sessionId: 'take',
  blockId,
  sequence,
  frameCount: 2,
  channelCount: 1,
  buffer: new ArrayBuffer(2048 * Float32Array.BYTES_PER_ELEMENT),
})

describe('recording writer handler', () => {
  test('owns SAB consumption, planar copying, wake sequencing, and final drain', async () => {
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const writes: number[][][] = []
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async (channels) => {
          writes.push(channels.map((channel) => Array.from(channel)))
        },
        finalize: async () => ({
          capturedFrames: writes.reduce((total, channels) => total + (channels[0]?.length ?? 0), 0),
        }),
        abort: async () => undefined,
      }),
    }, (message) => output.push(message))
    handler.handle({
      type: 'start-sab',
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 2,
      ...buffers,
    })
    await handler.testing.settled()
    expect(producer.push([Float32Array.of(1, 2), Float32Array.of(3, 4)], 2)).toBe(true)
    expect(producer.push([Float32Array.of(5), Float32Array.of(6)], 1)).toBe(true)
    handler.handle({ type: 'wake', generation: 1, sessionId: 'take' })
    handler.handle({
      type: 'finalize',
      generation: 1,
      sessionId: 'take',
      capturedFrames: 3,
    })
    await handler.testing.settled()
    expect(writes).toEqual([
      [[1, 2], [3, 4]],
      [[5], [6]],
    ])
    expect(output.at(-1)).toMatchObject({ type: 'finalized', capturedFrames: 3 })
  })

  test('writes in order, returns buffers after writes, and finalizes after queued work', async () => {
    const events: string[] = []
    let frames = 0
    const storage: RecordingWriterStorage = {
      createSession: async () => ({
        append: async (channels) => {
          events.push(`write:${channels[0]?.[0]}`)
          frames += channels[0]?.length ?? 0
        },
        finalize: async () => {
          events.push('finalize')
          return { capturedFrames: frames }
        },
        abort: async () => undefined,
      }),
    }
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler(storage, (message) => {
      output.push(message)
      if (message.type === 'return') events.push(`return:${message.blockId}`)
    })
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    const first = block(0)
    new Float32Array(first.buffer).set([1, 2])
    const second = block(1)
    new Float32Array(second.buffer).set([3, 4])
    handler.handle(first)
    handler.handle(second)
    handler.handle({ type: 'finalize', generation: 1, sessionId: 'take' })
    await handler.testing.settled()
    expect(events).toEqual(['write:1', 'return:0', 'write:3', 'return:1', 'finalize'])
    expect(output.at(-1)).toMatchObject({ type: 'finalized', capturedFrames: 4 })
  })

  test('passes contiguous transferable PCM directly to storage', async () => {
    const planarBlocks: ArrayBuffer[] = []
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        appendPlanar: async (buffer) => {
          planarBlocks.push(buffer)
        },
        append: async () => {
          throw new Error('channel slicing should not be used')
        },
        finalize: async () => ({ capturedFrames: 2 }),
        abort: async () => undefined,
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    const input = block(0)
    new Float32Array(input.buffer).set([1, 2])
    handler.handle(input)
    await handler.testing.settled()
    expect(planarBlocks).toEqual([input.buffer])
    expect(output.at(-1)).toMatchObject({ type: 'return', blockId: 0 })
  })

  test('ignores stale sessions and rejects malformed messages', async () => {
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async () => undefined,
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => undefined,
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    handler.handle({ type: 'finalize', generation: 0, sessionId: 'old' })
    expect(output).toHaveLength(1)
    handler.handle({ nope: true })
    await handler.testing.settled()
    expect(output.at(-1)).toMatchObject({ type: 'failure', reason: 'malformed-message' })
  })

  test('enforces the eight-block queue during a stalled write', async () => {
    let release = () => {}
    const stalled = new Promise<void>((resolve) => {
      release = resolve
    })
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: () => stalled,
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => undefined,
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    for (let sequence = 0; sequence < 9; sequence += 1) handler.handle(block(sequence))
    expect(handler.testing.snapshot().queuedBlocks).toBe(8)
    expect(output.at(-1)).toMatchObject({ type: 'ready' })
    release()
    await handler.testing.settled()
    expect(output.at(-1)).toMatchObject({ type: 'failure', reason: 'writer-queue-overflow' })
    expect(handler.testing.snapshot()).toMatchObject({ state: 'failed', queuedBlocks: 0 })
  })

  test('settles storage cleanup before reporting writer failure', async () => {
    let releaseAbort = () => {}
    const aborting = new Promise<void>((resolve) => {
      releaseAbort = resolve
    })
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async () => {
          throw new Error('write-failed')
        },
        finalize: async () => ({ capturedFrames: 0 }),
        abort: () => aborting,
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    handler.handle(block(0))
    await Promise.resolve()
    await Promise.resolve()
    expect(output.at(-1)).toMatchObject({ type: 'ready' })
    releaseAbort()
    await handler.testing.settled()
    expect(output.at(-1)).toMatchObject({ type: 'failure', reason: 'write-failed' })
  })

  test('aborts only after queued writes and surfaces worker storage failure', async () => {
    const events: string[] = []
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async () => {
          events.push('write')
        },
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => {
          events.push('abort')
        },
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    handler.handle(block(0))
    handler.handle({ type: 'abort', generation: 1, sessionId: 'take' })
    await handler.testing.settled()
    expect(events).toEqual(['write', 'abort'])
    expect(output.at(-1)).toMatchObject({ type: 'aborted' })

    const failedOutput: WriterOutboundMessage[] = []
    const failed = createRecordingWriterHandler({
      createSession: async () => {
        throw new Error('storage-unavailable')
      },
    }, (message) => failedOutput.push(message))
    failed.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await failed.testing.settled()
    expect(failedOutput.at(-1)).toMatchObject({ type: 'failure', reason: 'storage-unavailable' })
  })

  test('rejects channel layout changes without appending the block', async () => {
    let appends = 0
    let aborts = 0
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async () => {
          appends += 1
        },
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => {
          aborts += 1
        },
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    handler.handle({
      ...block(0),
      channelCount: 2,
      buffer: new ArrayBuffer(2048 * 2 * Float32Array.BYTES_PER_ELEMENT),
    })
    await handler.testing.settled()
    expect(appends).toBe(0)
    expect(aborts).toBe(1)
    expect(output.at(-1)).toMatchObject({ type: 'failure', reason: 'recording-channel-layout-mismatch' })
  })

  test('serializes abort after the active write and cancels queued appends on failure', async () => {
    let release = () => {}
    const active = new Promise<void>((resolve) => {
      release = resolve
    })
    const events: string[] = []
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: async (channels) => {
          events.push(`append:${channels[0]?.[0]}`)
          if (channels[0]?.[0] === 1) await active
        },
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => {
          events.push('abort')
        },
      }),
    }, (message) => output.push(message))
    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    const first = block(0)
    new Float32Array(first.buffer)[0] = 1
    const second = block(1)
    new Float32Array(second.buffer)[0] = 2
    handler.handle(first)
    handler.handle(second)
    await Promise.resolve()
    handler.handle({ malformed: true })
    expect(events).toEqual(['append:1'])
    release()
    await handler.testing.settled()
    expect(events).toEqual(['append:1', 'abort'])
    expect(handler.testing.snapshot()).toMatchObject({ state: 'failed', queuedBlocks: 0 })
    expect(output.filter((message) => message.type === 'failure')).toHaveLength(1)
  })

  test('keeps createSession failure terminal when startup completion is already queued', async () => {
    let resolveSession = () => {}
    let aborts = 0
    const pendingSession = new Promise<Awaited<ReturnType<RecordingWriterStorage['createSession']>>>((resolve) => {
      resolveSession = () => resolve({
        append: async () => undefined,
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => {
          aborts += 1
        },
      })
    })
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: () => pendingSession,
    }, (message) => output.push(message))

    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    handler.handle({ malformed: true })
    resolveSession()
    await handler.testing.settled()

    expect(output).toEqual([{
      type: 'failure',
      generation: 1,
      sessionId: 'take',
      reason: 'malformed-message',
    }])
    expect(aborts).toBe(1)
    expect(handler.testing.snapshot()).toEqual({ state: 'failed', queuedBlocks: 0 })
  })

  test('keeps queued finalize completion from overwriting a terminal failure', async () => {
    let releaseAppend = () => {}
    const pendingAppend = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let finalizes = 0
    let aborts = 0
    const output: WriterOutboundMessage[] = []
    const handler = createRecordingWriterHandler({
      createSession: async () => ({
        append: () => pendingAppend,
        finalize: async () => {
          finalizes += 1
          return { capturedFrames: 2 }
        },
        abort: async () => {
          aborts += 1
        },
      }),
    }, (message) => output.push(message))

    handler.handle({ type: 'start', generation: 1, sessionId: 'take', sampleRate: 48000, channelCount: 1 })
    await handler.testing.settled()
    handler.handle(block(0))
    handler.handle({ type: 'finalize', generation: 1, sessionId: 'take' })
    await Promise.resolve()
    handler.handle({ malformed: true })
    releaseAppend()
    await handler.testing.settled()

    expect(finalizes).toBe(0)
    expect(aborts).toBe(1)
    expect(handler.testing.snapshot()).toEqual({ state: 'failed', queuedBlocks: 0 })
    expect(output.filter((message) =>
      message.type === 'failure' || message.type === 'finalized' || message.type === 'aborted'
    )).toEqual([{
      type: 'failure',
      generation: 1,
      sessionId: 'take',
      reason: 'malformed-message',
    }])
  })
})
