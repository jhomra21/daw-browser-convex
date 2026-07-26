import { expect, test } from 'bun:test'

import { createMidiRecordingCheckpointController } from './recording-checkpoint'

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

test('checkpoints dirty takes after one second and after 64 events', async () => {
  let events = 1
  let timer: (() => void) | undefined
  const writes: number[] = []
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => ({ checkpoint: events, eventCount: events, version: events }),
    state: () => ({ eventCount: events, version: events }),
    persist: async (checkpoint) => { writes.push(checkpoint) },
    isActive: () => true,
    setTimer: (callback) => {
      timer = callback
      return 1
    },
    clearTimer: () => {
      timer = undefined
    },
  })

  checkpoints.schedule()
  expect(writes).toEqual([])
  timer?.()
  await flush()
  await flush()
  expect(writes).toEqual([1])

  events = 65
  expect(checkpoints.shouldRequest()).toBe(true)
  await checkpoints.request()
  expect(writes).toEqual([1, 65])
})

test('coalesces writes and awaits a newest final checkpoint', async () => {
  let events = 1
  let resolveFirst: (() => void) | undefined
  let resolveFinal: (() => void) | undefined
  const writes: number[] = []
  const finalWrites: boolean[] = []
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => ({ checkpoint: events, eventCount: events, version: events }),
    state: () => ({ eventCount: events, version: events }),
    persist: (checkpoint, final) => new Promise<void>((resolve) => {
      writes.push(checkpoint)
      finalWrites.push(final)
      if (writes.length === 1) resolveFirst = resolve
      else resolveFinal = resolve
    }),
    isActive: () => true,
  })

  const first = checkpoints.request()
  events = 2
  const final = checkpoints.request(true)
  resolveFirst?.()
  await Promise.resolve()
  expect(writes).toEqual([1, 2])
  expect(finalWrites).toEqual([false, true])
  let settled = false
  void final.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  resolveFinal?.()
  await Promise.all([first, final])
  expect(writes).toEqual([1, 2])
})

test('retries the newest final checkpoint after an in-flight periodic write fails', async () => {
  let events = 1
  let rejectFirst: ((error: Error) => void) | undefined
  const writes: { checkpoint: number; final: boolean }[] = []
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => ({ checkpoint: events, eventCount: events, version: events }),
    state: () => ({ eventCount: events, version: events }),
    persist: (checkpoint, final) => new Promise<void>((resolve, reject) => {
      writes.push({ checkpoint, final })
      if (writes.length === 1) rejectFirst = reject
      else resolve()
    }),
    isActive: () => true,
  })

  const periodic = checkpoints.request()
  events = 2
  const final = checkpoints.request(true)
  rejectFirst?.(new Error('network unavailable'))
  await expect(periodic).rejects.toThrow('network unavailable')
  await final
  expect(writes).toEqual([
    { checkpoint: 1, final: false },
    { checkpoint: 2, final: true },
  ])
})

test('checks 500 incoming events without creating a snapshot before the checkpoint threshold', () => {
  let events = 0
  let snapshots = 0
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => {
      snapshots += 1
      return { checkpoint: events, eventCount: events, version: events }
    },
    state: () => ({ eventCount: events, version: events }),
    persist: async () => {},
    isActive: () => true,
    eventThreshold: 501,
  })

  for (events = 1; events <= 500; events += 1) expect(checkpoints.shouldRequest()).toBe(false)
  expect(snapshots).toBe(0)
})

test('stops automatic event checkpoint retries after the retry budget and preserves the final write', async () => {
  let events = 64
  const writes: { checkpoint: number; final: boolean }[] = []
  const checkpoints = createMidiRecordingCheckpointController({
    snapshot: () => ({ checkpoint: events, eventCount: events, version: events }),
    state: () => ({ eventCount: events, version: events }),
    persist: async (checkpoint, final) => {
      writes.push({ checkpoint, final })
      if (!final) throw new Error('network unavailable')
    },
    isActive: () => true,
    eventThreshold: 64,
    maxRetryAttempts: 2,
  })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (checkpoints.shouldRequest()) await expect(checkpoints.request()).rejects.toThrow('network unavailable')
    events += 64
  }
  expect(writes).toEqual([
    { checkpoint: 64, final: false },
    { checkpoint: 128, final: false },
  ])

  await checkpoints.request(true)
  expect(writes.at(-1)).toEqual({ checkpoint: 384, final: true })
})
