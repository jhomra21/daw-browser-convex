import { expect, test } from 'bun:test'
import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_QUEUED_BLOCKS,
  type WriterInboundMessage,
  type WriterOutboundMessage,
} from '@daw-browser/audio-engine/recording-protocol'
import type { PortableWasmStatusMessage } from '@daw-browser/audio-engine/portable-wasm-protocol'
import { createPortableRecordingWriter } from '~/lib/recording/portable-recording-writer'

test('bridges portable planar blocks into the bounded recording writer protocol', async () => {
  const posted: WriterInboundMessage[] = []
  let handleMessage = (_message: WriterOutboundMessage | null) => {}
  const writer = createPortableRecordingWriter({
    generation: 3,
    sessionId: 'take-1',
    sampleRate: 48_000,
    channelCount: 2,
    worker: {
      postMessage: (message) => posted.push(message),
      setMessageHandler: (handler) => {
        handleMessage = handler
      },
      terminate: () => undefined,
    },
  })

  handleMessage({ type: 'ready', generation: 3, sessionId: 'take-1' })
  await writer.ready
  writer.write({
    version: 1,
    type: 'recording-capture-block',
    generation: 3,
    sessionId: 9,
    sequence: 0,
    frameCount: 2,
    channelCount: 2,
    planes: [Float32Array.from([0.25, 0.5]), Float32Array.from([-0.25, -0.5])],
    rms: 0.25,
    peak: 0.5,
  })

  const block = posted.find((message) => message.type === 'block')
  expect(block?.frameCount).toBe(2)
  expect(block?.buffer instanceof ArrayBuffer).toBeTrue()
  if (!block) throw new Error('Expected a portable recording block.')
  const samples = new Float32Array(block.buffer)
  expect(Array.from(samples.slice(0, 2))).toEqual([0.25, 0.5])
  expect(Array.from(samples.slice(RECORDER_BLOCK_FRAMES, RECORDER_BLOCK_FRAMES + 2))).toEqual([-0.25, -0.5])

  handleMessage({ type: 'return', generation: 3, sessionId: 'take-1', blockId: 0, buffer: block.buffer })
  const completion = writer.finalize(2)
  await Promise.resolve()
  expect(posted.some((message) => message.type === 'finalize')).toBeTrue()
  handleMessage({ type: 'finalized', generation: 3, sessionId: 'take-1', capturedFrames: 2 })
  expect(await completion).toEqual({ capturedFrames: 2 })
})

test('fails instead of growing beyond the fixed portable writer queue', async () => {
  let handleMessage = (_message: WriterOutboundMessage | null) => {}
  const writer = createPortableRecordingWriter({
    generation: 4,
    sessionId: 'take-2',
    sampleRate: 48_000,
    channelCount: 1,
    worker: {
      postMessage: () => undefined,
      setMessageHandler: (handler) => {
        handleMessage = handler
      },
      terminate: () => undefined,
    },
  })
  handleMessage({ type: 'ready', generation: 4, sessionId: 'take-2' })
  await writer.ready
  const block: Extract<PortableWasmStatusMessage, { type: 'recording-capture-block' }> = {
    version: 1,
    type: 'recording-capture-block',
    generation: 4,
    sessionId: 10,
    sequence: 0,
    frameCount: 1,
    channelCount: 1,
    planes: [Float32Array.of(0)],
    rms: 0,
    peak: 0,
  }
  for (let index = 0; index < RECORDER_MAX_QUEUED_BLOCKS; index += 1) {
    writer.write({ ...block, sequence: index })
  }
  expect(() => writer.write({ ...block, sequence: RECORDER_MAX_QUEUED_BLOCKS }))
    .toThrow('Portable recording writer queue exceeded its hard bound.')
  writer.terminate()
})

test('terminates when the portable writer never becomes ready', async () => {
  let terminations = 0
  const writer = createPortableRecordingWriter({
    generation: 5,
    sessionId: 'take-timeout',
    sampleRate: 48_000,
    channelCount: 1,
    timeoutMs: 5,
    worker: {
      postMessage: () => undefined,
      setMessageHandler: () => undefined,
      terminate: () => {
        terminations += 1
      },
    },
  })

  await expect(writer.ready).rejects.toThrow('Portable recording writer startup timed out.')
  expect(terminations).toBe(1)
})

test('terminates when portable writer abort acknowledgement hangs', async () => {
  const posted: WriterInboundMessage[] = []
  let handleMessage = (_message: WriterOutboundMessage | null) => {}
  let terminations = 0
  const writer = createPortableRecordingWriter({
    generation: 6,
    sessionId: 'take-abort-timeout',
    sampleRate: 48_000,
    channelCount: 1,
    timeoutMs: 5,
    worker: {
      postMessage: (message) => posted.push(message),
      setMessageHandler: (handler) => {
        handleMessage = handler
      },
      terminate: () => {
        terminations += 1
      },
    },
  })
  handleMessage({ type: 'ready', generation: 6, sessionId: 'take-abort-timeout' })
  await writer.ready

  await writer.abort()

  expect(posted.some((message) => message.type === 'abort')).toBeTrue()
  expect(terminations).toBe(1)
})
