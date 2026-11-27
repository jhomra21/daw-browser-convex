import { describe, expect, test } from 'bun:test'
import { createDefaultUtilityParams, type UtilityParams } from '@daw-browser/shared'
import { utilityWorklet } from '../worklet-manifest'

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: { type: string }) => void
  close: () => void
}

type Processor = {
  port: Port
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}

type ProcessorConstructor = { new (): Processor; parameterDescriptors: { name: string; defaultValue: number; minValue: number; maxValue: number }[] }

const loadConstructor = async () => {
  const source = await Bun.file(new URL(`../../../../public/${utilityWorklet.modulePath}`, import.meta.url)).text()
  const registered = new Map<string, ProcessorConstructor>()

  class FakeAudioWorkletProcessor {
    port: Port = { onmessage: null, postMessage: () => {}, close: () => {} }
  }

  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    48_000,
  )
  const Constructor = registered.get(utilityWorklet.processorName)

  if (!Constructor) throw new Error('Utility processor did not register.')

  return Constructor
}

const render = async (state: Partial<UtilityParams>, left: Float32Array, right: Float32Array, controls: Record<string, number> = {}) => {
  const Constructor = await loadConstructor()
  const processor = new Constructor()
  processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: { ...createDefaultUtilityParams(), ...state } } })
  const parameters = Object.fromEntries(Constructor.parameterDescriptors.map(({ name, defaultValue }) => [name, Float32Array.of(controls[name] ?? defaultValue)]))
  const output = [new Float32Array(left.length), new Float32Array(left.length)]

  for (let start = 0; start < left.length; start += 128) {
    processor.process(
      [[left.subarray(start, start + 128), right.subarray(start, start + 128)]],
      [[output[0].subarray(start, start + 128), output[1].subarray(start, start + 128)]],
      parameters,
    )
  }

  return output
}

const tone = (frames: number, amplitude: number) => Float32Array.from({ length: frames }, (_, n) => amplitude * Math.sin(n * 0.21))

describe('Utility static worklet', () => {
  test('declares the automation range of every continuous control', async () => {
    const { parameterDescriptors } = await loadConstructor()

    expect(parameterDescriptors.map(({ name, minValue, maxValue }) => [name, minValue, maxValue])).toEqual([
      ['utility.gainDb', -70, 35], ['utility.balance', -1, 1], ['utility.width', 0, 2], ['utility.midSide', -1, 1], ['utility.bassMonoHz', 50, 500],
    ])
  })

  test('is transparent at its defaults and silent at minimum gain and when muted', async () => {
    const input = tone(1024, 0.5)
    const [left, right] = await render({}, input, input)

    expect(Array.from(left)).toEqual(Array.from(input))
    expect(Array.from(right)).toEqual(Array.from(input))

    for (const output of [await render({}, input, input, { 'utility.gainDb': -70 }), await render({ mute: true }, input, input)]) {
      expect(Math.max(...output[0].map(Math.abs), ...output[1].map(Math.abs))).toBe(0)
    }
  })

  test('inverts only the channel Phase L names', async () => {
    const input = tone(512, 0.5)
    const [left, right] = await render({ phaseLeft: true }, input, input)

    expect(Array.from(left)).toEqual(Array.from(input, (value) => 0 - value))
    expect(Array.from(right)).toEqual(Array.from(input))
  })

  test('moves a left-only signal to the right with a swap and ignores a stale or malformed configure', async () => {
    const input = tone(512, 0.5)
    const silence = new Float32Array(512)
    const [left, right] = await render({ channelMode: 'swap' }, input, silence)

    expect(Math.max(...left.map(Math.abs))).toBe(0)
    expect(Array.from(right)).toEqual(Array.from(input))
    const Constructor = await loadConstructor()
    const processor = new Constructor()
    const messages: { type: string }[] = []
    processor.port.postMessage = (message) => messages.push(message)
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 3, state: createDefaultUtilityParams() } })
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 3, state: createDefaultUtilityParams() } })
    processor.port.onmessage?.({ data: { type: 'configure', version: 2, revision: 5, state: {} } })
    expect(messages.map((message) => message.type)).toEqual(['configured', 'fault', 'fault'])
  })
})
