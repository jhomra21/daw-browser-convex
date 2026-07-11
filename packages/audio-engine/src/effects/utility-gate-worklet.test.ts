import { describe, expect, test } from 'bun:test'
import { gateWorklet, utilityWorklet } from '../worklet-manifest'

type Port = {
  onmessage: ((event: { data: unknown }) => void) | null
  messages: unknown[]
  closed: boolean
  postMessage: (message: unknown) => void
  close: () => void
}
type Processor = {
  port: Port
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}
type ProcessorConstructor = new () => Processor

const publicRoot = new URL('../../../../public/', import.meta.url)

const loadProcessor = async (modulePath: string, processorName: string, sampleRate: number) => {
  const source = await Bun.file(new URL(modulePath, publicRoot)).text()
  const registered = new Map<string, ProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: Port = {
      onmessage: null,
      messages: [],
      closed: false,
      postMessage: (message: unknown) => this.port.messages.push(message),
      close: () => { this.port.closed = true },
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    sampleRate,
  )
  const Constructor = registered.get(processorName)
  if (!Constructor) throw new Error(`${processorName} did not register.`)
  return new Constructor()
}

const configure = (processor: Processor, state: object) => {
  const onmessage = processor.port.onmessage
  if (!onmessage) throw new Error('Processor message handler is unavailable.')
  onmessage({ data: { type: 'configure', version: 1, revision: 1, state } })
}

const message = (processor: Processor, data: object) => {
  const onmessage = processor.port.onmessage
  if (!onmessage) throw new Error('Processor message handler is unavailable.')
  onmessage({ data })
}

const utilityParams = (updates: Partial<Record<string, number>> = {}) => ({
  'utility.gainDb': Float32Array.of(updates['utility.gainDb'] ?? 0),
  'utility.pan': Float32Array.of(updates['utility.pan'] ?? 0),
  'utility.balance': Float32Array.of(updates['utility.balance'] ?? 0),
  'utility.width': Float32Array.of(updates['utility.width'] ?? 1),
})

const gateParams = (updates: Partial<Record<string, number>> = {}) => ({
  'gate.thresholdDb': Float32Array.of(updates['gate.thresholdDb'] ?? -40),
  'gate.ratio': Float32Array.of(updates['gate.ratio'] ?? 4),
  'gate.attackMs': Float32Array.of(updates['gate.attackMs'] ?? 0.1),
  'gate.holdMs': Float32Array.of(updates['gate.holdMs'] ?? 0),
  'gate.releaseMs': Float32Array.of(updates['gate.releaseMs'] ?? 5),
  'gate.hysteresisDb': Float32Array.of(updates['gate.hysteresisDb'] ?? 6),
  'gate.rangeDb': Float32Array.of(updates['gate.rangeDb'] ?? -80),
  'gate.lookaheadMs': Float32Array.of(updates['gate.lookaheadMs'] ?? 0),
  'gate.link': Float32Array.of(updates['gate.link'] ?? 1),
})

const utilityState = (updates: Partial<Record<string, unknown>> = {}) => ({
  enabled: true,
  polarity: 'normal',
  inputMode: 'stereo',
  matrix: 'stereo',
  swap: false,
  dcBlock: false,
  ...updates,
})

const gateState = (updates: Partial<Record<string, unknown>> = {}) => ({
  enabled: true,
  mode: 'gate',
  detector: 'peak',
  sidechain: { enabled: false, frequencyHz: 80, q: 0.707 },
  ...updates,
})

const renderUtility = async (
  sampleRate: number,
  left: Float32Array,
  right: Float32Array | undefined,
  state = utilityState(),
  params = utilityParams(),
) => {
  const processor = await loadProcessor(utilityWorklet.modulePath, utilityWorklet.processorName, sampleRate)
  configure(processor, state)
  const output = [new Float32Array(left.length), new Float32Array(left.length)]
  processor.process([[left, ...(right ? [right] : [])]], [output], params)
  return { processor, output }
}

const maxError = (actual: Float32Array, expected: Float32Array) => {
  let result = 0
  for (let index = 0; index < actual.length; index += 1) result = Math.max(result, Math.abs(actual[index] - expected[index]))
  return result
}

describe('utility static worklet numerical characterization', () => {
  for (const sampleRate of [44_100, 48_000, 96_000]) {
    for (const channels of [1, 2]) {
      test(`${sampleRate} Hz ${channels === 1 ? 'mono' : 'stereo'} unity`, async () => {
        const left = Float32Array.from({ length: 257 }, (_, index) => Math.sin(index * 0.17) * 0.7)
        const right = channels === 2 ? Float32Array.from(left, (value) => -value * 0.5) : undefined
        const { output } = await renderUtility(sampleRate, left, right)
        expect(maxError(output[0], left)).toBeLessThanOrEqual(1e-6)
        expect(maxError(output[1], right ?? left)).toBeLessThanOrEqual(1e-6)
      })
    }
  }

  test('mono sum, polarity, swap, pan, balance, and width are deterministic', async () => {
    const left = Float32Array.of(1)
    const right = Float32Array.of(-0.5)
    expect((await renderUtility(48_000, left, right, utilityState({ inputMode: 'mono-sum' }))).output.map((channel) => channel[0])).toEqual([0.25, 0.25])
    expect((await renderUtility(48_000, left, right, utilityState({ polarity: 'invert', swap: true }))).output.map((channel) => channel[0])).toEqual([0.5, -1])
    const panned = await renderUtility(48_000, left, right, utilityState(), utilityParams({ 'utility.pan': 1 }))
    expect(Math.abs(panned.output[0][0])).toBeLessThanOrEqual(1e-6)
    expect(panned.output[1][0]).toBeCloseTo(-Math.SQRT2 * 0.5, 6)
    const balanced = await renderUtility(48_000, left, right, utilityState(), utilityParams({ 'utility.balance': 1 }))
    expect(balanced.output[0][0]).toBe(0)
    expect(balanced.output[1][0]).toBeCloseTo(-0.5, 6)
    const monoWidth = await renderUtility(48_000, left, right, utilityState(), utilityParams({ 'utility.width': 0 }))
    expect(monoWidth.output[0][0]).toBeCloseTo(0.25, 6)
    expect(monoWidth.output[1][0]).toBeCloseTo(0.25, 6)
  })

  test('mid-side encode and decode roundtrip within two ppm', async () => {
    const left = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index * 0.11))
    const right = Float32Array.from({ length: 128 }, (_, index) => Math.cos(index * 0.07) * 0.6)
    const encoded = await renderUtility(48_000, left, right, utilityState({ matrix: 'mid-side-encode' }))
    const decoded = await renderUtility(48_000, encoded.output[0], encoded.output[1], utilityState({ matrix: 'mid-side-decode' }))
    expect(maxError(decoded.output[0], left)).toBeLessThanOrEqual(2e-6)
    expect(maxError(decoded.output[1], right)).toBeLessThanOrEqual(2e-6)
  })

  test('DC blocker settles below -80 dBFS after one second', async () => {
    const input = new Float32Array(48_000).fill(0.5)
    const { output } = await renderUtility(48_000, input, input, utilityState({ dcBlock: true }))
    expect(20 * Math.log10(Math.max(Math.abs(output[0].at(-1) ?? 0), 1e-12))).toBeLessThanOrEqual(-80)
  })

  test('non-finite input zeros output, reports a fault, and reset is deterministic', async () => {
    const first = await renderUtility(48_000, Float32Array.of(Number.NaN, 0.5), undefined, utilityState({ dcBlock: true }))
    expect(first.output[0][0]).toBe(0)
    expect(first.processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'nonfinite-input' })
    message(first.processor, { type: 'reset', version: 1 })
    const output = [new Float32Array(2), new Float32Array(2)]
    first.processor.process([[Float32Array.of(0.5, 0)]], [output], utilityParams())
    const fresh = await renderUtility(48_000, Float32Array.of(0.5, 0), undefined, utilityState({ dcBlock: true }))
    expect(output).toEqual(fresh.output)
  })
})

describe('gate static worklet numerical characterization', () => {
  test('has fixed ceil two millisecond latency when enabled and bypassed at all sample rates', async () => {
    for (const sampleRate of [44_100, 48_000, 96_000]) {
      for (const enabled of [true, false]) {
        const processor = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, sampleRate)
        configure(processor, gateState({ enabled }))
        const latency = Math.ceil(0.002 * sampleRate)
        const input = new Float32Array(latency + 2).fill(1)
        const output = [new Float32Array(input.length), new Float32Array(input.length)]
        processor.process([[input]], [output], gateParams({ 'gate.thresholdDb': -80 }))
        expect(output[0][latency]).toBeCloseTo(1, 6)
      }
    }
  })

  test('open gain is within 0.1 dB and closed gain is within 0.5 dB of range', async () => {
    const sampleRate = 48_000
    const latency = 96
    const processor = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, sampleRate)
    configure(processor, gateState())
    const openInput = new Float32Array(sampleRate).fill(1)
    const openOutput = [new Float32Array(sampleRate), new Float32Array(sampleRate)]
    processor.process([[openInput]], [openOutput], gateParams({ 'gate.thresholdDb': -20 }))
    expect(20 * Math.log10(openOutput[0].at(-1) ?? 0)).toBeGreaterThanOrEqual(-0.1)
    const closedInput = new Float32Array(sampleRate).fill(0.001)
    const closedOutput = [new Float32Array(sampleRate), new Float32Array(sampleRate)]
    processor.process([[closedInput]], [closedOutput], gateParams({ 'gate.thresholdDb': -20, 'gate.rangeDb': -40 }))
    const closedGainDb = 20 * Math.log10((closedOutput[0].at(-1) ?? 0) / closedInput[latency])
    expect(closedGainDb).toBeCloseTo(-40, 0)
  })

  test('expander formula, hysteresis, hold, attack, and release produce bounded finite gain', async () => {
    const processor = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, 48_000)
    configure(processor, gateState({ mode: 'expander' }))
    const input = new Float32Array(24_000).fill(0.01)
    const output = [new Float32Array(input.length), new Float32Array(input.length)]
    processor.process([[input]], [output], gateParams({ 'gate.thresholdDb': -20, 'gate.ratio': 2, 'gate.rangeDb': -60, 'gate.attackMs': 5, 'gate.releaseMs': 20, 'gate.holdMs': 10, 'gate.hysteresisDb': 3 }))
    const gainDb = 20 * Math.log10((output[0].at(-1) ?? 0) / 0.01)
    expect(gainDb).toBeCloseTo(-20, 0)
    expect(output[0].every(Number.isFinite)).toBe(true)
  })

  test('external sidechain changes gain reduction without leaking into output', async () => {
    const processor = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, 48_000)
    configure(processor, gateState({ sidechain: { enabled: true, frequencyHz: 80, q: 0.707 } }))
    const audio = new Float32Array(4_096).fill(0.25)
    const sidechain = new Float32Array(4_096).fill(1)
    const output = [new Float32Array(audio.length), new Float32Array(audio.length)]
    processor.process([[audio], [sidechain]], [output], gateParams({ 'gate.thresholdDb': -6 }))
    expect(Math.max(...output[0])).toBeLessThanOrEqual(0.25)
    expect(output[0].includes(1)).toBe(false)
  })

  test('meter cadence is bounded, non-finite input faults, reset is deterministic, and stereo stays isolated', async () => {
    const processor = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, 48_000)
    configure(processor, gateState())
    message(processor, { type: 'metering', version: 1, enabled: true })
    const left = new Float32Array(2_048)
    left[0] = Number.NaN
    left.fill(1, 1)
    const right = new Float32Array(2_048)
    right.fill(0.5, 2)
    const output = [new Float32Array(left.length), new Float32Array(left.length)]
    processor.process([[left, right]], [output], gateParams({ 'gate.thresholdDb': -80 }))
    expect(output[0][96]).toBe(0)
    expect(output[0][97]).toBeCloseTo(1, 6)
    expect(output[1][98]).toBeCloseTo(0.5, 6)
    expect(processor.port.messages.filter((entry) => typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'meter')).toHaveLength(1)
    expect(processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'nonfinite-input' })
    message(processor, { type: 'reset', version: 1 })
    const resetOutput = [new Float32Array(128), new Float32Array(128)]
    processor.process([[new Float32Array(128).fill(1)]], [resetOutput], gateParams({ 'gate.thresholdDb': -80 }))
    const fresh = await loadProcessor(gateWorklet.modulePath, gateWorklet.processorName, 48_000)
    configure(fresh, gateState())
    const freshOutput = [new Float32Array(128), new Float32Array(128)]
    fresh.process([[new Float32Array(128).fill(1)]], [freshOutput], gateParams({ 'gate.thresholdDb': -80 }))
    expect(resetOutput).toEqual(freshOutput)
  })
})
