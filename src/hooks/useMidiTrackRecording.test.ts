import 'fake-indexeddb/auto'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'
import { createMidiTrackRecordingController } from '~/lib/midi/midi-recording-controller'
import type { MidiInputEvent, MidiSourceReset } from '~/lib/midi/midi-input'
import { createLocalProject } from '~/lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { readSharedOutboxSummary } from '~/lib/shared-outbox'
import type { Track } from '@daw-browser/timeline-core/types'

import { settlePopstateProjectTransition } from './useTimelineProjectRoute'

type RecordedOperation = {
  projectId: string
  kind: string
  payload: Record<string, unknown>
}

const track = (): Track => ({
  id: 'instrument-track',
  name: 'Instrument',
  volume: 1,
  clips: [],
  kind: 'instrument',
})

const noteOn = (sourceId: string, timeStamp: number): MidiInputEvent => ({
  sourceId,
  timeStamp,
  channel: 1,
  kind: 'note-on',
  note: 60,
  velocity: 0.5,
})

const noteOff = (sourceId: string, timeStamp: number): MidiInputEvent => ({
  sourceId,
  timeStamp,
  channel: 1,
  kind: 'note-off',
  note: 60,
  velocity: 0,
})

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window

const createHarness = (input: {
  projectId?: string
  bpm?: number | (() => number)
  loopEnabled?: boolean
  requestAccess?: () => Promise<void>
  requestTransportPlay?: () => Promise<void>
  inputs?: () => Array<{ id: string; selected: boolean; connected: boolean }>
} = {}) => {
  const operations: RecordedOperation[] = []
  const notifications: string[] = []
  const provisional: Array<string | null> = []
  const activeTargets: Array<string | null> = []
  const history: unknown[] = []
  const inserted: Array<{ trackId: string; clip: Track['clips'][number] }> = []
  const removed: string[][] = []
  const locks: Array<{ trackId: string; locker: string | null }> = []
  const subscribers = new Set<(event: MidiInputEvent) => void>()
  const resetSubscribers = new Set<(event: MidiSourceReset) => void>()
  let dispose = () => {}
  let controller: ReturnType<typeof createMidiTrackRecordingController> | undefined

  createRoot((rootDispose) => {
    dispose = rootDispose
    const [isRecording, setIsRecording] = createSignal(false)
    const [recordingTrackId, setRecordingTrackId] = createSignal<string | null>(null)
    controller = createMidiTrackRecordingController({
      audioEngine: {
        midiEventTimes: (timeStamp) => ({
          timelineTime: timeStamp / 1_000,
          contextTime: timeStamp / 1_000,
          scheduledContextTime: timeStamp / 1_000,
        }),
      },
      tracks: () => [track()],
      projectId: () => input.projectId ?? 'cloud-project',
      userId: () => 'user-1',
      playheadSec: () => 0,
      bpm: () => typeof input.bpm === 'function' ? input.bpm() : input.bpm ?? 120,
      loopEnabled: () => input.loopEnabled ?? false,
      recordArmTrackId: () => 'instrument-track',
      setTrackLock: (trackId, lockedBy) => { locks.push({ trackId, locker: lockedBy }) },
      clearTrackLock: (trackId) => { locks.push({ trackId, locker: null }) },
      insertLocalClip: (trackId, clip) => { inserted.push({ trackId, clip }) },
      removeLocalClips: (clipIds) => { removed.push([...clipIds]) },
      selection: { selectPrimaryClip: () => {} },
      requestTransportPlay: input.requestTransportPlay ?? (async () => {}),
      pauseTransport: () => {},
      notify: (message) => { notifications.push(message) },
      historyPush: (entry) => { history.push(entry) },
      setActiveRecordingTarget: (trackId) => { activeTargets.push(trackId) },
      setProvisionalClipId: (clipId) => { provisional.push(clipId) },
      isRecording,
      setIsRecording,
      recordingTrackId,
      setRecordingTrackId,
    }, {
        status: () => 'ready',
        inputs: () => (input.inputs?.() ?? []).map((entry) => ({
          ...entry,
          name: null,
          manufacturer: null,
        })),
        requestAccess: input.requestAccess ?? (async () => {}),
        setInputSelected: () => {},
        subscribe: (subscriber) => {
          subscribers.add(subscriber)
          return () => { subscribers.delete(subscriber) }
        },
        subscribeSourceReset: (subscriber) => {
          resetSubscribers.add(subscriber)
          return () => { resetSubscribers.delete(subscriber) }
        },
        panic: () => {},
      })
  })
  if (!controller) throw new Error('MIDI recording controller was not created.')

  return {
    controller,
    projectId: input.projectId ?? 'cloud-project',
    operations,
    notifications,
    provisional,
    activeTargets,
    history,
    inserted,
    removed,
    locks,
    emit: (event: MidiInputEvent) => { for (const subscriber of subscribers) subscriber(event) },
    reset: (sourceId: string) => {
      for (const subscriber of resetSubscribers) subscriber({ sourceId, kind: 'source-reset' })
    },
    dispose,
  }
}

beforeEach(() => {
  let heartbeat: (() => void) | undefined
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval: (callback: () => void) => {
        heartbeat = callback
        return 1
      },
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
  Object.defineProperty(globalThis, '__midiRecordingHeartbeat', {
    configurable: true,
    value: () => heartbeat?.(),
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  Reflect.deleteProperty(globalThis, '__midiRecordingHeartbeat')
})

const setFetch = (
  handler: (operation: RecordedOperation) => Response | Promise<Response>,
  operations: RecordedOperation[],
) => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
      if (!body || typeof body.kind !== 'string' || typeof body.payload !== 'object' || body.payload === null) {
        throw new Error('Expected a timeline operation request.')
      }
      const operation = {
        projectId: 'cloud-project',
        kind: body.kind,
        payload: body.payload,
      }
      operations.push(operation)
      return await handler(operation)
    },
  })
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

describe('useMidiTrackRecording transactions', () => {
  test('holds a project transition until a MIDI recording permission startup settles', async () => {
    let allowAccess: (() => void) | undefined
    const recording = createHarness({
      requestAccess: () => new Promise<void>((resolve) => { allowAccess = resolve }),
    })
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock' || operation.kind === 'clips.removeMany') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)
    const events: string[] = []

    const start = recording.controller.startRecording()
    await flush()
    const transition = settlePopstateProjectTransition({
      currentProjectId: 'cloud-project',
      nextProjectId: 'other-project',
      settle: async () => {
        events.push('settle')
        await recording.controller.stopRecording()
      },
      resolve: () => { events.push('resolve') },
      restore: () => { events.push('restore') },
    })
    await flush()
    expect(events).toEqual(['settle'])

    if (!allowAccess) throw new Error('MIDI permission request did not begin.')
    allowAccess()
    await Promise.all([start, transition])
    expect(events).toEqual(['settle', 'resolve'])
    expect(recording.operations.map((operation) => operation.kind)).toEqual([
      'tracks.lock', 'clips.create', 'clips.removeMany', 'tracks.unlock',
    ])
    recording.dispose()
  })

  test('rolls back a created provisional clip and releases its cloud lock when startup fails', async () => {
    const recording = createHarness({ requestTransportPlay: async () => { throw new Error('transport failed') } })
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.removeMany') return json({ ok: true })
      if (operation.kind === 'tracks.unlock') return json({ ok: true })
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await expect(recording.controller.startRecording()).resolves.toBe(false)

    expect(recording.operations.map((operation) => operation.kind)).toEqual([
      'tracks.lock', 'clips.create', 'clips.removeMany', 'tracks.unlock',
    ])
    expect(recording.removed).toEqual([['clip-1'], ['clip-1']])
    expect(recording.locks.at(-1)).toEqual({ trackId: 'instrument-track', locker: null })
    expect(recording.notifications).toEqual(['Unable to start MIDI recording.'])
    recording.dispose()
  })

  test('persists a local final checkpoint with the start BPM and commits one history item', async () => {
    const project = await createLocalProject(`MIDI recording ${crypto.randomUUID()}`)
    const repository = createLocalTimelineRepository(project.id)
    await repository.createTrack({ id: 'instrument-track', kind: 'instrument' })
    const recording = createHarness({ projectId: project.id, bpm: 120 })

    await expect(recording.controller.startRecording()).resolves.toBe(true)
    recording.emit(noteOn('keyboard', 0))
    recording.emit(noteOff('keyboard', 1_000))
    await recording.controller.stopRecording()

    const clip = (await repository.loadSnapshot()).clips[0]
    expect(clip?.midi?.notes).toEqual([
      expect.objectContaining({ beat: 0, length: 2, pitch: 60 }),
    ])
    expect(clip?.duration).toBeGreaterThan(0)
    expect(recording.history).toHaveLength(1)
    expect(recording.provisional.at(-1)).toBeNull()
    recording.dispose()
  })

  test('queues a retryable cloud final checkpoint while retaining its final projection and history', async () => {
    const recording = createHarness()
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.setMidiAndTiming') throw new TypeError('network unavailable')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard', 0))
    recording.emit(noteOff('keyboard', 1_000))
    await recording.controller.stopRecording()

    expect(await readSharedOutboxSummary('cloud-project', 'user-1')).toEqual({ pending: 1, failed: 0 })
    expect(recording.inserted.at(-1)?.clip.midi?.notes).toHaveLength(1)
    expect(recording.history).toHaveLength(1)
    expect(recording.notifications).toContain('MIDI recording was queued and will retry when sync resumes.')
    recording.dispose()
  })

  test('queues an empty cloud take deletion and clears its mutation guard on retryable failure', async () => {
    const recording = createHarness({ projectId: `empty-midi-${crypto.randomUUID()}` })
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.removeMany') throw new TypeError('network unavailable')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    await recording.controller.stopRecording()

    expect(await readSharedOutboxSummary(recording.projectId, 'user-1')).toEqual({ pending: 1, failed: 0 })
    expect(recording.provisional.at(-1)).toBeNull()
    expect(recording.notifications).toContain('Empty MIDI recording cleanup was queued and will retry when sync resumes.')
    recording.dispose()
  })

  test('clears the mutation guard after a permanently rejected empty cloud take deletion', async () => {
    const recording = createHarness()
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.removeMany') return json({ error: 'forbidden' }, 403)
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    await recording.controller.stopRecording()

    expect(recording.provisional.at(-1)).toBeNull()
    expect(recording.notifications).toContain('Empty MIDI recording could not be removed from this project.')
    recording.dispose()
  })

  test('rolls back and reports a permanently rejected cloud final checkpoint without history', async () => {
    const recording = createHarness()
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.setMidiAndTiming') return json({ error: 'forbidden' }, 403)
      if (operation.kind === 'clips.removeMany') return json({ ok: true })
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard', 0))
    await recording.controller.stopRecording()

    expect(recording.operations.map((operation) => operation.kind)).toEqual([
      'tracks.lock', 'clips.create', 'clips.setMidiAndTiming', 'clips.removeMany', 'tracks.unlock',
    ])
    expect(recording.history).toHaveLength(0)
    expect(recording.provisional.at(-1)).toBeNull()
    expect(recording.notifications).toContain('MIDI recording could not be saved to this project.')
    recording.dispose()
  })

  test('retains provisional protection when final rollback cannot delete the clip', async () => {
    const recording = createHarness()
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.setMidiAndTiming') return json({ error: 'forbidden' }, 403)
      if (operation.kind === 'clips.removeMany') throw new TypeError('network unavailable')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard', 0))
    await recording.controller.stopRecording()

    expect(recording.provisional.at(-1)).toBe('clip-1')
    expect(recording.history).toHaveLength(0)
    recording.dispose()
  })

  test('resolves lock loss locally without forbidden final persistence or a guarded take', async () => {
    const recording = createHarness()
    let lockCount = 0
    let finishHeartbeat: (() => void) | undefined
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock') {
        lockCount += 1
        if (lockCount === 1) return json({ ok: true })
        return new Promise<Response>((resolve) => {
          finishHeartbeat = () => { resolve(json({ ok: false, reason: 'lost' })) }
        })
      }
      if (operation.kind === 'clips.create') return json('clip-1')
      if (operation.kind === 'clips.setMidiAndTiming' || operation.kind === 'clips.removeMany' || operation.kind === 'tracks.unlock') {
        return json({ error: 'forbidden' }, 403)
      }
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard', 0))
    const heartbeat = Reflect.get(globalThis, '__midiRecordingHeartbeat')
    if (typeof heartbeat !== 'function') throw new Error('Heartbeat was not registered.')
    heartbeat()
    await flush()
    if (!finishHeartbeat) throw new Error('Heartbeat did not begin.')
    finishHeartbeat()
    await flush()
    recording.emit(noteOn('keyboard', 1_000))
    await flush()

    expect(recording.operations.map((operation) => operation.kind)).toEqual([
      'tracks.lock', 'clips.create', 'tracks.lock',
    ])
    expect(recording.history).toHaveLength(0)
    expect(recording.provisional.at(-1)).toBeNull()
    expect(recording.removed.at(-1)).toEqual(['clip-1'])
    expect(recording.notifications).toContain('MIDI recording could not be saved because the track lock was lost.')
    expect(recording.controller.isRecording()).toBe(false)
    recording.dispose()
  })

  test('keeps a take running when one of multiple participating sources resets', async () => {
    let connectedSources = ['keyboard-a', 'keyboard-b']
    const recording = createHarness({
      inputs: () => connectedSources.map((id) => ({ id, selected: true, connected: true })),
    })
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock' || operation.kind === 'clips.setMidiAndTiming') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard-a', 0))
    recording.emit(noteOn('keyboard-b', 0))
    connectedSources = ['keyboard-b']
    recording.reset('keyboard-a')
    await flush()
    expect(recording.controller.isRecording()).toBe(true)

    connectedSources = []
    recording.reset('keyboard-b')
    await recording.controller.stopRecording()
    expect(recording.controller.isRecording()).toBe(false)
    expect(recording.operations.filter((operation) => operation.kind === 'clips.setMidiAndTiming')).toHaveLength(1)
    recording.dispose()
  })

  test('joins concurrent stop calls into one finalization and lock release', async () => {
    const recording = createHarness()
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock' || operation.kind === 'clips.setMidiAndTiming') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)

    await recording.controller.startRecording()
    recording.emit(noteOn('keyboard', 0))
    await Promise.all([recording.controller.stopRecording(), recording.controller.stopRecording()])

    expect(recording.operations.filter((operation) => operation.kind === 'clips.setMidiAndTiming')).toHaveLength(1)
    expect(recording.operations.filter((operation) => operation.kind === 'tracks.unlock')).toHaveLength(1)
    recording.dispose()
  })

  test('refuses looped starts and snapshots BPM at take start', async () => {
    const looped = createHarness({ loopEnabled: true })
    await expect(looped.controller.startRecording()).resolves.toBe(false)
    expect(looped.notifications).toEqual(['Disable looping before recording MIDI.'])
    looped.dispose()

    let bpm = 60
    const recording = createHarness({ bpm: () => bpm })
    setFetch((operation) => {
      if (operation.kind === 'tracks.lock' || operation.kind === 'tracks.unlock' || operation.kind === 'clips.setMidiAndTiming') return json({ ok: true })
      if (operation.kind === 'clips.create') return json('clip-1')
      throw new Error(`Unexpected ${operation.kind}`)
    }, recording.operations)
    await recording.controller.startRecording()
    bpm = 240
    recording.emit(noteOn('keyboard', 0))
    recording.emit(noteOff('keyboard', 1_000))
    await recording.controller.stopRecording()

    const final = recording.operations.find((operation) => operation.kind === 'clips.setMidiAndTiming')
    expect(final?.payload.midi).toEqual(expect.objectContaining({
      notes: [expect.objectContaining({ length: 1 })],
    }))
    recording.dispose()
  })
})
