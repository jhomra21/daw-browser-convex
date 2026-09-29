import { describe, expect, test } from 'bun:test'

import {
  incrementPerformanceBenchmarkCounter,
  measurePerformanceBenchmarkDuration,
} from './performance-benchmark-telemetry'

describe('performance benchmark telemetry', () => {
  test('is a no-op without an installed benchmark collector', () => {
    incrementPerformanceBenchmarkCounter('waveform.requests')
    expect(measurePerformanceBenchmarkDuration('waveform.geometry', 10, 14)).toBe(4)
  })
})
