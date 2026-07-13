import {
  getSpectralLatencyFrames,
  normalizeDelayParams,
  normalizeReverbParams,
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
  | Extract<AudioEffectRuntimeInstance, { kind: 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble' }>
  | Extract<AudioEffectRuntimeInstance, { kind: 'utility' | 'autofilter' | 'gate' | 'limiter' | 'lofi' | 'spectral' }>
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
  if (input.kind === 'utility' || input.kind === 'lofi') {
    return { latencyFrames: 0, tail: finite(0) }
  }
  if (input.kind === 'autofilter') {
    return { latencyFrames: 6, tail: finite(0) }
  }
  if (input.kind === 'limiter') {
    return { latencyFrames: Math.ceil(5 * rate / 1000), tail: finite(0) }
  }
  if (input.kind === 'gate') {
    return { latencyFrames: Math.ceil(2 * rate / 1000), tail: finite(0) }
  }
  if (input.kind === 'spectral') {
    return {
      latencyFrames: getSpectralLatencyFrames(input.params.state.fftSize, input.params.state.overlap),
      tail: finite(0),
    }
  }
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
  if (input.kind === 'chorus' || input.kind === 'flanger') {
    if (!input.params.state.enabled || input.params.state.mix === 0) return { latencyFrames: 0, tail: finite(0) }
    const delayFrames = (input.params.state.delayMs + input.params.state.depthMs) * rate / 1000
    const feedback = Math.abs(input.params.state.feedback)
    const repeats = feedback > 0 ? Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(feedback))) : 1
    return { latencyFrames: 0, tail: finite(delayFrames * repeats) }
  }
  if (input.kind === 'ensemble') {
    return {
      latencyFrames: 0,
      tail: finite(input.params.state.enabled && input.params.state.mix > 0
        ? (input.params.state.delayMs + input.params.state.depthMs) * rate / 1000
        : 0),
    }
  }
  if (input.kind === 'phaser') {
    if (!input.params.state.enabled || input.params.state.mix === 0) return { latencyFrames: 0, tail: finite(0) }
    const feedback = Math.abs(input.params.state.feedback)
    const cycles = feedback > 0 ? Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(feedback))) : 1
    return { latencyFrames: 0, tail: finite(input.params.state.stages * cycles) }
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
