import { expect, test } from 'bun:test'

import { canPersistMidiEditor } from './useMidiEditorPersistence'

test('does not permit cloud MIDI writes for a viewer or after a live downgrade', () => {
  expect(canPersistMidiEditor('cloud-project', 'user-1', false)).toBe(false)
  expect(canPersistMidiEditor('cloud-project', 'user-1', true)).toBe(true)
  expect(canPersistMidiEditor('cloud-project', 'user-1', false)).toBe(false)
})
