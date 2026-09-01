import { expect, test } from 'bun:test'

import type { NativeOfflineRenderPlan } from '@daw-browser/audio-engine/native-host-wire'
import { nativeAudioHostMaximumInMemoryPcmBytes } from '@daw-browser/desktop-protocol/native-audio-host'

import { createDesktopNativeOfflinePcmRenderer } from '~/lib/export/desktop-native-offline-pcm-renderer'
import type {
  NativeOfflinePcmSpoolDescriptor,
  NativeOfflinePcmSpoolSession,
} from '~/lib/export/native-offline-pcm-spool'

const plan = (totalFrames: number): NativeOfflineRenderPlan => ({
  version: 1,
  sampleRateHz: 48_000,
  channelCount: 2,
  totalFrames,
  blockFrames: 1_024,
  graph: new Uint8Array([1]),
  assets: [],
  transport: { epoch: 1, running: false, frame: 0 },
  schedule: new Uint8Array([1]),
})

const chunk = (startFrame: number, values: readonly number[]) => ({
  startFrame,
  frameCount: values.length,
  channelCount: 2,
  planes: [new Float32Array(values), new Float32Array(values)],
})

type FakeSpoolState = {
  appended: number[]
  finalized: number
  aborted: number
}

const fakeSession = (
  state: FakeSpoolState,
  append?: NativeOfflinePcmSpoolSession['append'],
): NativeOfflinePcmSpoolSession => ({
  append: append ?? (async (value) => { state.appended.push(value.startFrame) }),
  finalize: async (): Promise<NativeOfflinePcmSpoolDescriptor> => {
    state.finalized += 1
    return {
      sessionId: 'test',
      sampleRate: 48_000,
      channelCount: 2,
      totalFrames: 4,
      byteLength: 4 * 2 * Float32Array.BYTES_PER_ELEMENT,
      samplePeak: 0,
    }
  },
  replay: async function* () {},
  remove: async () => {},
  abort: async () => { state.aborted += 1 },
})

test('disk-backed native renderer has no 512 MiB AudioBuffer admission limit', async () => {
  let started = false
  let created = false
  const state: FakeSpoolState = { appended: [], finalized: 0, aborted: 0 }
  const renderer = createDesktopNativeOfflinePcmRenderer({
    start: async () => {
      started = true
      return { ok: false, error: 'test stop' }
    },
    cancel: async () => ({ accepted: true }),
  }, {
    createSession: async () => {
      created = true
      return fakeSession(state)
    },
  })
  const totalFrames = nativeAudioHostMaximumInMemoryPcmBytes
    / (2 * Float32Array.BYTES_PER_ELEMENT) + 1

  await expect(renderer(plan(totalFrames), new AbortController().signal, () => undefined))
    .rejects.toThrow('test stop')
  expect(created).toBe(true)
  expect(started).toBe(true)
  expect(state.aborted).toBe(1)
})

test('native bridge waits for each spool append before advancing', async () => {
  const firstWrite = Promise.withResolvers<void>()
  const state: FakeSpoolState = { appended: [], finalized: 0, aborted: 0 }
  let reachedAfterFirst = false
  const session = fakeSession(state, async (value) => {
    state.appended.push(value.startFrame)
    if (value.startFrame === 0) await firstWrite.promise
  })
  const renderer = createDesktopNativeOfflinePcmRenderer({
    start: async (_jobId, _plan, onChunk) => {
      await onChunk(chunk(0, [0.25, -0.25]))
      reachedAfterFirst = true
      await onChunk(chunk(2, [0.5, -0.5]))
      return { ok: true }
    },
    cancel: async () => ({ accepted: true }),
  }, {
    createSession: async () => session,
  })

  const render = renderer(plan(4), new AbortController().signal, () => undefined)
  await Promise.resolve()
  await Promise.resolve()
  expect(state.appended).toEqual([0])
  expect(reachedAfterFirst).toBe(false)

  firstWrite.resolve()
  expect(await render).toBe(session)
  expect(state.appended).toEqual([0, 2])
  expect(state.finalized).toBe(1)
  expect(state.aborted).toBe(0)
})

test('spool append failure cancels native work and removes partial output', async () => {
  const state: FakeSpoolState = { appended: [], finalized: 0, aborted: 0 }
  let cancellations = 0
  const renderer = createDesktopNativeOfflinePcmRenderer({
    start: async (_jobId, _plan, onChunk) => {
      await onChunk(chunk(0, [0.25, -0.25]))
      return { ok: true }
    },
    cancel: async () => {
      cancellations += 1
      return { accepted: true }
    },
  }, {
    createSession: async () => fakeSession(state, async () => {
      throw new Error('disk write failed')
    }),
  })

  await expect(renderer(plan(2), new AbortController().signal, () => undefined))
    .rejects.toThrow('disk write failed')
  expect(cancellations).toBeGreaterThanOrEqual(1)
  expect(state.finalized).toBe(0)
  expect(state.aborted).toBe(1)
})
