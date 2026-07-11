import { describe, expect, test } from 'bun:test'
import { normalizeCompressorParams } from '@daw-browser/shared'
import { computeCompressorWorkletCurveDb } from './effects/compressor-worklet'
import { compressorWorklet, recorderWorklet, trackMeterWorklet } from './worklet-manifest'

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
    'currentFrame',
    `${source}\nreturn { curveDb: typeof curveDb === 'function' ? curveDb : undefined }`,
  )
  const exports = evaluate(
    FakeAudioWorkletProcessor,
    (name: string, processor: ProcessorConstructor) => registered.set(name, processor),
    48_000,
    0,
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

  test('registers and flushes transformed PCM from the exact recorder asset', async () => {
    const evaluated = await evaluateAsset(recorderWorklet.modulePath)
    const Processor = evaluated.registered.get(recorderWorklet.processorName)
    expect(Processor).toBeFunction()
    if (!Processor) throw new Error('Recorder processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Recorder processor did not bind its message handler.')
    onmessage({
      data: {
        type: 'configure',
        generation: 1,
        sessionId: 'asset',
        channelCount: 2,
        inputChannels: [0, 2],
        gain: 2,
        polarity: -1,
        punchStartFrame: 0,
        punchEndFrame: null,
      },
    })
    expect(processor.process([[Float32Array.from([0.25, -0.5])]])).toBe(true)
    onmessage({ data: { type: 'finalize', generation: 1, sessionId: 'asset' } })
    const message = processor.port.messages[0]
    if (typeof message !== 'object' || message === null || !('buffer' in message) || !(message.buffer instanceof ArrayBuffer)) {
      throw new Error('Recorder did not emit a transferable block.')
    }
    const samples = new Float32Array(message.buffer)
    expect(Array.from(samples.subarray(0, 2))).toEqual([-0.5, 1])
    expect(Array.from(samples.subarray(2048, 2050))).toEqual([0, 0])
    expect(message).toMatchObject({ type: 'block', frameCount: 2, channelCount: 2 })
    expect(processor.port.messages[1]).toEqual({
      type: 'complete',
      generation: 1,
      sessionId: 'asset',
      capturedFrames: 2,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    onmessage({ data: { type: 'finalize', generation: 1, sessionId: 'asset' } })
    expect(processor.process([[Float32Array.from([1])]])).toBe(false)
    expect(processor.port.messages).toHaveLength(2)
  })

  test('fails the exact recorder asset on the first starved frame and emits no later blocks', async () => {
    const evaluated = await evaluateAsset(recorderWorklet.modulePath)
    const Processor = evaluated.registered.get(recorderWorklet.processorName)
    if (!Processor) throw new Error('Recorder processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Recorder processor did not bind its message handler.')
    onmessage({
      data: {
        type: 'configure',
        generation: 3,
        sessionId: 'starved',
        channelCount: 1,
        inputChannels: [0],
        gain: 1,
        polarity: 1,
        punchStartFrame: 0,
        punchEndFrame: null,
      },
    })
    const fullBlock = new Float32Array(2048)
    for (let index = 0; index < 32; index += 1) {
      expect(processor.process([[fullBlock]])).toBe(true)
    }
    expect(processor.process([[Float32Array.from([1])]])).toBe(false)
    expect(processor.port.messages.at(-1)).toEqual({
      type: 'failure',
      generation: 3,
      sessionId: 'starved',
      reason: 'recorder-overrun',
      capturedFrames: 32 * 2048,
      droppedFrames: 1,
      droppedBlocks: 1,
    })
    const messageCount = processor.port.messages.length
    onmessage({ data: { type: 'finalize', generation: 3, sessionId: 'starved' } })
    expect(processor.port.messages).toHaveLength(messageCount)
  })
})
