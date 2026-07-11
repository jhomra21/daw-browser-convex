import { describe, expect, test } from 'bun:test'
import { normalizeCompressorParams } from '@daw-browser/shared'
import { computeCompressorWorkletCurveDb } from './effects/compressor-worklet'
import { compressorWorklet, trackMeterWorklet } from './worklet-manifest'

const publicRoot = new URL('../../../public/', import.meta.url)

type EvaluatedProcessor = {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null
    messages: unknown[]
  }
  process: (inputs: Float32Array[][], outputs?: Float32Array[][]) => boolean
}

type ProcessorConstructor = new () => EvaluatedProcessor

const evaluateAsset = async (modulePath: string) => {
  const source = await Bun.file(new URL(modulePath, publicRoot)).text()
  const registered = new Map<string, ProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null,
      messages: Array<unknown>(),
      postMessage: (message: unknown) => {
        this.port.messages.push(message)
      },
    }
  }
  const evaluate = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'sampleRate',
    `${source}\nreturn { curveDb: typeof curveDb === 'function' ? curveDb : undefined }`,
  )
  const exports = evaluate(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    48_000,
  )
  return { registered, exports }
}

describe('checked-in worklet assets', () => {
  test('registers and processes the exact compressor asset with curve parity', async () => {
    const evaluated = await evaluateAsset(compressorWorklet.modulePath)
    const Processor = evaluated.registered.get(compressorWorklet.processorName)
    expect(Processor).toBeFunction()
    if (!Processor) throw new Error('Compressor processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Compressor processor did not bind its message handler.')
    onmessage({ data: { type: 'params', params: normalizeCompressorParams({ enabled: false, dryWet: 1 }) } })
    const input = Float32Array.from([0.25, -0.5])
    const output = new Float32Array(2)
    expect(processor.process([[input]], [[output]])).toBe(true)
    expect(Array.from(output)).toEqual(Array.from(input))

    const params = normalizeCompressorParams({ thresholdDb: -18, ratio: 6, kneeDb: 8 })
    for (const inputDb of [-40, -20, -18, -12, 0]) {
      expect(evaluated.exports.curveDb(inputDb, params)).toBeCloseTo(
        computeCompressorWorkletCurveDb(inputDb, params),
        12,
      )
    }
  })

  test('registers and emits bounded levels from the exact meter asset', async () => {
    const evaluated = await evaluateAsset(trackMeterWorklet.modulePath)
    const Processor = evaluated.registered.get(trackMeterWorklet.processorName)
    expect(Processor).toBeFunction()
    if (!Processor) throw new Error('Meter processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Meter processor did not bind its message handler.')
    onmessage({ data: { active: true } })
    const signal = new Float32Array(4096).fill(0.25)
    expect(processor.process([[signal, signal]])).toBe(true)
    expect(processor.port.messages).toEqual([{ type: 'levels', left: 0.5, right: 0.5 }])
  })
})
