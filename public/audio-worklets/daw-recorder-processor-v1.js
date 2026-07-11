const BLOCK_FRAMES = 2048
const POOL_BLOCKS = 32
const FATAL_DROPPED_FRAMES = 1

class DawRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.session = null
    this.blocks = []
    this.current = null
    this.writeOffset = 0
    this.sequence = 0
    this.capturedFrames = 0
    this.droppedFrames = 0
    this.droppedBlocks = 0
    this.fatal = false
    this.completed = false
    this.port.onmessage = (event) => this.handleMessage(event.data)
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return this.fail('malformed-message')
    if (message.type === 'configure') {
      if (
        this.session ||
        !Number.isSafeInteger(message.generation) ||
        message.generation < 0 ||
        typeof message.sessionId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(message.sessionId) ||
        !Number.isInteger(message.channelCount) ||
        message.channelCount < 1 ||
        message.channelCount > 2 ||
        !Array.isArray(message.inputChannels) ||
        message.inputChannels.length !== message.channelCount ||
        message.inputChannels.some((index) => !Number.isInteger(index) || index < 0) ||
        !Number.isFinite(message.gain) ||
        message.gain < 0 ||
        (message.polarity !== 1 && message.polarity !== -1) ||
        !Number.isSafeInteger(message.punchStartFrame) ||
        message.punchStartFrame < 0 ||
        (message.punchEndFrame !== null &&
          (!Number.isSafeInteger(message.punchEndFrame) || message.punchEndFrame < message.punchStartFrame))
      ) return this.fail('invalid-configuration')
      this.session = message
      const bytes = BLOCK_FRAMES * message.channelCount * Float32Array.BYTES_PER_ELEMENT
      this.blocks = Array.from({ length: POOL_BLOCKS }, (_, id) => {
        const buffer = new ArrayBuffer(bytes)
        return { id, owner: 'available', buffer, view: new Float32Array(buffer) }
      })
      return
    }
    if (!this.session || message.generation !== this.session.generation || message.sessionId !== this.session.sessionId) return
    if (message.type === 'return') {
      const block = this.blocks[message.blockId]
      const expectedBytes = BLOCK_FRAMES * this.session.channelCount * Float32Array.BYTES_PER_ELEMENT
      if (!block || block.owner !== 'transport' || !(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== expectedBytes) {
        return this.fail('invalid-buffer-return')
      }
      block.buffer = message.buffer
      block.view = new Float32Array(message.buffer)
      block.owner = 'available'
      return
    }
    if (message.type === 'finalize') {
      if (this.completed || this.fatal) return
      this.completed = true
      this.emitCurrent()
      this.port.postMessage({
        type: 'complete',
        generation: this.session.generation,
        sessionId: this.session.sessionId,
        capturedFrames: this.capturedFrames,
        droppedFrames: this.droppedFrames,
        droppedBlocks: this.droppedBlocks,
      })
      return
    }
    this.fail('malformed-message')
  }

  fail(reason) {
    if (this.fatal || this.completed) return
    this.fatal = true
    this.port.postMessage({
      type: 'failure',
      generation: this.session?.generation ?? 0,
      sessionId: this.session?.sessionId ?? '',
      reason,
      capturedFrames: this.capturedFrames,
      droppedFrames: this.droppedFrames,
      droppedBlocks: this.droppedBlocks,
    })
  }

  acquire() {
    for (const block of this.blocks) {
      if (block.owner !== 'available') continue
      block.owner = 'capture'
      return block
    }
    return null
  }

  emitCurrent() {
    if (!this.current || this.writeOffset === 0) return
    const message = {
      type: 'block',
      generation: this.session.generation,
      sessionId: this.session.sessionId,
      blockId: this.current.id,
      sequence: this.sequence,
      frameCount: this.writeOffset,
      channelCount: this.session.channelCount,
      buffer: this.current.buffer,
    }
    this.current.owner = 'transport'
    this.current = null
    this.writeOffset = 0
    this.sequence += 1
    this.port.postMessage(message, [message.buffer])
  }

  process(inputs) {
    if (!this.session) return true
    if (this.fatal || this.completed) return false
    const input = inputs[0] ?? []
    const quantumFrames = input[0]?.length ?? 0
    for (let frameIndex = 0; frameIndex < quantumFrames; frameIndex += 1) {
      const absoluteFrame = currentFrame + frameIndex
      if (
        absoluteFrame < this.session.punchStartFrame ||
        (this.session.punchEndFrame !== null && absoluteFrame >= this.session.punchEndFrame)
      ) continue
      if (!this.current) this.current = this.acquire()
      if (!this.current) {
        this.droppedFrames += 1
        if (this.droppedFrames % BLOCK_FRAMES === 1) this.droppedBlocks += 1
        if (this.droppedFrames >= FATAL_DROPPED_FRAMES) this.fail('recorder-overrun')
        return false
      }
      for (let channel = 0; channel < this.session.channelCount; channel += 1) {
        const source = input[this.session.inputChannels[channel]]
        this.current.view[channel * BLOCK_FRAMES + this.writeOffset] =
          source ? (source[frameIndex] ?? 0) * this.session.gain * this.session.polarity : 0
      }
      this.writeOffset += 1
      this.capturedFrames += 1
      if (this.writeOffset === BLOCK_FRAMES) this.emitCurrent()
    }
    return !this.fatal
  }
}

registerProcessor('daw-recorder-processor', DawRecorderProcessor)
