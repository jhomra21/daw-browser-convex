import { describe, expect, test } from 'bun:test'
import { getEffectTiming } from './timing'
import { normalizeCompressorParams, normalizeDelayParams, normalizeReverbParams } from '@daw-browser/shared'

describe('effect timing contracts', () => {
  test('declares compressor lookahead latency even while bypassed', () => {
    expect(getEffectTiming({
      kind: 'compressor',
      params: normalizeCompressorParams({ enabled: false, lookaheadMs: 10 }),
    }, 48_000).latencyFrames).toBe(480)
  })

  test('declares finite reverb and feedback delay tails', () => {
    expect(getEffectTiming({
      kind: 'reverb',
      params: normalizeReverbParams({ enabled: true, decaySec: 2, preDelayMs: 50 }),
    }, 48_000).tail).toEqual({ kind: 'finite', frames: 98_400 })
    const delay = getEffectTiming({
      kind: 'delay',
      params: normalizeDelayParams({ enabled: true, mode: 'time', timeMs: 250, feedback: 0.5, dryWet: 1 }),
    }, 48_000)
    expect(delay.tail.kind).toBe('finite')
    if (delay.tail.kind === 'finite') expect(delay.tail.frames).toBeGreaterThan(120_000)
  })
})
