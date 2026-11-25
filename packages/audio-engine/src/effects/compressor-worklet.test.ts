import { describe, expect, test } from 'bun:test'
import { readCompressorMeterFrame } from './compressor-worklet'

describe('compressor worklet messages', () => {
  test('rejects malformed and non-finite meter frames', () => {
    expect(readCompressorMeterFrame(null)).toBeNull()
    expect(readCompressorMeterFrame({ type: 'meter', inputDb: Number.NaN, outputDb: 0, gainReductionDb: 0, thresholdDb: -24 })).toBeNull()
    expect(readCompressorMeterFrame({ type: 'other', inputDb: 0, outputDb: 0, gainReductionDb: 0, thresholdDb: -24 })).toBeNull()
  })

  test('accepts valid meter frames', () => {
    expect(readCompressorMeterFrame({ type: 'meter', inputDb: -12, outputDb: -18, gainReductionDb: -6, thresholdDb: -24 }))
      .toEqual({ inputDb: -12, outputDb: -18, gainReductionDb: -6, thresholdDb: -24 })
  })
})
