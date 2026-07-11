import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_CHANNELS,
  RECORDER_POOL_BLOCKS,
} from './recording-protocol'

const READ_INDEX = 0
const WRITE_INDEX = 1
const NOTIFICATION = 2
const DROPPED_FRAMES = 3
const DROPPED_BLOCKS = 4
const HEADER_LENGTH = 5

export type RecorderSabRingBuffers = {
  state: SharedArrayBuffer
  frameCounts: SharedArrayBuffer
  samples: SharedArrayBuffer
}

type RecorderSabBlock = {
  sequence: number
  frameCount: number
  channels: readonly Float32Array[]
}

export const createRecorderSabRingBuffers = (): RecorderSabRingBuffers => ({
  state: new SharedArrayBuffer(HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT),
  frameCounts: new SharedArrayBuffer(RECORDER_POOL_BLOCKS * Int32Array.BYTES_PER_ELEMENT),
  samples: new SharedArrayBuffer(
    RECORDER_POOL_BLOCKS *
    RECORDER_BLOCK_FRAMES *
    RECORDER_MAX_CHANNELS *
    Float32Array.BYTES_PER_ELEMENT,
  ),
})

const createViews = (buffers: RecorderSabRingBuffers) => {
  const state = new Int32Array(buffers.state)
  const frameCounts = new Int32Array(buffers.frameCounts)
  const samples = new Float32Array(buffers.samples)
  if (
    state.length !== HEADER_LENGTH ||
    frameCounts.length !== RECORDER_POOL_BLOCKS ||
    samples.length !== RECORDER_POOL_BLOCKS * RECORDER_BLOCK_FRAMES * RECORDER_MAX_CHANNELS
  ) throw new Error('Recorder SAB ring buffers are invalid.')
  return { state, frameCounts, samples }
}

export const createRecorderSabRingProducer = (buffers: RecorderSabRingBuffers) => {
  const views = createViews(buffers)

  const push = (channels: readonly Float32Array[], frameCount: number): boolean => {
    if (
      channels.length < 1 ||
      channels.length > RECORDER_MAX_CHANNELS ||
      !Number.isInteger(frameCount) ||
      frameCount < 1 ||
      frameCount > RECORDER_BLOCK_FRAMES ||
      channels.some((channel) => channel.length < frameCount)
    ) throw new Error('Recorder SAB block is invalid.')
    const writeIndex = Atomics.load(views.state, WRITE_INDEX)
    const readIndex = Atomics.load(views.state, READ_INDEX)
    if (writeIndex - readIndex >= RECORDER_POOL_BLOCKS) {
      Atomics.add(views.state, DROPPED_FRAMES, frameCount)
      Atomics.add(views.state, DROPPED_BLOCKS, 1)
      return false
    }
    const slot = writeIndex % RECORDER_POOL_BLOCKS
    const slotOffset = slot * RECORDER_BLOCK_FRAMES * RECORDER_MAX_CHANNELS
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      const source = channels[channelIndex]
      if (!source) continue
      views.samples.set(
        source.subarray(0, frameCount),
        slotOffset + channelIndex * RECORDER_BLOCK_FRAMES,
      )
    }
    Atomics.store(views.frameCounts, slot, frameCount)
    Atomics.store(views.state, WRITE_INDEX, writeIndex + 1)
    Atomics.add(views.state, NOTIFICATION, 1)
    Atomics.notify(views.state, NOTIFICATION)
    return true
  }

  return {
    push,
    stats: () => ({
      droppedFrames: Atomics.load(views.state, DROPPED_FRAMES),
      droppedBlocks: Atomics.load(views.state, DROPPED_BLOCKS),
    }),
  }
}

export const createRecorderSabRingConsumer = (
  buffers: RecorderSabRingBuffers,
  channelCount: number,
) => {
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > RECORDER_MAX_CHANNELS) {
    throw new Error('Recorder SAB channel count is invalid.')
  }
  const views = createViews(buffers)

  const pop = (): RecorderSabBlock | null => {
    const readIndex = Atomics.load(views.state, READ_INDEX)
    if (readIndex === Atomics.load(views.state, WRITE_INDEX)) return null
    const slot = readIndex % RECORDER_POOL_BLOCKS
    const frameCount = Atomics.load(views.frameCounts, slot)
    if (frameCount < 1 || frameCount > RECORDER_BLOCK_FRAMES) {
      throw new Error('Recorder SAB frame count is invalid.')
    }
    const slotOffset = slot * RECORDER_BLOCK_FRAMES * RECORDER_MAX_CHANNELS
    const channels: Float32Array[] = []
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = new Float32Array(frameCount)
      channel.set(views.samples.subarray(
        slotOffset + channelIndex * RECORDER_BLOCK_FRAMES,
        slotOffset + channelIndex * RECORDER_BLOCK_FRAMES + frameCount,
      ))
      channels.push(channel)
    }
    Atomics.store(views.state, READ_INDEX, readIndex + 1)
    return { sequence: readIndex, frameCount, channels }
  }

  const waitForData = async (): Promise<void> => {
    if (Atomics.load(views.state, READ_INDEX) !== Atomics.load(views.state, WRITE_INDEX)) return
    const notification = Atomics.load(views.state, NOTIFICATION)
    if (Atomics.load(views.state, READ_INDEX) !== Atomics.load(views.state, WRITE_INDEX)) return
    await Atomics.waitAsync(views.state, NOTIFICATION, notification).value
  }

  return {
    pop,
    waitForData,
    notify: () => {
      Atomics.add(views.state, NOTIFICATION, 1)
      Atomics.notify(views.state, NOTIFICATION)
    },
    stats: () => ({
      droppedFrames: Atomics.load(views.state, DROPPED_FRAMES),
      droppedBlocks: Atomics.load(views.state, DROPPED_BLOCKS),
    }),
  }
}
