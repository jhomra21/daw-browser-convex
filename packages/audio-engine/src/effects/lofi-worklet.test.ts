import { describe, expect, test } from 'bun:test'
import { createDefaultLoFiParams } from '@daw-browser/shared'
import { loFiWorklet } from '../worklet-manifest'

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: unknown) => void
  close: () => void
}

type Processor = {
  port: Port
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ) => boolean
}

type ProcessorConstructor = new () => Processor

const loadProcessor = async () => {
  const source = await Bun.file(new URL(`../../../../public/${loFiWorklet.modulePath}`, import.meta.url)).text()
  const registered = new Map<string, ProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: Port = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    48_000,
  )
  const Constructor = registered.get(loFiWorklet.processorName)
  if (!Constructor) throw new Error('LoFi processor did not register.')
  return new Constructor()
}

describe('LoFi static worklet', () => {
  test('uses the same bypass transition for every channel', async () => {
    const processor = await loadProcessor()
    processor.port.onmessage?.({
      data: {
        type: 'configure',
        version: 1,
        revision: 1,
        state: { ...createDefaultLoFiParams(), enabled: false },
      },
    })
    const input = Float32Array.from({ length: 128 }, () => 0.75)
    const output = [new Float32Array(128), new Float32Array(128)]
    processor.process(
      [[input, input]],
      [output],
      {
        'lofi.bitDepth': Float32Array.of(2),
        'lofi.sampleRateRatio': Float32Array.of(1),
        'lofi.jitter': Float32Array.of(0),
        'lofi.noiseDb': Float32Array.of(-120),
        'lofi.mix': Float32Array.of(1),
      },
    )
    expect(output[0]).toEqual(output[1])
    expect(output[0][0]).not.toBe(output[0][127])
  })
})
