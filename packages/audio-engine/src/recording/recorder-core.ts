import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_FATAL_DROPPED_FRAMES,
  RECORDER_MAX_CHANNELS,
  RECORDER_POOL_BLOCKS,
  RECORDER_POOL_PAYLOAD_MAX_BYTES,
  type RecorderBlockMessage,
} from './recording-protocol'

type BlockOwner = 'available' | 'capture' | 'transport'

type RecorderBlock = {
  id: number
  owner: BlockOwner
  buffer: ArrayBuffer
  view: Float32Array
}

type RecorderCaptureOptions = {
  generation: number
  sessionId: string
  channelCount: number
  inputChannels: readonly number[]
  gain: number
  polarity: 1 | -1
  punchStartFrame: number
  punchEndFrame: number | null
  buffers?: readonly ArrayBuffer[]
  emit: (message: RecorderBlockMessage) => void
}

type RecorderCaptureStats = {
  capturedFrames: number
  droppedFrames: number
  droppedBlocks: number
  availableBlocks: number
  transportBlocks: number
  fatal: boolean
}

const createBuffers = (channelCount: number): ArrayBuffer[] =>
  Array.from(
    { length: RECORDER_POOL_BLOCKS },
    () => new ArrayBuffer(RECORDER_BLOCK_FRAMES * channelCount * Float32Array.BYTES_PER_ELEMENT),
  )

export const createRecorderCapture = (options: RecorderCaptureOptions) => {
  if (!Number.isInteger(options.channelCount) || options.channelCount < 1 || options.channelCount > RECORDER_MAX_CHANNELS) {
    throw new Error('Recorder channel count is invalid.')
  }
  if (options.inputChannels.length !== options.channelCount || options.inputChannels.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new Error('Recorder input channel mapping is invalid.')
  }
  if (!Number.isFinite(options.gain) || options.gain < 0) throw new Error('Recorder gain is invalid.')
  if (!Number.isSafeInteger(options.punchStartFrame) || options.punchStartFrame < 0) {
    throw new Error('Recorder punch start is invalid.')
  }
  if (
    options.punchEndFrame !== null &&
    (!Number.isSafeInteger(options.punchEndFrame) || options.punchEndFrame < options.punchStartFrame)
  ) throw new Error('Recorder punch end is invalid.')

  const buffers = options.buffers ?? createBuffers(options.channelCount)
  const expectedBytes = RECORDER_BLOCK_FRAMES * options.channelCount * Float32Array.BYTES_PER_ELEMENT
  if (expectedBytes * RECORDER_POOL_BLOCKS > RECORDER_POOL_PAYLOAD_MAX_BYTES) {
    throw new Error('Recorder transferable pool exceeds its payload bound.')
  }
  if (buffers.length !== RECORDER_POOL_BLOCKS || buffers.some((buffer) => buffer.byteLength !== expectedBytes)) {
    throw new Error('Recorder transferable pool is invalid.')
  }
  const blocks: RecorderBlock[] = buffers.map((buffer, id) => ({
    id,
    owner: 'available',
    buffer,
    view: new Float32Array(buffer),
  }))
  let current: RecorderBlock | null = null
  let writeOffset = 0
  let sequence = 0
  let capturedFrames = 0
  let droppedFrames = 0
  let droppedBlocks = 0
  let fatal = false
  let finalized = false

  const acquire = (): RecorderBlock | null => {
    for (const block of blocks) {
      if (block.owner !== 'available') continue
      block.owner = 'capture'
      return block
    }
    return null
  }

  const emitCurrent = () => {
    if (!current || writeOffset === 0) return
    current.owner = 'transport'
    options.emit({
      type: 'block',
      generation: options.generation,
      sessionId: options.sessionId,
      blockId: current.id,
      sequence,
      frameCount: writeOffset,
      channelCount: options.channelCount,
      buffer: current.buffer,
    })
    sequence += 1
    current = null
    writeOffset = 0
  }

  const process = (inputs: readonly Float32Array[], quantumStartFrame: number): boolean => {
    if (fatal || finalized) return false
    const quantumFrames = inputs[0]?.length ?? 0
    if (quantumFrames === 0) return true
    for (let frameIndex = 0; frameIndex < quantumFrames; frameIndex += 1) {
      const absoluteFrame = quantumStartFrame + frameIndex
      if (
        absoluteFrame < options.punchStartFrame ||
        (options.punchEndFrame !== null && absoluteFrame >= options.punchEndFrame)
      ) continue
      if (!current) current = acquire()
      if (!current) {
        droppedFrames += 1
        if (droppedFrames % RECORDER_BLOCK_FRAMES === 1) droppedBlocks += 1
        if (droppedFrames >= RECORDER_FATAL_DROPPED_FRAMES) fatal = true
        return false
      }
      for (let outputChannel = 0; outputChannel < options.channelCount; outputChannel += 1) {
        const input = inputs[options.inputChannels[outputChannel] ?? -1]
        current.view[outputChannel * RECORDER_BLOCK_FRAMES + writeOffset] = input
          ? (input[frameIndex] ?? 0) * options.gain * options.polarity
          : 0
      }
      writeOffset += 1
      capturedFrames += 1
      if (writeOffset === RECORDER_BLOCK_FRAMES) emitCurrent()
    }
    return !fatal
  }

  const returnBuffer = (blockId: number, buffer: ArrayBuffer) => {
    const block = blocks[blockId]
    if (!block || block.owner !== 'transport') throw new Error('Recorder buffer is not owned by transport.')
    if (buffer.byteLength !== expectedBytes) throw new Error('Returned recorder buffer has an invalid size.')
    block.buffer = buffer
    block.view = new Float32Array(buffer)
    block.owner = 'available'
  }

  const finalize = () => {
    if (finalized) return
    finalized = true
    if (!fatal) emitCurrent()
  }

  const stats = (): RecorderCaptureStats => ({
    capturedFrames,
    droppedFrames,
    droppedBlocks,
    availableBlocks: blocks.filter((block) => block.owner === 'available').length,
    transportBlocks: blocks.filter((block) => block.owner === 'transport').length,
    fatal,
  })

  return { process, returnBuffer, finalize, stats }
}
