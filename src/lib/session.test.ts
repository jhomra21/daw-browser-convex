import { describe, expect, test } from 'bun:test'
import { normalizeClientSession } from './session'

describe('normalizeClientSession', () => {
  test('fails closed for malformed session responses', () => {
    for (const value of [
      undefined,
      null,
      {},
      { session: {} },
      { user: {}, session: {} },
      { user: { id: '' }, session: {} },
      { user: { id: 1 }, session: {} },
      { user: { id: 'user-1' } },
    ]) {
      expect(normalizeClientSession(value)).toBeNull()
    }
  })

  test('retains a valid user ID, safe user fields, and record session', () => {
    expect(normalizeClientSession({
      user: {
        id: 'user-1',
        email: 'artist@example.com',
        name: 'Artist',
        image: null,
        ignored: 1,
      },
      session: { id: 'session-1' },
    })).toEqual({
      user: {
        id: 'user-1',
        email: 'artist@example.com',
        name: 'Artist',
        image: null,
      },
      session: { id: 'session-1' },
    })
  })
})
