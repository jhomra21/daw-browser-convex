const MAX_DELAY_FRAMES = 24001
const PI2 = Math.PI * 2
const BYPASS_STEP = 1 / Math.max(1, Math.round(sampleRate * 0.01))

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback
const parameterValue = (parameters, name, frame, fallback) => {
  const values = parameters[name]
  if (!values || values.length === 0) return fallback
  return values.length === 1 ? values[0] : values[frame] ?? values[values.length - 1] ?? fallback
}

const readDelay = (buffer, write, delayFrames) => {
  const delay = Math.max(1, Math.min(delayFrames, MAX_DELAY_FRAMES - 1))
  const read = write - delay
  const base = Math.floor(read)
  const fraction = read - base
  let olderIndex = base % MAX_DELAY_FRAMES
  if (olderIndex < 0) olderIndex += MAX_DELAY_FRAMES
  let newerIndex = (base + 1) % MAX_DELAY_FRAMES
  if (newerIndex < 0) newerIndex += MAX_DELAY_FRAMES
  const older = buffer[olderIndex] ?? 0
  const newer = buffer[newerIndex] ?? 0
  return older + (newer - older) * fraction
}

class DawReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'reverb.wet', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.preDelayMs', defaultValue: 20, minValue: 0, maxValue: 250, automationRate: 'a-rate' },
      { name: 'reverb.lowCutHz', defaultValue: 20, minValue: 20, maxValue: 1200, automationRate: 'a-rate' },
      { name: 'reverb.highCutHz', defaultValue: 20000, minValue: 1200, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'reverb.stereoWidth', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'a-rate' },
    ]
  }

  constructor() {
    super()
    this.left = new Float32Array(MAX_DELAY_FRAMES)
    this.right = new Float32Array(MAX_DELAY_FRAMES)
    this.write = 0
    this.lowLeft = 0
    this.lowRight = 0
    this.highInputLeft = 0
    this.highInputRight = 0
    this.highLeft = 0
    this.highRight = 0
    this.phase = 0
    this.bypass = 0
    this.state = {
      enabled: true,
      reflections: 0,
      reflectionSpin: true,
      reflectionModAmountMs: 17.5,
      reflectionModRateHz: 0.3,
      'reflectionShape': 0.5,
      diffuse: 1,
      size: 0.65,
      diffusion: 0.75,
      density: 0.8,
      diffusionLowCutHz: 20,
      diffusionHighCutHz: 20000,
    }
    this.port.onmessage = (event) => {
      const message = event.data
      if (!message || Object.prototype.toString.call(message) !== '[object Object]' || message.version !== 1) return
      if (message.type === 'configure' && message.state && Object.prototype.toString.call(message.state) === '[object Object]') {
        this.state = message.state
        return
      }
      if (message.type === 'reset') {
        this.reset()
        return
      }
      if (message.type === 'release') this.port.close()
    }
  }

  reset() {
    this.left.fill(0)
    this.right.fill(0)
    this.write = 0
    this.lowLeft = 0
    this.lowRight = 0
    this.highInputLeft = 0
    this.highInputRight = 0
    this.highLeft = 0
    this.highRight = 0
    this.phase = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] ?? []
    const output = outputs[0] ?? []
    const outputLeft = output[0]
    const outputRight = output[1] ?? outputLeft
    if (!outputLeft || !outputRight) return true
    const inputLeft = input[0]
    const inputRight = input[1] ?? inputLeft
    const state = this.state
    for (let frame = 0; frame < outputLeft.length; frame += 1) {
      const dryLeft = finite(inputLeft?.[frame])
      const dryRight = finite(inputRight?.[frame], dryLeft)
      const wet = Math.max(0, Math.min(1, parameterValue(parameters, 'reverb.wet', frame, 0.25)))
      const preDelayMs = Math.max(0, Math.min(250, parameterValue(parameters, 'reverb.preDelayMs', frame, 20)))
      const lowCutHz = Math.max(20, Math.min(1200, parameterValue(parameters, 'reverb.lowCutHz', frame, 20)))
      const highCutHz = Math.max(1200, Math.min(20000, parameterValue(parameters, 'reverb.highCutHz', frame, 20000)))
      const width = Math.max(0, Math.min(2, parameterValue(parameters, 'reverb.stereoWidth', frame, 1)))
      const enabled = state.enabled !== false
      if (!enabled) {
        const bypass = this.bypass
        this.reset()
        this.bypass = bypass
      }
      const modulationMs = state.reflections > 0 && state.reflectionSpin
        ? Math.sin(this.phase * PI2) * finite(state.reflectionModAmountMs) * 0.5
        : 0
      const boundedWet = Math.max(0, Math.min(1, wet))
      const boundedPreDelayMs = Math.max(0, Math.min(250, preDelayMs))
      const boundedLowCutHz = Math.max(20, Math.min(1200, lowCutHz))
      const boundedHighCutHz = Math.max(1200, Math.min(20000, highCutHz))
      const boundedWidth = Math.max(0, Math.min(2, width))
      const boundedSize = Math.max(0, Math.min(1, finite(state.size)))
      const preDelayFrames = Math.max(
        1,
        boundedPreDelayMs * sampleRate / 1000 + modulationMs * sampleRate / 1000,
      )
      const mono = !input[1]
      const spreadFrames = mono ? (6 + boundedSize * 8) * sampleRate / 1000 : 0
      const rawLeft = readDelay(this.left, this.write, preDelayFrames)
      const rawRight = readDelay(this.right, this.write, preDelayFrames + spreadFrames)
      const diffusionDelayMs = Math.max(20, Math.min(20 + boundedSize * 80, 100))
      const networkDelayFrames = Math.max(
        1,
        preDelayFrames + diffusionDelayMs * sampleRate / 1000,
      )
      const lateRawLeft = readDelay(this.left, this.write, networkDelayFrames)
      const lateRawRight = readDelay(this.right, this.write, networkDelayFrames + spreadFrames)
      const lowCut = Math.max(boundedLowCutHz, finite(state.diffusionLowCutHz, 20))
      const highCut = Math.min(boundedHighCutHz, finite(state.diffusionHighCutHz, 20000))
      const lowpassAlpha = 1 - Math.exp(-PI2 * Math.min(highCut, sampleRate * 0.49) / sampleRate)
      const highpassAlpha = Math.exp(-PI2 * lowCut / sampleRate)
      this.lowLeft += lowpassAlpha * (lateRawLeft - this.lowLeft)
      this.highLeft = highpassAlpha * (this.highLeft + this.lowLeft - this.highInputLeft)
      this.highInputLeft = this.lowLeft
      this.lowRight += lowpassAlpha * (lateRawRight - this.lowRight)
      this.highRight = highpassAlpha * (this.highRight + this.lowRight - this.highInputRight)
      this.highInputRight = this.lowRight
      const textureGain = Math.max(0, Math.min(
        1,
        finite(state.diffuse) * finite(state.density) * (0.5 + 0.5 * finite(state.diffusion)),
      ))
      const decay = Math.max(0.05, finite(state.decaySec, 2.2))
      const feedbackGain = Math.min(0.9999, Math.pow(1e-4, networkDelayFrames / (decay * sampleRate)))
      const reflectionGain = finite(state.reflections) * (0.65 + finite(state['reflectionShape']) * 0.7)
      const earlyLeft = rawLeft * reflectionGain
      const earlyRight = rawRight * reflectionGain
      const hasLateTexture = state.diffuse > 0 && state.density > 0 && state.diffusion > 0
      const lateWriteGain = hasLateTexture ? textureGain * feedbackGain : 0
      this.left[this.write] = dryLeft + this.highLeft * lateWriteGain
      this.right[this.write] = dryRight + this.highRight * lateWriteGain
      this.write = (this.write + 1) % MAX_DELAY_FRAMES
      const outputLateLeft = hasLateTexture ? this.highLeft * textureGain : 0
      const outputLateRight = hasLateTexture ? this.highRight * textureGain : 0
      const wideLeft = outputLateLeft * (1 + boundedWidth) * 0.5 + outputLateRight * (1 - boundedWidth) * 0.5
      const wideRight = outputLateRight * (1 + boundedWidth) * 0.5 + outputLateLeft * (1 - boundedWidth) * 0.5
      let processedLeft = dryLeft * (1 - boundedWet) + (wideLeft + earlyLeft) * boundedWet
      let processedRight = dryRight * (1 - boundedWet) + (wideRight + earlyRight) * boundedWet
      if (!Number.isFinite(processedLeft) || !Number.isFinite(processedRight)) {
        processedLeft = 0
        processedRight = 0
        this.reset()
      }
      const targetBypass = enabled ? 0 : 1
      this.bypass += Math.max(-BYPASS_STEP, Math.min(BYPASS_STEP, targetBypass - this.bypass))
      outputLeft[frame] = processedLeft + (dryLeft - processedLeft) * this.bypass
      outputRight[frame] = processedRight + (dryRight - processedRight) * this.bypass
      this.phase += finite(state.reflectionModRateHz, 0.3) / sampleRate
      this.phase -= Math.floor(this.phase)
    }
    return true
  }
}

registerProcessor('daw-reverb-processor', DawReverbProcessor)
