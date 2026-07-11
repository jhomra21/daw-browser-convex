const MAX_GRAINS = 128
const MAX_CHANNELS = 2
const EMPTY = new Float32Array(0)

class DawGranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'grainSizeMs', defaultValue: 80, minValue: 5, maxValue: 1000, automationRate: 'a-rate' },
      { name: 'densityHz', defaultValue: 12, minValue: 0.25, maxValue: 200, automationRate: 'a-rate' },
      { name: 'position', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'spray', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'pitchSemitones', defaultValue: 0, minValue: -48, maxValue: 48, automationRate: 'a-rate' },
      { name: 'reverseProbability', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'stereoSpread', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'gate', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ]
  }

  constructor(options) {
    super()
    const config = options.processorOptions || {}
    this.seed = (config.seed || 1) >>> 0
    this.maxGrains = Math.max(1, Math.min(MAX_GRAINS, config.maxGrains || 64))
    this.windowShape = config.windowShape || 'hann'
    this.channels = [EMPTY, EMPTY]
    this.sampleRateSource = sampleRate
    this.nextGrainFrame = 0
    this.frozenPosition = -1
    this.freeze = false
    this.generation = 0
    this.active = new Uint8Array(MAX_GRAINS)
    this.cursor = new Float64Array(MAX_GRAINS)
    this.step = new Float64Array(MAX_GRAINS)
    this.age = new Uint32Array(MAX_GRAINS)
    this.length = new Uint32Array(MAX_GRAINS)
    this.pan = new Float32Array(MAX_GRAINS)
    this.port.onmessage = (event) => {
      const data = event.data
      if (!data || data.version !== 1) return
      if (data.type === 'install') {
        if (!Number.isInteger(data.generation) || data.generation < this.generation || !Array.isArray(data.channels) || !(data.channels[0] instanceof Float32Array)) {
          this.port.postMessage({ type: 'error', version: 1, generation: data.generation || 0, code: 'invalid-install' })
          return
        }
        this.generation = data.generation
        this.channels[0] = data.channels[0]
        this.channels[1] = data.channels[1] instanceof Float32Array ? data.channels[1] : this.channels[0]
        this.sampleRateSource = data.sampleRate || sampleRate
        this.nextGrainFrame = 0
        this.active.fill(0)
        this.port.postMessage({ type: 'installed', version: 1, generation: data.generation })
        return
      }
      if (data.type === 'release' && Number.isInteger(data.generation) && data.generation >= this.generation) {
        this.generation = data.generation
        this.channels[0] = EMPTY
        this.channels[1] = EMPTY
        this.active.fill(0)
        return
      }
      if (data.type === 'reset-seed') {
        this.seed = (data.seed || 1) >>> 0
        this.nextGrainFrame = 0
        this.active.fill(0)
        return
      }
      if (data.type === 'freeze') {
        this.freeze = data.freeze === true
        if (!this.freeze) this.frozenPosition = -1
      }
    }
  }

  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }

  window(phase) {
    if (this.windowShape === 'tukey') {
      if (phase < 0.25) return 0.5 * (1 - Math.cos(4 * Math.PI * phase))
      if (phase > 0.75) return 0.5 * (1 - Math.cos(4 * Math.PI * (1 - phase)))
      return 1
    }
    if (this.windowShape === 'gaussian') {
      const x = (phase - 0.5) / 0.18
      return Math.exp(-0.5 * x * x)
    }
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase)
  }

  spawn(frame, parameters) {
    const sourceLength = this.channels[0].length
    if (sourceLength === 0) return
    let slot = -1
    for (let index = 0; index < this.maxGrains; index += 1) if (this.active[index] === 0) { slot = index; break }
    if (slot < 0) return
    const at = (name) => parameters[name].length === 1 ? parameters[name][0] : parameters[name][frame]
    const grainFrames = Math.max(1, Math.round(at('grainSizeMs') * 0.001 * sampleRate))
    const requestedPosition = at('position')
    if (this.freeze && this.frozenPosition < 0) this.frozenPosition = requestedPosition
    const position = this.frozenPosition >= 0 ? this.frozenPosition : requestedPosition
    const spread = this.freeze ? 0 : (this.random() * 2 - 1) * at('spray') * sourceLength
    const reverse = this.random() < at('reverseProbability')
    const rate = Math.pow(2, at('pitchSemitones') / 12) * this.sampleRateSource / sampleRate
    this.active[slot] = 1
    this.length[slot] = grainFrames
    this.age[slot] = 0
    this.step[slot] = reverse ? -rate : rate
    this.cursor[slot] = Math.max(0, Math.min(sourceLength - 1, position * (sourceLength - 1) + spread))
    this.pan[slot] = (this.random() * 2 - 1) * at('stereoSpread')
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0]
    const left = output[0]
    const right = output[1] || left
    for (let frame = 0; frame < left.length; frame += 1) {
      if (this.nextGrainFrame <= 0) {
        this.spawn(frame, parameters)
        const density = parameters.densityHz.length === 1 ? parameters.densityHz[0] : parameters.densityHz[frame]
        this.nextGrainFrame += Math.max(1, sampleRate / density)
      }
      this.nextGrainFrame -= 1
      let l = 0
      let r = 0
      for (let index = 0; index < this.maxGrains; index += 1) {
        if (this.active[index] === 0) continue
        const cursor = this.cursor[index]
        const base = Math.floor(cursor)
        if (base < 0 || base >= this.channels[0].length - 1 || this.age[index] >= this.length[index]) {
          this.active[index] = 0
          continue
        }
        const fraction = cursor - base
        const a = this.channels[0][base] * (1 - fraction) + this.channels[0][base + 1] * fraction
        const b = this.channels[1][base] * (1 - fraction) + this.channels[1][base + 1] * fraction
        const window = this.window(this.age[index] / Math.max(1, this.length[index] - 1))
        const pan = this.pan[index]
        l += a * window * Math.sqrt((1 - pan) * 0.5)
        r += b * window * Math.sqrt((1 + pan) * 0.5)
        this.cursor[index] += this.step[index]
        this.age[index] += 1
      }
      const gate = parameters.gate.length === 1 ? parameters.gate[0] : parameters.gate[frame]
      if (right === left) left[frame] = (l + r) * 0.7071067811865476 * gate
      else {
        left[frame] = l * gate
        right[frame] = r * gate
      }
    }
    return true
  }
}

registerProcessor('daw-granular-processor', DawGranularProcessor)
