import { clamp } from './numeric'
import {
  EQ_BANDS_PER_CURVE,
  supportsGain,
  type EqBandParams,
  type EqBandType,
  type EqParams,
} from './effects-params'

// TypeScript twin of native/audio-core/src/dsp/eq_band.h (and the matched designs in dsp/biquad.h). The device graph is
// drawn from this, so it describes the filter the core runs. packages/shared/src/eq-design.test.ts and the effects
// harness (tools/effects-harness, row graph-vs-render) compare it with a render of the real core.

export type BiquadCoefficients = { b0: number; b1: number; b2: number; a1: number; a2: number }

const TWO_PI = 2 * Math.PI

// Butterworth 8th order: Q = 1 / (2 sin((2k - 1) pi / 16)). The highest-Q section carries the band's Q.
const BUTTERWORTH_8_Q = [0.5097955791041592, 0.6013448869350453, 0.8999762231364156, 2.5629154477415055]

const cornerOmega = (frequency: number, sampleRate: number) => TWO_PI * clamp(frequency, 1, 0.49 * sampleRate) / sampleRate

// Impulse-invariant poles for damping `q` = 1 / (2 Q) at `omega` radians per sample.
const impulseInvariantPoles = (q: number, omega: number) => {
  const decay = Math.exp(-q * omega)

  const a1 = q <= 1
    ? -2 * decay * Math.cos(Math.sqrt(1 - q * q) * omega)
    : -2 * decay * Math.cosh(Math.sqrt(q * q - 1) * omega)

  return { a1, a2: decay * decay }
}

type Poles = ReturnType<typeof impulseInvariantPoles>

// |H|^2 = c0 phi0 + c1 phi1 + c2 4 phi0 phi1 for the denominator, phi0 = cos^2(w/2), phi1 = sin^2(w/2).
const denominator = (poles: Poles) => ({
  c0: (1 + poles.a1 + poles.a2) ** 2,
  c1: (1 - poles.a1 + poles.a2) ** 2,
  c2: -4 * poles.a2,
})

const quadraticAt = (den: ReturnType<typeof denominator>, omega: number) => {
  const s = Math.sin(0.5 * omega)
  const p1 = s * s
  const p0 = 1 - p1

  return den.c0 * p0 + den.c1 * p1 + den.c2 * 4 * p0 * p1
}

// Vicanek eq. (29); a numerator that asks for less than a real one can is pulled back to 0.9 of the bound.
const withNumerator = (poles: Poles, B0: number, B1: number, B2: number): BiquadCoefficients => {
  const r0 = Math.sqrt(Math.max(B0, 0))
  const r1 = Math.sqrt(Math.max(B1, 0))
  const w = 0.5 * (r0 + r1)
  const held = B2 < -w * w ? -0.9 * w * w : B2
  const b0 = 0.5 * (w + Math.sqrt(w * w + held))

  return { b0, b1: 0.5 * (r0 - r1), b2: b0 > 0 ? -held / (4 * b0) : 0, a1: poles.a1, a2: poles.a2 }
}

const matchedBell = (frequency: number, sampleRate: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const gain = 10 ** (gainDb / 20)
  const poles = impulseInvariantPoles(0.5 / (Math.sqrt(gain) * Math.max(q, 0.01)), omega0)
  const den = denominator(poles)
  const phi1 = Math.sin(0.5 * omega0) ** 2
  const phi0 = 1 - phi1
  const B0 = den.c0
  const R1 = quadraticAt(den, omega0) * gain * gain
  const R2 = (-den.c0 + den.c1 + 4 * (phi0 - phi1) * den.c2) * gain * gain
  const B2 = (R1 - R2 * phi1 - B0) / (4 * phi1 * phi1)
  const B1 = R2 + B0 + 4 * (phi1 - phi0) * B2

  return withNumerator(poles, B0, B1, B2)
}

const matchedLowPass = (frequency: number, sampleRate: number, q: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const quality = Math.max(q, 0.01)
  const poles = impulseInvariantPoles(0.5 / quality, omega0)
  const den = denominator(poles)
  const phi1 = Math.sin(0.5 * omega0) ** 2
  const R1 = quadraticAt(den, omega0) * quality * quality

  return withNumerator(poles, den.c0, (R1 - den.c0 * (1 - phi1)) / phi1, 0)
}

const matchedHighPass = (frequency: number, sampleRate: number, q: number): BiquadCoefficients => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const quality = Math.max(q, 0.01)
  const poles = impulseInvariantPoles(0.5 / quality, omega0)
  const phi1 = Math.sin(0.5 * omega0) ** 2
  const b0 = Math.sqrt(quadraticAt(denominator(poles), omega0)) * quality / (4 * phi1)

  return { b0, b1: -2 * b0, b2: b0, a1: poles.a1, a2: poles.a2 }
}

const shelfMagnitudeSquared = (low: boolean, a: number, q: number, x: number) => {
  const c = x * Math.sqrt(a) / q
  const plain = (a - x * x) ** 2 + c * c
  const scaled = (1 - a * x * x) ** 2 + c * c

  return a * a * (low ? plain / scaled : scaled / plain)
}

const matchedShelf = (low: boolean, frequency: number, sampleRate: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const a = 10 ** (gainDb / 40)
  const poles = impulseInvariantPoles(0.5 / Math.max(q, 0.01), low ? omega0 / Math.sqrt(a) : omega0 * Math.sqrt(a))
  const den = denominator(poles)
  const B0 = den.c0 * shelfMagnitudeSquared(low, a, q, 0)
  const B1 = den.c1 * shelfMagnitudeSquared(low, a, q, Math.PI / omega0)
  const phi1 = Math.sin(0.5 * omega0) ** 2
  const phi2 = 4 * (1 - phi1) * phi1
  const mid = quadraticAt(den, omega0) * a * a
  const B2 = phi2 > 1e-12 ? (mid - B0 * (1 - phi1) - B1 * phi1) / phi2 : 0

  return withNumerator(poles, B0, B1, B2)
}

const rbjBiquad = (type: EqBandType, frequency: number, sampleRate: number, q: number, gainDb: number): BiquadCoefficients => {
  const omega = cornerOmega(frequency, sampleRate)
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * Math.max(q, 0.01))
  const a = 10 ** (gainDb / 40)
  let b0 = 1
  let b1 = 0
  let b2 = 0
  let a0 = 1
  let a1 = 0
  let a2 = 0

  if (type === 'lowpass' || type === 'lowpass48') {
    b0 = (1 - cosine) / 2; b1 = 1 - cosine; b2 = b0; a0 = 1 + alpha; a1 = -2 * cosine; a2 = 1 - alpha
  } else if (type === 'highpass' || type === 'highpass48') {
    b0 = (1 + cosine) / 2; b1 = -(1 + cosine); b2 = b0; a0 = 1 + alpha; a1 = -2 * cosine; a2 = 1 - alpha
  } else if (type === 'bandpass') {
    b0 = alpha; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cosine; a2 = 1 - alpha
  } else if (type === 'notch') {
    b0 = 1; b1 = -2 * cosine; b2 = 1; a0 = 1 + alpha; a1 = b1; a2 = 1 - alpha
  } else if (type === 'allpass') {
    b0 = 1 - alpha; b1 = -2 * cosine; b2 = 1 + alpha; a0 = b2; a1 = b1; a2 = b0
  } else if (type === 'lowshelf') {
    const beta = 2 * Math.sqrt(a) * alpha

    b0 = a * ((a + 1) - (a - 1) * cosine + beta)
    b1 = 2 * a * ((a - 1) - (a + 1) * cosine)
    b2 = a * ((a + 1) - (a - 1) * cosine - beta)
    a0 = (a + 1) + (a - 1) * cosine + beta
    a1 = -2 * ((a - 1) + (a + 1) * cosine)
    a2 = (a + 1) + (a - 1) * cosine - beta
  } else if (type === 'highshelf') {
    const beta = 2 * Math.sqrt(a) * alpha

    b0 = a * ((a + 1) + (a - 1) * cosine + beta)
    b1 = -2 * a * ((a - 1) + (a + 1) * cosine)
    b2 = a * ((a + 1) + (a - 1) * cosine - beta)
    a0 = (a + 1) - (a - 1) * cosine + beta
    a1 = 2 * ((a - 1) - (a + 1) * cosine)
    a2 = (a + 1) - (a - 1) * cosine - beta
  } else {
    b0 = 1 + alpha * a; b1 = -2 * cosine; b2 = 1 - alpha * a; a0 = 1 + alpha / a; a1 = b1; a2 = 1 - alpha / a
  }

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/**
 * The biquad sections of one band for a filter running at `sampleRate`, as the core designs them: matched (Vicanek)
 * bells and cuts; matched shelves for Q <= 1.5 when boosting or with the corner under 0.25 fs, RBJ otherwise;
 * RBJ band-pass, notch and all-pass. The numbers behind the choice are in eq_band.h.
 */
export const designEqBand = (type: EqBandType, frequency: number, sampleRate: number, q: number, gainDb: number): BiquadCoefficients[] => {
  switch (type) {
    case 'peaking': return [matchedBell(frequency, sampleRate, q, gainDb)]
    case 'lowpass': return [matchedLowPass(frequency, sampleRate, q)]
    case 'highpass': return [matchedHighPass(frequency, sampleRate, q)]
    case 'lowpass48':
    case 'highpass48':
      return BUTTERWORTH_8_Q.map((sectionQ, index) => {
        const scaled = index === BUTTERWORTH_8_Q.length - 1 ? sectionQ * q * Math.SQRT2 : sectionQ

        return type === 'lowpass48' ? matchedLowPass(frequency, sampleRate, scaled) : matchedHighPass(frequency, sampleRate, scaled)
      })
    case 'lowshelf':
    case 'highshelf': {
      const corner = clamp(frequency, 1, 0.49 * sampleRate) / sampleRate

      return q <= 1.5 && (gainDb >= 0 || corner < 0.25)
        ? [matchedShelf(type === 'lowshelf', frequency, sampleRate, q, gainDb)]
        : [rbjBiquad(type, frequency, sampleRate, q, gainDb)]
    }

    default: return [rbjBiquad(type, frequency, sampleRate, q, gainDb)]
  }
}

/** Magnitude in dB of cascaded sections at `frequencies` (Hz) for a filter running at `sampleRate`. */
export const eqChainResponseDb = (bands: readonly (readonly BiquadCoefficients[])[], frequencies: readonly number[], sampleRate: number): number[] => (
  frequencies.map((frequency) => {
    const omega = TWO_PI * frequency / sampleRate
    const c1 = Math.cos(omega)
    const s1 = -Math.sin(omega)
    const c2 = Math.cos(2 * omega)
    const s2 = -Math.sin(2 * omega)
    let power = 0

    for (const band of bands) {
      for (const section of band) {
        const numRe = section.b0 + section.b1 * c1 + section.b2 * c2
        const numIm = section.b1 * s1 + section.b2 * s2
        const denRe = 1 + section.a1 * c1 + section.a2 * c2
        const denIm = section.a1 * s1 + section.a2 * s2

        power += Math.log10((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm))
      }
    }

    return 10 * power
  })
)

/** A band's gain and Q after Scale and Adaptive Q, as the core applies them (Q * (1 + |gain| / 24)). */
export const effectiveEqBand = (band: EqBandParams, params: Pick<EqParams, 'scale' | 'adaptiveQ'>) => {
  const gainDb = supportsGain(band.type) ? band.gainDb * params.scale : 0

  return { gainDb, q: params.adaptiveQ && supportsGain(band.type) ? band.q * (1 + Math.abs(gainDb) / 24) : band.q }
}

/** The curve (0 = first, 1 = second) of the device as the graph draws it: enabled bands only, at the real sample rate. */
export const eqCurveResponseDb = (params: EqParams, curve: 0 | 1, frequencies: readonly number[], sampleRate: number): number[] => {
  const processingRate = params.highQuality ? 2 * sampleRate : sampleRate

  const bands = params.bands
    .slice(curve * EQ_BANDS_PER_CURVE, (curve + 1) * EQ_BANDS_PER_CURVE)
    .filter((band) => band.enabled)
    .map((band) => {
      const { gainDb, q } = effectiveEqBand(band, params)

      return designEqBand(band.type, band.frequency, processingRate, q, gainDb)
    })

  return eqChainResponseDb(bands, frequencies, processingRate)
}
