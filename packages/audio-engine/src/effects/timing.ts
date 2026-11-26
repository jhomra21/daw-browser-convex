import { DEFAULT_BPM } from '@daw-browser/timeline-core/project-defaults'
import {
  AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES,
  EQ_HIGH_QUALITY_LATENCY_FRAMES,
  getSpectralLatencyFrames,
  normalizeDelayParams,
  normalizeReverbParams,
  type CompressorParamsLite,
  type DelayParamsLite,
  type EqParamsLite,
  type OwnedProcessorKind,
  type ReverbParamsLite,
  type SaturatorParamsLite,
} from '@daw-browser/shared'
import { resolveDelayTimeSec } from './dsp'
import type { AudioEffectRuntimeInstance } from './runtime-instance'

type EffectTiming = {
  latencyFrames: number
  tail: { kind: 'finite'; frames: number } | { kind: 'unbounded' }
}

export type EffectTimingInput =
  | Extract<AudioEffectRuntimeInstance, { kind: OwnedProcessorKind }>
  | { kind: 'eq'; params: EqParamsLite }
  | { kind: 'compressor'; params: CompressorParamsLite }
  | { kind: 'saturator'; params: SaturatorParamsLite }
  | { kind: 'delay'; params: DelayParamsLite }
  | { kind: 'reverb'; params: ReverbParamsLite }

// The longest the Reverb holds a signal before its decay starts: the Shape onset (24 ms) plus the four diffuser steps (120 ms).
const REVERB_NETWORK_DELAY_SEC = 0.15

const finite = (frames: number): EffectTiming['tail'] => ({
  kind: 'finite',
  frames: Math.max(0, Math.ceil(frames)),
})

// The core rejects a processor whose declared latency differs from its kernel's, so these mirror
// dsp::Latency::fromMilliseconds and the kernels' latency_frames in native/audio-core/src, which read the
// lookahead as a float: Math.fround keeps the same value, and the ceiling rounds the same way.
const KERNEL_DELAY_CAPACITY_FRAMES = 2048
const LIMITER_MINIMUM_LATENCY_FRAMES = 14
const LIMITER_MAXIMUM_LATENCY_FRAMES = KERNEL_DELAY_CAPACITY_FRAMES - 48

const lookaheadFrames = (lookaheadMs: number, rate: number) =>
  Math.max(0, Math.ceil(Math.fround(lookaheadMs) * rate / 1000))

export const limiterLatencyFrames = (lookaheadMs: number, rate: number) =>
  Math.min(Math.max(lookaheadFrames(lookaheadMs, rate), LIMITER_MINIMUM_LATENCY_FRAMES), LIMITER_MAXIMUM_LATENCY_FRAMES)

/** The Gate and the Compressor share one cap: their delay lines hold one frame less than their capacity. */
export const gateCompressorLatencyFrames = (lookaheadMs: number, rate: number) =>
  Math.min(lookaheadFrames(lookaheadMs, rate), KERNEL_DELAY_CAPACITY_FRAMES - 1)

/** The Through-zero Flanger holds its dry path back by the kernel's fixed 5 ms (ChorusKernel::kThroughZeroDryMs), whatever the other controls say. */
const THROUGH_ZERO_DRY_MS = 5

export const throughZeroLatencyFrames = (rate: number) => lookaheadFrames(THROUGH_ZERO_DRY_MS, rate)

export const getEffectTiming = (
  input: EffectTimingInput,
  sampleRate: number,
  bpm = DEFAULT_BPM,
): EffectTiming => {
  const rate = Math.max(1, sampleRate)

  if (input.kind === 'utility' || input.kind === 'lofi') {
    return { latencyFrames: 0, tail: finite(0) }
  }

  if (input.kind === 'autofilter') {
    return { latencyFrames: input.params.state.hiQuality ? AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES : 0, tail: finite(0) }
  }

  if (input.kind === 'eq') {
    return { latencyFrames: input.params.highQuality ? EQ_HIGH_QUALITY_LATENCY_FRAMES : 0, tail: finite(0) }
  }

  if (input.kind === 'limiter') {
    return { latencyFrames: limiterLatencyFrames(input.params.state.lookaheadMs, rate), tail: finite(0) }
  }

  if (input.kind === 'gate') {
    return { latencyFrames: gateCompressorLatencyFrames(input.params.state.lookaheadMs, rate), tail: finite(0) }
  }

  if (input.kind === 'spectral') {
    return {
      latencyFrames: getSpectralLatencyFrames(input.params.state.fftSize, input.params.state.overlap),
      tail: finite(0),
    }
  }

  if (input.kind === 'compressor') {
    return { latencyFrames: gateCompressorLatencyFrames(input.params.lookaheadMs, rate), tail: finite(0) }
  }

  if (input.kind === 'delay') {
    const normalized = normalizeDelayParams(input.params)

    if (!normalized.enabled || normalized.dryWet === 0) return { latencyFrames: 0, tail: finite(0) }

    if (normalized.freeze || normalized.feedback >= 1) return { latencyFrames: 0, tail: { kind: 'unbounded' } }
    const delayFrames = resolveDelayTimeSec(normalized, bpm) * rate
    const repeats = Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(Math.max(normalized.feedback, 1e-6))))

    return { latencyFrames: 0, tail: finite(delayFrames * repeats) }
  }

  if (input.kind === 'reverb') {
    const normalized = normalizeReverbParams(input.params)

    if (!normalized.enabled || normalized.wet === 0) return { latencyFrames: 0, tail: finite(0) }

    if (normalized.freeze) return { latencyFrames: 0, tail: { kind: 'unbounded' } }

    return {
      latencyFrames: 0,
      tail: finite((normalized.preDelayMs / 1000 + REVERB_NETWORK_DELAY_SEC + normalized.decaySec) * rate),
    }
  }

  if (input.kind === 'chorus' || input.kind === 'flanger') {
    const latencyFrames = input.kind === 'flanger' && input.params.state.mode === 'throughZero' ? throughZeroLatencyFrames(rate) : 0

    if (!input.params.state.enabled || input.params.state.mix === 0) return { latencyFrames, tail: finite(0) }
    const delayFrames = (input.params.state.delayMs + input.params.state.depthMs) * rate / 1000
    const feedback = Math.abs(input.params.state.feedback)
    const repeats = feedback > 0 ? Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(feedback))) : 1

    return { latencyFrames, tail: finite(delayFrames * repeats) }
  }

  if (input.kind === 'ensemble') {
    return {
      latencyFrames: 0,
      tail: finite(input.params.state.enabled && input.params.state.mix > 0
        ? (input.params.state.delayMs + input.params.state.depthMs + input.params.state.fastDepthMs) * rate / 1000
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
  bpm = DEFAULT_BPM,
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

type ExternalEffectTimingInput = {
  latencyFrames: number
  tailFrames: number | null
}

export const getEffectChainTimingWithExternal = (
  instances: readonly AudioEffectRuntimeInstance[],
  external: readonly ExternalEffectTimingInput[],
  sampleRate: number,
  bpm = DEFAULT_BPM,
): EffectTiming => {
  const timing = getEffectChainTiming(instances, sampleRate, bpm)
  let latencyFrames = timing.latencyFrames
  let tailFrames = timing.tail.kind === 'finite' ? timing.tail.frames : 0
  let hasUnboundedTail = timing.tail.kind === 'unbounded'

  for (const processor of external) {
    latencyFrames += Math.max(0, Math.ceil(processor.latencyFrames))

    if (processor.tailFrames === null) {
      hasUnboundedTail = true
      continue
    }

    tailFrames += Math.max(0, Math.ceil(processor.tailFrames))
  }

  return {
    latencyFrames,
    tail: hasUnboundedTail ? { kind: 'unbounded' } : finite(tailFrames),
  }
}
