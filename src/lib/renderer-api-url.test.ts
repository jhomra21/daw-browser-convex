import { describe, expect, test } from 'bun:test'
import {
  resolveDefaultSampleMediaUrl,
  resolveRendererApiUrl,
  type RendererApiRuntime,
} from './renderer-api-url'

const browser: RendererApiRuntime = {
  isDesktop: false,
  isDawProtocol: false,
  browserOrigin: 'https://app.example.test',
}

describe('resolveRendererApiUrl', () => {
  test('preserves browser-relative API URLs without a configured base', () => {
    expect(resolveRendererApiUrl(undefined, browser, '/api/default-samples?limit=20'))
      .toBe('/api/default-samples?limit=20')
  })

  test('uses the local worker for Forge development', () => {
    expect(resolveRendererApiUrl(undefined, {
      isDesktop: true,
      isDawProtocol: false,
      browserOrigin: 'http://localhost:5173',
    }, '/api/default-sample?key=default%2FKick.wav'))
      .toBe('http://localhost:3000/api/default-sample?key=default%2FKick.wav')
  })

  test('requires a valid configured origin for packaged desktop', () => {
    const packaged: RendererApiRuntime = {
      isDesktop: true,
      isDawProtocol: true,
      browserOrigin: 'daw://app',
    }
    expect(resolveRendererApiUrl(undefined, packaged, '/api/default-samples')).toBeNull()
    expect(resolveRendererApiUrl('http://example.test', packaged, '/api/default-samples')).toBeNull()
    expect(resolveRendererApiUrl('https://api.example.test', packaged, '/api/default-samples'))
      .toBe('https://api.example.test/api/default-samples')
  })

  test('rejects configured path, query, fragment, and credential injection', () => {
    for (const configured of [
      'https://api.example.test/worker',
      'https://api.example.test?next=https://evil.test',
      'https://api.example.test#fragment',
      'https://api.example.test/fixture',
    ]) {
      expect(resolveRendererApiUrl(configured, browser, '/api/default-samples')).toBe('/api/default-samples')
    }
  })

  test('only accepts absolute API URLs from the resolved API origin', () => {
    expect(resolveRendererApiUrl('https://api.example.test', browser, 'https://api.example.test/api/default-sample?key=default%2Fsnare'))
      .toBe('https://api.example.test/api/default-sample?key=default%2Fsnare')
    expect(resolveRendererApiUrl('https://api.example.test', browser, 'https://other.example.test/api/default-sample')).toBeNull()
  })
})

describe('resolveDefaultSampleMediaUrl', () => {
  test('normalizes a catalog media URL to the API origin and preserves its query', () => {
    expect(resolveDefaultSampleMediaUrl('https://api.example.test', browser, '/api/default-sample?key=default%2FKick.wav'))
      .toBe('https://api.example.test/api/default-sample?key=default%2FKick.wav')
  })

  test('does not allow a packaged renderer to fetch a relative media URL without an endpoint', () => {
    expect(resolveDefaultSampleMediaUrl(undefined, {
      isDesktop: true,
      isDawProtocol: true,
      browserOrigin: 'daw://app',
    }, '/api/default-sample?key=default%2FKick.wav')).toBeNull()
  })
})
