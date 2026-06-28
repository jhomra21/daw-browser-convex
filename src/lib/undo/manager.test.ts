import { describe, expect, test } from 'bun:test'
import { createDefaultCompressorParams } from '@daw-browser/shared'
import { createUndoManager } from './manager'
import type { HistoryEntry } from './types'

const compressorParams = createDefaultCompressorParams()

function createCompressorEntry(toThresholdDb: number): HistoryEntry {
  return {
    type: 'effect-params',
    projectId: 'project-1',
    data: {
      trackRef: 'track-ref-1',
      effect: 'compressor',
      from: { ...compressorParams, thresholdDb: -24 },
      to: { ...compressorParams, thresholdDb: toThresholdDb },
    },
  }
}

function createMasterCompressorEntry(toThresholdDb: number): HistoryEntry {
  return {
    type: 'effect-params',
    projectId: 'project-1',
    data: {
      effect: 'master-compressor',
      from: { ...compressorParams, thresholdDb: -24 },
      to: { ...compressorParams, thresholdDb: toThresholdDb },
    },
  }
}

describe('createUndoManager', () => {
  test('merges track compressor effect parameter entries', () => {
    const manager = createUndoManager({})

    manager.push(createCompressorEntry(-30), 'track-1:compressor')
    manager.push(createCompressorEntry(-36), 'track-1:compressor')
    manager.push(createCompressorEntry(-42), 'track-1:compressor')

    const undo = manager.snapshot().undo
    expect(undo).toHaveLength(2)
    expect(undo[0]).toEqual(createCompressorEntry(-30))
    expect(undo[1]).toEqual(createCompressorEntry(-42))
  })

  test('merges master compressor effect parameter entries', () => {
    const manager = createUndoManager({})

    manager.push(createMasterCompressorEntry(-30), 'master:master-compressor')
    manager.push(createMasterCompressorEntry(-36), 'master:master-compressor')
    manager.push(createMasterCompressorEntry(-42), 'master:master-compressor')

    const undo = manager.snapshot().undo
    expect(undo).toHaveLength(2)
    expect(undo[1]).toEqual(createMasterCompressorEntry(-42))
  })
})
