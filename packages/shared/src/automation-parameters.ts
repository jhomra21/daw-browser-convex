import type { AutomationEnvelope, AutomationPoint, AutomationTarget, AutomationTargetKind } from './automation'
import { isAutomationInterpolation } from './automation'
import {
  createDefaultDelayParams,
  createDefaultAutoFilterParams,
  createDefaultEqParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  DELAY_DRY_WET_MAX,
  DELAY_DRY_WET_MIN,
  DELAY_FEEDBACK_MAX,
  DELAY_FEEDBACK_MIN,
  DELAY_HIGH_CUT_HZ_MAX,
  DELAY_HIGH_CUT_HZ_MIN,
  DELAY_LOW_CUT_HZ_MAX,
  DELAY_LOW_CUT_HZ_MIN,
  DELAY_TIME_MS_MAX,
  DELAY_TIME_MS_MIN,
  REVERB_PRE_DELAY_MS_MAX,
  REVERB_PRE_DELAY_MS_MIN,
  REVERB_STEREO_WIDTH_MAX,
  REVERB_STEREO_WIDTH_MIN,
  REVERB_WET_MAX,
  REVERB_WET_MIN,
  type AudioEffectKind,
  SATURATOR_COLOR_FREQUENCY_HZ_MAX,
  SATURATOR_COLOR_FREQUENCY_HZ_MIN,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_DRIVE_DB_MIN,
  SATURATOR_DRY_WET_MAX,
  SATURATOR_DRY_WET_MIN,
  SATURATOR_OUTPUT_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
} from './effects-params'
import { instrumentAutomationKey, parseInstrumentAutomationKey, SAMPLER_AUTOMATION_DESCRIPTORS, SAMPLER_AUTOMATION_PARAMETER_IDS } from './sampler-automation'
import { GRANULAR_AUTOMATION_DESCRIPTORS, GRANULAR_AUTOMATION_PARAMETER_IDS, granularAutomationKey, parseGranularAutomationKey } from './granular-automation'
import { parseSynthAutomationKey, SYNTH_AUTOMATION_DESCRIPTORS, SYNTH_AUTOMATION_PARAMETER_IDS, synthAutomationKey } from './synth-automation'

export type AutomationParameterDescriptor = {
  id: string
  label: string
  group: string
  device: string
  owner: 'mixer' | 'sampler' | 'granular' | 'synth' | AudioEffectKind | 'spectral'
  targetKinds: AutomationTargetKind[]
  min: number
  max: number
  defaultValue: number
  scale: 'linear' | 'log'
  unit?: 'db' | 'hz' | 'percent' | 'seconds' | 'milliseconds' | 'semitones' | 'cents' | 'octaves'
}

export type AutomationParameterOption = {
  id: string
  label: string
  group: string
  device: string
}

export type AutomationParameterSelection = {
  parameterId: string
  effectInstanceId?: string
}

export type AutomationEffectInstance = {
  id: string
  kind: AudioEffectKind
}

export type AutomationInstrumentInstance = {
  id: string
  kind: 'sampler' | 'granular' | 'synth'
}

export type AutomationTargetDeviceInstance = AutomationEffectInstance | AutomationInstrumentInstance

export type AutomationTargetParameterOption = AutomationParameterOption & AutomationParameterSelection

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const staticDescriptors: AutomationParameterDescriptor[] = [
  { id: 'volume', label: 'Volume', group: 'Mixer', device: 'Mixer', owner: 'mixer', targetKinds: ['track', 'master'], min: 0, max: 1.5, defaultValue: 1, scale: 'linear', unit: 'percent' },
]

const effectDescriptors: AutomationParameterDescriptor[] = [
  { id: 'utility.gainDb', label: 'Utility Gain', group: 'Audio Effects', device: 'Utility', owner: 'utility', targetKinds: ['track', 'master'], min: -60, max: 24, defaultValue: 0, scale: 'linear', unit: 'db' },
  { id: 'utility.pan', label: 'Utility Pan', group: 'Audio Effects', device: 'Utility', owner: 'utility', targetKinds: ['track', 'master'], min: -1, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'utility.balance', label: 'Utility Balance', group: 'Audio Effects', device: 'Utility', owner: 'utility', targetKinds: ['track', 'master'], min: -1, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'utility.width', label: 'Utility Width', group: 'Audio Effects', device: 'Utility', owner: 'utility', targetKinds: ['track', 'master'], min: 0, max: 2, defaultValue: 1, scale: 'linear' },
  { id: 'autofilter.frequencyHz', label: 'Auto Filter Frequency', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 20, max: 20000, defaultValue: createDefaultAutoFilterParams().frequencyHz, scale: 'log', unit: 'hz' },
  { id: 'autofilter.resonance', label: 'Auto Filter Resonance', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: createDefaultAutoFilterParams().resonance, scale: 'linear' },
  { id: 'autofilter.driveDb', label: 'Auto Filter Drive', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0, max: 24, defaultValue: createDefaultAutoFilterParams().driveDb, scale: 'linear', unit: 'db' },
  { id: 'autofilter.mix', label: 'Auto Filter Mix', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: createDefaultAutoFilterParams().mix, scale: 'linear', unit: 'percent' },
  { id: 'autofilter.envelope.amountOctaves', label: 'Auto Filter Envelope Amount', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: -6, max: 6, defaultValue: 0, scale: 'linear' },
  { id: 'autofilter.envelope.attackMs', label: 'Auto Filter Envelope Attack', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0.5, max: 500, defaultValue: 10, scale: 'linear' },
  { id: 'autofilter.envelope.releaseMs', label: 'Auto Filter Envelope Release', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 5, max: 2000, defaultValue: 100, scale: 'linear' },
  { id: 'autofilter.lfo.rateHz', label: 'Auto Filter LFO Rate', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 1, scale: 'log', unit: 'hz' },
  { id: 'autofilter.lfo.depthOctaves', label: 'Auto Filter LFO Depth', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0, max: 6, defaultValue: 0, scale: 'linear' },
  { id: 'autofilter.lfo.phaseOffset', label: 'Auto Filter LFO Phase', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'autofilter.lfo.stereoPhase', label: 'Auto Filter LFO Stereo Phase', group: 'Audio Effects', device: 'Auto Filter', owner: 'autofilter', targetKinds: ['track', 'master'], min: -0.5, max: 0.5, defaultValue: 0, scale: 'linear' },
  { id: 'gate.thresholdDb', label: 'Gate Threshold', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: -80, max: 0, defaultValue: -40, scale: 'linear', unit: 'db' },
  { id: 'gate.ratio', label: 'Gate Ratio', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 1, max: 20, defaultValue: 4, scale: 'linear' },
  { id: 'gate.attackMs', label: 'Gate Attack', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 0.1, max: 100, defaultValue: 1, scale: 'linear' },
  { id: 'gate.holdMs', label: 'Gate Hold', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 0, max: 500, defaultValue: 20, scale: 'linear' },
  { id: 'gate.releaseMs', label: 'Gate Release', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 5, max: 2000, defaultValue: 120, scale: 'linear' },
  { id: 'gate.hysteresisDb', label: 'Gate Hysteresis', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 0, max: 24, defaultValue: 6, scale: 'linear', unit: 'db' },
  { id: 'gate.rangeDb', label: 'Gate Range', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: -80, max: 0, defaultValue: -80, scale: 'linear', unit: 'db' },
  { id: 'gate.lookaheadMs', label: 'Gate Lookahead', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 0, max: 2, defaultValue: 0, scale: 'linear' },
  { id: 'gate.link', label: 'Gate Link', group: 'Audio Effects', device: 'Gate', owner: 'gate', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear' },
  { id: 'limiter.ceiling', label: 'Limiter Ceiling', group: 'Audio Effects', device: 'Limiter', owner: 'limiter', targetKinds: ['track', 'master'], min: -12, max: 0, defaultValue: -1, scale: 'linear', unit: 'db' },
  { id: 'limiter.release', label: 'Limiter Release', group: 'Audio Effects', device: 'Limiter', owner: 'limiter', targetKinds: ['track', 'master'], min: 20, max: 1000, defaultValue: 100, scale: 'linear' },
  { id: 'limiter.link', label: 'Limiter Link', group: 'Audio Effects', device: 'Limiter', owner: 'limiter', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear' },
  { id: 'lofi.bitDepth', label: 'LoFi Bit Depth', group: 'Audio Effects', device: 'LoFi', owner: 'lofi', targetKinds: ['track', 'master'], min: 2, max: 24, defaultValue: 12, scale: 'linear' },
  { id: 'lofi.sampleRateRatio', label: 'LoFi Sample Rate', group: 'Audio Effects', device: 'LoFi', owner: 'lofi', targetKinds: ['track', 'master'], min: 0.01, max: 1, defaultValue: 1, scale: 'linear', unit: 'percent' },
  { id: 'lofi.jitter', label: 'LoFi Jitter', group: 'Audio Effects', device: 'LoFi', owner: 'lofi', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'lofi.noiseDb', label: 'LoFi Noise', group: 'Audio Effects', device: 'LoFi', owner: 'lofi', targetKinds: ['track', 'master'], min: -120, max: -24, defaultValue: -80, scale: 'linear', unit: 'db' },
  { id: 'lofi.mix', label: 'LoFi Mix', group: 'Audio Effects', device: 'LoFi', owner: 'lofi', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear', unit: 'percent' },
  { id: 'saturator.driveDb', label: 'Saturator Drive', group: 'Audio Effects', device: 'Saturator', owner: 'saturator', targetKinds: ['track', 'master'], min: SATURATOR_DRIVE_DB_MIN, max: SATURATOR_DRIVE_DB_MAX, defaultValue: createDefaultSaturatorParams().driveDb, scale: 'linear', unit: 'db' },
  { id: 'saturator.outputDb', label: 'Saturator Output', group: 'Audio Effects', device: 'Saturator', owner: 'saturator', targetKinds: ['track', 'master'], min: SATURATOR_OUTPUT_DB_MIN, max: SATURATOR_OUTPUT_DB_MAX, defaultValue: createDefaultSaturatorParams().outputDb, scale: 'linear', unit: 'db' },
  { id: 'saturator.dryWet', label: 'Saturator Dry/Wet', group: 'Audio Effects', device: 'Saturator', owner: 'saturator', targetKinds: ['track', 'master'], min: SATURATOR_DRY_WET_MIN, max: SATURATOR_DRY_WET_MAX, defaultValue: createDefaultSaturatorParams().dryWet, scale: 'linear', unit: 'percent' },
  { id: 'saturator.colorFrequencyHz', label: 'Saturator Color Frequency', group: 'Audio Effects', device: 'Saturator', owner: 'saturator', targetKinds: ['track', 'master'], min: SATURATOR_COLOR_FREQUENCY_HZ_MIN, max: SATURATOR_COLOR_FREQUENCY_HZ_MAX, defaultValue: createDefaultSaturatorParams().colorFrequencyHz, scale: 'log', unit: 'hz' },
  { id: 'delay.timeMs', label: 'Delay Time', group: 'Audio Effects', device: 'Delay', owner: 'delay', targetKinds: ['track', 'master'], min: DELAY_TIME_MS_MIN, max: DELAY_TIME_MS_MAX, defaultValue: createDefaultDelayParams().timeMs, scale: 'linear' },
  { id: 'delay.feedback', label: 'Delay Feedback', group: 'Audio Effects', device: 'Delay', owner: 'delay', targetKinds: ['track', 'master'], min: DELAY_FEEDBACK_MIN, max: DELAY_FEEDBACK_MAX, defaultValue: createDefaultDelayParams().feedback, scale: 'linear', unit: 'percent' },
  { id: 'delay.dryWet', label: 'Delay Dry/Wet', group: 'Audio Effects', device: 'Delay', owner: 'delay', targetKinds: ['track', 'master'], min: DELAY_DRY_WET_MIN, max: DELAY_DRY_WET_MAX, defaultValue: createDefaultDelayParams().dryWet, scale: 'linear', unit: 'percent' },
  { id: 'delay.lowCutHz', label: 'Delay Low Cut', group: 'Audio Effects', device: 'Delay', owner: 'delay', targetKinds: ['track', 'master'], min: DELAY_LOW_CUT_HZ_MIN, max: DELAY_LOW_CUT_HZ_MAX, defaultValue: createDefaultDelayParams().lowCutHz, scale: 'log', unit: 'hz' },
  { id: 'delay.highCutHz', label: 'Delay High Cut', group: 'Audio Effects', device: 'Delay', owner: 'delay', targetKinds: ['track', 'master'], min: DELAY_HIGH_CUT_HZ_MIN, max: DELAY_HIGH_CUT_HZ_MAX, defaultValue: createDefaultDelayParams().highCutHz, scale: 'log', unit: 'hz' },
  { id: 'reverb.wet', label: 'Reverb Dry/Wet', group: 'Audio Effects', device: 'Reverb', owner: 'reverb', targetKinds: ['track', 'master'], min: REVERB_WET_MIN, max: REVERB_WET_MAX, defaultValue: createDefaultReverbParams().wet, scale: 'linear', unit: 'percent' },
  { id: 'reverb.preDelayMs', label: 'Reverb Predelay', group: 'Audio Effects', device: 'Reverb', owner: 'reverb', targetKinds: ['track', 'master'], min: REVERB_PRE_DELAY_MS_MIN, max: REVERB_PRE_DELAY_MS_MAX, defaultValue: createDefaultReverbParams().preDelayMs, scale: 'linear' },
  { id: 'reverb.stereoWidth', label: 'Reverb Width', group: 'Audio Effects', device: 'Reverb', owner: 'reverb', targetKinds: ['track', 'master'], min: REVERB_STEREO_WIDTH_MIN, max: REVERB_STEREO_WIDTH_MAX, defaultValue: createDefaultReverbParams().stereoWidth, scale: 'linear' },
  { id: 'chorus.delayMs', label: 'Chorus Delay', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: 5, max: 30, defaultValue: 12, scale: 'linear' },
  { id: 'chorus.depthMs', label: 'Chorus Depth', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: 0, max: 10, defaultValue: 4, scale: 'linear' },
  { id: 'chorus.rateHz', label: 'Chorus Rate', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 0.8, scale: 'log', unit: 'hz' },
  { id: 'chorus.feedback', label: 'Chorus Feedback', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: 0, max: 0.5, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'chorus.stereoPhase', label: 'Chorus Stereo Phase', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: -0.5, max: 0.5, defaultValue: 0.25, scale: 'linear' },
  { id: 'chorus.mix', label: 'Chorus Mix', group: 'Audio Effects', device: 'Chorus', owner: 'chorus', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.35, scale: 'linear', unit: 'percent' },
  { id: 'flanger.delayMs', label: 'Flanger Delay', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: 0.1, max: 10, defaultValue: 1.5, scale: 'linear' },
  { id: 'flanger.depthMs', label: 'Flanger Depth', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: 0, max: 5, defaultValue: 1, scale: 'linear' },
  { id: 'flanger.rateHz', label: 'Flanger Rate', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 0.2, scale: 'log', unit: 'hz' },
  { id: 'flanger.feedback', label: 'Flanger Feedback', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: -0.95, max: 0.95, defaultValue: 0.35, scale: 'linear', unit: 'percent' },
  { id: 'flanger.stereoPhase', label: 'Flanger Stereo Phase', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: -0.5, max: 0.5, defaultValue: 0.5, scale: 'linear' },
  { id: 'flanger.mix', label: 'Flanger Mix', group: 'Audio Effects', device: 'Flanger', owner: 'flanger', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear', unit: 'percent' },
  { id: 'phaser.centerHz', label: 'Phaser Center', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: 100, max: 8000, defaultValue: 1000, scale: 'log', unit: 'hz' },
  { id: 'phaser.depthOctaves', label: 'Phaser Depth', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: 0, max: 5, defaultValue: 3, scale: 'linear' },
  { id: 'phaser.rateHz', label: 'Phaser Rate', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 0.3, scale: 'log', unit: 'hz' },
  { id: 'phaser.feedback', label: 'Phaser Feedback', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: -0.95, max: 0.95, defaultValue: 0.3, scale: 'linear', unit: 'percent' },
  { id: 'phaser.stereoPhase', label: 'Phaser Stereo Phase', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: -0.5, max: 0.5, defaultValue: 0.5, scale: 'linear' },
  { id: 'phaser.mix', label: 'Phaser Mix', group: 'Audio Effects', device: 'Phaser', owner: 'phaser', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear', unit: 'percent' },
  { id: 'tremolo.rateHz', label: 'Tremolo Rate', group: 'Audio Effects', device: 'Tremolo', owner: 'tremolo', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 4, scale: 'log', unit: 'hz' },
  { id: 'tremolo.depth', label: 'Tremolo Depth', group: 'Audio Effects', device: 'Tremolo', owner: 'tremolo', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear', unit: 'percent' },
  { id: 'tremolo.shape', label: 'Tremolo Shape', group: 'Audio Effects', device: 'Tremolo', owner: 'tremolo', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear' },
  { id: 'tremolo.phase', label: 'Tremolo Phase', group: 'Audio Effects', device: 'Tremolo', owner: 'tremolo', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'autopan.rateHz', label: 'Auto Pan Rate', group: 'Audio Effects', device: 'Auto Pan', owner: 'autopan', targetKinds: ['track', 'master'], min: 0.01, max: 20, defaultValue: 1, scale: 'log', unit: 'hz' },
  { id: 'autopan.depth', label: 'Auto Pan Depth', group: 'Audio Effects', device: 'Auto Pan', owner: 'autopan', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear', unit: 'percent' },
  { id: 'autopan.shape', label: 'Auto Pan Shape', group: 'Audio Effects', device: 'Auto Pan', owner: 'autopan', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear' },
  { id: 'autopan.phase', label: 'Auto Pan Phase', group: 'Audio Effects', device: 'Auto Pan', owner: 'autopan', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'ensemble.delayMs', label: 'Ensemble Delay', group: 'Audio Effects', device: 'Ensemble', owner: 'ensemble', targetKinds: ['track', 'master'], min: 10, max: 30, defaultValue: 18, scale: 'linear' },
  { id: 'ensemble.depthMs', label: 'Ensemble Depth', group: 'Audio Effects', device: 'Ensemble', owner: 'ensemble', targetKinds: ['track', 'master'], min: 1, max: 12, defaultValue: 6, scale: 'linear' },
  { id: 'ensemble.rateHz', label: 'Ensemble Rate', group: 'Audio Effects', device: 'Ensemble', owner: 'ensemble', targetKinds: ['track', 'master'], min: 0.05, max: 5, defaultValue: 0.6, scale: 'log', unit: 'hz' },
  { id: 'ensemble.spread', label: 'Ensemble Spread', group: 'Audio Effects', device: 'Ensemble', owner: 'ensemble', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear' },
  { id: 'ensemble.mix', label: 'Ensemble Mix', group: 'Audio Effects', device: 'Ensemble', owner: 'ensemble', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0.5, scale: 'linear', unit: 'percent' },
  { id: 'spectral.freeze', label: 'Spectral Freeze', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'spectral.gateThresholdDb', label: 'Spectral Gate Threshold', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: -120, max: 0, defaultValue: -60, scale: 'linear', unit: 'db' },
  { id: 'spectral.gateAttackMs', label: 'Spectral Gate Attack', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0.1, max: 1000, defaultValue: 10, scale: 'linear' },
  { id: 'spectral.gateReleaseMs', label: 'Spectral Gate Release', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 1, max: 5000, defaultValue: 100, scale: 'linear' },
  { id: 'spectral.morph', label: 'Spectral Morph', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'spectral.binShift', label: 'Spectral Bin Shift', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: -2048, max: 2048, defaultValue: 0, scale: 'linear' },
  { id: 'spectral.blur', label: 'Spectral Blur', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'spectral.harmonicPercussiveBalance', label: 'Spectral HPSS Balance', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: -1, max: 1, defaultValue: 0, scale: 'linear' },
  { id: 'spectral.noiseReduction', label: 'Spectral Noise Reduction', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'spectral.profileLearn', label: 'Spectral Profile Learn', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 0, scale: 'linear', unit: 'percent' },
  { id: 'spectral.mix', label: 'Spectral Mix', group: 'Audio Effects', device: 'Spectral', owner: 'spectral', targetKinds: ['track', 'master'], min: 0, max: 1, defaultValue: 1, scale: 'linear', unit: 'percent' },
]

const descriptorsByEffectKind: Record<AudioEffectKind | 'spectral', AutomationParameterDescriptor[]> = {
  utility: effectDescriptors.filter((descriptor) => descriptor.owner === 'utility'),
  eq: [],
  autofilter: effectDescriptors.filter((descriptor) => descriptor.owner === 'autofilter'),
  gate: effectDescriptors.filter((descriptor) => descriptor.owner === 'gate'),
  limiter: effectDescriptors.filter((descriptor) => descriptor.owner === 'limiter'),
  lofi: effectDescriptors.filter((descriptor) => descriptor.owner === 'lofi'),
  compressor: [],
  saturator: effectDescriptors.filter((descriptor) => descriptor.owner === 'saturator'),
  delay: effectDescriptors.filter((descriptor) => descriptor.owner === 'delay'),
  reverb: effectDescriptors.filter((descriptor) => descriptor.owner === 'reverb'),
  chorus: effectDescriptors.filter((descriptor) => descriptor.owner === 'chorus'),
  flanger: effectDescriptors.filter((descriptor) => descriptor.owner === 'flanger'),
  phaser: effectDescriptors.filter((descriptor) => descriptor.owner === 'phaser'),
  tremolo: effectDescriptors.filter((descriptor) => descriptor.owner === 'tremolo'),
  autopan: effectDescriptors.filter((descriptor) => descriptor.owner === 'autopan'),
  ensemble: effectDescriptors.filter((descriptor) => descriptor.owner === 'ensemble'),
  spectral: effectDescriptors.filter((descriptor) => descriptor.owner === 'spectral'),
}

export const getAutomationParameterOptions = (): AutomationParameterOption[] => [
  { id: 'volume', label: 'Volume', group: 'Mixer', device: 'Mixer' },
  ...effectDescriptors.map(({ id, label, group, device }) => ({ id, label, group, device })),
  ...createDefaultEqParams().bands.flatMap((band, index) => {
    const label = `EQ ${index + 1}`
    return [
      { id: createEqBandParameterId(band.id, 'frequencyHz'), label: `${label} Frequency`, group: 'Audio Effects', device: 'EQ Eight' },
      { id: createEqBandParameterId(band.id, 'gainDb'), label: `${label} Gain`, group: 'Audio Effects', device: 'EQ Eight' },
      { id: createEqBandParameterId(band.id, 'q'), label: `${label} Q`, group: 'Audio Effects', device: 'EQ Eight' },
    ]
  }),
]

const eqParameterOptions = (): AutomationParameterOption[] => (
  createDefaultEqParams().bands.flatMap((band, index) => {
    const label = `EQ ${index + 1}`
    return [
      { id: createEqBandParameterId(band.id, 'frequencyHz'), label: `${label} Frequency`, group: 'Audio Effects', device: 'EQ Eight' },
      { id: createEqBandParameterId(band.id, 'gainDb'), label: `${label} Gain`, group: 'Audio Effects', device: 'EQ Eight' },
      { id: createEqBandParameterId(band.id, 'q'), label: `${label} Q`, group: 'Audio Effects', device: 'EQ Eight' },
    ]
  })
)

export const getAutomationParameterOptionsForTarget = (
  effects: readonly AutomationTargetDeviceInstance[],
  trackId?: string,
): AutomationTargetParameterOption[] => {
  const kindCounts = new Map<AudioEffectKind, number>()
  return [
    { id: 'volume', parameterId: 'volume', label: 'Volume', group: 'Mixer', device: 'Mixer' },
    ...effects.flatMap((effect): AutomationTargetParameterOption[] => {
      if (effect.kind === 'sampler' || effect.kind === 'granular' || effect.kind === 'synth') {
        if (!trackId) return []
        if (effect.kind === 'sampler') {
          return SAMPLER_AUTOMATION_PARAMETER_IDS.map((parameterId) => ({
            id: instrumentAutomationKey(trackId, effect.id, parameterId),
            parameterId: instrumentAutomationKey(trackId, effect.id, parameterId),
            label: parameterId,
            group: 'Instrument',
            device: 'Sampler',
          }))
        }
        if (effect.kind === 'granular') return GRANULAR_AUTOMATION_PARAMETER_IDS.map((parameterId) => ({
          id: granularAutomationKey(trackId, effect.id, parameterId),
          parameterId: granularAutomationKey(trackId, effect.id, parameterId),
          label: parameterId,
          group: 'Instrument',
          device: 'Granular',
        }))
        return SYNTH_AUTOMATION_PARAMETER_IDS.map((parameterId) => ({
          id: synthAutomationKey(trackId, effect.id, parameterId),
          parameterId: synthAutomationKey(trackId, effect.id, parameterId),
          label: parameterId,
          group: 'Instrument',
          device: 'Synth',
        }))
      }
      const ordinal = (kindCounts.get(effect.kind) ?? 0) + 1
      kindCounts.set(effect.kind, ordinal)
      const options = effect.kind === 'eq'
        ? eqParameterOptions()
        : descriptorsByEffectKind[effect.kind].map(({ id, label, group, device }) => ({ id, label, group, device }))
      return options.map((option) => ({
        ...option,
        parameterId: option.id,
        effectInstanceId: effect.id,
        device: `${option.device} ${ordinal}`,
      }))
    }),
  ]
}

export const createEqBandParameterId = (
  bandId: string,
  property: 'frequencyHz' | 'gainDb' | 'q',
): string => `eq.${bandId}.${property}`

export const parseEqBandParameterId = (parameterId: string) => {
  const parts = parameterId.split('.')
  if (parts.length !== 3 || parts[0] !== 'eq' || !parts[1]) return null
  const property = parts[2]
  if (property !== 'frequencyHz' && property !== 'gainDb' && property !== 'q') return null
  return { bandId: parts[1], property }
}

export const getAutomationParameterDescriptor = (
  parameterId: string,
): AutomationParameterDescriptor | undefined => {
  const staticDescriptor = staticDescriptors.find((descriptor) => descriptor.id === parameterId)
  if (staticDescriptor) return staticDescriptor
  const effectDescriptor = effectDescriptors.find((descriptor) => descriptor.id === parameterId)
  if (effectDescriptor) return effectDescriptor
  const sampler = parseInstrumentAutomationKey(parameterId)
  if (sampler) {
    const descriptor = SAMPLER_AUTOMATION_DESCRIPTORS[sampler.parameterId]
    return {
      id: parameterId,
      label: sampler.parameterId,
      group: 'Instrument',
      device: 'Sampler',
      owner: 'sampler',
      targetKinds: ['track'],
      min: descriptor.min,
      max: descriptor.max,
      defaultValue: descriptor.defaultValue,
      scale: descriptor.unit === 'hz' ? 'log' : 'linear',
      unit: descriptor.unit === 'ratio' ? 'percent' : descriptor.unit,
    }
  }
  const granular = parseGranularAutomationKey(parameterId)
  if (granular) {
    const descriptor = GRANULAR_AUTOMATION_DESCRIPTORS[granular.parameterId]
    return {
      id: parameterId,
      label: granular.parameterId,
      group: 'Instrument',
      device: 'Granular',
      owner: 'granular',
      targetKinds: ['track'],
      min: descriptor.min,
      max: descriptor.max,
      defaultValue: descriptor.defaultValue,
      scale: descriptor.unit === 'hz' ? 'log' : 'linear',
      unit: descriptor.unit === 'ratio' ? 'percent' : descriptor.unit,
    }
  }
  const synth = parseSynthAutomationKey(parameterId)
  if (synth) {
    const descriptor = SYNTH_AUTOMATION_DESCRIPTORS[synth.parameterId]
    return {
      id: parameterId,
      label: synth.parameterId,
      group: 'Instrument',
      device: 'Synth',
      owner: 'synth',
      targetKinds: ['track'],
      min: descriptor.min,
      max: descriptor.max,
      defaultValue: descriptor.defaultValue,
      scale: descriptor.unit === 'hz' || descriptor.unit === 'seconds' ? 'log' : 'linear',
      unit: descriptor.unit === 'ratio' ? 'percent' : descriptor.unit,
    }
  }
  const eq = parseEqBandParameterId(parameterId)
  if (!eq) return undefined
  if (eq.property === 'frequencyHz') {
    return { id: parameterId, label: 'EQ Frequency', group: 'Audio Effects', device: 'EQ Eight', owner: 'eq', targetKinds: ['track', 'master'], min: 20, max: 20000, defaultValue: 1000, scale: 'log', unit: 'hz' }
  }
  if (eq.property === 'gainDb') {
    return { id: parameterId, label: 'EQ Gain', group: 'Audio Effects', device: 'EQ Eight', owner: 'eq', targetKinds: ['track', 'master'], min: -24, max: 24, defaultValue: 0, scale: 'linear', unit: 'db' }
  }
  return { id: parameterId, label: 'EQ Q', group: 'Audio Effects', device: 'EQ Eight', owner: 'eq', targetKinds: ['track', 'master'], min: 0.1, max: 18, defaultValue: 1, scale: 'linear' }
}

export const isAutomationParameterSupportedForTarget = (
  parameterId: string,
  targetKind: AutomationTargetKind,
) => getAutomationParameterDescriptor(parameterId)?.targetKinds.includes(targetKind) ?? false

export const isAutomationParameterOwnedByTarget = (
  parameterId: string,
  target: AutomationTarget,
): boolean => {
  const descriptor = getAutomationParameterDescriptor(parameterId)
  if (!descriptor || !descriptor.targetKinds.includes(target.kind)) return false
  return descriptor.owner === 'mixer'
    ? target.effectInstanceId === undefined
    : descriptor.owner === 'sampler' || descriptor.owner === 'granular' || descriptor.owner === 'synth'
      ? target.effectInstanceId === undefined
      : target.effectInstanceId !== undefined
}

export const automationValueToRatio = (
  descriptor: AutomationParameterDescriptor,
  value: number,
): number => {
  const clamped = clamp(value, descriptor.min, descriptor.max)
  if (descriptor.scale === 'log') {
    const min = Math.max(Number.MIN_VALUE, descriptor.min)
    const max = Math.max(min, descriptor.max)
    return clamp(Math.log(clamped / min) / Math.log(max / min), 0, 1)
  }
  return clamp((clamped - descriptor.min) / (descriptor.max - descriptor.min), 0, 1)
}

export const automationRatioToValue = (
  descriptor: AutomationParameterDescriptor,
  ratio: number,
): number => {
  const clamped = clamp(ratio, 0, 1)
  if (descriptor.scale === 'log') {
    const min = Math.max(Number.MIN_VALUE, descriptor.min)
    const max = Math.max(min, descriptor.max)
    return min * ((max / min) ** clamped)
  }
  return descriptor.min + clamped * (descriptor.max - descriptor.min)
}

export const normalizeAutomationPoints = (
  points: AutomationPoint[],
  descriptor: AutomationParameterDescriptor,
): AutomationPoint[] => {
  const byTime = new Map<number, AutomationPoint>()
  for (const point of points) {
    if (!Number.isFinite(point.timeSec) || !Number.isFinite(point.value) || !point.id) continue
    const timeSec = Math.max(0, point.timeSec)
    byTime.set(timeSec, {
      id: point.id,
      timeSec,
      value: clamp(point.value, descriptor.min, descriptor.max),
      interpolation: isAutomationInterpolation(point.interpolation) ? point.interpolation : 'linear',
    })
  }
  return [...byTime.values()].sort((a, b) => a.timeSec - b.timeSec || a.id.localeCompare(b.id))
}

export const valueAtAutomationTime = (
  points: readonly AutomationPoint[],
  timeSec: number,
  fallbackValue: number,
): number => {
  if (points.length === 0) return fallbackValue
  // Automation points are normalized at persistence and editing boundaries.
  // Keep evaluation allocation-free because this runs for every active envelope
  // on each bounded playhead publication.
  const first = points[0]
  if (!first || timeSec <= first.timeSec) return first?.value ?? fallbackValue
  let low = 1
  let high = points.length - 1
  let nextIndex = points.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const point = points[middle]
    if (!point) {
      high = middle - 1
      continue
    }
    if (timeSec <= point.timeSec) {
      nextIndex = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  if (nextIndex >= points.length) return points[points.length - 1]?.value ?? fallbackValue
  const previous = points[nextIndex - 1]
  const next = points[nextIndex]
  if (!previous || !next) return fallbackValue
  if (previous.interpolation === 'hold') return previous.value
  const span = next.timeSec - previous.timeSec
  if (span <= 0) return next.value
  const progress = (timeSec - previous.timeSec) / span
  return previous.value + ((next.value - previous.value) * progress)
}

export const evaluatedAutomationValuesByTargetKey = (
  envelopes: readonly AutomationEnvelope[],
  timeSec: number,
  overriddenTargetKeys: ReadonlySet<string> = new Set(),
): Map<string, number> => {
  const values = new Map<string, number>()
  for (const envelope of envelopes) {
    if (!envelope.enabled || overriddenTargetKeys.has(envelope.targetKey)) continue
    const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
    values.set(
      envelope.targetKey,
      valueAtAutomationTime(envelope.points, timeSec, descriptor?.defaultValue ?? 0),
    )
  }
  return values
}
