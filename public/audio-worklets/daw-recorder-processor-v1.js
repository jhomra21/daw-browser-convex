const BLOCK_FRAMES = 2048
const POOL_BLOCKS = 32
const FATAL_DROPPED_FRAMES = 1
const SAB_READ_INDEX = 0
const SAB_WRITE_INDEX = 1
const SAB_NOTIFICATION = 2
const SAB_DROPPED_FRAMES = 3
const SAB_DROPPED_BLOCKS = 4

class DawRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.session = null
    this.blocks = []
    this.current = null
    this.currentStartFrame = null
    this.pending = null
    this.writeOffset = 0
    this.sequence = 0
    this.capturedFrames = 0
    this.droppedFrames = 0
    this.droppedBlocks = 0
    this.fatal = false
    this.completed = false
    this.sab = null
    this.port.onmessage = (event) => this.handleMessage(event.data)
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return this.fail('malformed-message')
    if (message.type === 'initialize-sab') {
      if (
        this.session ||
        this.sab ||
        !(message.state instanceof SharedArrayBuffer) ||
        !(message.frameCounts instanceof SharedArrayBuffer) ||
        !(message.samples instanceof SharedArrayBuffer)
      ) return this.fail('invalid-sab-configuration')
      const state = new Int32Array(message.state)
      const frameCounts = new Int32Array(message.frameCounts)
      const samples = new Float32Array(message.samples)
      if (state.length !== 5 || frameCounts.length !== POOL_BLOCKS || samples.length !== POOL_BLOCKS * BLOCK_FRAMES * 2) {
        return this.fail('invalid-sab-configuration')
      }
      this.sab = { state, frameCounts, samples }
      return
    }
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
      if (!this.sab) {
        const bytes = BLOCK_FRAMES * message.channelCount * Float32Array.BYTES_PER_ELEMENT
        this.blocks = Array.from({ length: POOL_BLOCKS }, (_, id) => {
          const buffer = new ArrayBuffer(bytes)
          return { id, owner: 'available', buffer, view: new Float32Array(buffer) }
        })
      }
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
      const stopFrame = Number.isSafeInteger(message.stopContextFrame) ? message.stopContextFrame : currentFrame
      this.emitThrough(stopFrame)
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
    if (this.sab) {
      const reservedIndex = this.sequence + (this.pending ? 1 : 0)
      const readIndex = Atomics.load(this.sab.state, SAB_READ_INDEX)
      if (reservedIndex - readIndex >= POOL_BLOCKS) return null
      const slot = reservedIndex % POOL_BLOCKS
      const slotOffset = slot * BLOCK_FRAMES * 2
      return {
        id: slot,
        owner: 'capture',
        buffer: null,
        view: this.sab.samples.subarray(slotOffset, slotOffset + BLOCK_FRAMES * 2),
      }
    }
    for (const block of this.blocks) {
      if (block.owner !== 'available') continue
      block.owner = 'capture'
      return block
    }
    return null
  }

  emitCurrent() {
    if (!this.current || this.writeOffset === 0) return
    if (this.pending) this.emitBlock(this.pending)
    this.pending = {
      block: this.current,
      frameCount: this.writeOffset,
      startFrame: this.currentStartFrame,
    }
    this.current = null
    this.currentStartFrame = null
    this.writeOffset = 0
  }

  emitBlock(pending, frameCount = pending.frameCount) {
    if (this.sab) {
      let sum = 0
      let peak = 0
      const sampleCount = frameCount * this.session.channelCount
      for (let channel = 0; channel < this.session.channelCount; channel += 1) {
        const offset = channel * BLOCK_FRAMES
        for (let frame = 0; frame < frameCount; frame += 1) {
          const value = pending.block.view[offset + frame] ?? 0
          sum += value * value
          peak = Math.max(peak, Math.abs(value))
        }
      }
      this.port.postMessage({
        type: 'meter',
        generation: this.session.generation,
        sessionId: this.session.sessionId,
        rms: sampleCount > 0 ? Math.sqrt(sum / sampleCount) : 0,
        peak,
      })
    }
    if (this.sab) {
      const writeIndex = Atomics.load(this.sab.state, SAB_WRITE_INDEX)
      const slot = writeIndex % POOL_BLOCKS
      if (pending.block.id !== slot) return this.fail('invalid-sab-write-order')
      Atomics.store(this.sab.frameCounts, slot, frameCount)
      Atomics.store(this.sab.state, SAB_WRITE_INDEX, writeIndex + 1)
      Atomics.add(this.sab.state, SAB_NOTIFICATION, 1)
      Atomics.notify(this.sab.state, SAB_NOTIFICATION)
      this.port.postMessage({
        type: 'sab-notify',
        generation: this.session.generation,
        sessionId: this.session.sessionId,
      })
      this.sequence += 1
      return
    }
    const message = {
      type: 'block',
      generation: this.session.generation,
      sessionId: this.session.sessionId,
      blockId: pending.block.id,
      sequence: this.sequence,
      frameCount,
      channelCount: this.session.channelCount,
      buffer: pending.block.buffer,
    }
    pending.block.owner = 'transport'
    this.sequence += 1
    this.port.postMessage(message, [message.buffer])
  }

  emitThrough(stopFrame) {
    const candidates = []
    if (this.pending) candidates.push(this.pending)
    if (this.current && this.writeOffset > 0) {
      candidates.push({
        block: this.current,
        frameCount: this.writeOffset,
        startFrame: this.currentStartFrame,
      })
    }
    let retainedFrames = 0
    for (const candidate of candidates) {
      const frameCount = Math.max(0, Math.min(candidate.frameCount, stopFrame - candidate.startFrame))
      if (frameCount > 0) {
        this.emitBlock(candidate, frameCount)
        retainedFrames += frameCount
      } else {
        candidate.block.owner = 'available'
      }
    }
    const candidateFrames = candidates.reduce((total, candidate) => total + candidate.frameCount, 0)
    this.capturedFrames -= candidateFrames - retainedFrames
    this.pending = null
    this.current = null
    this.currentStartFrame = null
    this.writeOffset = 0
  }

  process(inputs, outputs = []) {
    if (!this.session) return true
    if (this.fatal || this.completed) return false
    const input = inputs[0] ?? []
    const output = outputs[0] ?? []
    const quantumFrames = input[0]?.length ?? 0
    for (let frameIndex = 0; frameIndex < quantumFrames; frameIndex += 1) {
      const absoluteFrame = currentFrame + frameIndex
      let processed0 = 0
      let processed1 = 0
      for (let channel = 0; channel < this.session.channelCount; channel += 1) {
        const source = input[this.session.inputChannels[channel]]
        const sample = source ? (source[frameIndex] ?? 0) * this.session.gain * this.session.polarity : 0
        if (channel === 0) processed0 = sample
        else processed1 = sample
        if (output[channel]) output[channel][frameIndex] = sample
      }
      if (
        absoluteFrame < this.session.punchStartFrame ||
        (this.session.punchEndFrame !== null && absoluteFrame >= this.session.punchEndFrame)
      ) continue
      if (!this.current) {
        this.current = this.acquire()
        this.currentStartFrame = absoluteFrame
      }
      if (!this.current) {
        this.droppedFrames += 1
        if (this.droppedFrames % BLOCK_FRAMES === 1) this.droppedBlocks += 1
        if (this.sab) {
          Atomics.add(this.sab.state, SAB_DROPPED_FRAMES, 1)
          if (this.droppedFrames % BLOCK_FRAMES === 1) Atomics.add(this.sab.state, SAB_DROPPED_BLOCKS, 1)
        }
        if (this.droppedFrames >= FATAL_DROPPED_FRAMES) this.fail('recorder-overrun')
        return false
      }
      this.current.view[this.writeOffset] = processed0
      if (this.session.channelCount === 2) this.current.view[BLOCK_FRAMES + this.writeOffset] = processed1
      this.writeOffset += 1
      this.capturedFrames += 1
      if (this.writeOffset === BLOCK_FRAMES) this.emitCurrent()
    }
    return !this.fatal
  }
}

registerProcessor('daw-recorder-processor', DawRecorderProcessor)
