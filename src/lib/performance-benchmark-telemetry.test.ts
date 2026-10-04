import { describe, expect, test } from 'bun:test'

import {
  withPerformanceBenchmarkPhase,
} from './performance-benchmark-telemetry'

describe('performance benchmark telemetry', () => {
  test('preserves work results without an installed phase collector', async () => {
    await expect(withPerformanceBenchmarkPhase('recording-wav-encode', async () => 42)).resolves.toBe(42)
  })
})
