import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../../public/audio-worklets/daw-granular-processor-v1.js', import.meta.url), 'utf8')

type GranularProcessorOptions = {
  seed?: number
  maxGrains?: number
}

type GranularProcessor = {
  port: { onmessage: ((event: { data: object }) => void) | null }
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}

describe('granular worklet source', () => {
  test('uses a bounded preallocated pool and sample-accurate parameters', () => {
    expect(source).toContain('const MAX_GRAINS = 128')
    expect(source).toContain("automationRate: 'a-rate'")
    expect(source).toContain('new Uint8Array(MAX_GRAINS)')
    expect(source).toContain('new Float64Array(MAX_GRAINS)')
    expect(source).toContain('const right = output[1] || left')
    expect(source).toContain('if (right === left) left[frame] = (l + r) * 0.7071067811865476 * gate')
  })

  test('downmixes a centered mono grain without overwriting one side', () => {
    const registered = new Map<string, new (options?: { processorOptions: GranularProcessorOptions }) => GranularProcessor>()
    class FakeAudioWorkletProcessor {
      port = {
        onmessage: null,
        postMessage: () => undefined,
      }
    }
    const evaluate = new Function(
      'AudioWorkletProcessor',
      'registerProcessor',
      'sampleRate',
      `${source}`,
    )
    evaluate(
      FakeAudioWorkletProcessor,
      (name: string, processor: new (options?: { processorOptions: GranularProcessorOptions }) => GranularProcessor) => registered.set(name, processor),
      48_000,
    )
    const Processor = registered.get('daw-granular-processor')
    if (!Processor) throw new Error('Granular processor was not registered.')
    const processor = new Processor({ processorOptions: { seed: 1, maxGrains: 1 } })
    const channel = new Float32Array(256).fill(1)
    processor.port.onmessage?.({
      data: {
        type: 'install',
        version: 1,
        generation: 1,
        channels: [channel, channel],
        sampleRate: 48_000,
      },
    })
    const output = new Float32Array(16)
    const parameters = {
      grainSizeMs: Float32Array.of(80),
      densityHz: Float32Array.of(200),
      position: Float32Array.of(0),
      spray: Float32Array.of(0),
      pitchSemitones: Float32Array.of(0),
      reverseProbability: Float32Array.of(0),
      stereoSpread: Float32Array.of(0),
      gate: Float32Array.of(1),
    }
    expect(processor.process([[new Float32Array(16)]], [[output]], parameters)).toBe(true)
    expect(output[1]).toBeCloseTo(0.5 - 0.5 * Math.cos(2 * Math.PI / 3839), 8)
  })

  test('does not allocate, log, or schedule timers in process', () => {
    const processBody = source.slice(source.indexOf('process(inputs'))
    expect(processBody).not.toContain('new ')
    expect(processBody).not.toContain('console.')
    expect(processBody).not.toContain('setTimeout')
    expect(processBody).not.toContain('setInterval')
    expect(processBody).not.toContain('.map(')
    expect(processBody).not.toContain('.slice(')
  })
})
