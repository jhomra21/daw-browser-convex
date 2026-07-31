const PARAMS = [
  ['lofi.bitDepth', 12, 2, 24],
  ['lofi.sampleRateRatio', 1, 0.01, 1],
  ['lofi.jitter', 0, 0, 1],
  ['lofi.noiseDb', -80, -120, -24],
  ['lofi.mix', 1, 0, 1],
]

class DawLoFiProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' }))
  }

  constructor(_options) {
    super()
    this.revision = -1
    this.state = { enabled: true, quantization: 'round', dither: 'off', seed: 1 }
    this.initialSeed = 1
    this.channels = []
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  onMessage(message) {
    if (!message || typeof message !== 'object' || message.version !== 1) return this.fault('malformed-message')
    if (message.type === 'dispose') return this.port.close()
    if (message.type === 'reset') return this.reset()
    if (message.type !== 'configure' || !Number.isInteger(message.revision) || message.revision <= this.revision || !message.state || typeof message.state !== 'object') return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    this.state = message.state
    const seed = Number.isInteger(message.state.seed) && message.state.seed > 0 ? message.state.seed >>> 0 : 1
    if (seed !== this.initialSeed) {
      this.initialSeed = seed
      this.reset()
    }
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  reset() {
    this.channels = []
    this.bypass = this.state.enabled ? 0 : 1
  }

  random(channel) {
    let value = channel.randomState
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    channel.randomState = value >>> 0 || 1
    return channel.randomState / 0x100000000
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  parameter(parameters, name, frame) {
    const values = parameters[name]
    return values[values.length === 1 ? 0 : frame]
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const bypassStep = 1 / Math.max(1, Math.round(0.01 * sampleRate))
    const targetBypass = this.state.enabled ? 0 : 1
    for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
      if (!this.channels[channelIndex]) {
        const channelSeed = (this.initialSeed ^ (channelIndex === 0 ? 0 : 0x9e3779b9)) >>> 0 || 1
        this.channels[channelIndex] = { phase: 1, held: 0, interval: 1, randomState: channelSeed }
      }
    }
    for (let frame = 0; frame < output[0].length; frame++) {
      for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
        const source = input && (input[channelIndex] || input[0])
        const target = output[channelIndex]
        const channel = this.channels[channelIndex]
        let dry = source ? source[frame] : 0
        if (!Number.isFinite(dry)) {
          dry = 0
          this.fault('nonfinite-input')
        }
        const ratio = this.parameter(parameters, 'lofi.sampleRateRatio', frame)
        channel.phase += ratio
        if (channel.phase >= channel.interval) {
          channel.phase -= channel.interval
          const jitter = this.parameter(parameters, 'lofi.jitter', frame)
          channel.interval = 1 + (this.random(channel) - 0.5) * jitter
          const bits = Math.round(this.parameter(parameters, 'lofi.bitDepth', frame))
          const levels = 2 ** (bits - 1) - 1
          const lsb = 1 / levels
          const noise = (this.random(channel) * 2 - 1) * 10 ** (this.parameter(parameters, 'lofi.noiseDb', frame) / 20)
          let sample = dry + noise
          if (this.state.dither === 'rectangular') sample += (this.random(channel) - 0.5) * lsb
          else if (this.state.dither === 'triangular') sample += (this.random(channel) - this.random(channel)) * lsb
          const scaled = sample * levels
          const quantized = this.state.quantization === 'floor' ? Math.floor(scaled) : this.state.quantization === 'truncate' ? Math.trunc(scaled) : Math.round(scaled)
          channel.held = Math.max(-1, Math.min(1, quantized / levels))
        }
        const mix = this.parameter(parameters, 'lofi.mix', frame)
        const processed = dry + (channel.held - dry) * mix
        const value = processed
        target[frame] = Number.isFinite(value) ? value : dry
        if (!Number.isFinite(value)) this.fault('nonfinite-state')
      }
      this.bypass += Math.max(-bypassStep, Math.min(bypassStep, targetBypass - this.bypass))
      for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
        const source = input && (input[channelIndex] || input[0])
        const target = output[channelIndex]
        const dry = source ? (Number.isFinite(source[frame]) ? source[frame] : 0) : 0
        const processed = target[frame]
        const value = processed + (dry - processed) * this.bypass
        target[frame] = Number.isFinite(value) ? value : dry
        if (!Number.isFinite(value)) this.fault('nonfinite-state')
      }
    }
    return true
  }
}

registerProcessor('daw-lofi-processor', DawLoFiProcessor)
