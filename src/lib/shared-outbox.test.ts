import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { AUDIO_EFFECT_CONTRACTS, type JsonValue } from '@daw-browser/shared'
import { z } from 'zod'
import { openLocalProjectDb } from './local-project-db'
import * as outbox from './shared-outbox'
import type { SharedTimelineOperation } from './shared-timeline-operations-api'
import {
  attachClipDeletionRecoveriesToHistory,
  flushPendingSharedOutboxHistoryUpdates,
  flushSharedOutbox,
  flushSharedOutboxOperation,
  publishDurableSharedTimelineOperation,
  recoverStaleSharedOutboxClaims,
  registerSharedOutboxHistoryHandler,
  SharedOutboxUnavailableError,
  setSharedOutboxRuntimeForTesting,
} from './shared-outbox'

const parseRequestBody = (init: RequestInit | undefined): JsonValue => (
  JSON.parse(init?.body?.toString() ?? 'null')
)
const volumeOperationSchema = z.object({
  payload: z.object({ volume: z.number() }),
})
const midiOperationSchema = z.object({
  payload: z.object({
    midi: z.object({
      notes: z.array(z.json()),
    }),
  }),
})

const createRetryFileStorage = () => {
  const files = new Map<string, File>()
  let failRemoval = false
  const assets = {
    getFileHandle: async (name: string) => ({
      getFile: async () => files.get(name),
    }),
    removeEntry: async (name: string) => {
      if (failRemoval) throw new Error('retry file cleanup unavailable')
      files.delete(name)
    },
  }
  const projects = new Map<string, { getDirectoryHandle: (name: string) => Promise<typeof assets> }>()
  const storageRoot = {
    getDirectoryHandle: async (projectId: string) => {
      const project = projects.get(projectId) ?? {
        getDirectoryHandle: async (name: string) => {
          if (name !== 'assets') throw new Error(`Unexpected directory: ${name}`)
          return assets
        },
      }
      projects.set(projectId, project)
      return project
    },
  }
  return {
    files,
    storage: { getDirectory: async () => storageRoot },
    setFailRemoval: (value: boolean) => { failRemoval = value },
  }
}

const uploadedAudioEntry = (projectId: string, userId: string, id: string, timestamp: number) => ({
  id,
  kind: 'clips.createUploadedAudio',
  projectId,
  userId,
  payload: {
    projectId,
    assetKey: 'asset-1',
    materializedPath: 'outbox-source.bin',
    fileName: 'clip.wav',
    mimeType: 'audio/wav',
    duration: 1,
    clipPayload: {
      trackId: 'track-1',
      startSec: 0,
      duration: 1,
      assetKey: 'asset-1',
      sourceKind: 'upload',
      durationSec: 1,
      sampleRate: 48_000,
      channelCount: 2,
      clipKind: 'audio',
      operationId: id,
    },
  },
  status: 'pending',
  attempts: 0,
  nextAttemptAt: timestamp,
  sequence: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
})

test('sanitizes legacy queued MIDI through the strict endpoint and continues with later operations', async () => {
  const projectId = `outbox-replay-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  const entries = [
    {
      id: 'legacy-midi',
      kind: 'clips.create',
      projectId,
      userId,
      payload: {
        trackId: 'track-1',
        startSec: 0,
        duration: 1,
        clipKind: 'midi',
        midi: {
          wave: 'custom-legacy',
          gain: 7,
          notes: Array.from({ length: 501 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
        },
      },
    },
    {
      id: 'next-operation',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
    },
  ]
  await Promise.all(entries.map((entry, index) => db.put('syncState', {
    key: `shared-outbox:${entry.id}`,
    value: {
      ...entry,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp + index,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })))

  const requests: Array<{ url: string; operation: unknown }> = []
  const originalFetch = globalThis.fetch
  const replayFetch: typeof globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [input, init] = arguments_
      requests.push({
        url: String(input),
        operation: parseRequestBody(init),
      })
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = replayFetch
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 0 })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(requests).toHaveLength(2)
  expect(requests.map((request) => request.url)).toEqual([
    `/api/projects/${encodeURIComponent(projectId)}/timeline/operations`,
    `/api/projects/${encodeURIComponent(projectId)}/timeline/operations`,
  ])
  expect(requests[0]?.operation).toMatchObject({
    kind: 'clips.create',
    payload: {
      trackId: 'track-1',
      startSec: 0,
      duration: 1,
      clipKind: 'midi',
      midi: { wave: 'sine' },
    },
  })
  const firstOperation = midiOperationSchema.safeParse(requests[0]?.operation)
  if (!firstOperation.success) throw new Error('Expected sanitized queued MIDI payload.')
  expect(firstOperation.data.payload.midi.notes).toHaveLength(500)
  expect(firstOperation.data.payload.midi).not.toHaveProperty('gain')
  expect(requests[1]?.operation).toEqual({
    kind: 'tracks.setVolume',
    payload: { trackId: 'track-1', volume: 0.5 },
  })
  expect(await db.get('syncState', 'shared-outbox:legacy-midi')).toBeUndefined()
})

test('migrates legacy queued clip deletion operation IDs before publishing and retains them on retry', async () => {
  const projectId = `outbox-delete-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:legacy-delete',
    value: {
      id: 'legacy-delete',
      kind: 'clips.removeMany',
      projectId,
      userId,
      payload: { clipIds: ['clip-1'] },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const requests: unknown[] = []
  let historyReady = false
  let attachedRecoveryId: string | undefined
  const unregisterHistory = registerSharedOutboxHistoryHandler((update) => {
    if (
      update.kind !== 'clip-deletion-recoveries'
      || update.projectId !== projectId
      || !historyReady
    ) return false
    attachedRecoveryId = update.recoveryIdsBySourceClipId.get('clip-1')
    return true
  })
  const originalFetch = globalThis.fetch
  let fail = true
  const replayFetch: typeof globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      requests.push(parseRequestBody(init))
      if (fail) return new Response('retry', { status: 500 })
      return new Response(JSON.stringify({
        removedClipIds: ['clip-1'],
        recoveries: [{ sourceClipId: 'clip-1', recoveryId: 'recovery-1' }],
        skippedClipIds: [],
        skipped: [],
      }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = replayFetch
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 1 })
    const retained = await db.get('syncState', 'shared-outbox:legacy-delete')
    expect(retained?.value).toMatchObject({
      payload: { clipIds: ['clip-1'], operationId: 'outbox:legacy-delete' },
    })
    fail = false
    expect(await flushSharedOutbox(projectId, userId, { retryFailed: true })).toEqual({ pending: 0, failed: 0 })
    expect(attachedRecoveryId).toBeUndefined()
    historyReady = true
    flushPendingSharedOutboxHistoryUpdates()
  } finally {
    unregisterHistory()
    globalThis.fetch = originalFetch
  }
  expect(attachedRecoveryId).toBe('recovery-1')
  expect(requests).toEqual([
    { kind: 'clips.removeMany', payload: { clipIds: ['clip-1'], operationId: 'outbox:legacy-delete' } },
    { kind: 'clips.removeMany', payload: { clipIds: ['clip-1'], operationId: 'outbox:legacy-delete' } },
  ])
})

test('migrates legacy queued track creation IDs before a response-loss retry', async () => {
  const projectId = `outbox-track-create-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:legacy-track',
    value: {
      id: 'legacy-track',
      kind: 'tracks.create',
      projectId,
      userId,
      payload: { name: 'Recovered track', index: 0, kind: 'audio', channelRole: 'track', collapsed: false },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const requests: unknown[] = []
  const originalFetch = globalThis.fetch
  let responseLost = true
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      requests.push(parseRequestBody(init))
      return responseLost
        ? new Response('response lost', { status: 500 })
        : new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
    expect((await db.get('syncState', 'shared-outbox:legacy-track'))?.value).toMatchObject({
      payload: { operationId: 'outbox:legacy-track' },
    })
    responseLost = false
    await flushSharedOutbox(projectId, userId, { retryFailed: true })
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(requests).toEqual([
    expect.objectContaining({ kind: 'tracks.create', payload: expect.objectContaining({ operationId: 'outbox:legacy-track' }) }),
    expect.objectContaining({ kind: 'tracks.create', payload: expect.objectContaining({ operationId: 'outbox:legacy-track' }) }),
  ])
})

test('queues newer durable operations behind an existing backlog and replays them in order', async () => {
  const projectId = `outbox-order-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:volume-0',
    value: {
      id: 'volume-0',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  const volumes: number[] = []
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      const operation = volumeOperationSchema.parse(parseRequestBody(init))
      volumes.push(operation.payload.volume)
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'tracks.setVolume', payload: { trackId: 'track-1', volume: 0.8 } },
    })
    await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'tracks.setVolume', payload: { trackId: 'track-1', volume: 0.9 } },
    })
    expect(volumes).toEqual([0.5, 0.8, 0.9])
    await flushSharedOutbox(projectId, userId)
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(volumes).toEqual([0.5, 0.8, 0.9])
})

test('dead-letters a rejected operation and continues with later FIFO rows', async () => {
  const projectId = `outbox-rejected-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:rejected',
    value: {
      id: 'rejected',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  const volumes: number[] = []
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      const operation = volumeOperationSchema.parse(parseRequestBody(init))
      if (operation.payload.volume === 0.5) {
        return new Response(JSON.stringify({ status: 'rejected', reason: 'Track was deleted.' }), { status: 200 })
      }
      volumes.push(operation.payload.volume)
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  await db.put('syncState', {
    key: 'shared-outbox:later',
    value: {
      id: 'later',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.8 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp + 1,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 1 })
  } finally {
    globalThis.fetch = originalFetch
  }
  expect((await db.get('syncState', 'shared-outbox:rejected'))?.value).toMatchObject({
    status: 'dead-letter',
    lastError: 'Permanent failure: Track was deleted.',
  })
  expect(volumes).toEqual([0.8])
})

test('serializes concurrent flushes for one project and user', async () => {
  const projectId = `outbox-concurrent-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:once',
    value: {
      id: 'once',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1
      await Promise.resolve()
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await Promise.all([flushSharedOutbox(projectId, userId), flushSharedOutbox(projectId, userId)])
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(requests).toBe(1)
})

test('dead-letters HTTP 400 failures without blocking later rows', async () => {
  const projectId = `outbox-http-400-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  for (const [id, volume] of [['invalid', 0.5], ['later', 0.8]] as const) {
    await db.put('syncState', {
      key: `shared-outbox:${id}`,
      value: {
        id,
        kind: 'tracks.setVolume',
        projectId,
        userId,
        payload: { trackId: 'track-1', volume },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    })
  }
  const originalFetch = globalThis.fetch
  const published: number[] = []
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      const operation = volumeOperationSchema.parse(parseRequestBody(init))
      if (operation.payload.volume === 0.5) return new Response('invalid track', { status: 400 })
      published.push(operation.payload.volume)
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
  } finally {
    globalThis.fetch = originalFetch
  }
  expect((await db.get('syncState', 'shared-outbox:invalid'))?.value).toMatchObject({
    status: 'dead-letter',
    lastError: 'Permanent failure: Shared timeline operation failed: 400 invalid track',
  })
  expect(published).toEqual([0.8])
})

test('dead-letters uploaded audio clip creates with null results before completion', async () => {
  const projectId = `outbox-upload-null-${crypto.randomUUID()}`
  const userId = 'user-1'
  const operationId = 'uploaded-audio'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: `shared-outbox:${operationId}`,
    value: {
      id: operationId,
      kind: 'clips.createUploadedAudio',
      projectId,
      userId,
      payload: {
        projectId,
        assetKey: 'asset-1',
        file: new File(['audio'], 'clip.wav', { type: 'audio/wav' }),
        duration: 1,
        clipPayload: {
          trackId: 'track-1',
          startSec: 0,
          duration: 1,
          assetKey: 'asset-1',
          sourceKind: 'upload',
          durationSec: 1,
          sampleRate: 48_000,
          channelCount: 2,
          clipKind: 'audio',
          operationId,
        },
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      sequence: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })

  const originalFetch = globalThis.fetch
  const uploadUrls: string[] = []
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/samples?projectId=')) {
        uploadUrls.push(url)
        return new Response(JSON.stringify({ url: 'https://example.test/clip.wav', assetKey: 'asset-1' }), { status: 200 })
      }
      return new Response(JSON.stringify(null), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
  } finally {
    globalThis.fetch = originalFetch
  }

  expect((await db.get('syncState', `shared-outbox:${operationId}`))?.value).toMatchObject({
    status: 'dead-letter',
    attempts: 1,
    lastError: 'Permanent failure: Clip creation was rejected.',
  })
  expect(uploadUrls).toEqual([`/api/samples?projectId=${encodeURIComponent(projectId)}`])
  expect(await db.get('syncState', `shared-outbox-completion:${projectId}:${userId}:${operationId}`)).toBeUndefined()
})

test('records uploaded clip completion before retry-file cleanup and retries cleanup independently', async () => {
  const projectId = `outbox-cleanup-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  const storage = createRetryFileStorage()
  storage.files.set('outbox-source.bin', new File(['audio'], 'outbox-source.bin', { type: 'audio/wav' }))
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage.storage })
  await db.put('syncState', {
    key: 'shared-outbox:uploaded-audio',
    value: uploadedAudioEntry(projectId, userId, 'uploaded-audio', timestamp),
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  let publicationRequests = 0
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      publicationRequests += 1
      if (String(input).startsWith('/api/samples?')) {
        return new Response(JSON.stringify({ assetKey: 'asset-1', url: 'https://example.test/asset-1.wav' }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  storage.setFailRemoval(true)
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 0 })
    expect(publicationRequests).toBe(2)
    expect((await db.get('syncState', 'shared-outbox:uploaded-audio'))?.value).toMatchObject({
      status: 'completed',
      retryFileCleanup: { storagePath: 'outbox-source.bin' },
      lastError: 'retry file cleanup unavailable',
    })
    expect(await db.get('syncState', `shared-outbox-completion:${projectId}:${userId}:uploaded-audio`)).toBeDefined()

    storage.setFailRemoval(false)
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 0 })
    expect(publicationRequests).toBe(2)
    expect(await db.get('syncState', 'shared-outbox:uploaded-audio')).toBeUndefined()
    expect(storage.files.has('outbox-source.bin')).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
})

test('resumes completed uploaded clip cleanup after a crash without republishing', async () => {
  const projectId = `outbox-cleanup-crash-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  const storage = createRetryFileStorage()
  storage.files.set('outbox-source.bin', new File(['audio'], 'outbox-source.bin', { type: 'audio/wav' }))
  const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage.storage })
  await db.put('syncState', {
    key: 'shared-outbox:uploaded-audio',
    value: {
      ...uploadedAudioEntry(projectId, userId, 'uploaded-audio', timestamp),
      status: 'completed',
      retryFileCleanup: { projectId, storagePath: 'outbox-source.bin' },
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 0, failed: 0 })
  } finally {
    globalThis.fetch = originalFetch
    if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage)
    else Reflect.deleteProperty(navigator, 'storage')
  }
  expect(requests).toBe(0)
  expect(await db.get('syncState', 'shared-outbox:uploaded-audio')).toBeUndefined()
  expect(storage.files.has('outbox-source.bin')).toBe(false)
})

test('assigns a durable FIFO sequence before publishing same-millisecond admissions', async () => {
  const projectId = `outbox-sequence-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const originalFetch = globalThis.fetch
  let releaseFirst: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    globalThis.fetch = Object.assign(
      async (...arguments_: Parameters<typeof globalThis.fetch>) => {
        const [, init] = arguments_
        const operation = volumeOperationSchema.parse(parseRequestBody(init))
        if (operation.payload.volume === 0.5) {
          resolve()
          await new Promise<void>((release) => { releaseFirst = release })
        }
        return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    )
  })
  const first = publishDurableSharedTimelineOperation({
    projectId,
    userId,
    operation: { kind: 'tracks.setVolume', payload: { trackId: 'track-1', volume: 0.5 } },
  })
  await firstStarted
  const second = publishDurableSharedTimelineOperation({
    projectId,
    userId,
    operation: { kind: 'tracks.setVolume', payload: { trackId: 'track-1', volume: 0.8 } },
  })
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  const rows = await db.getAll('syncState')
  const entries = rows
    .filter((row) => row.key.startsWith('shared-outbox:'))
    .map((row) => row.value)
    .filter((value): value is { sequence: number } => (
      typeof value === 'object' && value !== null && 'sequence' in value && typeof value.sequence === 'number'
    ))
    .sort((left, right) => left.sequence - right.sequence)
  expect(entries.map((entry) => entry.sequence)).toEqual([1, 2])
  releaseFirst?.()
  await Promise.all([first, second])
  globalThis.fetch = originalFetch
})

test('requires explicit stale-claim recovery when Web Locks are unavailable', async () => {
  const projectId = `outbox-expired-lease-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:expired',
    value: {
      id: 'expired',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      sequence: 1,
      claimOwner: 'crashed-context',
      claimToken: 'stale-token',
      leaseExpiresAt: timestamp - 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: undefined } })
    await expect(flushSharedOutbox(projectId, userId)).rejects.toBeInstanceOf(SharedOutboxUnavailableError)
    expect(requests).toBe(0)
    await recoverStaleSharedOutboxClaims(projectId, userId)
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: { request: async <T>(_name: string, callback: () => Promise<T>) => await callback() } },
    })
    await flushSharedOutbox(projectId, userId)
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    globalThis.fetch = originalFetch
  }
  expect(requests).toBe(1)
  expect(await db.get('syncState', 'shared-outbox:expired')).toBeUndefined()
})

test('uses the project-user Web Lock before recovering an expired publication claim', async () => {
  const projectId = `outbox-web-lock-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:expired',
    value: {
      id: 'expired',
      kind: 'tracks.setVolume',
      projectId,
      userId,
      payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: timestamp,
      sequence: 1,
      claimOwner: 'crashed-context',
      claimToken: 'stale-token',
      leaseExpiresAt: timestamp - 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalNavigator = globalThis.navigator
  const originalFetch = globalThis.fetch
  const lockNames: string[] = []
  Reflect.set(globalThis, 'navigator', {
    locks: {
      request: async <T>(name: string, callback: () => Promise<T>) => {
        lockNames.push(name)
        return await callback()
      },
    },
  })
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({ status: 'applied' }), { status: 200 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
  } finally {
    Reflect.set(globalThis, 'navigator', originalNavigator)
    globalThis.fetch = originalFetch
  }
  expect(lockNames).toEqual([`daw-browser:shared-outbox:${projectId}:${userId}`])
  expect(await db.get('syncState', 'shared-outbox:expired')).toBeUndefined()
})

test('retains authentication failures for reauthentication and preserves FIFO', async () => {
  const projectId = `outbox-auth-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  for (const [id, volume] of [['auth', 0.5], ['later', 0.8]] as const) {
    await db.put('syncState', {
      key: `shared-outbox:${id}`,
      value: {
        id, kind: 'tracks.setVolume', projectId, userId, payload: { trackId: 'track-1', volume },
        status: 'pending', attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
      },
      updatedAt: timestamp,
    })
  }
  const originalFetch = globalThis.fetch
  const published: number[] = []
  let authenticated = false
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const [, init] = arguments_
      const operation = volumeOperationSchema.parse(parseRequestBody(init))
      if (!authenticated) return new Response('authentication required', { status: 401 })
      published.push(operation.payload.volume)
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    expect(await flushSharedOutbox(projectId, userId)).toEqual({ pending: 1, failed: 1 })
    expect(published).toEqual([])
    expect((await db.get('syncState', 'shared-outbox:auth'))?.value).toMatchObject({ status: 'failed' })
    authenticated = true
    expect(await flushSharedOutbox(projectId, userId, { retryFailed: true })).toEqual({ pending: 0, failed: 0 })
  } finally {
    globalThis.fetch = originalFetch
  }
  expect(published).toEqual([0.5, 0.8])
})

test('renews an active lease before it expires', async () => {
  const projectId = `outbox-heartbeat-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  let timestamp = 0
  let heartbeat: (() => void) | undefined
  setSharedOutboxRuntimeForTesting({
    now: () => timestamp,
    schedule: (callback) => {
      heartbeat = callback
      const handle = setTimeout(() => undefined, 60_000)
      clearTimeout(handle)
      return handle
    },
    cancel: () => undefined,
  })
  await db.put('syncState', {
    key: 'shared-outbox:active',
    value: {
      id: 'active', kind: 'tracks.setVolume', projectId, userId,
      payload: { trackId: 'track-1', volume: 0.5 }, status: 'pending',
      attempts: 0, nextAttemptAt: 0, sequence: 1, createdAt: 0, updatedAt: 0,
    },
    updatedAt: 0,
  })
  const originalFetch = globalThis.fetch
  let release: (() => void) | undefined
  let started!: () => void
  const publishing = new Promise<void>((resolve) => { started = resolve })
  globalThis.fetch = Object.assign(
    async () => {
      started()
      await new Promise<void>((resolve) => { release = resolve })
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    const flushing = flushSharedOutbox(projectId, userId)
    await publishing
    timestamp = 15_000
    heartbeat?.()
    await Promise.resolve()
    await Promise.resolve()
    expect((await db.get('syncState', 'shared-outbox:active'))?.value).toMatchObject({
      leaseExpiresAt: 45_000,
    })
    release?.()
    await flushing
  } finally {
    setSharedOutboxRuntimeForTesting(undefined)
    globalThis.fetch = originalFetch
  }
})

test('reads a persisted completion when a background drain consumed the target row', async () => {
  const projectId = `outbox-completion-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:target',
    value: {
      id: 'target', kind: 'tracks.setVolume', projectId, userId,
      payload: { trackId: 'track-1', volume: 0.5 }, status: 'pending',
      attempts: 0, nextAttemptAt: timestamp, sequence: 1, createdAt: timestamp, updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({ status: 'applied' }), { status: 200 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
    expect(await flushSharedOutboxOperation(projectId, userId, 'target')).toEqual({
      status: 'applied',
      result: { status: 'applied' },
      completionOwner: 'background',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('does not consume a completion stored for another user', async () => {
  const projectId = `outbox-completion-scope-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: `shared-outbox-completion:${projectId}:user-a:target`,
    value: {
      result: { status: 'applied' },
      createdAt: timestamp,
      expiresAt: timestamp + 60_000,
      completionOwner: 'background',
    },
    updatedAt: timestamp,
  })

  expect(await flushSharedOutboxOperation(projectId, 'user-b', 'target')).toEqual({ status: 'missing' })
})

test('stops the current drain after lease ownership is lost', async () => {
  const projectId = `outbox-lease-loss-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = 0
  setSharedOutboxRuntimeForTesting({ now: () => timestamp })
  for (const [id, volume] of [['first', 0.5], ['second', 0.8]] as const) {
    await db.put('syncState', {
      key: `shared-outbox:${id}`,
      value: {
        id,
        kind: 'tracks.setVolume',
        projectId,
        userId,
        payload: { trackId: 'track-1', volume },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: timestamp,
        sequence: volume === 0.5 ? 1 : 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      updatedAt: timestamp,
    })
  }
  const originalFetch = globalThis.fetch
  let releaseFirst: (() => void) | undefined
  let requests = 0
  const firstStarted = new Promise<void>((resolve) => {
    globalThis.fetch = Object.assign(
      async (...arguments_: Parameters<typeof globalThis.fetch>) => {
        requests += 1
        const [, init] = arguments_
        const operation = volumeOperationSchema.parse(parseRequestBody(init))
        if (operation.payload.volume === 0.5) {
          resolve()
          await new Promise<void>((release) => { releaseFirst = release })
        }
        return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    )
  })
  try {
    const flushing = flushSharedOutbox(projectId, userId)
    await firstStarted
    const claimed = await db.get('syncState', 'shared-outbox:first')
    const parsedClaimedValue = z.record(
      z.string(),
      z.union([z.json(), z.undefined()]),
    ).safeParse(claimed?.value)
    if (!claimed || !parsedClaimedValue.success) {
      throw new Error('Expected first outbox row to be claimed.')
    }
    await db.put('syncState', {
      ...claimed,
      value: { ...parsedClaimedValue.data, claimOwner: 'other-context', claimToken: 'other-token' },
      updatedAt: timestamp,
    })
    releaseFirst?.()
    await flushing
  } finally {
    setSharedOutboxRuntimeForTesting(undefined)
    globalThis.fetch = originalFetch
  }
  expect((await db.get('syncState', 'shared-outbox:first'))?.value).toMatchObject({ claimOwner: 'other-context' })
  expect((await db.get('syncState', 'shared-outbox:second'))?.value).toMatchObject({ status: 'pending' })
  expect(requests).toBe(1)
})

test('returns a terminal rejection instead of pending for a targeted dead-letter', async () => {
  const projectId = `outbox-terminal-${crypto.randomUUID()}`
  const userId = 'user-1'
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => new Response('forbidden', { status: 403 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await expect(publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'tracks.setVolume', payload: { trackId: 'track-1', volume: 0.5 } },
    })).rejects.toThrow('Permanent failure: Shared timeline operation failed: 403 forbidden')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('caller-owned foreground completion does not publish background history', async () => {
  const projectId = `outbox-caller-completion-${crypto.randomUUID()}`
  const userId = 'user-1'
  let historyUpdates = 0
  const unregister = registerSharedOutboxHistoryHandler((update) => {
    if (update.kind === 'entry') historyUpdates += 1
    return false
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => new Response(JSON.stringify({
      status: 'applied',
      group: { id: 'group-1', parentGroupId: undefined },
      children: [],
    }), { status: 200 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await publishDurableSharedTimelineOperation({
      projectId,
      userId,
      operation: { kind: 'tracks.ungroup', payload: { groupId: 'group-1', operationId: 'operation-1' } },
      completion: {
        kind: 'tracks.ungroup',
        tracks: [],
        groupTrack: {
          id: 'group-1',
          historyRef: 'group-1',
          name: 'Group',
          volume: 1,
          clips: [],
          muted: false,
          soloed: false,
          kind: 'audio',
          channelRole: 'group',
          sends: [],
        },
        effects: {},
        automation: [],
      },
      completionOwner: 'caller',
    })
  } finally {
    unregister()
    globalThis.fetch = originalFetch
  }
  expect(historyUpdates).toBe(0)
})

test('retains recovery operation correlation after attaching recovery IDs', () => {
  const history = {
    undo: [{
      type: 'clip-delete' as const,
      projectId: 'project-1',
      data: {
        items: [{
          trackRef: 'track-1',
          clip: {
            clipRef: 'clip-1',
            startSec: 0,
            duration: 1,
            recoveryOperationId: 'operation-1',
            recoverySourceClipId: 'source-1',
          },
        }],
      },
    }],
    redo: [],
  }
  expect(attachClipDeletionRecoveriesToHistory(history, 'operation-1', new Map([['source-1', 'recovery-1']]))).toBe(true)
  expect(history.undo[0]?.data.items[0]?.clip).toMatchObject({
    recoveryId: 'recovery-1',
    recoveryOperationId: 'operation-1',
  })
})

const utilityOperation = (instanceId = 'utility-1'): SharedTimelineOperation => ({
  kind: 'effects.setUtilityParams',
  payload: { trackId: 'track-1', instanceId, params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() },
})
const stubFetch = (respond: (body: JsonValue) => Response | Promise<Response>) => {
  const originalFetch = globalThis.fetch
  const bodies: JsonValue[] = []
  globalThis.fetch = Object.assign(
    async (...arguments_: Parameters<typeof globalThis.fetch>) => {
      const body = parseRequestBody(arguments_[1])
      bodies.push(body)
      return await respond(body)
    },
    { preconnect: originalFetch.preconnect },
  )
  return { bodies, restore: () => { globalThis.fetch = originalFetch } }
}
const typedResult = (revision: number) => ({ status: 'applied', effectId: 'effect-1', revision })
const decodedTypedResult = (revision: number) => ({
  status: 'applied',
  effectId: 'effect-1',
  revision: { kind: 'ordered', revision },
})
// What a drain in another tab leaves behind: the completion and the removed entry land in one transaction.
const settleInAnotherTab = async (
  projectId: string,
  userId: string,
  entryId: string,
  settlement: { result: JsonValue; createdAt: number } | { deadLetter: string },
) => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('syncState', 'readwrite')
  const entryKey = `shared-outbox:${entryId}`
  const current = await tx.store.get(entryKey)
  if ('deadLetter' in settlement) {
    tx.store.put({
      key: entryKey,
      value: { ...z.record(z.string(), z.unknown()).parse(current?.value), status: 'dead-letter', lastError: settlement.deadLetter, claimOwner: undefined, claimToken: undefined, leaseExpiresAt: undefined },
      updatedAt: Date.now(),
    })
  } else {
    tx.store.put({
      key: `shared-outbox-completion:${projectId}:${userId}:${entryId}`,
      value: { result: settlement.result, createdAt: settlement.createdAt, completionOwner: 'background' },
      updatedAt: Date.now(),
    })
    tx.store.delete(entryKey)
  }
  await tx.done
}

test('an effects publication returns its typed result and keeps it until the owner consumes it', async () => {
  const projectId = `outbox-effects-direct-${crypto.randomUUID()}`
  const userId = 'user-1'
  const fetchStub = stubFetch(() => new Response(JSON.stringify(typedResult(4)), { status: 200 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(published).toMatchObject({ kind: 'applied', result: decodedTypedResult(4) })
    if (published.kind !== 'applied') throw new Error('Expected a direct result.')
    // The duplicate notification: the same result is read back from the durable record, any number of times.
    const duplicate = {
      status: 'applied',
      result: decodedTypedResult(4),
      completionOwner: 'background',
    } satisfies Awaited<ReturnType<typeof outbox.readSharedOutboxOperation>>
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId)).toEqual(duplicate)
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId)).toEqual(duplicate)
    // Binding the result consumes it; consuming twice is harmless.
    await outbox.consumeSharedOutboxCompletion(projectId, userId, published.entryId)
    await outbox.consumeSharedOutboxCompletion(projectId, userId, published.entryId)
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId)).toEqual({ status: 'missing' })
  } finally {
    fetchStub.restore()
  }
})

test('no age decides whether a stored result is still the answer', async () => {
  const projectId = `outbox-effects-age-${crypto.randomUUID()}`
  const userId = 'user-1'
  const fetchStub = stubFetch(() => new Response(JSON.stringify(typedResult(2)), { status: 200 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    if (published.kind !== 'applied') throw new Error('Expected a direct result.')
    setSharedOutboxRuntimeForTesting({ now: () => Date.now() + 30 * 24 * 60 * 60 * 1000 })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId)).toMatchObject({ status: 'applied' })
    expect(await flushSharedOutboxOperation(projectId, userId, published.entryId)).toMatchObject({ status: 'applied', result: decodedTypedResult(2) })
  } finally {
    setSharedOutboxRuntimeForTesting(undefined)
    fetchStub.restore()
  }
})

test('a permanent rejection is a typed outcome and its dead letter outlives consumption', async () => {
  const projectId = `outbox-effects-rejected-${crypto.randomUUID()}`
  const userId = 'user-1'
  const fetchStub = stubFetch(() => new Response('forbidden', { status: 403 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(published).toMatchObject({ kind: 'rejected', reason: 'Permanent failure: Shared timeline operation failed: 403 forbidden' })
    if (published.kind !== 'rejected') throw new Error('Expected a rejection.')
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId))
      .toEqual({ status: 'rejected', lastError: 'Permanent failure: Shared timeline operation failed: 403 forbidden' })
    await outbox.consumeSharedOutboxCompletion(projectId, userId, published.entryId)
    const db = await openLocalProjectDb(projectId)
    expect(await db.get('syncState', `shared-outbox:${published.entryId}`)).toBeDefined()
  } finally {
    fetchStub.restore()
  }
})

test('a retryable failure is admitted and reads as pending', async () => {
  const projectId = `outbox-effects-admitted-${crypto.randomUUID()}`
  const userId = 'user-1'
  const fetchStub = stubFetch(() => new Response('unavailable', { status: 503 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(published.kind).toBe('admitted')
    if (published.kind !== 'admitted') throw new Error('Expected admission.')
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId)).toEqual({ status: 'pending' })
  } finally {
    fetchStub.restore()
  }
})

test('wakes the admitting owner when a dead letter settles behind a stalled outbox tail', async () => {
  const projectId = `outbox-settlement-wake-${crypto.randomUUID()}`
  const userId = 'user-1'
  const firstId = await outbox.enqueueSharedTimelineOperationOnFailure({
    projectId,
    userId,
    operation: utilityOperation(),
  })
  await outbox.enqueueSharedTimelineOperationOnFailure({
    projectId,
    userId,
    operation: utilityOperation(),
  })
  let releaseTail: ((response: Response) => void) | undefined
  let releaseSecondRequest: (() => void) | undefined
  const secondStarted = new Promise<void>((resolve) => { releaseSecondRequest = resolve })
  let wakes = 0
  const unsubscribe = outbox.subscribeToSharedOutboxSettlements(projectId, userId, () => { wakes += 1 })
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = Object.assign(async () => {
    requests += 1
    if (requests === 1) return new Response('deleted', { status: 403 })
    releaseSecondRequest?.()
    return await new Promise<Response>((resolve) => { releaseTail = resolve })
  }, { preconnect: originalFetch.preconnect })
  try {
    const draining = flushSharedOutbox(projectId, userId)
    await secondStarted
    expect(wakes).toBeGreaterThan(0)
    expect(await outbox.readSharedOutboxOperation(projectId, userId, firstId)).toMatchObject({ status: 'rejected' })
    releaseTail?.(new Response(JSON.stringify(typedResult(4)), { status: 200 }))
    await draining
  } finally {
    unsubscribe()
    globalThis.fetch = originalFetch
  }
})

test('broadcasts a terminal settlement to an idle foreign owner without a manual read', async () => {
  const projectId = `outbox-broadcast-wake-${crypto.randomUUID()}`
  const userId = 'user-1'
  await outbox.enqueueSharedTimelineOperationOnFailure({
    projectId,
    userId,
    operation: utilityOperation(),
  })
  const channelName = `shared-outbox-settlement:${encodeURIComponent(projectId)}:${encodeURIComponent(userId)}`
  const foreignChannel = new BroadcastChannel(channelName)
  let foreignWake: (() => void) | undefined
  const observed = new Promise<void>((resolve) => { foreignWake = resolve })
  foreignChannel.addEventListener('message', () => foreignWake?.())
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    async () => new Response('deleted', { status: 403 }),
    { preconnect: originalFetch.preconnect },
  )
  try {
    await flushSharedOutbox(projectId, userId)
    await observed;
  } finally {
    foreignChannel.close()
    globalThis.fetch = originalFetch
  }
})

test('a completion that a foreign drainer wrote before the owner bound is read from the durable record', async () => {
  const projectId = `outbox-effects-foreign-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  // Another tab holds a live claim on the head, so this tab's publication is admitted but not drained.
  await db.put('syncState', {
    key: 'shared-outbox:foreign-head',
    value: {
      id: 'foreign-head', kind: 'tracks.setVolume', projectId, userId, payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending', attempts: 0, nextAttemptAt: timestamp, sequence: 1, createdAt: timestamp, updatedAt: timestamp,
      claimOwner: 'another-tab', claimToken: 'foreign-token', leaseExpiresAt: timestamp + 60_000,
    },
    updatedAt: timestamp,
  })
  const fetchStub = stubFetch(() => new Response(JSON.stringify(typedResult(9)), { status: 200 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(published.kind).toBe('admitted')
    if (published.kind !== 'admitted') throw new Error('Expected admission behind the foreign claim.')
    expect(fetchStub.bodies).toHaveLength(0)
    // The event fires before the owner ever looked: the settlement is already durable when it reads.
    await settleInAnotherTab(projectId, userId, published.entryId, { result: typedResult(9), createdAt: timestamp })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId))
      .toEqual({ status: 'applied', result: typedResult(9), completionOwner: 'background' })
  } finally {
    fetchStub.restore()
  }
})

test('a rejection a foreign drainer recorded is read as rejected, and the next flush reports it without publishing', async () => {
  const projectId = `outbox-effects-foreign-reject-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:foreign-head',
    value: {
      id: 'foreign-head', kind: 'tracks.setVolume', projectId, userId, payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending', attempts: 0, nextAttemptAt: timestamp, sequence: 1, createdAt: timestamp, updatedAt: timestamp,
      claimOwner: 'another-tab', claimToken: 'foreign-token', leaseExpiresAt: timestamp + 60_000,
    },
    updatedAt: timestamp,
  })
  const fetchStub = stubFetch(() => new Response(JSON.stringify(typedResult(1)), { status: 200 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    if (published.kind !== 'admitted') throw new Error('Expected admission behind the foreign claim.')
    await settleInAnotherTab(projectId, userId, published.entryId, { deadLetter: 'Permanent failure: Track was deleted.' })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, published.entryId))
      .toEqual({ status: 'rejected', lastError: 'Permanent failure: Track was deleted.' })
    await expect(flushSharedOutboxOperation(projectId, userId, published.entryId)).rejects.toThrow('Track was deleted.')
    expect(fetchStub.bodies).toHaveLength(0)
  } finally {
    fetchStub.restore()
  }
})

test('rows ahead of the publication drain first and each keeps its own readable result', async () => {
  const projectId = `outbox-effects-ahead-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: 'shared-outbox:ahead',
    value: {
      id: 'ahead', kind: 'tracks.setVolume', projectId, userId, payload: { trackId: 'track-1', volume: 0.5 },
      status: 'pending', attempts: 0, nextAttemptAt: timestamp, sequence: 1, createdAt: timestamp, updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  const fetchStub = stubFetch((body) => new Response(JSON.stringify(
    z.object({ kind: z.string() }).parse(body).kind === 'tracks.setVolume' ? { status: 'applied' } : typedResult(3),
  ), { status: 200 }))
  try {
    const published = await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(published).toMatchObject({ kind: 'applied', result: decodedTypedResult(3) })
    expect(fetchStub.bodies.map((body) => z.object({ kind: z.string() }).parse(body).kind)).toEqual(['tracks.setVolume', 'effects.setUtilityParams'])
    expect(await outbox.readSharedOutboxOperation(projectId, userId, 'ahead'))
      .toEqual({ status: 'applied', result: { status: 'applied' }, completionOwner: 'background' })
  } finally {
    fetchStub.restore()
  }
})

test('one read of an operation is one readonly transaction over the entry and its completion', async () => {
  const projectId = `outbox-effects-one-tx-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  await db.put('syncState', {
    key: `shared-outbox-completion:${projectId}:${userId}:done`,
    value: { result: { status: 'applied' }, createdAt: timestamp, completionOwner: 'background' },
    updatedAt: timestamp,
  })
  const modes: IDBTransactionMode[] = []
  const original = IDBDatabase.prototype.transaction
  Object.defineProperty(IDBDatabase.prototype, 'transaction', {
    configurable: true,
    value: function transaction(this: IDBDatabase, storeNames: string, mode: IDBTransactionMode = 'readonly') {
      modes.push(mode)
      return original.call(this, storeNames, mode)
    },
  })
  try {
    expect(await outbox.readSharedOutboxOperation(projectId, userId, 'done')).toMatchObject({ status: 'applied' })
  } finally {
    Object.defineProperty(IDBDatabase.prototype, 'transaction', { configurable: true, value: original })
  }
  expect(modes).toEqual(['readonly'])
})

test('the count cap is the only collector: an old legacy-dated completion survives, the oldest is evicted', async () => {
  const projectId = `outbox-effects-evict-${crypto.randomUUID()}`
  const userId = 'user-1'
  const db = await openLocalProjectDb(projectId)
  const timestamp = Date.now()
  for (let index = 1; index <= 64; index += 1) {
    // old-2 is a legacy record whose expiry passed long ago; age must not decide.
    const legacyExpiry = index === 2 ? { expiresAt: 1 } : { expiresAt: undefined }
    await db.put('syncState', {
      key: `shared-outbox-completion:${projectId}:${userId}:old-${index}`,
      value: { result: { status: 'applied', index }, createdAt: index, completionOwner: 'background', ...legacyExpiry },
      updatedAt: timestamp,
    })
  }
  const fetchStub = stubFetch(() => new Response(JSON.stringify(typedResult(1)), { status: 200 }))
  try {
    await outbox.publishDurableEffectsOperation({ projectId, userId, operation: utilityOperation() })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, 'old-1')).toEqual({ status: 'missing' })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, 'old-2')).toMatchObject({ status: 'applied' })
    expect(await outbox.readSharedOutboxOperation(projectId, userId, 'old-64')).toMatchObject({ status: 'applied' })
  } finally {
    fetchStub.restore()
  }
})
