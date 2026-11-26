import type { EffectSpec } from './effects'

export type Planar = [Float32Array, Float32Array]

/** Sets state paths (e.g. "thresholdDb", "bands.0.gainDb") from `frame` onward, sample accurate in the wasm core. */
export type ParamStep = { frame: number; set: Readonly<Record<string, number>> }

export type RenderOptions = {
  input: readonly Float32Array[]
  /** A key from another track, routed to the effect's sidechain input. */
  key?: readonly Float32Array[]
  steps?: readonly ParamStep[]
  /** Song position, in frames, of the first rendered frame; the transport runs from there (default 0). The legacy worklet has no song position. */
  startFrame?: number
  // The project tempo the transport carries; 0 or absent is no tempo, which the core plays at 120 bpm.
  tempoBpm?: number
  /** Flips the processor's `enabled` state from `frame` onward (a block boundary); the core gets it as a republished graph. */
  enabledSteps?: readonly { frame: number; enabled: boolean }[]
}

/** `worstBlockNs` is the slowest single 128-frame process call, where a hop's whole FFT work lands. */
export type Rendered = { output: Planar; nsPerSample: number; worstBlockNs: number }

export type LegacyRenderer = (spec: EffectSpec, rate: number, options: RenderOptions) => Promise<Planar | null>

/** One measured value with its acceptance threshold; pass is null for informational rows. */
export type Check = {
  effect: string
  scenario: string
  rate: number
  metric: string
  value: number | null
  unit: string
  threshold: string
  pass: boolean | null
  note?: string
}

export type ParityRow = {
  effect: string
  scenario: string
  rate: number
  maxAbsDiff: number | null
  reason?: string
}
