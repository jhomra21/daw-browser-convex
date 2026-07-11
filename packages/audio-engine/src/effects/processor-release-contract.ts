import type { ChannelLayout } from '../mixer/types'

export type ProcessorQualityTier = 'standard' | 'high'
export type ProcessorAutomationRate = 'continuous' | 'hold'
export type OwnedProcessorKind = 'utility' | 'autofilter' | 'gate' | 'limiter' | 'spectral'

export type ProcessorReleaseContract = {
  kind: OwnedProcessorKind
  stateVersion: 1
  protocolVersion: 1
  layouts: readonly ChannelLayout[]
  parameterAutomation: Readonly<Record<string, ProcessorAutomationRate>>
  timing: (sampleRate: number) => { latencyFrames: number; tail: { kind: 'finite'; frames: number } }
}

export const PROCESSOR_RESOURCE_LIMITS = {
  effectsPerChain: 16,
  liveOwnedWorklets: 64,
  offlineOwnedWorkletsPerChain: 32,
  offlineOwnedWorklets: 256,
} as const

export const OWNED_PROCESSOR_RELEASE_CONTRACTS: Readonly<Record<OwnedProcessorKind, ProcessorReleaseContract>> = {
  utility: {
    kind: 'utility',
    stateVersion: 1,
    protocolVersion: 1,
    layouts: ['mono', 'stereo'],
    parameterAutomation: {
      'utility.gainDb': 'continuous',
      'utility.pan': 'continuous',
      'utility.balance': 'continuous',
      'utility.width': 'continuous',
    },
    timing: () => ({ latencyFrames: 0, tail: { kind: 'finite', frames: 0 } }),
  },
  autofilter: {
    kind: 'autofilter',
    stateVersion: 1,
    protocolVersion: 1,
    layouts: ['mono', 'stereo'],
    parameterAutomation: {
      'autofilter.frequencyHz': 'continuous',
      'autofilter.resonance': 'continuous',
      'autofilter.driveDb': 'continuous',
      'autofilter.mix': 'continuous',
      'autofilter.envelope.amountOctaves': 'continuous',
      'autofilter.envelope.attackMs': 'continuous',
      'autofilter.envelope.releaseMs': 'continuous',
      'autofilter.lfo.rateHz': 'continuous',
      'autofilter.lfo.depthOctaves': 'continuous',
      'autofilter.lfo.phaseOffset': 'continuous',
      'autofilter.lfo.stereoPhase': 'continuous',
      'autofilter.mode': 'hold',
      'autofilter.lfo.waveform': 'hold',
      'autofilter.quality': 'hold',
    },
    timing: () => ({ latencyFrames: 6, tail: { kind: 'finite', frames: 0 } }),
  },
  limiter: {
    kind: 'limiter',
    stateVersion: 1,
    protocolVersion: 1,
    layouts: ['mono', 'stereo'],
    parameterAutomation: {
      'limiter.ceiling': 'continuous',
      'limiter.release': 'continuous',
      'limiter.lookaheadMs': 'hold',
      'limiter.link': 'continuous',
      'limiter.detectorOversampling': 'hold',
    },
    timing: (sampleRate) => ({ latencyFrames: Math.ceil(0.005 * Math.max(1, sampleRate)), tail: { kind: 'finite', frames: 0 } }),
  },
  gate: {
    kind: 'gate',
    stateVersion: 1,
    protocolVersion: 1,
    layouts: ['mono', 'stereo'],
    parameterAutomation: {
      'gate.thresholdDb': 'continuous',
      'gate.ratio': 'continuous',
      'gate.attackMs': 'continuous',
      'gate.holdMs': 'continuous',
      'gate.releaseMs': 'continuous',
      'gate.hysteresisDb': 'continuous',
      'gate.rangeDb': 'continuous',
      'gate.lookaheadMs': 'hold',
      'gate.link': 'continuous',
    },
    timing: (sampleRate) => ({ latencyFrames: Math.ceil(0.002 * Math.max(1, sampleRate)), tail: { kind: 'finite', frames: 0 } }),
  },
  spectral: {
    kind: 'spectral',
    stateVersion: 1,
    protocolVersion: 1,
    layouts: ['mono', 'stereo'],
    parameterAutomation: {
      'spectral.freeze': 'continuous',
      'spectral.gateThresholdDb': 'continuous',
      'spectral.gateAttackMs': 'continuous',
      'spectral.gateReleaseMs': 'continuous',
      'spectral.morph': 'continuous',
      'spectral.binShift': 'continuous',
      'spectral.blur': 'continuous',
      'spectral.harmonicPercussiveBalance': 'continuous',
      'spectral.noiseReduction': 'continuous',
      'spectral.profileLearn': 'continuous',
      'spectral.mix': 'continuous',
      'spectral.fftSize': 'hold',
      'spectral.overlap': 'hold',
      'spectral.mode': 'hold',
    },
    timing: () => ({ latencyFrames: 1536, tail: { kind: 'finite', frames: 0 } }),
  },
}

export function assertEffectChainResourceLimit(effectCount: number): void {
  if (!Number.isInteger(effectCount) || effectCount < 0 || effectCount > PROCESSOR_RESOURCE_LIMITS.effectsPerChain) {
    throw new RangeError(`Effect chain exceeds the ${PROCESSOR_RESOURCE_LIMITS.effectsPerChain} effect limit.`)
  }
}
