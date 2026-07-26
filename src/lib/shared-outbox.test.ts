import { expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { openLocalProjectDb } from './local-project-db'
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
        operation: JSON.parse(typeof init?.body === 'string' ? init.body : 'null'),
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
  const firstOperation = requests[0]?.operation
  if (
    !firstOperation
    || typeof firstOperation !== 'object'
    || !('payload' in firstOperation)
    || typeof firstOperation.payload !== 'object'
    || firstOperation.payload === null
    || !('midi' in firstOperation.payload)
    || typeof firstOperation.payload.midi !== 'object'
    || firstOperation.payload.midi === null
    || !('notes' in firstOperation.payload.midi)
    || !Array.isArray(firstOperation.payload.midi.notes)
  ) throw new Error('Expected sanitized queued MIDI payload.')
  expect(firstOperation.payload.midi.notes).toHaveLength(500)
  expect(firstOperation.payload.midi).not.toHaveProperty('gain')
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
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'))
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
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null'))
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
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
      if (typeof body?.payload?.volume === 'number') volumes.push(body.payload.volume)
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
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
      if (body.payload.volume === 0.5) {
        return new Response(JSON.stringify({ status: 'rejected', reason: 'Track was deleted.' }), { status: 200 })
      }
      volumes.push(body.payload.volume)
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
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
      if (body.payload.volume === 0.5) return new Response('invalid track', { status: 400 })
      published.push(body.payload.volume)
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
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => (
      String(input) === '/api/samples'
        ? new Response(JSON.stringify({ url: 'https://example.test/clip.wav', assetKey: 'asset-1' }), { status: 200 })
        : new Response(JSON.stringify(null), { status: 200 })
    ),
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
  expect(await db.get('syncState', `shared-outbox-completion:${projectId}:${userId}:${operationId}`)).toBeUndefined()
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
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
        if (body.payload.volume === 0.5) {
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
  const originalWindow = Reflect.get(globalThis, 'window')
  let requests = 0
  globalThis.fetch = Object.assign(
    async () => {
      requests += 1
      return new Response(JSON.stringify({ status: 'applied' }), { status: 200 })
    },
    { preconnect: originalFetch.preconnect },
  )
  try {
    Reflect.set(globalThis, 'window', {})
    await expect(flushSharedOutbox(projectId, userId)).rejects.toBeInstanceOf(SharedOutboxUnavailableError)
    expect(requests).toBe(0)
    await recoverStaleSharedOutboxClaims(projectId, userId)
    const originalNavigator = globalThis.navigator
    Reflect.set(globalThis, 'navigator', {
      locks: { request: async <T>(_name: string, callback: () => Promise<T>) => await callback() },
    })
    try {
      await flushSharedOutbox(projectId, userId)
    } finally {
      Reflect.set(globalThis, 'navigator', originalNavigator)
    }
  } finally {
    Reflect.set(globalThis, 'window', originalWindow)
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
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
      if (!authenticated) return new Response('authentication required', { status: 401 })
      published.push(body.payload.volume)
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
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null')
        if (body.payload.volume === 0.5) {
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
    if (!claimed || typeof claimed.value !== 'object' || claimed.value === null || Array.isArray(claimed.value)) {
      throw new Error('Expected first outbox row to be claimed.')
    }
    await db.put('syncState', {
      ...claimed,
      value: { ...claimed.value, claimOwner: 'other-context', claimToken: 'other-token' },
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
