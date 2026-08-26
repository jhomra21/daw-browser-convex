import { expect, test } from 'bun:test'
import { parseTimelineOperationRequest } from './timeline-operations'

const legacyMidiCreate = {
  kind: 'clips.create',
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
}

test('rejects legacy persisted MIDI through the public timeline operation parser', () => {
  expect(parseTimelineOperationRequest(legacyMidiCreate)).toBeNull()
})
