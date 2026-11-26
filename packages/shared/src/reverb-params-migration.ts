import { createDefaultReverbParams } from './effects-params'
import { isJsonNumber, isJsonObject, type JsonValue } from './json-value'

// Version 1 -> 2. Version 1 was a fixed 8-line network with a Density knob, in-loop low and high cuts (the cuts and the
// "diffusion" cuts took the stricter of each pair), a Width of 0 to 2 and no Chorus, Smooth, Freeze or shelves. Everything
// below keeps those sounds where the new design can reproduce them:
// - the old cuts (and the "diffusion" cuts, the stricter of each pair) filtered inside the loop, so they become the Diffusion
//   Network shelves with the per-trip loss they cost; the new input Lo and Hi cuts start open;
// - the 8-line network stays (Density Sparse); the old Density and Diffusion levels (the old output gain was diffuse * density * (0.5 + 0.5 * diffusion)) fold into Diffuse so the tail is as loud;
// - Width becomes the Stereo angle with the same left/right correlation, and Width above 1 (which went anti-phase) stops at 120°.

const OLD_LINE_SECONDS = 2130.75 / 48000 // mean of the eight old line lengths at Size 1 with the 0.7 + 0.5 * size scale applied below
const ONE_POLE_PLATEAU_DB = 10 * Math.log10(5) // a one-pole cut at its corner loses 3 dB per trip; two octaves out it loses this

const finite = (value: JsonValue | undefined, fallback: number) => isJsonNumber(value) && Number.isFinite(value) ? value : fallback

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

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
  const shelfDb = shelfDbForCut(finite(old.decaySec, 2.2), clamp(finite(old.size, 0.65), 0, 1))
  const defaults = createDefaultReverbParams()
  const kept = Object.fromEntries(Object.entries(old).filter(([key]) => key !== 'diffusionLowCutHz' && key !== 'diffusionHighCutHz'))

  const state: JsonValue = {
    ...kept,
    density: 'sparse',
    diffuse: clamp(finite(old.diffuse, 1) * clamp(finite(old.density, 0.8), 0, 1) * (0.5 + 0.5 * clamp(finite(old.diffusion, 0.75), 0, 1)), 0, 1),
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
