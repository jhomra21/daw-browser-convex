const MAX_DELAY_FRAMES = 24001

// The late tail mirrors the portable core's reverb (native/audio-core/src/audio_core.cpp): keep
// these constants and the per-frame order identical so both backends render the same signal.
const LINE_COUNT = 8
const LINE_FRAMES = 20480
const DIFFUSION_STAGES = 3
const DIFFUSION_FRAMES = 2560
const LINE_FRAMES_48K = [1447, 1583, 1789, 1951, 2203, 2399, 2663, 3011]
const DIFFUSION_FRAMES_48K = [[113, 163, 241], [127, 179, 263]]
const OUTPUT_SIGNS = [[1, -1, -1, -1, -1, 1, 1, 1], [1, -1, -1, 1, 1, -1, 1, -1]]
const EARLY_TAPS_MS = [[0, 11.3, 19.7, 29.1], [0, 9.1, 23.3, 31.7]]
const LINE_OUTPUT_SCALE = 1 / Math.sqrt(LINE_COUNT)
const PI2 = Math.PI * 2
const BYPASS_STEP = 1 / Math.max(1, Math.round(sampleRate * 0.01))

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback

const parameterValue = (parameters, name, frame, fallback) => {
  const values = parameters[name]

  if (!values || values.length === 0) return fallback

  return values.length === 1 ? values[0] : values[frame] ?? values[values.length - 1] ?? fallback
}

const readDelay = (buffer, write, delayFrames) => {
  const size = buffer.length
  const delay = Math.max(1, Math.min(delayFrames, size - 1))
  const read = write - delay
  const base = Math.floor(read)
  const fraction = read - base
  let olderIndex = base % size

  if (olderIndex < 0) olderIndex += size
  let newerIndex = (base + 1) % size

  if (newerIndex < 0) newerIndex += size
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
    this.lines = Array.from({ length: LINE_COUNT }, () => new Float32Array(LINE_FRAMES))
    this.diffusion = Array.from({ length: 2 * DIFFUSION_STAGES }, () => new Float32Array(DIFFUSION_FRAMES))
    this.low = new Float64Array(LINE_COUNT)
    this.high = new Float64Array(LINE_COUNT)
    this.highInput = new Float64Array(LINE_COUNT)
    this.lineFrames = new Float64Array(LINE_COUNT)
    this.lineGain = new Float64Array(LINE_COUNT)
    this.filtered = new Float64Array(LINE_COUNT)
    this.linesKey = ''
    this.write = 0
    this.lineWrite = 0
    this.diffusionWrite = 0
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

    for (const line of this.lines) line.fill(0)

    for (const stage of this.diffusion) stage.fill(0)
    this.low.fill(0)
    this.high.fill(0)
    this.highInput.fill(0)
    this.linesKey = ''
    this.write = 0
    this.lineWrite = 0
    this.diffusionWrite = 0
    this.phase = 0
  }

  // Each line loses 10^(-3 L / (decay * rate)) per trip, so the tail falls 60 dB in decaySec.
  updateLines(decaySec, size) {
    const key = `${decaySec}:${size}`

    if (this.linesKey === key) return
    const scale = (0.7 + 0.5 * size) * sampleRate / 48000

    for (let line = 0; line < LINE_COUNT; line += 1) {
      const frames = Math.min(Math.round(LINE_FRAMES_48K[line] * scale), LINE_FRAMES - 512)
      this.lineFrames[line] = frames
      this.lineGain[line] = Math.min(0.9999, Math.pow(10, -3 * frames / (decaySec * sampleRate)))
    }

    this.linesKey = key
  }

  diffuse(channel, input, coefficient) {
    let signal = input

    for (let stage = 0; stage < DIFFUSION_STAGES; stage += 1) {
      const buffer = this.diffusion[channel * DIFFUSION_STAGES + stage]
      const delay = Math.min(DIFFUSION_FRAMES - 1, Math.max(1, Math.trunc(DIFFUSION_FRAMES_48K[channel][stage] * sampleRate / 48000)))
      const delayed = buffer[(this.diffusionWrite + DIFFUSION_FRAMES - delay) % DIFFUSION_FRAMES]
      const state = signal + coefficient * delayed
      buffer[this.diffusionWrite] = state
      signal = delayed - coefficient * state
    }

    return signal
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
      const tapFade = 0.55 + 0.4 * Math.max(0, Math.min(1, finite(state['reflectionShape'])))
      const tapScale = (0.5 + boundedSize) * sampleRate / 1000
      let earlyLeft = 0
      let earlyRight = 0
      let tapWeight = 1
      let tapEnergy = 0

      for (let tap = 0; tap < EARLY_TAPS_MS[0].length; tap += 1) {
        earlyLeft += tapWeight * readDelay(this.left, this.write, preDelayFrames + EARLY_TAPS_MS[0][tap] * tapScale)
        earlyRight += tapWeight * readDelay(this.right, this.write, preDelayFrames + spreadFrames + EARLY_TAPS_MS[1][tap] * tapScale)
        tapEnergy += tapWeight * tapWeight
        tapWeight *= tapFade
      }

      const reflectionGain = finite(state.reflections) * (0.65 + finite(state['reflectionShape']) * 0.7) / Math.sqrt(tapEnergy)
      const hasLateTexture = state.diffuse > 0 && state.density > 0 && state.diffusion > 0

      const textureGain = Math.max(0, Math.min(
        1,
        finite(state.diffuse) * finite(state.density) * (0.5 + 0.5 * finite(state.diffusion)),
      ))

      this.updateLines(Math.max(0.05, finite(state.decaySec, 2.2)), boundedSize)
      const diffusionCoefficient = 0.7 * Math.max(0, Math.min(1, finite(state.diffusion)))
      const diffusedLeft = this.diffuse(0, rawLeft, diffusionCoefficient)
      const diffusedRight = this.diffuse(1, rawRight, diffusionCoefficient)
      const lowCut = Math.max(boundedLowCutHz, finite(state.diffusionLowCutHz, 20))
      const highCut = Math.min(boundedHighCutHz, finite(state.diffusionHighCutHz, 20000))
      const lowpassAlpha = 1 - Math.exp(-PI2 * Math.min(highCut, sampleRate * 0.49) / sampleRate)
      const highpassAlpha = Math.exp(-PI2 * lowCut / sampleRate)

      const modulationFrames = Math.min(
        state.reflections > 0 && state.reflectionSpin ? finite(state.reflectionModAmountMs) * 0.5 : 0,
        2,
      ) * sampleRate / 1000

      const filtered = this.filtered
      let lateLeft = 0
      let lateRight = 0

      for (let line = 0; line < LINE_COUNT; line += 1) {
        const delay = this.lineFrames[line] + (modulationFrames > 0
          ? modulationFrames * Math.sin(PI2 * (this.phase + line / LINE_COUNT))
          : 0)

        const delayed = readDelay(this.lines[line], this.lineWrite, delay) * this.lineGain[line]
        this.low[line] += lowpassAlpha * (delayed - this.low[line])
        this.high[line] = highpassAlpha * (this.high[line] + this.low[line] - this.highInput[line])
        this.highInput[line] = this.low[line]
        filtered[line] = this.high[line]
        lateLeft += OUTPUT_SIGNS[0][line] * filtered[line]
        lateRight += OUTPUT_SIGNS[1][line] * filtered[line]
      }

      // Hadamard mix: orthogonal, so the per-line gains alone set the decay.
      for (let span = 1; span < LINE_COUNT; span *= 2) {
        for (let start = 0; start < LINE_COUNT; start += 2 * span) {
          for (let index = start; index < start + span; index += 1) {
            const sum = filtered[index] + filtered[index + span]
            filtered[index + span] = filtered[index] - filtered[index + span]
            filtered[index] = sum
          }
        }
      }

      for (let line = 0; line < LINE_COUNT; line += 1) {
        const value = filtered[line] * LINE_OUTPUT_SCALE + (hasLateTexture ? 0.5 * (line % 2 === 0 ? diffusedLeft : diffusedRight) : 0)
        this.lines[line][this.lineWrite] = Math.abs(value) < 1e-20 ? 0 : value
      }

      this.lineWrite = (this.lineWrite + 1) % LINE_FRAMES
      this.diffusionWrite = (this.diffusionWrite + 1) % DIFFUSION_FRAMES
      this.left[this.write] = dryLeft
      this.right[this.write] = dryRight
      this.write = (this.write + 1) % MAX_DELAY_FRAMES
      const outputLateLeft = hasLateTexture ? lateLeft * LINE_OUTPUT_SCALE * textureGain : 0
      const outputLateRight = hasLateTexture ? lateRight * LINE_OUTPUT_SCALE * textureGain : 0
      const wideLeft = outputLateLeft * (1 + boundedWidth) * 0.5 + outputLateRight * (1 - boundedWidth) * 0.5
      const wideRight = outputLateRight * (1 + boundedWidth) * 0.5 + outputLateLeft * (1 - boundedWidth) * 0.5
      let processedLeft = dryLeft * (1 - boundedWet) + (wideLeft + earlyLeft * reflectionGain) * boundedWet
      let processedRight = dryRight * (1 - boundedWet) + (wideRight + earlyRight * reflectionGain) * boundedWet

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
