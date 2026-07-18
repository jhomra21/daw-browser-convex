import { describe, expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import type { Clip } from '@daw-browser/timeline-core/types'
import { buildClipCreateSnapshot, buildClipHistorySnapshot, createUploadedAudioClip } from './clip-create'
import { buildDuplicateClipCreateItems } from './clip-drag-session'
import { openLocalProjectDb } from './local-project-db'
import { SharedOutboxQueuedError } from './shared-outbox'

const clip = (input: Partial<Clip> & Pick<Clip, 'id' | 'name' | 'startSec' | 'duration' | 'color'>): Clip => ({
  ...input,
})

describe('clip create snapshots', () => {
  test('preserves explicit clip colors for create and history consumers', () => {
    const sourceClip = clip({
      id: 'clip-1',
      historyRef: 'clip-history-1',
      name: 'Clip 1',
      startSec: 1,
      duration: 2,
      color: '#ff00aa',
    })

    expect(buildClipCreateSnapshot(sourceClip)).toMatchObject({
      historyRef: 'clip-history-1',
      color: '#ff00aa',
    })
    expect(buildClipHistorySnapshot(sourceClip)).toMatchObject({
      clipRef: 'clip-history-1',
      color: '#ff00aa',
    })
  })

  test('preserves explicit clip colors for drag duplicate create items', () => {
    const sourceClip = clip({
      id: 'clip-1',
      name: 'Clip 1',
      startSec: 1,
      duration: 2,
      color: '#ff00aa',
    })

    expect(
      buildDuplicateClipCreateItems([
        { trackId: 'track-1', originalClip: sourceClip, startSec: 4 },
      ], {
        getBuffer: () => undefined,
        getMediaStatus: () => undefined,
      })
    ).toMatchObject([
      {
        trackId: 'track-1',
        clip: {
          startSec: 4,
          color: '#ff00aa',
        },
      },
    ])
  })
})

const source = {
  durationSec: 1,
  sampleRate: 44_100,
  channelCount: 2,
}

const clipBufferWriter = {
  storeBuffer: () => undefined,
  storeBuffers: () => undefined,
  removeBuffer: () => undefined,
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

test('returns the committed clip when cancellation follows the server commit', async () => {
  const controller = new AbortController()
  const insertedClipIds: string[] = []
  let createCalls = 0

  const result = await createUploadedAudioClip({
    projectId: 'project-commit-abort',
    userId: 'user-1',
    trackId: 'track-1',
    startSec: 0,
    file: new File(['audio'], 'clip.wav', { type: 'audio/wav' }),
    durationSec: 1,
    source,
    sourceAssetKey: 'asset-1',
    sourceKind: 'upload',
    createServerClip: async () => {
      createCalls += 1
      controller.abort()
      return 'clip-1'
    },
    insertLocalClip: (_trackId, clip_) => insertedClipIds.push(clip_.id),
    uploadToR2: async () => ({ assetKey: 'asset-1', url: 'https://example.test/clip.wav' }),
    audioBufferCache: clipBufferWriter,
  })

  expect(controller.signal.aborted).toBe(true)
  expect(createCalls).toBe(1)
  expect(result.clipId).toBe('clip-1')
  expect(insertedClipIds).toHaveLength(2)
  expect(insertedClipIds[0]).toStartWith('pending:')
  expect(insertedClipIds[1]).toBe('clip-1')
})

test('carries the persisted operation receipt when an uploaded clip is queued', async () => {
  let error: unknown

  try {
    await createUploadedAudioClip({
      projectId: 'project-queued-receipt',
      userId: 'user-1',
      trackId: 'track-1',
      startSec: 0,
      file: new File(['audio'], 'clip.wav', { type: 'audio/wav' }),
      durationSec: 1,
      source,
      sourceAssetKey: 'asset-1',
      sourceKind: 'upload',
      createServerClip: async () => 'clip-1',
      insertLocalClip: () => undefined,
      uploadToR2: async () => {
        throw new Error('offline')
      },
      audioBufferCache: clipBufferWriter,
    })
  } catch (caught) {
    error = caught
  }

  expect(error).toBeInstanceOf(SharedOutboxQueuedError)
  if (!(error instanceof SharedOutboxQueuedError)) throw error
  expect(error.operationId).toMatch(/^[0-9a-f-]{36}$/)

  const rows = await (await openLocalProjectDb('project-queued-receipt')).getAll('syncState')
  const queued = rows.find((row) => row.key.startsWith('shared-outbox:'))
  if (!queued || !isRecord(queued.value) || !isRecord(queued.value.payload) || !isRecord(queued.value.payload.clipPayload)) {
    throw new Error('Queued clip receipt was not persisted.')
  }
  expect(queued.value.payload.clipPayload.operationId).toBe(error.operationId)
})
