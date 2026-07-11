import { describe, expect, test } from 'bun:test'
import { autoFilterWorklet } from '../worklet-manifest'

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  messages: unknown[]
  postMessage: (message: unknown) => void
  close: () => void
}
type Processor = {
  port: Port
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}
type ProcessorConstructor = new () => Processor

const loadProcessor = async (sampleRate: number) => {
  const source = await Bun.file(new URL(`../../../../public/${autoFilterWorklet.modulePath}`, import.meta.url)).text()
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
  const Constructor = registered.get(autoFilterWorklet.processorName)
  if (!Constructor) throw new Error('AutoFilter processor did not register.')
  return new Constructor()
}

const state = (enabled: boolean, mode = 'lowpass') => ({
  enabled,
  mode,
  quality: '2x',
  envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
  lfo: { waveform: 'sine', rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 },
})

const params = (frequencyHz = 1000, resonance = 0.25) => ({
  'autofilter.frequencyHz': Float32Array.of(frequencyHz),
  'autofilter.resonance': Float32Array.of(resonance),
  'autofilter.driveDb': Float32Array.of(0),
  'autofilter.mix': Float32Array.of(1),
  'autofilter.envelope.amountOctaves': Float32Array.of(0),
  'autofilter.envelope.attackMs': Float32Array.of(10),
  'autofilter.envelope.releaseMs': Float32Array.of(100),
  'autofilter.lfo.rateHz': Float32Array.of(1),
  'autofilter.lfo.depthOctaves': Float32Array.of(0),
  'autofilter.lfo.phaseOffset': Float32Array.of(0),
  'autofilter.lfo.stereoPhase': Float32Array.of(0),
})

const configure = (processor: Processor, enabled: boolean, mode = 'lowpass') => {
  processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: state(enabled, mode) } })
}

describe('AutoFilter static worklet', () => {
  test('preserves exact six-frame latency in enabled and bypass states', async () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const enabled of [true, false]) {
        const processor = await loadProcessor(sampleRate)
        configure(processor, enabled)
        const input = new Float32Array(32)
        input[0] = 1
        const output = [new Float32Array(32)]
        processor.process([[input]], [output], params())
        expect(output[0].findIndex((value) => value !== 0)).toBe(6)
      }
    }
  })

  test('all modes remain finite for mono and stereo extreme inputs', async () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const mode of ['lowpass', 'highpass', 'bandpass', 'notch', 'peak']) {
        const processor = await loadProcessor(sampleRate)
        configure(processor, true, mode)
        const left = Float32Array.from({ length: 2048 }, (_, index) => index === 0 ? Number.NaN : Math.sin(index * 0.31) * 4)
        const right = Float32Array.from(left, (value) => Number.isFinite(value) ? -value : value)
        const output = [new Float32Array(left.length), new Float32Array(left.length)]
        processor.process([[left, right]], [output], params(20_000, 1))
        expect(output[0].every(Number.isFinite)).toBe(true)
        expect(output[1].every(Number.isFinite)).toBe(true)
        expect(processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'nonfinite-input' })
      }
    }
  })

  test('reset restores deterministic state and phase', async () => {
    const processor = await loadProcessor(48_000)
    configure(processor, true)
    const input = Float32Array.from({ length: 256 }, (_, index) => Math.sin(index * 0.1))
    processor.process([[input]], [[new Float32Array(256)]], params())
    processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
    const resetOutput = [new Float32Array(256)]
    processor.process([[input]], [resetOutput], params())
    const fresh = await loadProcessor(48_000)
    configure(fresh, true)
    const freshOutput = [new Float32Array(256)]
    fresh.process([[input]], [freshOutput], params())
    expect(resetOutput).toEqual(freshOutput)
  })
})
