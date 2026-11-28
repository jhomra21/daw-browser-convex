// Deterministic test signals. Mono unless stated; renderers duplicate mono input to both channels.
export const sine = (frames: number, frequencyHz: number, rate: number, amplitude = 1, phaseRadians = 0) =>
  Float32Array.from({ length: frames }, (_, n) => amplitude * Math.sin(2 * Math.PI * frequencyHz * n / rate + phaseRadians))

/** A sine whose crest lands on frame `peakFrame`: the worst case for a gain or parameter step. */
export const sineWithPeakAt = (frames: number, frequencyHz: number, rate: number, amplitude: number, peakFrame: number) =>
  Float32Array.from({ length: frames }, (_, n) => amplitude * Math.cos(2 * Math.PI * frequencyHz * (n - peakFrame) / rate))

export const seededRandom = (seed: number) => {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform white noise in [-amplitude, amplitude]. */
export const noise = (frames: number, amplitude: number, seed = 1) => {
  const random = seededRandom(seed)

  return Float32Array.from({ length: frames }, () => amplitude * (2 * random() - 1))
}

/** Gaussian white noise with standard deviation `sigma` (Box-Muller on the seeded generator). */
export const gaussianNoise = (frames: number, sigma: number, seed = 1) => {
  const random = seededRandom(seed)

  return Float32Array.from({ length: frames }, () => sigma * Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()))
}

/** Pink noise (Paul Kellet's refined filter on seeded white noise) scaled to an exact RMS of `rmsDb` dBFS. */
export const pinkNoise = (frames: number, rmsDb: number, seed = 1) => {
  const white = noise(frames, 1, seed)
  const b = new Float64Array(7)

  const pink = Float64Array.from(white, (w) => {
    b[0] = 0.99886 * b[0] + w * 0.0555179
    b[1] = 0.99332 * b[1] + w * 0.0750759
    b[2] = 0.969 * b[2] + w * 0.153852
    b[3] = 0.8665 * b[3] + w * 0.3104856
    b[4] = 0.55 * b[4] + w * 0.5329522
    b[5] = -0.7616 * b[5] - w * 0.016898

    const value = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362

    b[6] = w * 0.115926

    return value
  })

  const current = Math.sqrt(pink.reduce((sum, value) => sum + value * value, 0) / frames)

  return Float32Array.from(pink, (value) => value * 10 ** (rmsDb / 20) / current)
}

export const impulse = (frames: number, amplitude = 1, at = 0) => {
  const signal = new Float32Array(frames)
  signal[at] = amplitude

  return signal
}

export const silence = (frames: number) => new Float32Array(frames)

export const constant = (frames: number, value: number) => new Float32Array(frames).fill(value)

export const ramp = (frames: number, from: number, to: number) =>
  Float32Array.from({ length: frames }, (_, n) => from + (to - from) * n / (frames - 1))

/** Isolated single-sample clicks every `period` frames. */
export const clickTrain = (frames: number, period: number, amplitude: number) =>
  Float32Array.from({ length: frames }, (_, n) => n > 0 && n % period === 0 ? amplitude : 0)

export const square = (frames: number, frequencyHz: number, rate: number, amplitude: number) =>
  Float32Array.from({ length: frames }, (_, n) => Math.sin(2 * Math.PI * frequencyHz * n / rate) >= 0 ? amplitude : -amplitude)

/** Logarithmic sine sweep. */
export const sweep = (frames: number, fromHz: number, toHz: number, rate: number, amplitude = 1) => {
  const seconds = frames / rate
  const k = Math.log(toHz / fromHz)

  return Float32Array.from({ length: frames }, (_, n) => {
    const t = n / rate

    return amplitude * Math.sin(2 * Math.PI * fromHz * seconds / k * (Math.exp(k * t / seconds) - 1))
  })
}

export const concat = (...parts: readonly Float32Array[]) => {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0

  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }

  return out
}

export const scale = (signal: Float32Array, gain: number) => signal.map((value) => value * gain)

export const dbToLinear = (db: number) => 10 ** (db / 20)

export const linearToDb = (value: number) => 20 * Math.log10(Math.max(value, 1e-30))

/** Linear fade in and out so tone bursts start and stop without clicks. */
export const taper = (signal: Float32Array, fadeFrames: number) =>
  signal.map((value, n) => value * Math.min(1, n / fadeFrames, (signal.length - 1 - n) / fadeFrames))

/** A frequency with an integer number of cycles in `frames`, near `targetHz` (for coherent THD and alias measurements). */
export const coherentFrequency = (targetHz: number, frames: number, rate: number, offsetBins = 0) =>
  (Math.round(targetHz * frames / rate) + offsetBins) * rate / frames

/** Sample-rate-independent seconds to frames. */
export const frames = (seconds: number, rate: number) => Math.round(seconds * rate)
