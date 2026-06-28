import { describe, expect, test } from 'bun:test'
import { createDefaultCompressorParams } from '@daw-browser/shared'
import { normalizePersistedHistory, serializePersistedHistory } from './persisted-history'
import type { HistoryEntry } from './types'

const compressorParams = createDefaultCompressorParams()

const compressorEntry: HistoryEntry = {
  type: 'effect-params',
  projectId: 'project-1',
  data: {
    trackRef: 'track-ref-1',
    effect: 'compressor',
    from: compressorParams,
    to: { ...compressorParams, thresholdDb: -30 },
  },
}

const masterCompressorEntry: HistoryEntry = {
  type: 'effect-params',
  projectId: 'project-1',
  data: {
    effect: 'master-compressor',
    from: compressorParams,
    to: { ...compressorParams, thresholdDb: -30 },
  },
}

describe('persisted undo history', () => {
  test('keeps compressor effect parameter entries', () => {
    const serialized = serializePersistedHistory({
      undo: [compressorEntry],
      redo: [masterCompressorEntry],
    })

    expect(normalizePersistedHistory(serialized)).toEqual({
      undo: [compressorEntry],
      redo: [masterCompressorEntry],
    })
  })
})
