const SQRT_HALF = Math.SQRT1_2
const PARAMS = [
  ['utility.gainDb', 0, -60, 24],
  ['utility.pan', 0, -1, 1],
  ['utility.balance', 0, -1, 1],
  ['utility.width', 1, 0, 2],
]

class DawUtilityProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map(([name, defaultValue, minValue, maxValue]) => ({ name, defaultValue, minValue, maxValue, automationRate: 'a-rate' }))
  }

  constructor() {
    super()
    this.revision = -1
    this.state = { enabled: true, polarity: 'normal', inputMode: 'stereo', matrix: 'stereo', swap: false, dcBlock: true }
    this.x1L = 0
    this.x1R = 0
    this.y1L = 0
    this.y1R = 0
    this.bypass = 0
    this.faults = 0
    this.port.onmessage = (event) => this.onMessage(event.data)
    this.port.postMessage({ type: 'ready', version: 1 })
  }

  onMessage(message) {
    if (!message || typeof message !== 'object' || message.version !== 1) return this.fault('malformed-message')
    if (message.type === 'dispose') return this.port.close()
    if (message.type === 'reset') {
      this.x1L = this.x1R = this.y1L = this.y1R = 0
      this.bypass = this.state.enabled ? 0 : 1
      return
    }
    if (message.type !== 'configure' || !Number.isInteger(message.revision) || message.revision <= this.revision || !message.state || typeof message.state !== 'object') return this.fault('malformed-or-stale-configure')
    this.revision = message.revision
    this.state = message.state
    this.port.postMessage({ type: 'configured', version: 1, revision: this.revision })
  }

  fault(code) {
    if (this.faults++ < 4) this.port.postMessage({ type: 'fault', version: 1, code })
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const leftIn = input && input[0]
    const rightIn = input && (input[1] || input[0])
    const leftOut = output[0]
    const rightOut = output[1]
    const frames = leftOut.length
    const dcR = Math.exp(-2 * Math.PI * 10 / sampleRate)
    const bypassStep = 1 / Math.max(1, Math.round(0.01 * sampleRate))
    for (let i = 0; i < frames; i++) {
      let l = leftIn ? leftIn[i] : 0
      let r = rightIn ? rightIn[i] : l
      if (!Number.isFinite(l) || !Number.isFinite(r)) {
        l = r = 0
        this.fault('nonfinite-input')
      }
      const dryL = l
      const dryR = r
      if (this.state.inputMode === 'mono-sum') l = r = 0.5 * l + 0.5 * r
      if (this.state.polarity === 'invert') { l = -l; r = -r }
      if (this.state.matrix === 'mid-side-encode') {
        const m = (l + r) * SQRT_HALF
        r = (l - r) * SQRT_HALF
        l = m
      } else if (this.state.matrix === 'mid-side-decode') {
        const m = l
        l = (m + r) * SQRT_HALF
        r = (m - r) * SQRT_HALF
      }
      if (this.state.swap) { const swap = l; l = r; r = swap }
      const mid = (l + r) * SQRT_HALF
      const side = (l - r) * SQRT_HALF * parameters['utility.width'][parameters['utility.width'].length === 1 ? 0 : i]
      l = (mid + side) * SQRT_HALF
      r = (mid - side) * SQRT_HALF
      const balance = parameters['utility.balance'][parameters['utility.balance'].length === 1 ? 0 : i]
      l *= balance > 0 ? 1 - balance : 1
      r *= balance < 0 ? 1 + balance : 1
      const pan = parameters['utility.pan'][parameters['utility.pan'].length === 1 ? 0 : i]
      l *= Math.cos((pan + 1) * Math.PI * 0.25) * Math.SQRT2
      r *= Math.sin((pan + 1) * Math.PI * 0.25) * Math.SQRT2
      const gain = 10 ** (parameters['utility.gainDb'][parameters['utility.gainDb'].length === 1 ? 0 : i] / 20)
      l *= gain
      r *= gain
      if (this.state.dcBlock) {
        const nextL = l - this.x1L + dcR * this.y1L
        const nextR = r - this.x1R + dcR * this.y1R
        this.x1L = l; this.x1R = r; this.y1L = nextL; this.y1R = nextR
        l = nextL; r = nextR
      }
      if (!Number.isFinite(l) || !Number.isFinite(r)) {
        l = r = 0
        this.x1L = this.x1R = this.y1L = this.y1R = 0
        this.fault('nonfinite-state')
      }
      const targetBypass = this.state.enabled ? 0 : 1
      this.bypass += Math.max(-bypassStep, Math.min(bypassStep, targetBypass - this.bypass))
      leftOut[i] = l + (dryL - l) * this.bypass
      if (rightOut) rightOut[i] = r + (dryR - r) * this.bypass
    }
    return true
  }
}

registerProcessor('daw-utility-processor', DawUtilityProcessor)
