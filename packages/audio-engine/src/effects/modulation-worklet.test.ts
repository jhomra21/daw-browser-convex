import { describe, expect, test } from 'bun:test'
import {
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultEnsembleParams,
  createDefaultFlangerParams,
  createDefaultPhaserParams,
  createDefaultTremoloParams,
} from '@daw-browser/shared'
import { modulationWorklet } from '../worklet-manifest'

type Kind = 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble'
type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  messages: unknown[]
  postMessage: (message: unknown) => void
  close: () => void
}
type Processor = {
  port: Port
  phase: number
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean
}
type ProcessorConstructor = new (options: { processorOptions: { processorKind: Kind } }) => Processor

const defaults = {
  chorus: createDefaultChorusParams,
  flanger: createDefaultFlangerParams,
  phaser: createDefaultPhaserParams,
  tremolo: createDefaultTremoloParams,
  autopan: createDefaultAutoPanParams,
  ensemble: createDefaultEnsembleParams,
}
const kinds: Kind[] = ['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble']

const loadProcessor = async (sampleRate: number, kind: Kind) => {
  const source = await Bun.file(new URL(`../../../../public/${modulationWorklet.modulePath}`, import.meta.url)).text()
  const registered = new Map<string, ProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: Port = {
      onmessage: null,
      messages: [],
      postMessage: (message) => this.port.messages.push(message),
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    sampleRate,
  )
  const Constructor = registered.get(modulationWorklet.processorName)
  if (!Constructor) throw new Error('Modulation processor did not register.')
  const processor = new Constructor({ processorOptions: { processorKind: kind } })
  processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, processorKind: kind, state: defaults[kind]() } })
  return processor
}

const render = async (sampleRate: number, kind: Kind, state: object, frames: number, stereo = true, impulse = false) => {
  const processor = await loadProcessor(sampleRate, kind)
  processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 2, processorKind: kind, state } })
  const left = Float32Array.from({ length: frames }, (_, index) => impulse ? Number(index === 0) : Math.sin(TWO_PI * 220 * index / sampleRate))
  const right = stereo ? Float32Array.from(left, (value) => -0.5 * value) : undefined
  const output = [new Float32Array(frames), new Float32Array(frames)]
  processor.process([[left, ...(right ? [right] : [])]], [output])
  return { processor, input: [left, right ?? left], output }
}

const TWO_PI = 2 * Math.PI

describe('modulation static worklet', () => {
  test('is deterministic and finite at 44.1, 48, and 96 kHz for mono and stereo', async () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const kind of kinds) {
        for (const stereo of [false, true]) {
          const first = await render(sampleRate, kind, defaults[kind](), 4096, stereo)
          const second = await render(sampleRate, kind, defaults[kind](), 4096, stereo)
          expect(first.output).toEqual(second.output)
          expect(first.output[0].every(Number.isFinite)).toBe(true)
          expect(first.output[1].every(Number.isFinite)).toBe(true)
        }
      }
    }
  })

  test('advances every LFO rate within 0.1 percent', async () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const kind of kinds) {
        const processor = await loadProcessor(sampleRate, kind)
        const state = { ...defaults[kind](), rateHz: 3.7 }
        processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 2, processorKind: kind, state } })
        processor.process([[new Float32Array(sampleRate)]], [[new Float32Array(sampleRate), new Float32Array(sampleRate)]])
        expect(Math.abs(processor.phase - 0.7) / 0.7).toBeLessThanOrEqual(0.001)
      }
    }
  })

  test('cubic circular delays place integer extrema within one frame', async () => {
    const delayKinds: Kind[] = ['chorus', 'flanger', 'ensemble']
    for (const kind of delayKinds) {
      const base = defaults[kind]()
      const delayMs = kind === 'flanger' ? 2 : 20
      const state = { ...base, delayMs, depthMs: 0, feedback: 0, mix: 1, rateHz: 0.01 }
      const result = await render(48_000, kind, state, 1200, false, true)
      const peak = result.output[0].reduce((best, value, index, values) => Math.abs(value) > Math.abs(values[best]) ? index : best, 0)
      expect(Math.abs(peak - delayMs * 48)).toBeLessThanOrEqual(1)
    }
  })

  test('tremolo and autopan reach their modulation endpoints', async () => {
    const tremolo = await render(48_000, 'tremolo', { ...createDefaultTremoloParams(), rateHz: 1, depth: 1, shape: 0.5, phase: 0.25 }, 24_001)
    expect(tremolo.output[0][0]).toBeCloseTo(tremolo.input[0][0], 5)
    const tremoloZero = await render(48_000, 'tremolo', { ...createDefaultTremoloParams(), rateHz: 1, depth: 1, shape: 0.5, phase: 0.75 }, 2)
    expect(Math.abs(tremoloZero.output[0][1])).toBeLessThanOrEqual(1e-5)

    const panLeft = await render(48_000, 'autopan', { ...createDefaultAutoPanParams(), rateHz: 1, depth: 1, shape: 0.5, phase: 0.75 }, 2)
    expect(Math.abs(panLeft.output[1][1])).toBeLessThanOrEqual(1e-5)
    const panRight = await render(48_000, 'autopan', { ...createDefaultAutoPanParams(), rateHz: 1, depth: 1, shape: 0.5, phase: 0.25 }, 2)
    expect(Math.abs(panRight.output[0][1])).toBeLessThanOrEqual(1e-5)
  })

  test('phaser response stays finite and stereo state is isolated', async () => {
    const processor = await loadProcessor(48_000, 'phaser')
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 2, processorKind: 'phaser', state: { ...createDefaultPhaserParams(), feedback: 0.95, depthOctaves: 5, centerHz: 8000 } } })
    const left = new Float32Array(48_000)
    left[0] = 1
    const output = [new Float32Array(left.length), new Float32Array(left.length)]
    processor.process([[left, new Float32Array(left.length)]], [output])
    expect(output[0].every(Number.isFinite)).toBe(true)
    expect(output[1].every(Number.isFinite)).toBe(true)
    expect(output[1].some((value) => value !== 0)).toBe(false)
  })

  test('bypass is transparent, reset deterministic, kind immutable, and nonfinite input faults', async () => {
    const bypassed = await render(48_000, 'chorus', { ...createDefaultChorusParams(), enabled: false }, 257, false)
    expect(bypassed.output[0]).toEqual(bypassed.input[0])
    expect(bypassed.output[1]).toEqual(bypassed.input[0])

    const processor = await loadProcessor(48_000, 'flanger')
    const input = Float32Array.from({ length: 512 }, (_, index) => Math.sin(index * 0.1))
    processor.process([[input]], [[new Float32Array(512), new Float32Array(512)]])
    processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
    const resetOutput = [new Float32Array(512), new Float32Array(512)]
    processor.process([[input]], [resetOutput])
    const fresh = await loadProcessor(48_000, 'flanger')
    const freshOutput = [new Float32Array(512), new Float32Array(512)]
    fresh.process([[input]], [freshOutput])
    expect(resetOutput).toEqual(freshOutput)

    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 3, processorKind: 'chorus', state: createDefaultChorusParams() } })
    expect(processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'immutable-processor-kind' })
    const nonfiniteOutput = [new Float32Array(1), new Float32Array(1)]
    processor.process([[Float32Array.of(Number.NaN)]], [nonfiniteOutput])
    expect(nonfiniteOutput[0].every(Number.isFinite)).toBe(true)
    expect(processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'nonfinite-input' })
  })
})
