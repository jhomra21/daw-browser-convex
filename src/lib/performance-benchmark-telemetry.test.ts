import { describe, expect, test } from 'bun:test'

import {
  incrementPerformanceBenchmarkCounter,
  measurePerformanceBenchmarkDuration,
  withPerformanceBenchmarkPhase,
} from './performance-benchmark-telemetry'

describe('performance benchmark telemetry', () => {
  test('is a no-op without an installed benchmark collector', () => {
    incrementPerformanceBenchmarkCounter('waveform.requests')
    expect(measurePerformanceBenchmarkDuration('waveform.geometry', 10, 14)).toBe(4)
  })

  test('preserves work results without an installed phase collector', async () => {
    await expect(withPerformanceBenchmarkPhase('recording-wav-encode', async () => 42)).resolves.toBe(42)
  })
})
