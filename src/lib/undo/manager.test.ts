import { describe, expect, test } from 'bun:test'
import { createDefaultCompressorParams } from '@daw-browser/shared'

import { createUndoManager } from './manager'
import type { HistoryEntry } from './types'

const compressorParams = createDefaultCompressorParams()

function createCompressorEntry(toThresholdDb: number, instanceId?: string): HistoryEntry {
  return {
    type: 'effect-params',
    projectId: 'project-1',
    data: {
      trackRef: 'track-ref-1',
      effect: 'compressor',
      instanceId: instanceId ? instanceId : undefined,
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

const entry = (from: number, to: number): HistoryEntry => ({
  type: 'track-volume',
  projectId: 'project-1',
  data: {
    trackRef: 'track-1',
    scope: 'shared',
    from,
    to,
  },
})

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

  test('keeps separate effect instance parameter entries', () => {
    const manager = createUndoManager({})

    manager.push(createCompressorEntry(-30, 'compressor-a'), 'track-1:compressor')
    manager.push(createCompressorEntry(-36, 'compressor-b'), 'track-1:compressor')

    expect(manager.snapshot().undo).toEqual([
      createCompressorEntry(-30, 'compressor-a'),
      createCompressorEntry(-36, 'compressor-b'),
    ])
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

test('undo completion moves the executed entry without removing a newer concurrent entry', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  const newer = entry(0.75, 1)
  manager.push(executed)
  manager.push(newer)

  expect(manager.reserveUndo()).toBe(newer)
  expect(manager.completeUndo(newer)).toBe(true)
  expect(manager.snapshot()).toEqual({
    undo: [executed],
    redo: [newer],
  })
})

test('does not create a redo branch when a new edit arrives during undo', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  const newer = entry(0.75, 1)
  manager.push(executed)

  expect(manager.reserveUndo()).toBe(executed)
  manager.push(newer)

  expect(manager.completeUndo(executed)).toBe(true)
  expect(manager.snapshot()).toEqual({
    undo: [newer],
    redo: [],
  })
})

test('redo completion moves the executed entry without removing a newer concurrent redo entry', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  const newer = entry(0.75, 1)
  manager.hydrate({ undo: [], redo: [executed, newer] })

  expect(manager.reserveRedo()).toBe(newer)
  expect(manager.completeRedo(newer)).toBe(true)
  expect(manager.snapshot()).toEqual({
    undo: [newer],
    redo: [executed],
  })
})

test('reserving undo preserves it through a merge-key push and failure restoration', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  const pushed = entry(0.75, 1)
  manager.push(executed, 'track-1')

  expect(manager.reserveUndo()).toBe(executed)
  manager.push(pushed, 'track-1')
  expect(manager.snapshot().undo).toEqual([executed, pushed])
  expect(manager.restoreUndo(executed)).toBe(true)
  expect(manager.snapshot().undo).toEqual([executed, pushed])
})

test('reserving redo preserves it through a push and restores chronological undo order', () => {
  const manager = createUndoManager({})
  const prior = entry(0.25, 0.5)
  const executed = entry(0.5, 0.75)
  const pushed = entry(0.75, 1)
  manager.hydrate({ undo: [prior], redo: [executed] })

  expect(manager.reserveRedo()).toBe(executed)
  manager.push(pushed)
  expect(manager.snapshot().redo).toEqual([executed])
  expect(manager.completeRedo(executed)).toBe(true)
  expect(manager.snapshot().undo).toEqual([prior, executed, pushed])
})

test('does not restore a failed redo after a new edit invalidates redo history', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  manager.hydrate({ undo: [], redo: [executed] })

  expect(manager.reserveRedo()).toBe(executed)
  manager.push(entry(0.75, 1))

  expect(manager.restoreRedo(executed)).toBe(true)
  expect(manager.snapshot()).toEqual({
    undo: [entry(0.75, 1)],
    redo: [],
  })
})

test('hydration preserves an active undo reservation through completion', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  manager.push(executed)
  expect(manager.reserveUndo()).toBe(executed)

  manager.hydrate({ undo: [executed], redo: [] })

  expect(manager.completeUndo(executed)).toBe(true)
  expect(manager.snapshot()).toEqual({ undo: [], redo: [executed] })
})

test('hydration preserves an active redo reservation through completion', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  manager.hydrate({ undo: [], redo: [executed] })
  expect(manager.reserveRedo()).toBe(executed)

  manager.hydrate({ undo: [], redo: [executed] })

  expect(manager.completeRedo(executed)).toBe(true)
  expect(manager.snapshot()).toEqual({ undo: [executed], redo: [] })
})

test('hydration preserves an active redo reservation through failure restoration', () => {
  const manager = createUndoManager({})
  const executed = entry(0.5, 0.75)
  manager.hydrate({ undo: [], redo: [executed] })
  expect(manager.reserveRedo()).toBe(executed)

  manager.hydrate({ undo: [], redo: [executed] })

  expect(manager.restoreRedo(executed)).toBe(true)
  expect(manager.snapshot()).toEqual({ undo: [], redo: [executed] })
})

test('hydration removes the reserved duplicate occurrence after persisted entries are prepended', () => {
  const manager = createUndoManager({})
  const duplicate = entry(0.5, 0.75)
  const middle = entry(0.75, 1)
  manager.hydrate({ undo: [duplicate, middle, duplicate], redo: [] })
  expect(manager.reserveUndo()).toBe(duplicate)

  manager.hydrate({ undo: [entry(-1, 0), duplicate, middle, duplicate], redo: [] })

  expect(manager.completeUndo(duplicate)).toBe(true)
  expect(manager.snapshot()).toEqual({
    undo: [entry(-1, 0), duplicate, middle],
    redo: [duplicate],
  })
})