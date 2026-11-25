import { BELL_POLE_TABLE, LOW_PASS_POLE_TABLE, LOW_SHELF_POLE_TABLE } from './eq-pole-table'
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

// |H|^2 of the RBJ prototypes at x = Omega / Omega0.
const bellMagnitudeSquared = (gain: number, q: number, x: number) => {
  const plain = (1 - x * x) ** 2
  const c = x / q

  return (plain + gain * c * c) / (plain + c * c / gain)
}

const shelfMagnitudeSquared = (low: boolean, a: number, sqrtA: number, q: number, x: number) => {
  const c = x * sqrtA / q
  const plain = (a - x * x) ** 2 + c * c
  const scaled = (1 - a * x * x) ** 2 + c * c

  return a * a * (low ? plain / scaled : scaled / plain)
}

const lowPassMagnitudeSquared = (q: number, x: number) => 1 / ((1 - x * x) ** 2 + (x / q) ** 2)

// Numerator for the analog |H|^2 (a function of x = Omega / Omega0). |H|^2 is linear in B0, B1, B2 once the poles are fixed.
// DC (B0) and the corner are matched exactly, which leaves one degree of freedom: B2, with B1 following from the corner.
// B2 is fitted from DC to `span` (0.45 of the project rate, the top of the EQ range) by least squares on the relative
// error, repeated with each point weighted by its previous error (Lawson) so the error spreads evenly instead of piling
// up at the band edge.
// Matching Nyquist, as Vicanek's closed forms do for shelves, leaves 1 to 6 dB inside the band for wide boosts, deep cuts
// and resonant low-passes, because the analog response is still moving at Nyquist.
// The top of the EQ range as a fraction of the project rate.
const FIT_TOP = 0.45

// Point and pass counts match kFitPoints and kFitPasses in biquad.h.
const FIT_POINTS = 48
const FIT_PASSES = 3

const fittedNumerator = (poles: Poles, omega0: number, span: number, analogSquared: (x: number) => number) => {
  const den = denominator(poles)
  const B0 = den.c0 * analogSquared(0)
  const corner1 = Math.sin(0.5 * omega0) ** 2
  const corner2 = 4 * (1 - corner1) * corner1
  const corner = quadraticAt(den, omega0) * analogSquared(1) - B0 * (1 - corner1)

  // Residual of point i is rest - B2 * slope, with B1 = (corner - B2 corner2) / corner1 substituted. The point sines come
  // from the recurrence sin((k + 1) h) = 2 cos(h) sin(k h) - sin((k - 1) h), h = half the point spacing, as in biquad.h.
  const half = 0.5 * span / FIT_POINTS
  const twoCosHalf = 2 * Math.cos(half)
  let sinPrevious = 0
  let sinCurrent = Math.sin(half)

  const points = Array.from({ length: FIT_POINTS }, (_, index) => {
    const omega = span * (index + 1) / FIT_POINTS
    const phi1 = sinCurrent * sinCurrent
    const phi0 = 1 - phi1
    const scale = 1 / ((den.c0 * phi0 + den.c1 * phi1 + den.c2 * 4 * phi0 * phi1) * analogSquared(omega / omega0))
    const u1 = phi1 * scale
    const u2 = 4 * (1 - phi1) * phi1 * scale
    const sinNext = twoCosHalf * sinCurrent - sinPrevious

    sinPrevious = sinCurrent
    sinCurrent = sinNext

    return { rest: 1 - B0 * (1 - phi1) * scale - u1 * corner / corner1, slope: u2 - u1 * corner2 / corner1 }
  })

  let weights = points.map(() => 1)
  let B2 = 0

  for (let pass = 0; pass < FIT_PASSES; pass++) {
    const num = points.reduce((sum, p, i) => sum + weights[i] * p.slope * p.rest, 0)
    const dn = points.reduce((sum, p, i) => sum + weights[i] * p.slope * p.slope, 0)

    B2 = dn > 0 ? num / dn : 0

    const next = weights.map((w, i) => w * Math.max(Math.abs(points[i].rest - B2 * points[i].slope), 1e-6))
    const total = next.reduce((sum, w) => sum + w, 0)

    weights = next.map((w) => w * FIT_POINTS / total)
  }

  return withNumerator(poles, B0, (corner - B2 * corner2) / corner1, B2)
}

// Impulse-invariant poles sit where the analog poles do, which is wrong once they are near Nyquist: a shelf whose pole
// frequency omega0 / sqrt(a) or omega0 * sqrt(a) reaches 0.45 fs, or a bell at 19 kHz, leaves 0.3 to 3 dB inside the band
// whatever the numerator is. A pole correction moves the denominator's values at DC, (1 + a1 + a2), and at Nyquist,
// (1 - a1 + a2), by e^dc and e^nyquist, looked up in a table over (corner frequency, Q, gain) that
// tools/eq_pole_table_generator.cpp fits offline (eq-pole-table.ts is its output, the same numbers eq_pole_table.h holds).
// Everything below mirrors PoleCorrection and its table in biquad.h.
type PoleCorrection = { dc: number; nyquist: number }

const POLE_TABLE_OMEGA_NODES = 18
const POLE_TABLE_Q_NODES = 10
const POLE_TABLE_GAIN_NODES = 9
const POLE_TABLE_OMEGA_TOP = 0.99
const POLE_TABLE_MIN_Q = 0.2
const POLE_TABLE_MAX_Q = 36
const POLE_TABLE_MAX_GAIN_DB = 24

// Hi-Quality designs (the EQ range is under 0.25 of the design rate) keep their poles: the table is fitted for the full range.
const POLE_TABLE_MIN_SPAN = 0.99 * TWO_PI * FIT_TOP

// Multilinear interpolation of `table` (nodes laid out omega, Q, gain, then the two corrections). A table without a gain
// axis (the low-pass) has one gain node.
const interpolatedCorrection = (table: readonly number[], gainNodes: number, omega0: number, q: number, gainDb: number, span: number): PoleCorrection => {
  if (span < POLE_TABLE_MIN_SPAN) return { dc: 0, nyquist: 0 }

  const position = (fraction: number, nodes: number) => {
    const scaled = clamp(fraction, 0, 1) * (nodes - 1)
    const index = Math.min(Math.floor(scaled), nodes - 2)

    return { index, fraction: scaled - index }
  }

  const i = position(Math.sqrt(omega0 / Math.PI) / POLE_TABLE_OMEGA_TOP, POLE_TABLE_OMEGA_NODES)
  const j = position(Math.log(q / POLE_TABLE_MIN_Q) / Math.log(POLE_TABLE_MAX_Q / POLE_TABLE_MIN_Q), POLE_TABLE_Q_NODES)
  const k = gainNodes === 1 ? { index: 0, fraction: 0 } : position(0.5 + 0.5 * gainDb / POLE_TABLE_MAX_GAIN_DB, gainNodes)
  const result = { dc: 0, nyquist: 0 }

  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < (gainNodes === 1 ? 1 : 2); c++) {
        const weight = (a ? i.fraction : 1 - i.fraction) * (b ? j.fraction : 1 - j.fraction) * (c ? k.fraction : 1 - k.fraction)
        const node = 2 * (((i.index + a) * POLE_TABLE_Q_NODES + (j.index + b)) * gainNodes + (k.index + c))

        result.dc += weight * table[node]
        result.nyquist += weight * table[node + 1]
      }
    }
  }

  return result
}

const correctedPoles = (poles: Poles, correction: PoleCorrection): Poles => {
  if (correction.dc === 0 && correction.nyquist === 0) return poles

  const dc = (1 + poles.a1 + poles.a2) * Math.exp(correction.dc)
  const nyquist = (1 - poles.a1 + poles.a2) * Math.exp(correction.nyquist)

  // Both denominator values positive and a2 < 1 keep both poles inside the unit circle.
  return dc > 0 && nyquist > 0 && dc + nyquist < 3.9999 ? { a1: 0.5 * (dc - nyquist), a2: 0.5 * (dc + nyquist) - 1 } : poles
}

const matchedBell = (frequency: number, sampleRate: number, span: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const gain = 10 ** (gainDb / 20)
  const quality = Math.max(q, 0.01)
  const poles = correctedPoles(impulseInvariantPoles(0.5 / (Math.sqrt(gain) * quality), omega0), interpolatedCorrection(BELL_POLE_TABLE, POLE_TABLE_GAIN_NODES, omega0, quality, gainDb, span))

  return fittedNumerator(poles, omega0, span, (x) => bellMagnitudeSquared(gain, quality, x))
}

const matchedLowPass = (frequency: number, sampleRate: number, span: number, q: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const quality = Math.max(q, 0.01)

  const poles = correctedPoles(impulseInvariantPoles(0.5 / quality, omega0), interpolatedCorrection(LOW_PASS_POLE_TABLE, 1, omega0, quality, 0, span))

  return fittedNumerator(poles, omega0, span, (x) => lowPassMagnitudeSquared(quality, x))
}

const matchedHighPass = (frequency: number, sampleRate: number, q: number): BiquadCoefficients => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const quality = Math.max(q, 0.01)
  const poles = impulseInvariantPoles(0.5 / quality, omega0)
  const phi1 = Math.sin(0.5 * omega0) ** 2
  const b0 = Math.sqrt(quadraticAt(denominator(poles), omega0)) * quality / (4 * phi1)

  return { b0, b1: -2 * b0, b2: b0, a1: poles.a1, a2: poles.a2 }
}

// A high shelf of gain g has the poles and the error of the low shelf of gain -g (their prototypes differ by the constant
// a^4), so one table serves both.
const matchedShelf = (low: boolean, frequency: number, sampleRate: number, span: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const a = 10 ** (gainDb / 40)
  const sqrtA = Math.sqrt(a)
  const quality = Math.max(q, 0.01)
  const correction = interpolatedCorrection(LOW_SHELF_POLE_TABLE, POLE_TABLE_GAIN_NODES, omega0, quality, low ? gainDb : -gainDb, span)
  const poles = correctedPoles(impulseInvariantPoles(0.5 / quality, low ? omega0 / sqrtA : omega0 * sqrtA), correction)

  return fittedNumerator(poles, omega0, span, (x) => shelfMagnitudeSquared(low, a, sqrtA, quality, x))
}

const rbjBiquad = (type: 'bandpass' | 'notch' | 'allpass', frequency: number, sampleRate: number, q: number): BiquadCoefficients => {
  const omega = cornerOmega(frequency, sampleRate)
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * Math.max(q, 0.01))
  const a1 = -2 * cosine

  const [b0, b1, b2, a0, a2] = type === 'bandpass' ? [alpha, 0, -alpha, 1 + alpha, 1 - alpha]
    : type === 'notch' ? [1, a1, 1, 1 + alpha, 1 - alpha]
      : [1 - alpha, a1, 1 + alpha, 1 + alpha, 1 - alpha]

  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/**
 * The biquad sections of one band for a filter running at `sampleRate`, as the core designs them: matched (Vicanek poles,
 * fitted numerator) bells, shelves, low-pass and high-pass; RBJ band-pass, notch and all-pass. The numbers behind the
 * choice are in eq_band.h. `projectRate` is the rate the EQ range (up to 0.45 of it) is judged at when `sampleRate` is
 * oversampled.
 */
export const designEqBand = (type: EqBandType, frequency: number, sampleRate: number, q: number, gainDb: number, projectRate = sampleRate): BiquadCoefficients[] => {
  const span = TWO_PI * FIT_TOP * projectRate / sampleRate

  switch (type) {
    case 'peaking': return [matchedBell(frequency, sampleRate, span, q, gainDb)]
    case 'lowpass': return [matchedLowPass(frequency, sampleRate, span, q)]
    case 'highpass': return [matchedHighPass(frequency, sampleRate, q)]
    case 'lowpass48':
    case 'highpass48':
      return BUTTERWORTH_8_Q.map((sectionQ, index) => {
        const scaled = index === BUTTERWORTH_8_Q.length - 1 ? sectionQ * q * Math.SQRT2 : sectionQ

        return type === 'lowpass48' ? matchedLowPass(frequency, sampleRate, span, scaled) : matchedHighPass(frequency, sampleRate, scaled)
      })
    case 'lowshelf':
    case 'highshelf':
      return [matchedShelf(type === 'lowshelf', frequency, sampleRate, span, q, gainDb)]

    default: return [rbjBiquad(type, frequency, sampleRate, q)]
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

      return designEqBand(band.type, band.frequency, processingRate, q, gainDb, sampleRate)
    })

  return eqChainResponseDb(bands, frequencies, processingRate)
}
