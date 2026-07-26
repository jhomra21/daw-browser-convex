import { expect, test } from 'bun:test'

import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { convexApi, convexClient } from '~/lib/convex'
import { saveHistory } from '~/lib/timeline-storage'

import { execRedo, execUndo } from './exec'
import type { HistoryEntry } from './types'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const track = (): Track => ({
  id: 'track-1',
  historyRef: 'track-ref-1',
  name: 'Track 1',
  volume: 0.8,
  clips: [],
  muted: false,
  soloed: false,
  kind: 'audio',
  channelRole: 'track',
  sends: [],
})

const actions = (inserted: Track['clips']) => ({
  insertLocalTrack: () => {},
  removeLocalTrack: () => {},
  insertLocalClip: (_trackId: string, clip: Track['clips'][number]) => { inserted.push(clip) },
  replaceLocalClip: () => {},
  removeLocalClips: () => {},
  commitClipMoves: () => {},
  commitClipTiming: () => {},
  commitClipAudioWarp: () => {},
  commitClipFades: () => {},
  rescheduleChangedClips: () => {},
  cancelTrackVolumeWrite: () => {},
  cancelTrackRoutingWrite: () => {},
  cancelTrackMixWrite: () => {},
  applyTrackVolume: () => {},
  applyTrackMixState: () => {},
  applyTrackRouting: () => {},
  applyTrackPatch: () => {},
  applyAutomationEnvelope: () => {},
})

const deps = (
  projectId: string,
  history: HistoryEntry[],
  inserted: Track['clips'],
): Parameters<typeof execUndo>[1] => ({
  convexClient,
  convexApi,
  getTracks: () => [track()],
  getHistoryEntries: () => history,
  projectId,
  userId: 'user-1',
  persistLocalMix: () => {},
  audioEngine: new AudioEngine(),
  grantTrackWrite: () => {},
  grantClipWrite: () => {},
  actions: actions(inserted),
})

test('legacy persisted cloud clip deletes recreate through the strict sanitized create endpoint', async () => {
  const projectId = 'project-cloud-legacy-delete'
  const entry: Extract<HistoryEntry, { type: 'clip-delete' }> = {
    type: 'clip-delete',
    projectId,
    data: {
      legacyRecreate: true,
      items: [{
        trackRef: 'track-ref-1',
        clip: {
          clipRef: 'clip-ref-1',
          startSec: 0,
          duration: 1,
          midi: {
            wave: 'custom-legacy',
            gain: 7,
            notes: Array.from({ length: 501 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
          },
        },
      }],
    },
  }
  const inserted: Track['clips'] = []
  let published: unknown
  const originalFetch = globalThis.fetch
  const replayFetch: typeof globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      published = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
      return new Response(JSON.stringify('restored-clip-1'), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = replayFetch
  try {
    await execUndo(entry, deps(projectId, [entry], inserted))
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(published).toMatchObject({
    kind: 'clips.create',
    payload: {
      trackId: 'track-1',
      clipKind: 'midi',
      midi: { wave: 'sine' },
    },
  })
  if (
    !published
    || typeof published !== 'object'
    || !('payload' in published)
    || typeof published.payload !== 'object'
    || published.payload === null
    || !('midi' in published.payload)
    || typeof published.payload.midi !== 'object'
    || published.payload.midi === null
    || !('notes' in published.payload.midi)
    || !Array.isArray(published.payload.midi.notes)
  ) throw new Error('Expected sanitized MIDI create operation.')
  expect(published.payload.midi.notes).toHaveLength(500)
  expect(published.payload.midi).not.toHaveProperty('gain')
  expect(inserted[0]?.id).toBe('restored-clip-1')
})

test('merges persisted queued deletion recoveries before reporting an in-memory recovery as missing', async () => {
  const projectId = 'project-cloud-persisted-recovery'
  const operationId = 'queued-delete-1'
  const recoveryId = 'recovery-1'
  const inMemoryEntry: Extract<HistoryEntry, { type: 'clip-delete' }> = {
    type: 'clip-delete',
    projectId,
    data: {
      items: [{
        trackRef: 'track-ref-1',
        clip: {
          clipRef: 'clip-ref-1',
          startSec: 0,
          duration: 1,
          recoveryOperationId: operationId,
          recoverySourceClipId: 'source-clip-1',
        },
      }],
    },
  }
  const persistedEntry: Extract<HistoryEntry, { type: 'clip-delete' }> = {
    ...inMemoryEntry,
    data: {
      items: [{
        ...inMemoryEntry.data.items[0],
        clip: {
          ...inMemoryEntry.data.items[0].clip,
          recoveryId,
        },
      }],
    },
  }
  const previousWindow = globalThis.window
  const previousLocalStorage = globalThis.localStorage
  const storage = new MemoryStorage()
  const originalMutation = Reflect.get(convexClient, 'mutation')
  const mutationCalls: unknown[] = []
  Reflect.set(globalThis, 'window', {
    localStorage: storage,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  })
  Reflect.set(globalThis, 'localStorage', storage)
  Reflect.set(convexClient, 'mutation', async (_reference: unknown, args: unknown) => {
    mutationCalls.push(args)
    return { status: 'applied', clipId: 'restored-clip-1' }
  })
  saveHistory({ projectId, userId: 'user-1' }, { undo: [persistedEntry], redo: [] })

  const inserted: Track['clips'] = []
  try {
    await execUndo(inMemoryEntry, deps(projectId, [inMemoryEntry], inserted))
  } finally {
    Reflect.set(convexClient, 'mutation', originalMutation)
    Reflect.set(globalThis, 'window', previousWindow)
    Reflect.set(globalThis, 'localStorage', previousLocalStorage)
  }

  expect(inMemoryEntry.data.items[0]?.clip.recoveryId).toBe(recoveryId)
  expect(mutationCalls).toEqual([{ recoveryId }])
  expect(inserted[0]?.id).toBe('restored-clip-1')
})

test('retries a response-lost clip deletion with its original operation ID', async () => {
  const projectId = 'project-cloud-delete-retry'
  const entry: Extract<HistoryEntry, { type: 'clip-delete' }> = {
    type: 'clip-delete',
    projectId,
    data: {
      items: [{
        trackRef: 'track-ref-1',
        clip: { clipRef: 'clip-ref-1', startSec: 0, duration: 1 },
      }],
      recreatedClips: [{ clipRef: 'clip-ref-1', clipId: 'clip-1' }],
    },
  }
  const originalMutation = Reflect.get(convexClient, 'mutation')
  const operationIds: string[] = []
  let responseLost = true
  Reflect.set(convexClient, 'mutation', async (_reference: unknown, args: unknown) => {
    if (
      !args
      || typeof args !== 'object'
      || !('operationId' in args)
      || typeof args.operationId !== 'string'
    ) throw new Error('Expected delete operation ID.')
    operationIds.push(args.operationId)
    if (responseLost) throw new Error('Response lost after deletion.')
    return {
      removedClipIds: ['clip-1'],
      recoveries: [{ sourceClipId: 'clip-1', recoveryId: 'recovery-1' }],
      skippedClipIds: [],
      skipped: [],
    }
  })
  try {
    await expect(execRedo(entry, deps(projectId, [entry], []))).rejects.toThrow('Response lost')
    const retainedOperationId = entry.data.deleteOperationId
    expect(retainedOperationId).toBeString()
    if (!retainedOperationId) throw new Error('Expected pending deletion operation ID.')
    responseLost = false
    await execRedo(entry, deps(projectId, [entry], []))
    expect(operationIds).toEqual([retainedOperationId, retainedOperationId])
    expect(entry.data.deleteOperationId).toBeUndefined()
  } finally {
    Reflect.set(convexClient, 'mutation', originalMutation)
  }
})
