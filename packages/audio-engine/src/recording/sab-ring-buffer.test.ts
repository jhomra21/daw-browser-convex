import { describe, expect, test } from 'bun:test'
import { RECORDER_BLOCK_FRAMES, RECORDER_POOL_BLOCKS } from './recording-protocol'
import {
  createRecorderSabRingBuffers,
  createRecorderSabRingConsumer,
  createRecorderSabRingProducer,
} from './sab-ring-buffer'

describe('recorder SAB ring buffer', () => {
  test('preserves ordering across wraparound and reports empty', () => {
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const consumer = createRecorderSabRingConsumer(buffers, 1)
    for (let sequence = 0; sequence < RECORDER_POOL_BLOCKS * 3; sequence += 1) {
      expect(producer.push([Float32Array.of(sequence)], 1)).toBe(true)
      expect(consumer.pop()).toMatchObject({
        sequence,
        frameCount: 1,
        channels: [Float32Array.of(sequence)],
      })
    }
    expect(consumer.pop()).toBeNull()
  })

  test('never overwrites a full ring', () => {
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const consumer = createRecorderSabRingConsumer(buffers, 1)
    for (let sequence = 0; sequence < RECORDER_POOL_BLOCKS; sequence += 1) {
      expect(producer.push([Float32Array.of(sequence)], 1)).toBe(true)
    }
    expect(producer.push([Float32Array.of(999)], 1)).toBe(false)
    expect(producer.stats()).toEqual({ droppedFrames: 1, droppedBlocks: 1 })
    expect(Array.from({ length: RECORDER_POOL_BLOCKS }, () => consumer.pop()?.channels[0]?.[0]))
      .toEqual(Array.from({ length: RECORDER_POOL_BLOCKS }, (_, index) => index))
  })

  test('copies stereo full and final partial blocks', () => {
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const consumer = createRecorderSabRingConsumer(buffers, 2)
    const left = new Float32Array(RECORDER_BLOCK_FRAMES).fill(0.25)
    const right = new Float32Array(RECORDER_BLOCK_FRAMES).fill(-0.5)
    expect(producer.push([left, right], RECORDER_BLOCK_FRAMES)).toBe(true)
    expect(producer.push([Float32Array.of(1, 2), Float32Array.of(3, 4)], 2)).toBe(true)
    expect(consumer.pop()?.channels).toEqual([left, right])
    expect(consumer.pop()?.channels).toEqual([Float32Array.of(1, 2), Float32Array.of(3, 4)])
  })

  test('waits for producer notification without polling', async () => {
    const buffers = createRecorderSabRingBuffers()
    const producer = createRecorderSabRingProducer(buffers)
    const consumer = createRecorderSabRingConsumer(buffers, 1)
    const waiting = consumer.waitForData()
    expect(producer.push([Float32Array.of(7)], 1)).toBe(true)
    await waiting
    expect(consumer.pop()?.channels[0]).toEqual(Float32Array.of(7))
  })
})
