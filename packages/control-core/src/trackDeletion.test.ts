import { expect, test } from 'bun:test'
import { collectDeletedTrackIdsV1 } from './trackDeletion'

test('collects nested descendants without including unrelated tracks', () => {
  expect(collectDeletedTrackIdsV1([
    { id: 'root', index: 0, sends: [] },
    { id: 'child', index: 1, groupId: 'root', sends: [] },
    { id: 'grandchild', index: 2, groupId: 'child', sends: [] },
    { id: 'unrelated', index: 3, sends: [] },
  ], 'root')).toEqual(new Set(['root', 'child', 'grandchild']))
})

test('ignores descendants whose parent reference is malformed', () => {
  expect(collectDeletedTrackIdsV1([
    { id: 'root', index: 0, sends: [] },
    { id: 'child', index: 1, groupId: 'root', sends: [] },
    { id: 'orphan', index: 2, groupId: 'missing-parent', sends: [] },
  ], 'root')).toEqual(new Set(['root', 'child']))
})
