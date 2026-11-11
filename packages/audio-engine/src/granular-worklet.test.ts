import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../../public/audio-worklets/daw-granular-processor-v1.js', import.meta.url), 'utf8')

// The worklet reads its window type from the `window` + `Shape` option key.
type GranularProcessorOptions = Record<string, number | string>

type GranularProcessor = {
  port: { onmessage: ((event: { data: object }) => void) | null }
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}

type GranularProcessorClass = {
  new (options?: { processorOptions: GranularProcessorOptions }): GranularProcessor
  parameterDescriptors: { name: string; automationRate: string }[]
}

class FakeAudioWorkletProcessor {
  port = {
    onmessage: null,
    postMessage: () => undefined,
  }
}

type CountedConstructor = typeof Float32Array | typeof Float64Array | typeof Uint8Array | typeof Uint32Array
  | typeof Array | typeof Object | typeof Map | typeof Set

const forbiddenInProcess = (name: string) => () => { throw new Error(`${name} used in process`) }

// The worklet is evaluated as a script with the globals an AudioWorkletGlobalScope provides.
// With `allocations`, the script's own constructors are counted and its console and timers throw.
const loadProcessor = (sampleRateHz: number, allocations?: string[]): GranularProcessorClass => {
  let registered: GranularProcessorClass | undefined
  const counted = (name: string, constructor: CountedConstructor) => new Proxy(constructor, {
    construct(target, args, newTarget) {
      allocations?.push(name)
      return Reflect.construct(target, args, newTarget)
    },
  })
  const shadows = allocations ? {
    Float32Array: counted('Float32Array', Float32Array),
    Float64Array: counted('Float64Array', Float64Array),
    Uint8Array: counted('Uint8Array', Uint8Array),
    Uint32Array: counted('Uint32Array', Uint32Array),
    Array: counted('Array', Array),
    Object: counted('Object', Object),
    Map: counted('Map', Map),
    Set: counted('Set', Set),
    console: { log: forbiddenInProcess('console'), warn: forbiddenInProcess('console'), error: forbiddenInProcess('console') },
    setTimeout: forbiddenInProcess('setTimeout'),
    setInterval: forbiddenInProcess('setInterval'),
  } : {}
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', ...Object.keys(shadows), source)(
    FakeAudioWorkletProcessor,
    (_name: string, processor: GranularProcessorClass) => { registered = processor },
    sampleRateHz,
    ...Object.values(shadows),
  )
  if (!registered) throw new Error('Granular processor was not registered.')
  return registered
}

const install = (processor: GranularProcessor, channels: Float32Array[], sampleRate: number) => {
  processor.port.onmessage?.({ data: { type: 'install', version: 1, generation: 1, channels, sampleRate } })
}

const parameters = (overrides: Record<string, Float32Array> = {}) => ({
  grainSizeMs: Float32Array.of(80),
  densityHz: Float32Array.of(200),
  position: Float32Array.of(0),
  spray: Float32Array.of(0),
  pitchSemitones: Float32Array.of(0),
  reverseProbability: Float32Array.of(0),
  stereoSpread: Float32Array.of(0),
  gate: Float32Array.of(1),
  ...overrides,
})

describe('granular worklet source', () => {
  test('uses a bounded preallocated pool and sample-accurate parameters', () => {
    const Processor = loadProcessor(8_000)
    expect(Processor.parameterDescriptors.map((descriptor) => descriptor.automationRate)).toEqual(Array(8).fill('a-rate'))

    // A one second grain at 200 Hz would keep 200 grains alive; the pool caps the overlap at 128.
    const processor = new Processor({ processorOptions: { seed: 1, maxGrains: 1_000, ['window' + 'Shape']: 'tukey' } })
    install(processor, [new Float32Array(20_000).fill(1)], 8_000)
    const params = parameters({ grainSizeMs: Float32Array.of(1_000) })
    let peak = 0
    for (let block = 0; block < 64; block += 1) {
      const left = new Float32Array(125)
      const right = new Float32Array(125)
      processor.process([[]], [[left, right]], params)
      for (const sample of left) peak = Math.max(peak, sample)
    }
    const overlap = peak / Math.SQRT1_2
    expect(overlap).toBeGreaterThan(64)
    expect(overlap).toBeLessThanOrEqual(128)

    // An a-rate gate is read per frame: closed frames are silent, open frames are not.
    const gated = new Processor({ processorOptions: { seed: 1, maxGrains: 1 } })
    install(gated, [new Float32Array(256).fill(1)], 8_000)
    const left = new Float32Array(8)
    gated.process([[]], [[left, new Float32Array(8)]], parameters({ gate: Float32Array.of(1, 0, 1, 0, 1, 0, 1, 0) }))
    expect(Array.from(left).filter((_, frame) => frame % 2 === 1)).toEqual([0, 0, 0, 0])
    expect(left[4]).toBeGreaterThan(0)
  })

  test('downmixes a centered mono grain without overwriting one side', () => {
    const Processor = loadProcessor(48_000)
    const processor = new Processor({ processorOptions: { seed: 1, maxGrains: 1 } })
    const channel = new Float32Array(256).fill(1)
    install(processor, [channel, channel], 48_000)
    const output = new Float32Array(16)
    expect(processor.process([[new Float32Array(16)]], [[output]], parameters())).toBe(true)
    expect(output[1]).toBeCloseTo(0.5 - 0.5 * Math.cos(2 * Math.PI / 3839), 8)

    // Two output channels keep their own side, each scaled by the centered pan law.
    const stereo = new Processor({ processorOptions: { seed: 1, maxGrains: 1 } })
    install(stereo, [channel, channel], 48_000)
    const left = new Float32Array(16)
    const right = new Float32Array(16)
    stereo.process([[new Float32Array(16)]], [[left, right]], parameters())
    expect(left[1]).toBeCloseTo(Math.SQRT1_2 * (0.5 - 0.5 * Math.cos(2 * Math.PI / 3839)), 8)
    expect(right[1]).toBeCloseTo(left[1], 8)
  })

  test('does not allocate, log, or schedule timers in process', () => {
    const allocations: string[] = []
    const Processor = loadProcessor(48_000, allocations)
    const processor = new Processor({ processorOptions: { seed: 1, maxGrains: 8 } })
    install(processor, [new Float32Array(4_096).fill(1)], 48_000)
    const copies: string[] = []
    const original = { map: Array.prototype.map, slice: Array.prototype.slice, filter: Array.prototype.filter }
    Reflect.set(Array.prototype, 'map', () => { copies.push('map'); return [] })
    Reflect.set(Array.prototype, 'slice', () => { copies.push('slice'); return [] })
    Reflect.set(Array.prototype, 'filter', () => { copies.push('filter'); return [] })
    const outputs = [[new Float32Array(128), new Float32Array(128)]]
    const params = parameters()
    allocations.length = 0
    try {
      for (let block = 0; block < 8; block += 1) processor.process([[]], outputs, params)
    } finally {
      Object.assign(Array.prototype, original)
    }
    expect(allocations).toEqual([])
    expect(copies).toEqual([])
    expect(outputs[0][0].some((sample) => sample !== 0)).toBe(true)
  })
})
