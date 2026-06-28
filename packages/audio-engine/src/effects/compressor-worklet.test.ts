import { describe, expect, test } from 'bun:test'
import { computeCompressorStaticCurveDb, normalizeCompressorParams, type CompressorParamsInput } from '@daw-browser/shared'
import { computeCompressorWorkletCurveDb } from './compressor-worklet'

describe('compressor worklet curve', () => {
  const cases: { name: string; inputDb: number; params: CompressorParamsInput }[] = [
    { name: 'hard-knee compression below threshold', inputDb: -30, params: { thresholdDb: -24, ratio: 4, kneeDb: 0 } },
    { name: 'hard-knee compression above threshold', inputDb: -12, params: { thresholdDb: -24, ratio: 4, kneeDb: 0 } },
    { name: 'hard-knee expansion below threshold', inputDb: -36, params: { thresholdDb: -24, ratio: 2, kneeDb: 0, dynamicsMode: 'expand' } },
    { name: 'hard-knee expansion above threshold', inputDb: -12, params: { thresholdDb: -24, ratio: 2, kneeDb: 0, dynamicsMode: 'expand' } },
    { name: 'soft-knee compression lower edge', inputDb: -27, params: { thresholdDb: -24, ratio: 4, kneeDb: 6 } },
    { name: 'soft-knee compression midpoint', inputDb: -24, params: { thresholdDb: -24, ratio: 4, kneeDb: 6 } },
    { name: 'soft-knee compression upper edge', inputDb: -21, params: { thresholdDb: -24, ratio: 4, kneeDb: 6 } },
    { name: 'soft-knee expansion lower edge', inputDb: -27, params: { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' } },
    { name: 'soft-knee expansion midpoint', inputDb: -25, params: { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' } },
    { name: 'soft-knee expansion threshold', inputDb: -24, params: { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' } },
  ]

  for (const item of cases) {
    test(`matches shared static curve for ${item.name}`, () => {
      const params = normalizeCompressorParams(item.params)
      expect(computeCompressorWorkletCurveDb(item.inputDb, params)).toBeCloseTo(computeCompressorStaticCurveDb(item.inputDb, params), 8)
    })
  }
})
