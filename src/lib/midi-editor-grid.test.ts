import { expect, test } from 'bun:test'

import { createMidiEditorGrid } from './midi-editor-grid'

const grid = createMidiEditorGrid(120, 4, 4)
const first = grid.noteFromCell({ col: 0, row: 48 }, 'first', 2)
const second = grid.noteFromCell({ col: 0, row: 48 }, 'second', 3)

test('MIDI grid preserves IDs and channels while moving and resizing notes', () => {
  const moved = grid.noteFromDrag(
    grid.createNoteDrag({ note: first, mode: 'move', cell: { col: 0, row: 48 }, pointerStep: 0 }),
    { col: 2, row: 46 },
    2,
  )
  const resized = grid.noteFromDrag(
    grid.createNoteDrag({ note: first, mode: 'resize', cell: { col: 0, row: 48 }, pointerStep: 0 }),
    { col: 3, row: 48 },
    3,
  )

  expect(moved).toMatchObject({ id: 'first', channel: 2, beat: 2 })
  expect(resized).toMatchObject({ id: 'first', channel: 2, length: 4 })
})

test('MIDI grid targets duplicate cells by durable ID', () => {
  const reordered = [second, first]
  expect(grid.findNoteAtCell(reordered, { col: 0, row: 48 })?.id).toBe('second')
  expect(grid.removeNoteById(reordered, 'first')).toEqual([second])
  expect(grid.replaceNoteById(reordered, 'first', { ...first, pitch: 61 })).toEqual([
    second,
    { ...first, pitch: 61 },
  ])
  expect(grid.removeNoteById(reordered, 'missing')).toEqual(reordered)
})
