// Mirrors native/audio-core/src/reverb_kernel.h and processor_reverb.cpp operation for operation (the legacy path must stay
// within 1e-5 of the core), so keep the three in step. Math.fround stands where the core rounds to float: the delay rings are
// Float32Arrays and every value that crosses the processor boundary is rounded; the arithmetic in between is double.
const f = Math.fround

const DENSITIES = ['sparse', 'low', 'mid', 'high']
const SMOOTHS = ['none', 'slow', 'fast']
const MAXIMUM_LINES = 16
const CONTROL_FRAMES = 8
const REFLECTION_STAGES = 8
const LINE_FRAMES_48K = [503, 631, 773, 919, 1069, 1217, 1373, 1531, 1693, 1861, 2039, 2213, 2393, 2579, 2777, 3011]
const LINE_COUNT = [8, 12, 16, 16]
const CHANNEL_COUNT = [8, 8, 16, 16]
const STEP_COUNT = [2, 2, 2, 3]
const DIFFUSER_STRIDE = [3, 5, 7]
const DIFFUSER_BASE_MS = 4
const REFLECTION_STAGE_MS = [[1.3, 2.3, 3.9, 6.1, 9.7, 13.9, 18.9, 24.1], [1.5, 2.7, 4.3, 6.7, 10.3, 14.5, 19.7, 25.3]]
const CHORUS_RATE_RATIO = [1, 1.071, 0.937, 1.123]
const PI = Math.PI
const REFLECTION_LEVEL = 4.5
const FAST_GLIDE = 0.01
const SLOW_GLIDE = 0.002
const PRE_DELAY_GLIDE = 0.1
const MAXIMUM_PRE_DELAY_MS = 250
const MAXIMUM_CHORUS_MS = 5
const DIFFUSER_TAP = 0.7
const WET_LEVEL = 0.27
const DENORMAL_FLOOR_FLOAT = f(1e-19)
const DENORMAL_FLOOR_DOUBLE = 1e-154
const SQRT_HALF = 0.7071067811865476

const flushFloat = (value) => Math.abs(value) < DENORMAL_FLOOR_FLOAT ? 0 : value
const flushDouble = (value) => Math.abs(value) < DENORMAL_FLOOR_DOUBLE ? 0 : value
const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
const fraction = (value) => value - Math.floor(value)
const isObject = (value) => value !== null && Object.prototype.toString.call(value) === '[object Object]'

const parity = (value) => {
  let odd = false

  for (; value !== 0; value >>>= 1) odd = odd !== ((value & 1) !== 0)

  return odd
}

const powerOfTwoFor = (frames) => {
  let size = 1

  while (size < frames) size *= 2

  return size
}

const bypassStep = (current, target, step) => {
  if (target > current + step) return f(current + step)

  if (target < current - step) return f(current - step)

  return target
}

class OnePole {
  constructor(rate, ms) {
    this.current = 0
    this.target = 0
    this.coefficient = 1 - Math.exp(-1000 / (ms * rate))
  }

  next() {
    if (this.current !== this.target) {
      this.current += this.coefficient * (this.target - this.current)

      if (Math.abs(this.target - this.current) < 1e-6) this.current = this.target
    }

    return this.current
  }
}

class Glide {
  constructor(step) {
    this.current = 0
    this.target = 0
    this.step = step
  }

  next() {
    const distance = this.target - this.current

    if (distance > this.step) this.current += this.step
    else if (distance < -this.step) this.current -= this.step
    else this.current = this.target

    return this.current
  }
}

// Signs and ring layouts as in the core: the diffuser, line and reflection rings hold the channels of a frame side by side.
class ReverbKernel {
  constructor(rate, densityIndex) {
    this.rate = rate
    this.k48 = rate / 48000
    this.lines = LINE_COUNT[densityIndex]
    this.channels = CHANNEL_COUNT[densityIndex]
    this.steps = STEP_COUNT[densityIndex]
    this.diffuserScale = 1 / Math.sqrt(this.channels)
    this.feed = Math.sqrt(2 / this.channels)
    const framesFor = (ms) => Math.ceil(ms * 0.001 * rate) + 8
    this.inputMask = powerOfTwoFor(framesFor(MAXIMUM_PRE_DELAY_MS + 30 + 12.5)) - 1
    this.reflectionMask = powerOfTwoFor(framesFor(REFLECTION_STAGE_MS[1][REFLECTION_STAGES - 1] * 2)) - 1
    this.lineMask = powerOfTwoFor(Math.ceil(LINE_FRAMES_48K[MAXIMUM_LINES - 1] * 1.2 * this.k48 + MAXIMUM_CHORUS_MS * 0.001 * rate) + 8) - 1
    this.input = [new Float32Array(this.inputMask + 1), new Float32Array(this.inputMask + 1)]
    this.reflection = [new Float32Array((this.reflectionMask + 1) * REFLECTION_STAGES), new Float32Array((this.reflectionMask + 1) * REFLECTION_STAGES)]
    this.diffuserMask = []
    this.diffuser = []
    this.diffuserDelay = []
    this.diffuserGain = []

    for (let step = 0; step < this.steps; step += 1) {
      const mask = powerOfTwoFor(framesFor(DIFFUSER_BASE_MS * 2 ** step)) - 1
      const rangeMs = DIFFUSER_BASE_MS * 2 ** step
      const delay = new Uint32Array(this.channels)
      const gain = new Float64Array(this.channels)

      for (let channel = 0; channel < this.channels; channel += 1) {
        const position = 0.15 + 0.7 * fraction(0.6180339887498949 * (1 + channel + 5 * step))
        const slot = (channel * DIFFUSER_STRIDE[step]) % this.channels
        delay[channel] = Math.max(1, Math.round(rangeMs * (slot + position) / this.channels * 0.001 * rate))
        const flip = (channel * 13 + step * 7 + 5) % 3 === 0 ? -1 : 1
        gain[channel] = step === 0 ? flip : flip * this.diffuserScale
      }

      this.diffuserMask.push(mask)
      this.diffuser.push(new Float32Array((mask + 1) * this.channels))
      this.diffuserDelay.push(delay)
      this.diffuserGain.push(gain)
    }

    this.linesBuffer = new Float32Array((this.lineMask + 1) * this.lines)
    this.lineBase = new Float64Array(MAXIMUM_LINES)
    this.lineGain = new Float64Array(MAXIMUM_LINES)
    this.lineEta = new Float64Array(MAXIMUM_LINES)
    this.lineWhole = new Uint32Array(MAXIMUM_LINES)
    this.lineAllpass = new Float64Array(MAXIMUM_LINES)
    this.tapLeft = new Float64Array(MAXIMUM_LINES)
    this.tapRight = new Float64Array(MAXIMUM_LINES)
    this.lowB0 = new Float64Array(MAXIMUM_LINES).fill(1)
    this.lowB1 = new Float64Array(MAXIMUM_LINES)
    this.lowA1 = new Float64Array(MAXIMUM_LINES)
    this.highB0 = new Float64Array(MAXIMUM_LINES).fill(1)
    this.highB1 = new Float64Array(MAXIMUM_LINES)
    this.highA1 = new Float64Array(MAXIMUM_LINES)
    this.lowState = new Float64Array(MAXIMUM_LINES)
    this.highState = new Float64Array(MAXIMUM_LINES)
    this.chorusCos = new Float64Array(MAXIMUM_LINES)
    this.chorusSin = new Float64Array(MAXIMUM_LINES)
    this.diffuserTapLeft = new Float64Array(this.channels)
    this.diffuserTapRight = new Float64Array(this.channels)

    for (let line = 0; line < this.lines; line += 1) {
      const slot = Math.floor(line * MAXIMUM_LINES / this.lines)
      this.lineBase[line] = LINE_FRAMES_48K[slot] * this.k48
      this.tapLeft[line] = parity(slot & 6) ? -1 : 1
      this.tapRight[line] = parity(slot & 11) ? -1 : 1
      const angle = 2 * PI * fraction(0.3819660112501051 * (line + 1))
      this.chorusCos[line] = Math.cos(angle)
      this.chorusSin[line] = Math.sin(angle)
    }

    for (let channel = 0; channel < this.channels; channel += 1) {
      this.diffuserTapLeft[channel] = DIFFUSER_TAP * this.diffuserScale * (fraction(0.7548776662466927 * (channel + 1)) < 0.5 ? 1 : -1)
      this.diffuserTapRight[channel] = DIFFUSER_TAP * this.diffuserScale * (fraction(0.5698402909980532 * (channel + 3)) < 0.5 ? 1 : -1)
    }

    this.spinCos = [new Float64Array(REFLECTION_STAGES), new Float64Array(REFLECTION_STAGES)]
    this.spinSin = [new Float64Array(REFLECTION_STAGES), new Float64Array(REFLECTION_STAGES)]
    this.reflectionSign = [new Float64Array(REFLECTION_STAGES), new Float64Array(REFLECTION_STAGES)]
    this.reflectionWhole = [new Uint32Array(REFLECTION_STAGES), new Uint32Array(REFLECTION_STAGES)]
    this.reflectionFraction = [new Float64Array(REFLECTION_STAGES), new Float64Array(REFLECTION_STAGES)]

    for (let stage = 0; stage < REFLECTION_STAGES; stage += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const angle = 2 * PI * fraction(0.6180339887498949 * (stage + 1) + 0.5 * channel)
        this.spinCos[channel][stage] = Math.cos(angle)
        this.spinSin[channel][stage] = Math.sin(angle)
        this.reflectionSign[channel][stage] = (stage + channel) % 3 === 1 ? -1 : 1
      }
    }

    this.wet = new OnePole(rate, 10)
    this.diffuse = new OnePole(rate, 20)
    this.reflect = new OnePole(rate, 20)
    this.diffusion = new OnePole(rate, 30)
    this.stereo = new OnePole(rate, 30)
    this.inputGain = new OnePole(rate, 20)
    this.freeze = new OnePole(rate, 50)
    this.preDelay = new Glide(PRE_DELAY_GLIDE)
    this.onset = new Glide(PRE_DELAY_GLIDE)
    this.size = new Glide(1)
    this.dcCoefficient = 1 - 2 * PI * 8 / rate
    this.initialized = false
    this.dirty = true
    this.gliding = false
    this.dynamic = false
    this.sizeCompensation = 1
    this.smooth = 99
    this.sizeLast = 0
    this.freezeLast = 0
    this.stereoLast = -1
    this.stereoCos = 1
    this.stereoSin = 0
    this.contour = -1
    this.reflectionGain = 0
    this.reflectionNorm = 0
    this.spinDepth = 0
    this.spinRate = -1
    this.spinStepSin = 0
    this.spinStepCos = 1
    this.chorusRate = -1
    this.chorusDepth = 0
    this.chorusGain = 1
    this.chorusStepSin = new Float64Array(4)
    this.chorusStepCos = new Float64Array(4)
    this.lowCutHz = -1
    this.highCutHz = -1
    this.lowCutActive = false
    this.highCutActive = false
    this.lowCut = null
    this.highCut = null
    this.lowShelfHz = 0
    this.highShelfHz = 0
    this.lowShelfDb = f(1e9)
    this.highShelfDb = f(1e9)
    this.lowShelfOn = true
    this.highShelfOn = true
    this.flat = false
    this.decay = 0
    this.lowActive = false
    this.highActive = false
    this.lowCutState = [new Float64Array(2), new Float64Array(2)]
    this.highCutState = [new Float64Array(2), new Float64Array(2)]
    this.dcIn = new Float64Array(2)
    this.dcOut = new Float64Array(2)
    this.chorusSine = new Float64Array(4)
    this.chorusCosine = new Float64Array(4)
    this.spinSine = 0
    this.spinCosine = 1
    this.frame = 0
    this.out = new Float64Array(MAXIMUM_LINES)
    this.bus = new Float64Array(MAXIMUM_LINES)
    this.x = new Float64Array(MAXIMUM_LINES)
    this.tailInput = new Float64Array(2)
    this.early = new Float64Array(2)
    this.reset()
  }

  reset() {
    for (const ring of this.input) ring.fill(0)

    for (const ring of this.reflection) ring.fill(0)

    for (const ring of this.diffuser) ring.fill(0)
    this.linesBuffer.fill(0)
    this.lineAllpass.fill(0)
    this.lowState.fill(0)
    this.highState.fill(0)

    for (const state of this.lowCutState) state.fill(0)

    for (const state of this.highCutState) state.fill(0)
    this.dcIn.fill(0)
    this.dcOut.fill(0)
    this.chorusSine.fill(0)
    this.chorusCosine.fill(1)
    this.spinSine = 0
    this.spinCosine = 1
    this.frame = 0
  }

  finiteOrReset(value) {
    if (Number.isFinite(value)) return f(value)
    this.reset()

    return 0
  }

  controlDue() {
    return (this.frame & (CONTROL_FRAMES - 1)) === 0
  }

  runFilter(coefficients, state, x) {
    const y = coefficients.b0 * x + state[0]
    state[0] = coefficients.b1 * x - coefficients.a1 * y + state[1]
    state[1] = coefficients.b2 * x - coefficients.a2 * y

    return y
  }

  hadamard(x, count) {
    for (let span = 1; span < count; span *= 2) {
      for (let start = 0; start < count; start += 2 * span) {
        for (let index = start; index < start + span; index += 1) {
          const sum = x[index] + x[index + span]
          x[index + span] = x[index] - x[index + span]
          x[index] = sum
        }
      }
    }
  }

  runDiffuser(n, bus) {
    const count = this.channels
    const x = this.x

    for (let channel = 0; channel < count; channel += 1) x[channel] = this.tailInput[channel & 1] * this.feed

    for (let step = 0; step < this.steps; step += 1) {
      const mask = this.diffuserMask[step]
      const ring = this.diffuser[step]
      const delay = this.diffuserDelay[step]
      const gain = this.diffuserGain[step]
      const row = (n & mask) * count

      for (let channel = 0; channel < count; channel += 1) ring[row + channel] = x[channel]

      for (let channel = 0; channel < count; channel += 1) x[channel] = gain[channel] * ring[((n - delay[channel]) & mask) * count + channel]
      this.hadamard(x, count)
    }

    for (let channel = 0; channel < count; channel += 1) bus[channel] = x[channel]
  }

  readInput(channel, delay) {
    const clamped = Math.max(1, delay)
    const whole = Math.floor(clamped)
    const fractional = clamped - whole
    const n = this.frame
    const ring = this.input[channel]
    const newer = ring[(n - whole) & this.inputMask]
    const older = ring[(n - whole - 1) & this.inputMask]

    return newer + (older - newer) * fractional
  }

  reflections(n, preDelay, level) {
    const result = this.early

    for (let channel = 0; channel < 2; channel += 1) {
      let x = this.readInput(channel, preDelay)
      const ring = this.reflection[channel]

      for (let stage = 0; stage < REFLECTION_STAGES; stage += 1) {
        ring[(n & this.reflectionMask) * REFLECTION_STAGES + stage] = x
        const whole = this.reflectionWhole[channel][stage]
        const newer = ring[((n - whole) & this.reflectionMask) * REFLECTION_STAGES + stage]
        const older = ring[((n - whole - 1) & this.reflectionMask) * REFLECTION_STAGES + stage]
        x += this.reflectionGain * this.reflectionSign[channel][stage] * (newer + (older - newer) * this.reflectionFraction[channel][stage])
      }

      result[channel] = x * this.reflectionNorm * level
    }
  }

  dcBlock(channel, x) {
    const y = x - this.dcIn[channel] + this.dcCoefficient * this.dcOut[channel]
    this.dcIn[channel] = x
    this.dcOut[channel] = flushDouble(y)

    return y
  }

  controlTick(size) {
    for (let base = 0; base < 4; base += 1) {
      const sine = this.chorusSine[base] * this.chorusStepCos[base] + this.chorusCosine[base] * this.chorusStepSin[base]
      this.chorusCosine[base] = this.chorusCosine[base] * this.chorusStepCos[base] - this.chorusSine[base] * this.chorusStepSin[base]
      this.chorusSine[base] = sine
    }

    const spin = this.spinSine * this.spinStepCos + this.spinCosine * this.spinStepSin
    this.spinCosine = this.spinCosine * this.spinStepCos - this.spinSine * this.spinStepSin
    this.spinSine = spin

    if ((Math.floor(this.frame / CONTROL_FRAMES) & 127) === 127) {
      for (let base = 0; base < 4; base += 1) {
        const norm = Math.sqrt(this.chorusSine[base] * this.chorusSine[base] + this.chorusCosine[base] * this.chorusCosine[base])
        this.chorusSine[base] /= norm
        this.chorusCosine[base] /= norm
      }

      const norm = Math.sqrt(this.spinSine * this.spinSine + this.spinCosine * this.spinCosine)
      this.spinSine /= norm
      this.spinCosine /= norm
    }

    const depth = this.chorusDepth * this.chorusGain * (1 - this.freeze.current)
    const dynamic = depth > 0 || this.gliding

    if (this.dynamic && !dynamic) this.dirty = true
    this.dynamic = dynamic

    if (dynamic) {
      const lineScale = 0.7 + 0.5 * size

      for (let line = 0; line < this.lines; line += 1) {
        const base = line & 3
        const modulation = this.chorusSine[base] * this.chorusCos[line] + this.chorusCosine[base] * this.chorusSin[line]
        const position = this.lineBase[line] * lineScale + depth * modulation - 0.5
        const floorPosition = Math.floor(position)
        this.lineWhole[line] = floorPosition
        const fractional = position + 0.5 - floorPosition
        this.lineEta[line] = (1 - fractional) / (1 + fractional)
      }
    }

    if (this.reflect.current > 0 || this.reflect.target > 0) {
      const msScale = (0.4 + 0.6 * size) * 0.001 * this.rate

      for (let channel = 0; channel < 2; channel += 1) {
        for (let stage = 0; stage < REFLECTION_STAGES; stage += 1) {
          let delay = REFLECTION_STAGE_MS[channel][stage] * msScale

          if (this.spinDepth > 0) {
            delay *= 1 + this.spinDepth * (this.spinSine * this.spinCos[channel][stage] + this.spinCosine * this.spinSin[channel][stage])
          }

          delay = Math.max(1, delay)
          const whole = Math.floor(delay)
          this.reflectionWhole[channel][stage] = whole
          this.reflectionFraction[channel][stage] = delay - whole
        }
      }
    }
  }

  apply(v, c) {
    const wet = clamp(v.wet, 0, 1)
    const preDelayMs = clamp(v.preDelayMs, 0, MAXIMUM_PRE_DELAY_MS)
    const size = clamp(v.size, 0, 1)
    const contour = clamp(v.contour, 0, 1)
    const decay = Math.max(0.05, v.decaySec)
    const freeze = c.freeze
    this.wet.target = wet
    this.diffuse.target = clamp(v.diffuse, 0, 1)
    this.reflect.target = clamp(v.reflections, 0, 1)
    this.diffusion.target = clamp(v.diffusion, 0, 1)
    this.inputGain.target = freeze && c.cut ? 0 : 1
    this.freeze.target = freeze ? 1 : 0
    this.stereo.target = clamp(v.stereoDegrees, 0, 120) / 120 * PI * 0.25
    this.preDelay.target = Math.max(1, preDelayMs * 0.001 * this.rate)
    this.onset.target = 0.024 * contour * this.rate
    this.size.target = size

    if (!this.initialized) this.snap()

    if (c.smooth !== this.smooth) {
      this.smooth = c.smooth
      this.size.step = c.smooth === 0 ? 2 : (c.smooth === 1 ? SLOW_GLIDE : FAST_GLIDE) / (0.5 * LINE_FRAMES_48K[MAXIMUM_LINES - 1] * this.k48)
    }

    if (contour !== this.contour) {
      this.contour = contour
      const stageGain = 0.9 - 0.4 * contour
      let energy = 1

      for (let stage = 0; stage < REFLECTION_STAGES; stage += 1) energy *= 1 + stageGain * stageGain
      this.reflectionGain = stageGain
      this.reflectionNorm = REFLECTION_LEVEL * (0.65 + 0.7 * contour) / Math.sqrt(energy)
    }

    this.spinDepth = c.spin ? clamp(v.spinAmountMs, 0, 25) / 2000 : 0

    if (v.spinRateHz !== this.spinRate) {
      this.spinRate = v.spinRateHz
      const step = 2 * PI * this.spinRate * CONTROL_FRAMES / this.rate
      this.spinStepCos = Math.cos(step)
      this.spinStepSin = Math.sin(step)
    }

    this.chorusDepth = clamp(v.chorusAmountMs, 0, MAXIMUM_CHORUS_MS) * 0.001 * this.rate
    this.chorusGain = c.chorus ? 1 : 0

    if (v.chorusRateHz !== this.chorusRate) {
      this.chorusRate = v.chorusRateHz

      for (let base = 0; base < 4; base += 1) {
        const step = 2 * PI * this.chorusRate * CHORUS_RATE_RATIO[base] * CONTROL_FRAMES / this.rate
        this.chorusStepCos[base] = Math.cos(step)
        this.chorusStepSin[base] = Math.sin(step)
      }
    }

    if (v.lowCutHz !== this.lowCutHz) {
      this.lowCutHz = v.lowCutHz
      this.lowCutActive = this.lowCutHz > f(20)

      if (this.lowCutActive) this.lowCut = this.designBiquad(true, Math.min(this.lowCutHz, 0.45 * this.rate))
    }

    if (v.highCutHz !== this.highCutHz) {
      this.highCutHz = v.highCutHz
      this.highCutActive = this.highCutHz < f(20000)

      if (this.highCutActive) this.highCut = this.designBiquad(false, Math.min(this.highCutHz, 0.45 * this.rate))
    }

    if (decay !== this.decay || v.lowShelfHz !== this.lowShelfHz || v.highShelfHz !== this.highShelfHz || v.lowShelfDb !== this.lowShelfDb
      || v.highShelfDb !== this.highShelfDb || c.lowShelf !== this.lowShelfOn || c.highShelf !== this.highShelfOn || c.flat !== this.flat) {
      this.decay = decay
      this.lowShelfHz = v.lowShelfHz
      this.highShelfHz = v.highShelfHz
      this.lowShelfDb = v.lowShelfDb
      this.highShelfDb = v.highShelfDb
      this.lowShelfOn = c.lowShelf
      this.highShelfOn = c.highShelf
      this.flat = c.flat
      this.lowActive = this.lowShelfOn && Math.abs(this.lowShelfDb) > 0.01
      this.highActive = this.highShelfOn && Math.abs(this.highShelfDb) > 0.01
      this.dirty = true
    }
  }

  snap() {
    for (const smoother of [this.wet, this.diffuse, this.reflect, this.diffusion, this.inputGain, this.freeze, this.stereo]) smoother.current = smoother.target
    this.preDelay.current = this.preDelay.target
    this.onset.current = this.onset.target
    this.size.current = this.size.target
    this.stereoLast = -1
    this.sizeLast = this.size.current
    this.freezeLast = this.freeze.current
    this.dirty = true
    this.gliding = false
    this.initialized = true
  }

  designBiquad(highpass, hz) {
    const omega = 2 * PI * hz / this.rate
    const cosine = Math.cos(omega)
    const alpha = Math.sin(omega) / (2 * SQRT_HALF)
    const a0 = 1 + alpha
    const edge = highpass ? (1 + cosine) * 0.5 : (1 - cosine) * 0.5

    return { b0: edge / a0, b1: (highpass ? -(1 + cosine) : 1 - cosine) / a0, b2: edge / a0, a1: -2 * cosine / a0, a2: (1 - alpha) / a0 }
  }

  design(size, freeze) {
    const scale = 0.7 + 0.5 * size
    const shelfWeight = 1 - (this.flat ? freeze : 0)
    this.sizeCompensation = Math.exp(-(1.48 - 2.643 * size + 0.5626 * size * size) * 0.11512925464970229)
    const lowTan = Math.tan(PI * Math.min(this.lowShelfHz, 0.45 * this.rate) / this.rate)
    const highTan = Math.tan(PI * Math.min(this.highShelfHz, 0.45 * this.rate) / this.rate)
    const lowRatio = Math.pow(10, this.lowShelfDb / 20)
    const highRatio = Math.pow(10, this.highShelfDb / 20)

    for (let line = 0; line < this.lines; line += 1) {
      const frames = this.lineBase[line] * scale
      const lossDb = 60 * frames / (this.rate * this.decay)
      this.lineGain[line] = Math.pow(10, -lossDb * (1 - freeze) / 20)
      const headroomDb = lossDb * (1 - freeze)

      if (this.lowActive) {
        const q = Math.pow(10, Math.min(lossDb * shelfWeight * (1 - 1 / lowRatio), headroomDb) / 40)
        const den = 1 + lowTan / q
        this.lowB0[line] = (1 + lowTan * q) / den
        this.lowB1[line] = (lowTan * q - 1) / den
        this.lowA1[line] = (lowTan / q - 1) / den
      }

      if (this.highActive) {
        const q = Math.pow(10, Math.min(lossDb * shelfWeight * (1 - 1 / highRatio), headroomDb) / 40)
        const den = 1 + highTan * q
        const gain = q * q
        this.highB0[line] = gain * (1 + highTan / q) / den
        this.highB1[line] = gain * (highTan / q - 1) / den
        this.highA1[line] = (highTan * q - 1) / den
      }

      const rounded = Math.round(frames)
      this.lineWhole[line] = rounded - 1
      this.lineEta[line] = 0
    }
  }

  process(v, c, inputLeft, inputRight, out) {
    const dryLeft = Number.isFinite(inputLeft) ? inputLeft : 0
    const dryRight = Number.isFinite(inputRight) ? inputRight : 0

    if (this.controlDue()) this.apply(v, c)
    const wet = this.wet.next()
    const diffuse = this.diffuse.next()
    const reflect = this.reflect.next()
    const diffusion = this.diffusion.next()
    const inputGain = this.inputGain.next()
    const freeze = this.freeze.next()
    const size = this.size.next()
    const preDelay = this.preDelay.next()
    const onset = this.onset.next()
    const stereo = this.stereo.next()

    if (stereo !== this.stereoLast) {
      this.stereoLast = stereo
      this.stereoCos = Math.cos(stereo)
      this.stereoSin = Math.sin(stereo)
    }

    const moved = size !== this.sizeLast || freeze !== this.freezeLast
    this.sizeLast = size
    this.freezeLast = freeze

    if (moved) this.gliding = true

    if (this.dirty || (this.gliding && (this.frame & 31) === 0)) {
      this.design(size, freeze)
      this.dirty = false

      if (!moved) this.gliding = false
    }

    let left = dryLeft
    let right = dryRight

    if (this.lowCutActive) {
      left = this.runFilter(this.lowCut, this.lowCutState[0], left)
      right = this.runFilter(this.lowCut, this.lowCutState[1], right)
    }

    if (this.highCutActive) {
      left = this.runFilter(this.highCut, this.highCutState[0], left)
      right = this.runFilter(this.highCut, this.highCutState[1], right)
    }

    const n = this.frame

    if ((n & (CONTROL_FRAMES - 1)) === 0) this.controlTick(size)
    const tailDelay = preDelay + onset
    this.tailInput[0] = this.readInput(0, tailDelay)
    this.tailInput[1] = this.readInput(1, tailDelay)
    this.early[0] = 0
    this.early[1] = 0

    if (reflect > 0) this.reflections(n, preDelay, reflect)
    const early = this.early
    const bus = this.bus
    this.runDiffuser(n, bus)

    const lines = this.lines
    const channels = this.channels
    const inject = Math.sqrt(channels / lines) * inputGain
    const lineOut = this.out
    const lineRing = this.linesBuffer
    let sum = 0
    let tailLeft = 0
    let tailRight = 0

    for (let channel = 0; channel < channels; channel += 1) {
      tailLeft += this.diffuserTapLeft[channel] * bus[channel]
      tailRight += this.diffuserTapRight[channel] * bus[channel]
    }

    for (let line = 0; line < lines; line += 1) {
      const whole = this.lineWhole[line]
      let value = lineRing[((n - whole - 1) & this.lineMask) * lines + line]

      if (this.dynamic) {
        const newer = lineRing[((n - whole) & this.lineMask) * lines + line]
        value += this.lineEta[line] * (newer - this.lineAllpass[line])
        this.lineAllpass[line] = flushDouble(value)
      }

      value *= this.lineGain[line]

      if (this.lowActive) {
        const filtered = this.lowB0[line] * value + this.lowState[line]
        this.lowState[line] = this.lowB1[line] * value - this.lowA1[line] * filtered
        value = filtered
      }

      if (this.highActive) {
        const filtered = this.highB0[line] * value + this.highState[line]
        this.highState[line] = this.highB1[line] * value - this.highA1[line] * filtered
        value = filtered
      }

      lineOut[line] = value
      sum += value
      tailLeft += this.tapLeft[line] * value
      tailRight += this.tapRight[line] * value
    }

    const reflection = 2 * sum / lines
    const crossfade = diffusion * this.diffuserScale

    for (let line = 0; line < lines; line += 1) {
      const fed = this.tailInput[line & 1] * this.feed * (1 - diffusion) + bus[line % channels] * crossfade
      const injected = (line >= channels ? -fed : fed) * inject
      lineRing[(n & this.lineMask) * lines + line] = flushFloat(f(lineOut[line] - reflection + injected))
    }

    this.input[0][n & this.inputMask] = left
    this.input[1][n & this.inputMask] = right
    this.frame = (this.frame + 1) >>> 0

    const tailGain = diffuse * this.sizeCompensation
    const wetLeft = this.dcBlock(0, (tailLeft * tailGain + early[0]) * WET_LEVEL)
    const wetRight = this.dcBlock(1, (tailRight * tailGain + early[1]) * WET_LEVEL)
    const mid = (wetLeft + wetRight) * SQRT_HALF
    const side = (wetLeft - wetRight) * SQRT_HALF
    const stereoLeft = this.stereoCos * mid + this.stereoSin * side
    const stereoRight = this.stereoCos * mid - this.stereoSin * side
    const mixedLeft = dryLeft * (1 - wet) + stereoLeft * wet
    const mixedRight = dryRight * (1 - wet) + stereoRight * wet

    out[0] = this.finiteOrReset(mixedLeft)
    out[1] = this.finiteOrReset(mixedRight)
  }
}

class DawReverbProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'reverb.wet', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.decaySec', defaultValue: 2.2, minValue: 0.05, maxValue: 12, automationRate: 'a-rate' },
      { name: 'reverb.preDelayMs', defaultValue: 20, minValue: 0, maxValue: 250, automationRate: 'a-rate' },
      { name: 'reverb.reflections', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.reflectionModAmountMs', defaultValue: 17.5, minValue: 0, maxValue: 25, automationRate: 'a-rate' },
      { name: 'reverb.reflectionModRateHz', defaultValue: 0.3, minValue: 0.01, maxValue: 5, automationRate: 'a-rate' },
      { name: 'reverb.reflectionShape', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.diffuse', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.size', defaultValue: 0.65, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.diffusion', defaultValue: 0.75, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'reverb.lowCutHz', defaultValue: 20, minValue: 20, maxValue: 1200, automationRate: 'a-rate' },
      { name: 'reverb.highCutHz', defaultValue: 20000, minValue: 1200, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'reverb.lowShelfHz', defaultValue: 200, minValue: 20, maxValue: 1200, automationRate: 'a-rate' },
      { name: 'reverb.highShelfHz', defaultValue: 5000, minValue: 1200, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'reverb.lowShelfDb', defaultValue: 0, minValue: -24, maxValue: 12, automationRate: 'a-rate' },
      { name: 'reverb.highShelfDb', defaultValue: 0, minValue: -24, maxValue: 12, automationRate: 'a-rate' },
      { name: 'reverb.chorusAmountMs', defaultValue: 0.6, minValue: 0, maxValue: 5, automationRate: 'a-rate' },
      { name: 'reverb.chorusRateHz', defaultValue: 0.6, minValue: 0.01, maxValue: 5, automationRate: 'a-rate' },
      { name: 'reverb.stereoWidth', defaultValue: 100, minValue: 0, maxValue: 120, automationRate: 'a-rate' },
    ]
  }

  constructor() {
    super()
    this.density = 3
    this.kernel = new ReverbKernel(sampleRate, this.density)
    this.enabled = true
    this.state = {}
    this.values = {
      wet: 0.25, decaySec: 2.2, preDelayMs: 20, reflections: 0.25, spinAmountMs: 17.5, spinRateHz: 0.3, contour: 0.5, diffuse: 0.7,
      size: 0.65, diffusion: 0.75, lowCutHz: 20, highCutHz: 20000, lowShelfHz: 200, highShelfHz: 5000, lowShelfDb: 0, highShelfDb: 0,
      chorusAmountMs: 0.6, chorusRateHz: 0.6, stereoDegrees: 100,
    }
    this.config = { smooth: 2, spin: true, chorus: true, highShelf: true, lowShelf: true, freeze: false, flat: false, cut: false }
    this.out = new Float64Array(2)
    this.bypassFrames = Math.floor((sampleRate + 50) / 100)
    this.bypass = 0
    this.port.onmessage = (event) => {
      const message = event.data

      if (!isObject(message) || message.version !== 1) return

      if (message.type === 'configure' && isObject(message.state)) {
        this.configure(message.state)

        return
      }

      if (message.type === 'reset') {
        this.kernel.reset()

        return
      }

      if (message.type === 'release') this.port.close()
    }
  }

  // A different Density is a different network, so it starts from silence like a new processor in the core.
  configure(state) {
    const density = Math.max(0, DENSITIES.indexOf(state.density))

    if (density !== this.density) {
      this.density = density
      this.kernel = new ReverbKernel(sampleRate, density)
    }

    this.state = state
    this.enabled = state.enabled !== false

    this.config = {
      smooth: Math.max(0, SMOOTHS.indexOf(state.smooth)),
      spin: state.reflectionSpin !== false,
      chorus: state.chorus !== false,
      highShelf: state.highShelfOn !== false,
      lowShelf: state.lowShelfOn !== false,
      freeze: state.freeze === true,
      flat: state.flat === true,
      cut: state.cut === true,
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] ?? []
    const output = outputs[0] ?? []
    const outputLeft = output[0]
    const outputRight = output[1] ?? outputLeft

    if (!outputLeft || !outputRight) return true
    const inputLeft = input[0]
    const inputRight = input[1] ?? inputLeft
    const values = this.values
    const kernel = this.kernel
    const step = f(1 / (this.bypassFrames === 0 ? 1 : this.bypassFrames))
    const at = (name, frame) => f(parameters[name][parameters[name].length === 1 ? 0 : frame])

    for (let frame = 0; frame < outputLeft.length; frame += 1) {
      const dryLeft = inputLeft ? inputLeft[frame] : 0
      const dryRight = inputRight ? inputRight[frame] : dryLeft
      const left = Number.isFinite(dryLeft) ? f(dryLeft) : 0
      const right = Number.isFinite(dryRight) ? f(dryRight) : 0

      if (kernel.controlDue()) {
        values.wet = at('reverb.wet', frame)
        values.decaySec = at('reverb.decaySec', frame)
        values.preDelayMs = at('reverb.preDelayMs', frame)
        values.reflections = at('reverb.reflections', frame)
        values.spinAmountMs = at('reverb.reflectionModAmountMs', frame)
        values.spinRateHz = at('reverb.reflectionModRateHz', frame)
        values.contour = at('reverb.reflectionShape', frame)
        values.diffuse = at('reverb.diffuse', frame)
        values.size = at('reverb.size', frame)
        values.diffusion = at('reverb.diffusion', frame)
        values.lowCutHz = at('reverb.lowCutHz', frame)
        values.highCutHz = at('reverb.highCutHz', frame)
        values.lowShelfHz = at('reverb.lowShelfHz', frame)
        values.highShelfHz = at('reverb.highShelfHz', frame)
        values.lowShelfDb = at('reverb.lowShelfDb', frame)
        values.highShelfDb = at('reverb.highShelfDb', frame)
        values.chorusAmountMs = at('reverb.chorusAmountMs', frame)
        values.chorusRateHz = at('reverb.chorusRateHz', frame)
        values.stereoDegrees = at('reverb.stereoWidth', frame)
      }

      kernel.process(values, this.config, left, right, this.out)
      this.bypass = bypassStep(this.bypass, this.enabled ? 0 : 1, step)
      outputLeft[frame] = f(this.out[0] + f(f(left - this.out[0]) * this.bypass))
      outputRight[frame] = f(this.out[1] + f(f(right - this.out[1]) * this.bypass))
    }

    return true
  }
}

registerProcessor('daw-reverb-processor', DawReverbProcessor)
