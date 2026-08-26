import { describe, expect, test } from 'bun:test'
import { resolveAuthBaseUrl } from './auth-base-url'

describe('resolveAuthBaseUrl', () => {
  test('keeps browser auth on the browser origin', () => {
    expect(resolveAuthBaseUrl(undefined, {
      isDesktop: false,
      isDawProtocol: false,
      browserOrigin: 'http://localhost:5173',
    })).toBe('http://localhost:5173')
  })

  test('uses the configured auth service when present', () => {
    expect(resolveAuthBaseUrl('https://auth.example.com', {
      isDesktop: true,
      isDawProtocol: false,
      browserOrigin: 'http://localhost:5173',
    }))
      .toBe('https://auth.example.com')
  })

  test('uses the local worker only for desktop development', () => {
    expect(resolveAuthBaseUrl(undefined, {
      isDesktop: true,
      isDawProtocol: false,
      browserOrigin: 'http://localhost:5173',
    })).toBe('http://localhost:3000')
  })

  test('does not target the packaged renderer origin without a configured endpoint', () => {
    expect(resolveAuthBaseUrl(undefined, {
      isDesktop: true,
      isDawProtocol: true,
      browserOrigin: 'daw://app',
    })).toBeUndefined()
  })
})
