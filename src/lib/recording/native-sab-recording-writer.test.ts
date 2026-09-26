import { expect, test } from 'bun:test'
import { createRecordingWriterHandler } from './recording-writer-core'
import { benchmarkWorkerAssetUrl, createNativeSabRecordingWriter } from './native-sab-recording-writer'
import type { WriterInboundMessage, WriterOutboundMessage } from '../../../packages/audio-engine/src/recording/recording-protocol'

test('benchmark worker asset stays within the packaged app origin', () => {
  expect(benchmarkWorkerAssetUrl(new URL('daw://app/assets/recording-writer-worker.js'), new URL('daw://app/'))).toBeTrue()
  expect(benchmarkWorkerAssetUrl(new URL('daw://other/assets/recording-writer-worker.js'), new URL('daw://app/'))).toBeFalse()
  expect(benchmarkWorkerAssetUrl(new URL('https://app/assets/recording-writer-worker.js'), new URL('daw://app/'))).toBeFalse()
  expect(benchmarkWorkerAssetUrl(new URL('daw://app.evil/assets/recording-writer-worker.js'), new URL('daw://app/'))).toBeFalse()
})

const setup = (channelCount: number, stall = false) => {
  const blocks: Float32Array[][] = []
  let aborted = false
  let terminated = false
  let receive = (_message: WriterOutboundMessage | null) => {}
  const core = createRecordingWriterHandler({
    createSession: async () => ({
      append: async (channels) => {
        if (stall) await new Promise<void>(() => undefined)
        blocks.push(channels.map((channel) => channel.slice()))
      },
      finalize: async () => ({ capturedFrames: blocks.reduce((sum, block) => sum + (block[0]?.length ?? 0), 0) }),
      abort: async () => { aborted = true },
    }),
  }, (message) => receive(message))
  const worker = {
    postMessage: (message: WriterInboundMessage) => core.handle(message),
    setMessageHandler: (handler: typeof receive) => { receive = handler },
    terminate: () => { terminated = true },
  }
  const writer = createNativeSabRecordingWriter({
    generation: 1, sessionId: 'native', sampleRate: 48000, channelCount, worker, timeoutMs: 20,
  })
  return { writer, blocks, worker, receive: (message: WriterOutboundMessage | null) => receive(message), aborted: () => aborted, terminated: () => terminated }
}

test.each([1, 2])('native SAB writes exact %i-channel samples and finalizes', async (channelCount) => {
  const { writer, blocks } = setup(channelCount)
  await writer.ready
  writer.write({ sequence: 0, frameCount: 3, planes: Array.from({ length: channelCount }, (_, index) => Float32Array.of(index + 0.25, -0.5, 1)), channelCount })
  expect(await writer.finalize(3)).toEqual({ capturedFrames: 3 })
  expect(blocks).toEqual([Array.from({ length: channelCount }, (_, index) => Float32Array.of(index + 0.25, -0.5, 1))])
  expect(writer.stats().peakOccupancy).toBeLessThanOrEqual(8)
})

test('native SAB rejects malformed blocks and fails at eight outstanding slots', async () => {
  const malformed = setup(1)
  await malformed.writer.ready
  expect(() => malformed.writer.write({ sequence: 0, frameCount: 2, channelCount: 1, planes: [Float32Array.of(1)] })).toThrow()
  expect(malformed.terminated()).toBe(true)
  const { writer, terminated } = setup(1, true)
  await writer.ready
  for (let sequence = 0; sequence < 8; sequence += 1) {
    writer.write({ sequence, frameCount: 1, channelCount: 1, planes: [Float32Array.of(sequence)] })
  }
  expect(() => writer.write({ sequence: 8, frameCount: 1, channelCount: 1, planes: [Float32Array.of(8)] })).toThrow(/bound/)
  expect(writer.stats().peakOccupancy).toBeLessThanOrEqual(8)
  expect(writer.stats().droppedBlocks).toBe(0)
  expect(terminated()).toBe(true)
})

test('native SAB bounds finalize after the consumer pops but append stalls', async () => {
  const { writer, terminated } = setup(1, true)
  await writer.ready
  writer.write({ sequence: 0, frameCount: 1, channelCount: 1, planes: [Float32Array.of(1)] })
  await expect(writer.finalize(1)).rejects.toThrow(/timed out/)
  expect(terminated()).toBe(true)
})

test('native SAB fails closed on malformed worker response and supports abort', async () => {
  const bad = setup(1)
  await bad.writer.ready
  bad.receive(null)
  expect(bad.terminated()).toBe(true)
  expect(() => bad.writer.write({ sequence: 0, frameCount: 1, channelCount: 1, planes: [Float32Array.of(1)] })).toThrow()
  const good = setup(1)
  await good.writer.ready
  await good.writer.abort()
  expect(good.aborted()).toBe(true)
  expect(good.terminated()).toBe(true)
})

test('native SAB wakes workers that do not support asynchronous atomic waits', async () => {
  const messages: WriterInboundMessage[] = []
  let receive = (_message: WriterOutboundMessage | null) => {}
  const worker = {
    postMessage: (message: WriterInboundMessage) => {
      messages.push(message)
      if (message.type === 'start-sab') {
        queueMicrotask(() => receive({ type: 'ready', generation: 1, sessionId: 'native' }))
      }
    },
    setMessageHandler: (handler: typeof receive) => { receive = handler },
    terminate: () => undefined,
  }
  const writer = createNativeSabRecordingWriter({
    generation: 1, sessionId: 'native', sampleRate: 48_000, channelCount: 1, worker,
  })
  await writer.ready
  writer.write({ sequence: 0, frameCount: 1, channelCount: 1, planes: [Float32Array.of(1)] })
  expect(messages.map((message) => message.type)).toEqual(['start-sab', 'wake'])
  writer.terminate()
})

test('native SAB reports a worker startup error before its deadline', async () => {
  let onError = (_error: Error) => {}
  const writer = createNativeSabRecordingWriter({
    generation: 1, sessionId: 'native', sampleRate: 48_000, channelCount: 1,
    timeoutMs: 20,
    worker: {
      postMessage: () => queueMicrotask(() => onError(new Error('worker-load-failed'))),
      setMessageHandler: () => undefined,
      setErrorHandler: (handler) => { onError = handler },
      terminate: () => undefined,
    },
  })
  await expect(writer.ready).rejects.toThrow('worker-load-failed')
})

test('native SAB distinguishes a loaded worker from storage startup failure', async () => {
  let receive = (_message: WriterOutboundMessage | null) => {}
  const writer = createNativeSabRecordingWriter({
    generation: 1, sessionId: 'native', sampleRate: 48_000, channelCount: 1, timeoutMs: 20,
    worker: {
      postMessage: () => queueMicrotask(() => receive({ type: 'boot', generation: 1, sessionId: 'native' })),
      setMessageHandler: (handler) => { receive = handler },
      terminate: () => undefined,
    },
  })
  await expect(writer.ready).rejects.toThrow('storage startup timed out')
})
