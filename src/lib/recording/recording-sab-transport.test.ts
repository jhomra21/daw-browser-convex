import { describe, expect, test } from 'bun:test'
import {
  createRecorderSabRingBuffers,
  createRecorderSabRingProducer,
} from '../../../packages/audio-engine/src/recording/sab-ring-buffer'
import { createRecordingSabTransport } from './recording-sab-transport'
import { createRecordingWriterHandler } from './recording-writer-core'

const endpoint = () => {
  let handler = (_message: unknown) => {}
  const messages: unknown[] = []
  return {
    messages,
    postMessage: (message: unknown) => {
      messages.push(message)
    },
    setMessageHandler: (next: (message: unknown) => void) => {
      handler = next
    },
    receive: (message: unknown) => handler(message),
  }
}

const storage = (failure?: 'start' | 'append' | 'finalize') => {
  const blocks: Float32Array[][] = []
  let aborted = false
  return {
    blocks,
    aborted: () => aborted,
    createSession: async () => {
      if (failure === 'start') throw new Error('start-failed')
      return {
        append: async (channels: readonly Float32Array[]) => {
          if (failure === 'append') throw new Error('write-failed')
          blocks.push(channels.map((channel) => channel.slice()))
        },
        finalize: async () => {
          if (failure === 'finalize') throw new Error('finalize-failed')
          return { capturedFrames: blocks.reduce((total, block) => total + (block[0]?.length ?? 0), 0) }
        },
        abort: async () => {
          aborted = true
        },
      }
    },
  }
}

const writer = (target: ReturnType<typeof storage>) => {
  let handler = (_message: unknown) => {}
  let terminated = false
  const core = createRecordingWriterHandler(target, (message) => handler(message))
  return {
    postMessage: (message: unknown) => core.handle(message),
    setMessageHandler: (next: (message: unknown) => void) => {
      handler = next
    },
    terminate: () => {
      terminated = true
    },
    settled: () => core.testing.settled(),
    terminated: () => terminated,
  }
}

describe('recording SAB transport', () => {
  test('finalizes a final partial block with transferable status parity', async () => {
    const worklet = endpoint()
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const target = storage()
    const transport = createRecordingSabTransport({
      generation: 3,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 2,
      worklet,
      buffers,
      worker: writer(target),
    })
    expect(Object.keys(transport).sort()).toEqual(['abort', 'finalize', 'ready', 'terminate'])
    await transport.ready
    expect(worklet.messages[0]).toMatchObject({ type: 'initialize-sab' })
    expect(producer.push([Float32Array.of(1, 2), Float32Array.of(3, 4)], 2)).toBe(true)
    worklet.receive({ type: 'sab-notify', generation: 3, sessionId: 'take' })
    const finishing = transport.finalize()
    worklet.receive({
      type: 'complete',
      generation: 3,
      sessionId: 'take',
      capturedFrames: 2,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    await expect(finishing).resolves.toEqual({ capturedFrames: 2 })
    expect(target.blocks).toEqual([[Float32Array.of(1, 2), Float32Array.of(3, 4)]])
  })

  test('aborts storage on device loss and rejects completion', async () => {
    const worklet = endpoint()
    const target = storage()
    const targetWriter = writer(target)
    const transport = createRecordingSabTransport({
      generation: 1,
      sessionId: 'lost',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: targetWriter,
    })
    await transport.ready
    const finishing = transport.finalize()
    worklet.receive({
      type: 'failure',
      generation: 1,
      sessionId: 'lost',
      reason: 'recording-device-ended',
      capturedFrames: 0,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    await expect(finishing).rejects.toThrow('recording-device-ended')
    await targetWriter.settled()
    expect(target.aborted()).toBe(true)
    expect(targetWriter.terminated()).toBe(true)
  })

  test('terminates the writer after startup failure cleanup settles', async () => {
    const targetWriter = writer(storage('start'))
    const transport = createRecordingSabTransport({
      generation: 1,
      sessionId: 'start-failed',
      sampleRate: 48000,
      channelCount: 1,
      worklet: endpoint(),
      worker: targetWriter,
    })
    await expect(transport.ready).rejects.toThrow('start-failed')
    await targetWriter.settled()
    expect(targetWriter.terminated()).toBe(true)
  })

  test('terminates the writer after append failure cleanup settles', async () => {
    const worklet = endpoint()
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const target = storage('append')
    const targetWriter = writer(target)
    const failed = createRecordingSabTransport({
      generation: 1,
      sessionId: 'failed',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      buffers,
      worker: targetWriter,
    })
    await failed.ready
    expect(producer.push([Float32Array.of(1)], 1)).toBe(true)
    worklet.receive({ type: 'sab-notify', generation: 1, sessionId: 'failed' })
    await targetWriter.settled()
    await expect(failed.finalize()).rejects.toThrow('write-failed')
    expect(target.aborted()).toBe(true)
    expect(targetWriter.terminated()).toBe(true)
  })

  test('terminates the writer after finalize failure cleanup settles', async () => {
    const worklet = endpoint()
    const target = storage('finalize')
    const targetWriter = writer(target)
    const transport = createRecordingSabTransport({
      generation: 1,
      sessionId: 'finalize-failed',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: targetWriter,
    })
    await transport.ready
    const finishing = transport.finalize()
    worklet.receive({
      type: 'complete',
      generation: 1,
      sessionId: 'finalize-failed',
      capturedFrames: 0,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    await expect(finishing).rejects.toThrow('finalize-failed')
    await targetWriter.settled()
    expect(target.aborted()).toBe(true)
    expect(targetWriter.terminated()).toBe(true)
  })

  test('supports explicit abort', async () => {
    const abortWorklet = endpoint()
    const target = storage()
    const targetWriter = writer(target)
    const aborted = createRecordingSabTransport({
      generation: 2,
      sessionId: 'abort',
      sampleRate: 48000,
      channelCount: 1,
      worklet: abortWorklet,
      worker: targetWriter,
    })
    await aborted.ready
    await aborted.abort()
    expect(target.aborted()).toBe(true)
    expect(targetWriter.terminated()).toBe(true)
  })
})
