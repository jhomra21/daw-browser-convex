import { createDefaultReverbParams } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 was a fixed 8-line network with a Density knob, in-loop low and high cuts (the cuts and the
// "diffusion" cuts took the stricter of each pair), a Width of 0 to 2 and no Chorus, Smooth, Freeze or shelves. Everything
// below keeps those sounds where the new design can reproduce them:
// - the old cuts (and the "diffusion" cuts, the stricter of each pair) filtered inside the loop, so they become the Diffusion
//   Network shelves with the per-trip loss they cost; the new input Lo and Hi cuts start open;
// - the 8-line network stays (Density Sparse); the old Density and Diffusion levels (the old output gain was diffuse * density * (0.5 + 0.5 * diffusion)) fold into Diffuse, scaled by the
//   loudness the two engines differ by (see newOverOldDb), so the tail is as loud;
// - Width becomes the Stereo angle with the same left/right correlation, and Width above 1 (which went anti-phase) stops at 120°.

const OLD_LINE_SECONDS = 2130.75 / 48000 // mean of the eight old line lengths at Size 1 with the 0.7 + 0.5 * size scale applied below
const ONE_POLE_PLATEAU_DB = 10 * Math.log10(5) // a one-pole cut at its corner loses 3 dB per trip; two octaves out it loses this

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// Total wet energy of the new network over the old one's at the same Diffuse, in dB (impulse, 6 s, both channels, old Width 1 and no
// reflections), by a least-squares fit over Decay 0.3 to 12 s and Size 0 to 1 (28 renders of the base-commit worklet against the new
// engine; the fit stays within 1.1 dB of the total and 1.9 dB of the first 300 ms). Terms: 1, x, x^2, z, z x, z^2 with x = ln(decay / 2.2)
// and z = size - 0.65.
const newOverOldDb = (decaySec: number, size: number) => {
  const x = Math.log(Math.max(decaySec, 0.05) / 2.2)
  const z = size - 0.65

  return -0.1386 - 0.7731 * x + 0.8027 * x * x + 2.4359 * z - 1.0007 * z * x - 0.3231 * z * z
}

// The old line modulation (on whenever Reflect was above 0 and Spin on) cost the old tail 1.8 to 3.3 dB (mean 2.7, measured over
// Decay 0.5 to 8 s and Amount 1 to 25 ms); the new Spin moves only the reflections.
const OLD_SPIN_TAIL_LOSS_DB = 2.7

// The old Width crossfaded the two tail channels, which put (1 + w^2) / 2 of the energy at Width 1 into the output (measured 0.55 at 0 and 2.3 at 2);
// the new Stereo angle rotates them and keeps the energy.
const oldWidthEnergy = (width: number) => (1 + width * width) / 2

// The shelf gain that gives the band edge the per-trip loss of the old one-pole cut: the edge T60 is the mid T60 times
// A0 / (A0 + loss), where A0 is what a mean line loses per trip at the mid band.
const shelfDbForCut = (decaySec: number, size: number) => {
  const midLossDb = 60 * OLD_LINE_SECONDS * (0.7 + 0.5 * size) / Math.max(decaySec, 0.05)

  return clamp(20 * Math.log10(midLossDb / (midLossDb + ONE_POLE_PLATEAU_DB)), -24, 0)
}

// Equal left/right correlation: old (1 - w^2) / (1 + w^2) against the new cos(pi / 2 * degrees / 120).
export const migrateReverbStereoWidthV1 = (width: number) => clamp(120 * (4 / Math.PI) * Math.atan(clamp(width, 0, 1)), 0, 120)

export const migrateReverbParamsV1 = (params: JsonValue): JsonValue => {
  if (!isJsonObject(params)) return params
  const wrapped = isJsonObject(params.state)
  const old = wrapped && isJsonObject(params.state) ? params.state : params
  const lowCutHz = Math.max(finite(old.lowCutHz, 20), finite(old.diffusionLowCutHz, 20))
  const highCutHz = Math.min(finite(old.highCutHz, 20000), finite(old.diffusionHighCutHz, 20000))
  const size = clamp(finite(old.size, 0.65), 0, 1)
  const decaySec = Math.max(finite(old.decaySec, 2.2), 0.05)
  const shelfDb = shelfDbForCut(decaySec, size)
  const oldGain = finite(old.diffuse, 1) * clamp(finite(old.density, 0.8), 0, 1) * (0.5 + 0.5 * clamp(finite(old.diffusion, 0.75), 0, 1))
  const spinned = finite(old.reflections, 0) > 0 && old.reflectionSpin !== false
  const defaults = createDefaultReverbParams()
  const kept = Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'diffusionLowCutHz' && key !== 'diffusionHighCutHz'))

  const state: JsonValue = {
    ...kept,
    density: 'sparse',
    diffuse: clamp(oldGain * 10 ** ((-newOverOldDb(decaySec, size) - (spinned ? OLD_SPIN_TAIL_LOSS_DB : 0)) / 20) * Math.sqrt(oldWidthEnergy(clamp(finite(old.stereoWidth, 1), 0, 2))), 0, 1),
    lowCutHz: 20,
    highCutHz: 20000,
    lowShelfHz: clamp(lowCutHz, 20, 1200),
    highShelfHz: clamp(highCutHz, 1200, 20000),
    lowShelfOn: lowCutHz > 20,
    highShelfOn: highCutHz < 20000,
    lowShelfDb: lowCutHz > 20 ? shelfDb : 0,
    highShelfDb: highCutHz < 20000 ? shelfDb : 0,
    stereoWidth: migrateReverbStereoWidthV1(finite(old.stereoWidth, 1)),
    smooth: defaults.smooth,
    freeze: false,
    flat: false,
    cut: false,
    chorus: defaults.chorus,
    chorusAmountMs: defaults.chorusAmountMs,
    chorusRateHz: defaults.chorusRateHz,
  }

  return wrapped ? { ...params, state } : state
}
