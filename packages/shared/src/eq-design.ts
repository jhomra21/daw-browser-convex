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

// Impulse-invariant poles sit where the analog poles do, which is wrong once they are near Nyquist: a shelf whose pole
// frequency omega0 / sqrt(a) or omega0 * sqrt(a) reaches 0.45 fs, or a bell at 19 kHz, leaves 0.3 to 0.6 dB inside the band
// whatever the numerator is. When the fit is further than POLISH_TRIGGER_DB from the prototype anywhere on a log grid over
// the EQ range (20 Hz at 96 kHz up to 0.45 fs), the poles and B2 are moved by damped Gauss-Newton on the dB error, with
// B0 and B1 still matching DC and the corner. Lawson weights as above, so a pass can raise the worst error before the next
// lowers it; the best pass is kept, and the search stops if the poles leave the unit circle. Bands that fit already are
// left exactly as fittedNumerator made them. Points where the prototype is below -60 dB are not judged. Counts match
// kPolish* in biquad.h.
const POLISH_POINTS = 256
const POLISH_PASSES = 8
const POLISH_TRIGGER_DB = 0.1
const POLISH_DAMPING = 1e-3
const POLISH_FLOOR_DB = -60

const responseDb = (c: BiquadCoefficients, omega: number) => {
  const c1 = Math.cos(omega)
  const c2 = Math.cos(2 * omega)
  const num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * c1 + 2 * c.b0 * c.b2 * c2
  const den = 1 + c.a1 * c.a1 + c.a2 * c.a2 + 2 * (c.a1 + c.a1 * c.a2) * c1 + 2 * c.a2 * c2

  return 10 * Math.log10(num / den)
}

// Gaussian elimination with partial pivoting.
const solve = (a: number[][], b: number[]) => {
  const n = b.length

  for (let i = 0; i < n; i++) {
    let pivot = i

    for (let k = i + 1; k < n; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[pivot][i])) pivot = k
    }

    ;[a[i], a[pivot]] = [a[pivot], a[i]]
    ;[b[i], b[pivot]] = [b[pivot], b[i]]

    for (let k = i + 1; k < n; k++) {
      const m = a[k][i] / a[i][i]

      for (let j = i; j < n; j++) a[k][j] -= m * a[i][j]

      b[k] -= m * b[i]
    }
  }

  const x = b.map(() => 0)

  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i]

    for (let j = i + 1; j < n; j++) sum -= a[i][j] * x[j]

    x[i] = sum / a[i][i]
  }

  return x
}

// `design` maps (a1, a2, B2) to coefficients with B0 and B1 matched to the prototype at DC and the corner.
const polished = (design: (x: number[]) => BiquadCoefficients, start: number[], omega0: number, span: number, analogSquared: (x: number) => number) => {
  const omegas = Array.from({ length: POLISH_POINTS }, (_, i) => span * 4e-4 * 2500 ** (i / (POLISH_POINTS - 1)))
  const targets = omegas.map((omega) => 10 * Math.log10(analogSquared(omega / omega0)))

  const worst = (x: number[]) => {
    const c = design(x)

    return omegas.reduce((result, omega, i) => (targets[i] > POLISH_FLOOR_DB ? Math.max(result, Math.abs(responseDb(c, omega) - targets[i])) : result), 0)
  }

  let best = start
  let bestError = worst(best)

  if (bestError <= POLISH_TRIGGER_DB) return design(start)

  let current = best
  let weights: number[] = targets.map((target) => (target > POLISH_FLOOR_DB ? 1 : 0))

  for (let pass = 0; pass < POLISH_PASSES; pass++) {
    const normal = current.map(() => current.map(() => 0))
    const gradient = current.map(() => 0)
    const here = design(current)

    omegas.forEach((omega, i) => {
      const residual = responseDb(here, omega) - targets[i]

      const row = current.map((value, k) => {
        const step = 1e-6 * Math.max(Math.abs(value), 1e-3)
        const moved = current.map((v, j) => (j === k ? v + step : v))

        return (responseDb(design(moved), omega) - responseDb(here, omega)) / step
      })

      row.forEach((jj, j) => {
        gradient[j] -= weights[i] * jj * residual
        row.forEach((jk, k) => { normal[j][k] += weights[i] * jj * jk })
      })
    })

    normal.forEach((row, j) => { row[j] *= 1 + POLISH_DAMPING })

    const step = solve(normal, gradient)
    const next = current.map((value, k) => value + step[k])

    if (!(Math.abs(next[1]) < 0.9999 && Math.abs(next[0]) < 1 + next[1] - 1e-6)) break

    current = next

    const error = worst(current)

    if (error < bestError) {
      best = current
      bestError = error
    }

    const c = design(current)
    const scaled = weights.map((w, i) => w * Math.max(Math.abs(responseDb(c, omegas[i]) - targets[i]), 1e-4))
    const total = scaled.reduce((sum, w) => sum + w, 0)

    weights = scaled.map((w) => w * POLISH_POINTS / total)
  }

  return design(best)
}

const fittedNumerator = (poles: Poles, omega0: number, span: number, analogSquared: (x: number) => number) => {
  const den = denominator(poles)
  const B0 = den.c0 * analogSquared(0)
  const corner1 = Math.sin(0.5 * omega0) ** 2
  const corner2 = 4 * (1 - corner1) * corner1
  const corner = quadraticAt(den, omega0) * analogSquared(1) - B0 * (1 - corner1)

  // Residual of point i is rest - B2 * slope, with B1 = (corner - B2 corner2) / corner1 substituted.
  const points = Array.from({ length: FIT_POINTS }, (_, index) => {
    const omega = span * (index + 1) / FIT_POINTS
    const phi1 = Math.sin(0.5 * omega) ** 2
    const scale = 1 / (quadraticAt(den, omega) * analogSquared(omega / omega0))
    const u1 = phi1 * scale
    const u2 = 4 * (1 - phi1) * phi1 * scale

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

  const design = ([a1, a2, b2]: number[]) => {
    const p = { a1, a2 }
    const d = denominator(p)
    const dc = d.c0 * analogSquared(0)
    const atCorner = quadraticAt(d, omega0) * analogSquared(1) - dc * (1 - corner1)

    return withNumerator(p, dc, (atCorner - b2 * corner2) / corner1, b2)
  }

  return polished(design, [poles.a1, poles.a2, B2], omega0, span, analogSquared)
}

const matchedBell = (frequency: number, sampleRate: number, span: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const gain = 10 ** (gainDb / 20)
  const quality = Math.max(q, 0.01)
  const poles = impulseInvariantPoles(0.5 / (Math.sqrt(gain) * quality), omega0)

  return fittedNumerator(poles, omega0, span, (x) => {
    const plain = (1 - x * x) ** 2
    const c = x / quality

    return (plain + gain * c * c) / (plain + c * c / gain)
  })
}

const matchedLowPass = (frequency: number, sampleRate: number, span: number, q: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const quality = Math.max(q, 0.01)

  return fittedNumerator(impulseInvariantPoles(0.5 / quality, omega0), omega0, span, (x) => 1 / ((1 - x * x) ** 2 + (x / quality) ** 2))
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

const matchedShelf = (low: boolean, frequency: number, sampleRate: number, span: number, q: number, gainDb: number) => {
  const omega0 = cornerOmega(frequency, sampleRate)
  const a = 10 ** (gainDb / 40)
  const quality = Math.max(q, 0.01)
  const poles = impulseInvariantPoles(0.5 / quality, low ? omega0 / Math.sqrt(a) : omega0 * Math.sqrt(a))

  return fittedNumerator(poles, omega0, span, (x) => shelfMagnitudeSquared(low, a, quality, x))
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
