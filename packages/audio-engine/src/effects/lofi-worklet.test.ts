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
  const parameters = () => ({
    'lofi.bitDepth': Float32Array.of(8),
    'lofi.sampleRateRatio': Float32Array.of(0.5),
    'lofi.jitter': Float32Array.of(0.35),
    'lofi.noiseDb': Float32Array.of(-60),
    'lofi.mix': Float32Array.of(1),
  })

  const input = Float32Array.from({ length: 128 }, (_, frame) => Math.sin(frame * 0.17) * 0.7)

  const configure = (processor: Processor) => {
    processor.port.onmessage?.({
      data: {
        type: 'configure',
        version: 1,
        revision: 1,
        state: { ...createDefaultLoFiParams(), seed: 123, enabled: true },
      },
    })
  }

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

  test('is invariant to render block partitioning and keeps stereo RNG streams independent', async () => {
    const wholeProcessor = await loadProcessor()
    const partitionedProcessor = await loadProcessor()
    configure(wholeProcessor)
    configure(partitionedProcessor)
    const whole = [new Float32Array(128), new Float32Array(128)]
    wholeProcessor.process([[input, input]], [whole], parameters())
    const partitioned = [new Float32Array(128), new Float32Array(128)]
    partitionedProcessor.process([[input.slice(0, 37), input.slice(0, 37)]], [[partitioned[0].subarray(0, 37), partitioned[1].subarray(0, 37)]], parameters())
    partitionedProcessor.process([[input.slice(37), input.slice(37)]], [[partitioned[0].subarray(37), partitioned[1].subarray(37)]], parameters())
    expect(partitioned[0]).toEqual(whole[0])
    expect(partitioned[1]).toEqual(whole[1])
    expect(whole[0]).not.toEqual(whole[1])
  })
})
