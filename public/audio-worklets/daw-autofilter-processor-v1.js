const PARAMS = [
  ['autofilter.frequencyHz', 1000, 20, 20000],
  ['autofilter.resonance', 0.25, 0, 1],
  ['autofilter.driveDb', 0, 0, 24],
  ['autofilter.mix', 1, 0, 1],
  ['autofilter.envelope.amountOctaves', 0, -6, 6],
  ['autofilter.envelope.attackMs', 10, 0.5, 500],
  ['autofilter.envelope.releaseMs', 100, 5, 2000],
  ['autofilter.lfo.rateHz', 1, 0.01, 20],
  ['autofilter.lfo.depthOctaves', 0, 0, 6],
  ['autofilter.lfo.phaseOffset', 0, 0, 1],
  ['autofilter.lfo.stereoPhase', 0, -0.5, 0.5],
]
const LATENCY = 6
const valueAt = (values, index) => values[values.length === 1 ? 0 : index]
const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

class DawAutoFilterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' }))
  }

  constructor() {
    super()
    this.revision = -1
    this.state = { enabled: true, mode: 'lowpass', lfo: { waveform: 'sine' }, quality: '2x' }
    this.channels = [this.createChannel(), this.createChannel()]
    this.delay = [new Float64Array(LATENCY), new Float64Array(LATENCY)]
    this.delayIndex = 0
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  createChannel() {
    return { ic1: 0, ic2: 0, envelope: 0, phase: 0, previous: 0 }
  }

  reset() {
    this.channels = [this.createChannel(), this.createChannel()]
    this.delay[0].fill(0)
    this.delay[1].fill(0)
    this.delayIndex = 0
    this.bypass = this.state.enabled ? 0 : 1
  }

  onMessage(message) {
    if (!message || typeof message !== 'object' || message.version !== 1) return this.fault('malformed-message')
    if (message.type === 'dispose') return this.port.close()
    if (message.type === 'reset') return this.reset()
    if (message.type !== 'configure' || !Number.isInteger(message.revision) || message.revision <= this.revision || !message.state || typeof message.state !== 'object') return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    this.state = message.state
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  lfo(phase) {
    const wrapped = phase - Math.floor(phase)
    return this.state.lfo && this.state.lfo.waveform === 'triangle'
      ? 1 - 4 * Math.abs(wrapped - 0.5)
      : Math.sin(2 * Math.PI * wrapped)
  }

  filter(channel, input, cutoff, q, mode) {
    const g = Math.tan(Math.PI * cutoff / (sampleRate * 2))
    const k = 1 / q
    const a1 = 1 / (1 + g * (g + k))
    const v1 = a1 * (channel.ic1 + g * (input - channel.ic2))
    const v2 = channel.ic2 + g * v1
    channel.ic1 = 2 * v1 - channel.ic1
    channel.ic2 = 2 * v2 - channel.ic2
    const high = input - k * v1 - v2
    if (mode === 'highpass') return high
    if (mode === 'bandpass') return v1
    if (mode === 'notch') return high + v2
    if (mode === 'peak') return v2 - high
    return v2
  }

  processChannel(channelIndex, input, parameters, frame) {
    const channel = this.channels[channelIndex]
    const attack = Math.exp(-1 / (Math.max(0.5, valueAt(parameters['autofilter.envelope.attackMs'], frame)) * 0.001 * sampleRate))
    const release = Math.exp(-1 / (Math.max(5, valueAt(parameters['autofilter.envelope.releaseMs'], frame)) * 0.001 * sampleRate))
    const peak = Math.abs(input)
    channel.envelope = peak > channel.envelope ? attack * channel.envelope + (1 - attack) * peak : release * channel.envelope + (1 - release) * peak
    const rate = valueAt(parameters['autofilter.lfo.rateHz'], frame)
    const phaseOffset = valueAt(parameters['autofilter.lfo.phaseOffset'], frame)
    const stereoPhase = channelIndex === 0 ? 0 : valueAt(parameters['autofilter.lfo.stereoPhase'], frame)
    const lfo = this.lfo(channel.phase + phaseOffset + stereoPhase)
    channel.phase = (channel.phase + rate / sampleRate) % 1
    const envOctaves = valueAt(parameters['autofilter.envelope.amountOctaves'], frame) * channel.envelope
    const lfoOctaves = valueAt(parameters['autofilter.lfo.depthOctaves'], frame) * lfo
    const cutoff = clamp(valueAt(parameters['autofilter.frequencyHz'], frame) * (2 ** (envOctaves + lfoOctaves)), 20, 0.45 * sampleRate)
    const q = 0.5 + 19.5 * valueAt(parameters['autofilter.resonance'], frame)
    const drive = 10 ** (valueAt(parameters['autofilter.driveDb'], frame) / 20)
    const driven = Math.tanh(input * drive)
    const midpoint = 0.5 * (channel.previous + driven)
    this.filter(channel, midpoint, cutoff, q, this.state.mode)
    const wet = this.filter(channel, driven, cutoff, q, this.state.mode)
    channel.previous = driven
    return input + (wet - input) * valueAt(parameters['autofilter.mix'], frame)
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const leftIn = input && input[0]
    const rightIn = input && input[1]
    const targetBypass = this.state.enabled ? 0 : 1
    const bypassStep = 1 / Math.max(1, Math.round(0.01 * sampleRate))
    for (let frame = 0; frame < output[0].length; frame++) {
      this.bypass += clamp(targetBypass - this.bypass, -bypassStep, bypassStep)
      for (let channelIndex = 0; channelIndex < output.length; channelIndex++) {
        let sample = channelIndex === 0 ? (leftIn ? leftIn[frame] : 0) : (rightIn ? rightIn[frame] : (leftIn ? leftIn[frame] : 0))
        if (!Number.isFinite(sample)) {
          sample = 0
          this.fault('nonfinite-input')
        }
        const processed = this.processChannel(channelIndex, sample, parameters, frame)
        const mixed = Number.isFinite(processed) ? processed + (sample - processed) * this.bypass : 0
        if (!Number.isFinite(processed)) {
          this.channels[channelIndex] = this.createChannel()
          this.fault('nonfinite-state')
        }
        const delayed = this.delay[channelIndex][this.delayIndex]
        this.delay[channelIndex][this.delayIndex] = mixed
        output[channelIndex][frame] = delayed
      }
      this.delayIndex = (this.delayIndex + 1) % LATENCY
    }
    return true
  }
}

registerProcessor('daw-autofilter-processor', DawAutoFilterProcessor)
