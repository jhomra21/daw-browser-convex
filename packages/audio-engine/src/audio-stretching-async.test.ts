import { expect, test } from 'bun:test'
import {
  createWsolaBoundedSourceAsyncTransaction,
  createWsolaMaterializingCompatibilityTransaction,
  type WsolaPcmSource,
} from './audio-stretching'

const input = Float32Array.from({ length: 256 }, (_, index) => Math.sin(index * 0.17))

test('async WSOLA transaction awaits each append with one pending write', async () => {
  let pending = 0
  let maximumPending = 0
  const stored: Float32Array[] = []
  const source: WsolaPcmSource = {
    sampleRate: 100,
    channelCount: 1,
    frameCount: input.length,
    replay: function* () { yield { channels: [input] } },
    replayAsync: async function* () {
      for (let start = 0; start < input.length; start += 17) {
        const end = Math.min(input.length, start + 17)
        yield { channels: [input.subarray(start, end)] }
      }
    },
    dispose: () => {},
  }
  const result = await createWsolaBoundedSourceAsyncTransaction(source, {
    outputFrameCount: 384,
    windowFrameCount: 64,
    overlapFrameCount: 32,
    searchFrameCount: 8,
    createAsyncTransaction: (metadata) => ({
      append: async (chunk) => {
        pending += 1
        maximumPending = Math.max(maximumPending, pending)
        await Promise.resolve()
        stored.push(new Float32Array(chunk.channels[0] ?? []))
        pending -= 1
      },
      commit: async () => ({
        ...metadata,
        replay: function* () {
          for (const chunk of stored) yield { channels: [new Float32Array(chunk)] }
        },
        dispose: () => {},
      }),
      abort: async () => {},
    }),
  })
  expect(maximumPending).toBe(1)
  expect([...result.source.replay()].reduce((total, chunk) => total + (chunk.channels[0]?.length ?? 0), 0)).toBe(384)
  result.source.dispose()
})

test('async WSOLA transaction aborts without committing', async () => {
  const controller = new AbortController()
  let committed = false
  let aborted = false
  const source: WsolaPcmSource = {
    sampleRate: 100,
    channelCount: 1,
    frameCount: input.length,
    replay: function* () { yield { channels: [input] } },
    replayAsync: async function* () {
      yield { channels: [input] }
    },
    dispose: () => {},
  }
  await expect(createWsolaBoundedSourceAsyncTransaction(source, {
    outputFrameCount: 384,
    signal: controller.signal,
    createAsyncTransaction: (metadata) => ({
      append: async () => {
        controller.abort(new Error('async append aborted'))
        await Promise.resolve()
        controller.signal.throwIfAborted()
      },
      commit: async () => {
        committed = true
        return createWsolaMaterializingCompatibilityTransaction(metadata).commit()
      },
      abort: async () => { aborted = true },
    }),
  })).rejects.toThrow('async append aborted')
  expect(committed).toBe(false)
  expect(aborted).toBe(true)
})

test('async WSOLA disposes a mismatched committed source, input, and transaction once', async () => {
  let sourceDisposals = 0
  let committedDisposals = 0
  let aborts = 0
  const source: WsolaPcmSource = {
    sampleRate: 100,
    channelCount: 1,
    frameCount: input.length,
    replay: function* () { yield { channels: [input] } },
    replayAsync: async function* () { yield { channels: [input] } },
    dispose: () => { sourceDisposals += 1 },
  }
  await expect(createWsolaBoundedSourceAsyncTransaction(source, {
    outputFrameCount: 384,
    createAsyncTransaction: (metadata) => ({
      append: async (chunk) => {
        if ((chunk.channels[0]?.length ?? 0) > metadata.frameCount) throw new Error('unexpected append')
      },
      commit: async () => ({
        ...metadata,
        frameCount: metadata.frameCount - 1,
        replay: function* () {},
        dispose: () => {
          committedDisposals += 1
          throw new Error('committed dispose failed')
        },
      }),
      abort: async () => {
        aborts += 1
        throw new Error('abort failed')
      },
    }),
  })).rejects.toBeInstanceOf(AggregateError)
  expect(sourceDisposals).toBe(1)
  expect(committedDisposals).toBe(1)
  expect(aborts).toBe(1)
})
