import { describe, expect, test } from 'bun:test'
import { createRecorderCapture } from './recorder-core'
import { RECORDER_BLOCK_FRAMES, RECORDER_POOL_BLOCKS } from './recording-protocol'

const quantum = (channels: readonly number[][]): Float32Array[] =>
  channels.map((channel) => Float32Array.from(channel))

describe('bounded recorder capture', () => {
  test('maps mono and unavailable channels with gain and polarity', () => {
    const messages: Parameters<ReturnType<typeof createRecorderCapture>['returnBuffer']>[] = []
    const emitted: Array<{ frameCount: number; buffer: ArrayBuffer }> = []
    const recorder = createRecorderCapture({
      generation: 1,
      sessionId: 'mono',
      channelCount: 2,
      inputChannels: [0, 3],
      gain: 2,
      polarity: -1,
      punchStartFrame: 0,
      punchEndFrame: null,
      emit: (message) => emitted.push(message),
    })
    recorder.process(quantum([[0.25, -0.5]]), 0)
    recorder.finalize()
    expect(emitted).toHaveLength(1)
    const message = emitted[0]
    if (!message) throw new Error('Missing recorder block.')
    const samples = new Float32Array(message.buffer)
    expect(Array.from(samples.subarray(0, 2))).toEqual([-0.5, 1])
    expect(Array.from(samples.subarray(RECORDER_BLOCK_FRAMES, RECORDER_BLOCK_FRAMES + 2))).toEqual([0, 0])
    expect(message.frameCount).toBe(2)
    void messages
  })

  test('applies exact punch boundaries within render quanta and flushes a partial block', () => {
    const emitted: Array<{ frameCount: number; buffer: ArrayBuffer }> = []
    const recorder = createRecorderCapture({
      generation: 2,
      sessionId: 'punch',
      channelCount: 1,
      inputChannels: [0],
      gain: 1,
      polarity: 1,
      punchStartFrame: 2,
      punchEndFrame: 6,
      emit: (message) => emitted.push(message),
    })
    recorder.process(quantum([[0, 1, 2, 3]]), 0)
    recorder.process(quantum([[4, 5, 6, 7]]), 4)
    recorder.finalize()
    recorder.finalize()
    expect(recorder.process(quantum([[8]]), 8)).toBeFalse()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.frameCount).toBe(4)
    expect(Array.from(new Float32Array(emitted[0]?.buffer).subarray(0, 4))).toEqual([2, 3, 4, 5])
  })

  test('enforces exclusive ownership and rejects double returns', () => {
    const emitted: Array<{ blockId: number; buffer: ArrayBuffer }> = []
    const recorder = createRecorderCapture({
      generation: 3,
      sessionId: 'ownership',
      channelCount: 1,
      inputChannels: [0],
      gain: 1,
      polarity: 1,
      punchStartFrame: 0,
      punchEndFrame: null,
      emit: (message) => emitted.push(message),
    })
    recorder.process([new Float32Array(RECORDER_BLOCK_FRAMES)], 0)
    const block = emitted[0]
    if (!block) throw new Error('Missing recorder block.')
    recorder.returnBuffer(block.blockId, block.buffer)
    expect(() => recorder.returnBuffer(block.blockId, block.buffer)).toThrow('not owned by transport')
  })

  test('counts starvation and becomes fatal on the first dropped frame', () => {
    const recorder = createRecorderCapture({
      generation: 4,
      sessionId: 'overflow',
      channelCount: 1,
      inputChannels: [0],
      gain: 1,
      polarity: 1,
      punchStartFrame: 0,
      punchEndFrame: null,
      emit: () => undefined,
    })
    for (let index = 0; index < RECORDER_POOL_BLOCKS; index += 1) {
      recorder.process([new Float32Array(RECORDER_BLOCK_FRAMES)], index * RECORDER_BLOCK_FRAMES)
    }
    expect(recorder.process(
      [new Float32Array(1)],
      RECORDER_POOL_BLOCKS * RECORDER_BLOCK_FRAMES,
    )).toBeFalse()
    expect(recorder.stats()).toMatchObject({
      capturedFrames: RECORDER_POOL_BLOCKS * RECORDER_BLOCK_FRAMES,
      droppedFrames: 1,
      droppedBlocks: 1,
      fatal: true,
    })
  })

  test('models thirty minutes without growing the fixed pool or retaining PCM', () => {
    const returned: Array<{ blockId: number; buffer: ArrayBuffer }> = []
    const recorder = createRecorderCapture({
      generation: 5,
      sessionId: 'long',
      channelCount: 2,
      inputChannels: [0, 1],
      gain: 1,
      polarity: 1,
      punchStartFrame: 0,
      punchEndFrame: null,
      emit: (message) => returned.push(message),
    })
    const block = [new Float32Array(RECORDER_BLOCK_FRAMES), new Float32Array(RECORDER_BLOCK_FRAMES)]
    const totalBlocks = Math.ceil(30 * 60 * 48_000 / RECORDER_BLOCK_FRAMES)
    for (let index = 0; index < totalBlocks; index += 1) {
      recorder.process(block, index * RECORDER_BLOCK_FRAMES)
      const message = returned.shift()
      if (!message) throw new Error('Expected an emitted block.')
      recorder.returnBuffer(message.blockId, message.buffer)
    }
    expect(returned).toHaveLength(0)
    expect(recorder.stats()).toMatchObject({
      availableBlocks: RECORDER_POOL_BLOCKS,
      transportBlocks: 0,
      droppedFrames: 0,
      fatal: false,
    })
  })
})
