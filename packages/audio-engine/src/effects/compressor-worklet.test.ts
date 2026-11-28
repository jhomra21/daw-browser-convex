import { describe, expect, test } from 'bun:test'
import { computeCompressorStaticCurveDb, normalizeCompressorParams, type CompressorParamsInput } from '@daw-browser/shared'
import { readCompressorMeterFrame } from './compressor-worklet'
import { compressorWorklet } from '../worklet-manifest'

type CurveKernel = {
  designCurve: (threshold: number, ratio: number, knee: number, expand: boolean, rms: boolean) => void
  targetDb: (db: number) => number
}

type ProcessorConstructor = new () => { kernel: CurveKernel }

const publicRoot = new URL('../../../../public/', import.meta.url)

// The legacy worklet carries its own copy of the gain computer; it must draw the same curve as the shared one the panel uses.
const loadWorkletKernel = async () => {
  const source = await Bun.file(new URL(compressorWorklet.modulePath, publicRoot)).text()
  let registered: ProcessorConstructor | undefined

  class FakeAudioWorkletProcessor {
    port = { onmessage: null, postMessage: () => undefined }
  }

  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (_name: string, processor: ProcessorConstructor) => { registered = processor },
    48000,
  )

  if (!registered) throw new Error(`${compressorWorklet.processorName} did not register.`)

  return new registered().kernel
}

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
    test(`matches shared static curve for ${item.name}`, async () => {
      const params = normalizeCompressorParams(item.params)
      const kernel = await loadWorkletKernel()
      kernel.designCurve(params.thresholdDb, params.ratio, params.kneeDb, params.dynamicsMode === 'expand', params.detectorMode === 'rms')

      expect(item.inputDb + kernel.targetDb(item.inputDb)).toBeCloseTo(computeCompressorStaticCurveDb(item.inputDb, params), 8)
    })
  }
})

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
