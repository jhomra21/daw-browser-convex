const TWO_PI = 2 * Math.PI
const MAX_DELAY_FRAMES = Math.ceil(0.043 * sampleRate) + 4
const KINDS = new Set(['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble'])
const PARAMETER_PROPERTIES = {
  chorus: ['delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'mix'],
  flanger: ['delayMs', 'depthMs', 'rateHz', 'feedback', 'stereoPhase', 'mix'],
  phaser: ['centerHz', 'depthOctaves', 'rateHz', 'feedback', 'stereoPhase', 'mix'],
  tremolo: ['rateHz', 'depth', 'shape', 'phase'],
  autopan: ['rateHz', 'depth', 'shape', 'phase'],
  ensemble: ['delayMs', 'depthMs', 'rateHz', 'spread', 'mix'],
}

class DawModulationProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      'chorus.delayMs', 'chorus.depthMs', 'chorus.rateHz', 'chorus.feedback', 'chorus.stereoPhase', 'chorus.mix',
      'flanger.delayMs', 'flanger.depthMs', 'flanger.rateHz', 'flanger.feedback', 'flanger.stereoPhase', 'flanger.mix',
      'phaser.centerHz', 'phaser.depthOctaves', 'phaser.rateHz', 'phaser.feedback', 'phaser.stereoPhase', 'phaser.mix',
      'tremolo.rateHz', 'tremolo.depth', 'tremolo.shape', 'tremolo.phase',
      'autopan.rateHz', 'autopan.depth', 'autopan.shape', 'autopan.phase',
      'ensemble.delayMs', 'ensemble.depthMs', 'ensemble.rateHz', 'ensemble.spread', 'ensemble.mix',
    ].map((name) => ({ name, defaultValue: 0, automationRate: 'a-rate' }))
  }

  constructor(options) {
    super()
    const requestedKind = options && options.processorOptions && options.processorOptions.processorKind
    this.processorKind = KINDS.has(requestedKind) ? requestedKind : null
    this.parameterProperties = this.processorKind ? PARAMETER_PROPERTIES[this.processorKind] : null
    this.revision = -1
    this.state = { enabled: true }
    this.phase = 0
    this.delayL = new Float32Array(MAX_DELAY_FRAMES)
    this.delayR = new Float32Array(MAX_DELAY_FRAMES)
    this.write = 0
    this.feedbackL = 0
    this.feedbackR = 0
    this.allpassXL = new Float64Array(12)
    this.allpassXR = new Float64Array(12)
    this.allpassYL = new Float64Array(12)
    this.allpassYR = new Float64Array(12)
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    if (!this.processorKind) this.fault('invalid-processor-kind')
    this.port.postMessage({ type: 'ready', version: 1, processorKind: this.processorKind })
  }

  onMessage(message) {
    if (!message || typeof message !== 'object' || message.version !== 1) return this.fault('malformed-message')
    if (message.type === 'dispose') return this.port.close()
    if (message.type === 'reset') {
      this.phase = 0
      this.delayL.fill(0); this.delayR.fill(0); this.write = 0
      this.feedbackL = this.feedbackR = 0
      this.allpassXL.fill(0); this.allpassXR.fill(0)
      this.allpassYL.fill(0); this.allpassYR.fill(0)
      return
    }
    if (message.type !== 'configure' || !Number.isInteger(message.revision) || message.revision <= this.revision || !message.state || typeof message.state !== 'object') return this.fault('malformed-or-stale-configure')
    if (message.processorKind !== undefined && message.processorKind !== this.processorKind) return this.fault('immutable-processor-kind')
    this.revision = message.revision
    this.state = message.state
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  lfo(phase) {
    const wrapped = phase - Math.floor(phase)
    if (this.state.waveform === 'triangle') return 1 - 4 * Math.abs(wrapped - 0.5)
    return Math.sin(TWO_PI * wrapped)
  }

  shapedUnipolar(phase) {
    const unipolar = 0.5 + 0.5 * this.lfo(phase)
    return unipolar ** (2 ** (4 * ((this.state.shape || 0) - 0.5)))
  }

  readDelay(buffer, delayFrames) {
    let position = this.write - delayFrames
    while (position < 0) position += buffer.length
    const index1 = Math.floor(position) % buffer.length
    const fraction = position - Math.floor(position)
    const index0 = (index1 + buffer.length - 1) % buffer.length
    const index2 = (index1 + 1) % buffer.length
    const index3 = (index1 + 2) % buffer.length
    const y0 = buffer[index0], y1 = buffer[index1], y2 = buffer[index2], y3 = buffer[index3]
    const a = 0.5 * (2 * y1)
    const b = 0.5 * (-y0 + y2)
    const c = 0.5 * (2 * y0 - 5 * y1 + 4 * y2 - y3)
    const d = 0.5 * (-y0 + 3 * y1 - 3 * y2 + y3)
    return ((d * fraction + c) * fraction + b) * fraction + a
  }

  phaserSample(input, channel, lfo) {
    const stages = this.state.stages
    const center = this.state.centerHz * 2 ** (this.state.depthOctaves * lfo)
    const frequency = Math.max(20, Math.min(sampleRate * 0.49, center))
    const tangent = Math.tan(Math.PI * frequency / sampleRate)
    const coefficient = (tangent - 1) / (tangent + 1)
    const xs = channel === 0 ? this.allpassXL : this.allpassXR
    const ys = channel === 0 ? this.allpassYL : this.allpassYR
    let value = input + (channel === 0 ? this.feedbackL : this.feedbackR) * this.state.feedback
    for (let stage = 0; stage < stages; stage++) {
      const output = coefficient * value + xs[stage] - coefficient * ys[stage]
      xs[stage] = value
      ys[stage] = output
      value = output
    }
    if (channel === 0) this.feedbackL = value
    else this.feedbackR = value
    return value
  }

  process(inputs, outputs, parameters = {}) {
    const input = inputs[0] || []
    const output = outputs[0] || []
    const outL = output[0]
    if (!outL) return true
    const outR = output[1]
    const inL = input[0]
    const inR = input[1] || inL
    const kind = this.processorKind
    for (let i = 0; i < outL.length; i++) {
      if (this.parameterProperties) {
        for (let bindingIndex = 0; bindingIndex < this.parameterProperties.length; bindingIndex++) {
          const property = this.parameterProperties[bindingIndex]
          const samples = parameters[`${kind}.${property}`]
          if (samples && samples.length > 0) {
            this.state[property] = samples.length === 1 ? samples[0] : samples[i]
          }
        }
      }
      let l = inL ? inL[i] : 0
      let r = inR ? inR[i] : l
      if (!Number.isFinite(l) || !Number.isFinite(r)) { l = r = 0; this.fault('nonfinite-input') }
      let processedL = l
      let processedR = r
      if (this.state.enabled && kind) {
        const phaseL = this.phase + (this.state.phase || 0)
        const phaseR = phaseL + (this.state.stereoPhase || 0)
        if (kind === 'chorus' || kind === 'flanger') {
          this.delayL[this.write] = l + this.feedbackL * this.state.feedback
          this.delayR[this.write] = r + this.feedbackR * this.state.feedback
          processedL = this.readDelay(this.delayL, Math.max(1, (this.state.delayMs + this.state.depthMs * this.lfo(phaseL)) * sampleRate / 1000))
          processedR = this.readDelay(this.delayR, Math.max(1, (this.state.delayMs + this.state.depthMs * this.lfo(phaseR)) * sampleRate / 1000))
          this.feedbackL = processedL; this.feedbackR = processedR
          this.write = (this.write + 1) % MAX_DELAY_FRAMES
          processedL = l * (1 - this.state.mix) + processedL * this.state.mix
          processedR = r * (1 - this.state.mix) + processedR * this.state.mix
        } else if (kind === 'ensemble') {
          this.delayL[this.write] = l; this.delayR[this.write] = r
          let wetL = 0, wetR = 0
          for (let voice = 0; voice < 3; voice++) {
            const voicePhase = this.phase + voice / 3
            const spread = this.state.spread * (voice - 1) * 0.25
            wetL += this.readDelay(this.delayL, Math.max(1, (this.state.delayMs + this.state.depthMs * this.lfo(voicePhase - spread)) * sampleRate / 1000))
            wetR += this.readDelay(this.delayR, Math.max(1, (this.state.delayMs + this.state.depthMs * this.lfo(voicePhase + spread)) * sampleRate / 1000))
          }
          this.write = (this.write + 1) % MAX_DELAY_FRAMES
          processedL = l * (1 - this.state.mix) + wetL * this.state.mix / 3
          processedR = r * (1 - this.state.mix) + wetR * this.state.mix / 3
        } else if (kind === 'phaser') {
          const wetL = this.phaserSample(l, 0, this.lfo(phaseL))
          const wetR = this.phaserSample(r, 1, this.lfo(phaseR))
          processedL = l * (1 - this.state.mix) + wetL * this.state.mix
          processedR = r * (1 - this.state.mix) + wetR * this.state.mix
        } else if (kind === 'tremolo') {
          processedL = l * (1 - this.state.depth + this.state.depth * this.shapedUnipolar(phaseL))
          processedR = r * (1 - this.state.depth + this.state.depth * this.shapedUnipolar(phaseL))
        } else if (kind === 'autopan') {
          const position = this.state.depth * (2 * this.shapedUnipolar(phaseL) - 1)
          processedL = l * Math.cos((position + 1) * Math.PI * 0.25) * Math.SQRT2
          processedR = r * Math.sin((position + 1) * Math.PI * 0.25) * Math.SQRT2
        }
        this.phase += this.state.rateHz / sampleRate
        if (this.phase >= 1) this.phase -= Math.floor(this.phase)
      }
      if (!Number.isFinite(processedL) || !Number.isFinite(processedR)) {
        processedL = processedR = 0
        this.feedbackL = this.feedbackR = 0
        this.fault('nonfinite-state')
      }
      outL[i] = processedL
      if (outR) outR[i] = processedR
    }
    return true
  }
}

registerProcessor('daw-modulation-processor', DawModulationProcessor)
