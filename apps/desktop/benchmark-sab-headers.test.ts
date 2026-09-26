import { expect, test } from 'bun:test'
import { benchmarkSabHeaders } from './benchmark-sab-headers'

test('SAB benchmark isolation applies only to the packaged app origin', () => {
  expect(benchmarkSabHeaders('daw://app/index.html', true)).toEqual({
    'Cross-Origin-Opener-Policy': ['same-origin'],
    'Cross-Origin-Embedder-Policy': ['require-corp'],
  })
  expect(benchmarkSabHeaders('https://example.com/', true)).toEqual({})
  expect(benchmarkSabHeaders('daw://app/index.html', false)).toEqual({})
})
