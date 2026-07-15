import { expect, test } from 'bun:test'

import { validateRestoreUngroupRouting } from './tracks'

test('restore-ungroup rejects assigning a Return child to its restored group', () => {
  expect(validateRestoreUngroupRouting({
    group: {
      index: 0,
      sends: [],
    },
    children: [{
      trackId: 'return',
      outputTargetId: 'restored-group',
      outputToGroup: true,
    }],
  }, [{
    _id: 'return',
    index: 0,
    channelRole: 'return',
    sends: [],
  }])).toBe(false)
})
