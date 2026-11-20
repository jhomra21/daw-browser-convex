import { expect, test } from 'bun:test'
import { normalizeTrackChannelRole } from './track-routing-core'
import { CLIP_KINDS, TRACK_CHANNEL_ROLES, TRACK_KINDS, isTrackKind } from './track-kinds'

test('track, channel role and clip kind vocabularies keep their values and order', () => {
  expect([...TRACK_KINDS]).toEqual(['audio', 'instrument'])
  expect([...TRACK_CHANNEL_ROLES]).toEqual(['track', 'group', 'return'])
  expect([...CLIP_KINDS]).toEqual(['audio', 'midi'])
})

test('unknown track kinds are rejected and unknown channel roles fall back to a plain track', () => {
  expect(isTrackKind('instrument')).toBe(true)
  expect(isTrackKind('midi')).toBe(false)
  expect(isTrackKind(undefined)).toBe(false)
  expect(normalizeTrackChannelRole('return')).toBe('return')
  expect(normalizeTrackChannelRole('group')).toBe('group')
  expect(normalizeTrackChannelRole('track')).toBe('track')
  expect(normalizeTrackChannelRole('bus')).toBe('track')
  expect(normalizeTrackChannelRole(undefined)).toBe('track')
})
