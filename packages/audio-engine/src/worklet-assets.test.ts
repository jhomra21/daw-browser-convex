import { describe, expect, test } from 'bun:test'
import { normalizeCompressorParams } from '@daw-browser/shared'
import { computeCompressorWorkletCurveDb } from './effects/compressor-worklet'
import { createRecorderSabRingBuffers, createRecorderSabRingConsumer } from './recording/sab-ring-buffer'
import { compressorWorklet, gateWorklet, limiterWorklet, modulationWorklet, recorderWorklet, trackMeterWorklet, utilityWorklet } from './worklet-manifest'

const publicRoot = new URL('../../../public/', import.meta.url)

type EvaluatedProcessor = {
  port: {
    onmessage: ((event: { data: unknown }) => void) | null
    messages: unknown[]
  }
  process: (inputs: Float32Array[][], outputs?: Float32Array[][], parameters?: Record<string, Float32Array>) => boolean
}

type ProcessorConstructor = new (options?: { processorOptions: { processorKind: string } }) => EvaluatedProcessor

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
  test('registers the shared modulation asset with immutable processor kind', async () => {
    const evaluated = await evaluateAsset(modulationWorklet.modulePath)
    const Processor = evaluated.registered.get(modulationWorklet.processorName)
    if (!Processor) throw new Error('Modulation processor was not registered.')
    const processor = new Processor({ processorOptions: { processorKind: 'tremolo' } })
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, processorKind: 'tremolo', state: { enabled: true, waveform: 'sine', rateHz: 1, depth: 1, shape: 0.5, phase: 0.25 } } })
    const input = Float32Array.of(0.5)
    const output = [new Float32Array(1), new Float32Array(1)]
    expect(processor.process([[input]], [output])).toBe(true)
    expect(output[0][0]).toBeCloseTo(0.5, 6)
    expect(output[1][0]).toBeCloseTo(0.5, 6)
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 2, processorKind: 'chorus', state: {} } })
    expect(processor.port.messages).toContainEqual({ type: 'fault', version: 1, code: 'immutable-processor-kind' })
  })

  test('registers utility and preserves stereo unity through the exact asset', async () => {
    const evaluated = await evaluateAsset(utilityWorklet.modulePath)
    const Processor = evaluated.registered.get(utilityWorklet.processorName)
    if (!Processor) throw new Error('Utility processor was not registered.')
    const processor = new Processor()
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: { enabled: true, polarity: 'normal', inputMode: 'stereo', matrix: 'stereo', swap: false, dcBlock: false } } })
    const left = Float32Array.of(0.25, -0.5)
    const right = Float32Array.of(-0.125, 0.75)
    const output = [new Float32Array(2), new Float32Array(2)]
    expect(processor.process([[left, right]], [output], {
      'utility.gainDb': Float32Array.of(0),
      'utility.pan': Float32Array.of(0),
      'utility.balance': Float32Array.of(0),
      'utility.width': Float32Array.of(1),
    })).toBe(true)
    expect(Array.from(output[0])).toEqual(Array.from(left))
    expect(Array.from(output[1])).toEqual(Array.from(right))
  })

  test('registers gate with fixed two millisecond delayed bypass', async () => {
    const evaluated = await evaluateAsset(gateWorklet.modulePath)
    const Processor = evaluated.registered.get(gateWorklet.processorName)
    if (!Processor) throw new Error('Gate processor was not registered.')
    const processor = new Processor()
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: { enabled: false, mode: 'gate', detector: 'peak', sidechain: { enabled: false } } } })
    const input = new Float32Array(98)
    input[0] = 1
    const output = new Float32Array(98)
    const parameters = Object.fromEntries(namesForGateTest().map((name) => [name, Float32Array.of(name === 'gate.lookaheadMs' ? 0 : name === 'gate.rangeDb' ? -80 : name === 'gate.thresholdDb' ? -40 : name === 'gate.ratio' ? 4 : name === 'gate.attackMs' ? 1 : name === 'gate.holdMs' ? 20 : name === 'gate.releaseMs' ? 120 : name === 'gate.hysteresisDb' ? 6 : 1)]))
    expect(processor.process([[input]], [[output]], parameters)).toBe(true)
    expect(output[96]).toBe(1)
  })

  test('registers limiter with fixed five millisecond delayed bypass', async () => {
    const evaluated = await evaluateAsset(limiterWorklet.modulePath)
    const Processor = evaluated.registered.get(limiterWorklet.processorName)
    if (!Processor) throw new Error('Limiter processor was not registered.')
    const processor = new Processor()
    processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: { enabled: false } } })
    const input = new Float32Array(242)
    input[0] = 1
    const output = new Float32Array(242)
    expect(processor.process([[input]], [[output]], {
      'limiter.ceiling': Float32Array.of(-1),
      'limiter.release': Float32Array.of(100),
      'limiter.lookaheadMs': Float32Array.of(5),
      'limiter.link': Float32Array.of(1),
      'limiter.detectorOversampling': Float32Array.of(4),
    })).toBe(true)
    expect(output[240]).toBe(1)
  })
  test('registers and processes the exact compressor asset with curve parity', async () => {
    const evaluated = await evaluateAsset(compressorWorklet.modulePath)
    const Processor = evaluated.registered.get(compressorWorklet.processorName)
    expect(Processor).toBeFunction()
    if (!Processor) throw new Error('Compressor processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Compressor processor did not bind its message handler.')
    onmessage({ data: { type: 'params', params: normalizeCompressorParams({ enabled: false, dryWet: 1 }) } })
    const input = new Float32Array(482)
    input[0] = 0.25
    input[1] = -0.5
    const output = new Float32Array(input.length)
    expect(processor.process([[input]], [[output]])).toBe(true)
    expect(output[479]).toBe(0)
    expect(output[480]).toBe(0.25)
    expect(output[481]).toBe(-0.5)

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
    onmessage({ data: { type: 'finalize', generation: 1, sessionId: 'asset', stopContextFrame: 2 } })
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
    onmessage({ data: { type: 'finalize', generation: 1, sessionId: 'asset', stopContextFrame: 2 } })
    expect(processor.process([[Float32Array.from([1])]])).toBe(false)
    expect(processor.port.messages).toHaveLength(2)
  })

  test('clips the pending recorder block at the exact stop frame and captures nothing after completion', async () => {
    const evaluated = await evaluateAsset(recorderWorklet.modulePath)
    const Processor = evaluated.registered.get(recorderWorklet.processorName)
    if (!Processor) throw new Error('Recorder processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Recorder processor did not bind its message handler.')
    onmessage({
      data: {
        type: 'configure',
        generation: 4,
        sessionId: 'bounded',
        channelCount: 1,
        inputChannels: [0],
        gain: 0.5,
        polarity: -1,
        punchStartFrame: 0,
        punchEndFrame: null,
      },
    })
    const input = Float32Array.from([1, 2, 3, 4])
    const output = new Float32Array(4)
    expect(processor.process([[input]], [[output]])).toBe(true)
    expect(Array.from(output)).toEqual([-0.5, -1, -1.5, -2])
    onmessage({ data: { type: 'finalize', generation: 4, sessionId: 'bounded', stopContextFrame: 2 } })
    const block = processor.port.messages[0]
    if (typeof block !== 'object' || block === null || !('buffer' in block) || !(block.buffer instanceof ArrayBuffer)) {
      throw new Error('Recorder did not emit its bounded block.')
    }
    expect(block).toMatchObject({ type: 'block', frameCount: 2 })
    expect(Array.from(new Float32Array(block.buffer).subarray(0, 2))).toEqual([-0.5, -1])
    expect(processor.port.messages[1]).toMatchObject({ type: 'complete', capturedFrames: 2 })
    expect(processor.process([[Float32Array.from([5])]], [[new Float32Array(1)]])).toBe(false)
    expect(processor.port.messages).toHaveLength(2)
  })

  test('writes recorder blocks into the SAB ring without transferable messages', async () => {
    const evaluated = await evaluateAsset(recorderWorklet.modulePath)
    const Processor = evaluated.registered.get(recorderWorklet.processorName)
    if (!Processor) throw new Error('Recorder processor was not registered.')
    const processor = new Processor()
    const onmessage = processor.port.onmessage
    if (!onmessage) throw new Error('Recorder processor did not bind its message handler.')
    const buffers = createRecorderSabRingBuffers()
    const consumer = createRecorderSabRingConsumer(buffers, 1)
    onmessage({ data: { type: 'initialize-sab', ...buffers } })
    onmessage({
      data: {
        type: 'configure',
        generation: 5,
        sessionId: 'sab',
        channelCount: 1,
        inputChannels: [0],
        gain: 1,
        polarity: 1,
        punchStartFrame: 0,
        punchEndFrame: null,
      },
    })
    expect(processor.process([[Float32Array.of(0.25, -0.5)]])).toBe(true)
    onmessage({ data: { type: 'finalize', generation: 5, sessionId: 'sab', stopContextFrame: 2 } })
    expect(consumer.pop()).toMatchObject({
      sequence: 0,
      frameCount: 2,
      channels: [Float32Array.of(0.25, -0.5)],
    })
    expect(processor.port.messages).toEqual([
      { type: 'meter', generation: 5, sessionId: 'sab', rms: Math.sqrt(0.15625), peak: 0.5 },
      { type: 'sab-notify', generation: 5, sessionId: 'sab' },
      {
        type: 'complete',
        generation: 5,
        sessionId: 'sab',
        capturedFrames: 2,
        droppedFrames: 0,
        droppedBlocks: 0,
      },
    ])
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

const namesForGateTest = () => ['gate.thresholdDb', 'gate.ratio', 'gate.attackMs', 'gate.holdMs', 'gate.releaseMs', 'gate.hysteresisDb', 'gate.rangeDb', 'gate.lookaheadMs', 'gate.link']
