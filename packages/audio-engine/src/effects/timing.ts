import {
  normalizeDelayParams,
  normalizeReverbParams,
  type AudioEffectKind,
  type CompressorParamsLite,
  type DelayParamsLite,
  type EqParamsLite,
  type ReverbParamsLite,
  type SaturatorParamsLite,
} from '@daw-browser/shared'
import type { AudioEffectRuntimeInstance } from './runtime-instance'

type EffectTiming = {
  latencyFrames: number
  tail: { kind: 'finite'; frames: number } | { kind: 'unbounded' }
}

type EffectTimingInput =
  | { kind: 'eq'; params: EqParamsLite }
  | { kind: 'compressor'; params: CompressorParamsLite }
  | { kind: 'saturator'; params: SaturatorParamsLite }
  | { kind: 'delay'; params: DelayParamsLite }
  | { kind: 'reverb'; params: ReverbParamsLite }

const COMPRESSOR_MAX_LOOKAHEAD_MS = 10

const finite = (frames: number): EffectTiming['tail'] => ({
  kind: 'finite',
  frames: Math.max(0, Math.ceil(frames)),
})

const delayTimeSeconds = (params: DelayParamsLite, bpm: number) => {
  const normalized = normalizeDelayParams(params)
  if (normalized.mode === 'time') return normalized.timeMs / 1000
  const beatsByDivision = {
    '1/16': 0.25,
    '1/8': 0.5,
    '1/4': 1,
    '1/2': 2,
    '1/1': 4,
  }
  return beatsByDivision[normalized.syncDivision] * 60 / Math.max(1, bpm)
}

export const getEffectTiming = (
  input: EffectTimingInput,
  sampleRate: number,
  bpm = 120,
): EffectTiming => {
  const rate = Math.max(1, sampleRate)
  if (input.kind === 'compressor') {
    return {
      latencyFrames: Math.ceil(COMPRESSOR_MAX_LOOKAHEAD_MS * rate / 1000),
      tail: finite(0),
    }
  }
  if (input.kind === 'delay') {
    const normalized = normalizeDelayParams(input.params)
    if (!normalized.enabled || normalized.dryWet === 0) return { latencyFrames: 0, tail: finite(0) }
    if (normalized.feedback >= 1) return { latencyFrames: 0, tail: { kind: 'unbounded' } }
    const delayFrames = delayTimeSeconds(normalized, bpm) * rate
    const repeats = Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(Math.max(normalized.feedback, 1e-6))))
    return { latencyFrames: 0, tail: finite(delayFrames * repeats) }
  }
  if (input.kind === 'reverb') {
    const normalized = normalizeReverbParams(input.params)
    return {
      latencyFrames: 0,
      tail: finite(normalized.enabled ? (normalized.preDelayMs / 1000 + normalized.decaySec) * rate : 0),
    }
  }
  return { latencyFrames: 0, tail: finite(0) }
}

export const getEffectChainTiming = (
  instances: readonly AudioEffectRuntimeInstance[],
  sampleRate: number,
  bpm = 120,
): EffectTiming => {
  let latencyFrames = 0
  let tailFrames = 0
  for (const instance of instances) {
    const timing = getEffectTiming(instance, sampleRate, bpm)
    latencyFrames += timing.latencyFrames
    if (timing.tail.kind === 'unbounded') return { latencyFrames, tail: timing.tail }
    tailFrames += timing.tail.frames
  }
  return { latencyFrames, tail: finite(tailFrames) }
}

export const getLegacyEffectChainTiming = (
  effects: {
    eq?: EqParamsLite
    compressor?: CompressorParamsLite
    saturator?: SaturatorParamsLite
    delay?: DelayParamsLite
    reverb?: ReverbParamsLite
  },
  order: readonly AudioEffectKind[],
  sampleRate: number,
  bpm = 120,
): EffectTiming => {
  let latencyFrames = 0
  let tailFrames = 0
  for (const kind of order) {
    const timing = (() => {
      if (kind === 'eq' && effects.eq) return getEffectTiming({ kind, params: effects.eq }, sampleRate, bpm)
      if (kind === 'compressor' && effects.compressor) return getEffectTiming({ kind, params: effects.compressor }, sampleRate, bpm)
      if (kind === 'saturator' && effects.saturator) return getEffectTiming({ kind, params: effects.saturator }, sampleRate, bpm)
      if (kind === 'delay' && effects.delay) return getEffectTiming({ kind, params: effects.delay }, sampleRate, bpm)
      if (kind === 'reverb' && effects.reverb) return getEffectTiming({ kind, params: effects.reverb }, sampleRate, bpm)
      return null
    })()
    if (!timing) continue
    latencyFrames += timing.latencyFrames
    if (timing.tail.kind === 'unbounded') return { latencyFrames, tail: timing.tail }
    tailFrames += timing.tail.frames
  }
  return { latencyFrames, tail: finite(tailFrames) }
}
