import { createDefaultSynthParams, SYNTH_PARAMETER_LIMITS } from './synth-params'

export const SYNTH_AUTOMATION_PARAMETER_IDS = [
  'output.gain',
  'output.pan',
  'osc1.level',
  'osc1.detune',
  'osc2.level',
  'osc2.detune',
  'noise.level',
  'amp.attack',
  'amp.decay',
  'amp.sustain',
  'amp.release',
  'filter.frequency',
  'filter.q',
  'filter.envAmount',
  'filter.attack',
  'filter.decay',
  'filter.sustain',
  'filter.release',
  'lfo.rate',
  'lfo.pitchDepth',
  'lfo.filterDepth',
  'lfo.ampDepth',
  'lfo.panDepth',
] as const

export type SynthAutomationParameterId = typeof SYNTH_AUTOMATION_PARAMETER_IDS[number]

export type SynthAutomationDescriptor = {
  defaultValue: number
  min: number
  max: number
  unit: 'ratio' | 'seconds' | 'hz' | 'cents' | 'octaves'
  rate: 'a-rate' | 'note'
}

const defaults = createDefaultSynthParams()

export const SYNTH_AUTOMATION_DESCRIPTORS: Readonly<Record<SynthAutomationParameterId, SynthAutomationDescriptor>> = {
  'output.gain': { defaultValue: defaults.gain, ...SYNTH_PARAMETER_LIMITS.gain, unit: 'ratio', rate: 'a-rate' },
  'output.pan': { defaultValue: defaults.pan, ...SYNTH_PARAMETER_LIMITS.pan, unit: 'ratio', rate: 'a-rate' },
  'osc1.level': { defaultValue: defaults.oscillators[0].level, ...SYNTH_PARAMETER_LIMITS.oscillatorLevel, unit: 'ratio', rate: 'a-rate' },
  'osc1.detune': { defaultValue: defaults.oscillators[0].detuneCents, ...SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents, unit: 'cents', rate: 'a-rate' },
  'osc2.level': { defaultValue: defaults.oscillators[1].level, ...SYNTH_PARAMETER_LIMITS.oscillatorLevel, unit: 'ratio', rate: 'a-rate' },
  'osc2.detune': { defaultValue: defaults.oscillators[1].detuneCents, ...SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents, unit: 'cents', rate: 'a-rate' },
  'noise.level': { defaultValue: defaults.noise.level, ...SYNTH_PARAMETER_LIMITS.noiseLevel, unit: 'ratio', rate: 'a-rate' },
  'amp.attack': { defaultValue: defaults.ampEnvelope.attackSec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'amp.decay': { defaultValue: defaults.ampEnvelope.decaySec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'amp.sustain': { defaultValue: defaults.ampEnvelope.sustain, ...SYNTH_PARAMETER_LIMITS.sustain, unit: 'ratio', rate: 'note' },
  'amp.release': { defaultValue: defaults.ampEnvelope.releaseSec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'filter.frequency': { defaultValue: defaults.filter.frequencyHz, ...SYNTH_PARAMETER_LIMITS.filterFrequencyHz, unit: 'hz', rate: 'a-rate' },
  'filter.q': { defaultValue: defaults.filter.q, ...SYNTH_PARAMETER_LIMITS.filterQ, unit: 'ratio', rate: 'a-rate' },
  'filter.envAmount': { defaultValue: defaults.filter.envelopeAmountOctaves, ...SYNTH_PARAMETER_LIMITS.filterEnvelopeAmountOctaves, unit: 'octaves', rate: 'note' },
  'filter.attack': { defaultValue: defaults.filter.envelope.attackSec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'filter.decay': { defaultValue: defaults.filter.envelope.decaySec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'filter.sustain': { defaultValue: defaults.filter.envelope.sustain, ...SYNTH_PARAMETER_LIMITS.sustain, unit: 'ratio', rate: 'note' },
  'filter.release': { defaultValue: defaults.filter.envelope.releaseSec, ...SYNTH_PARAMETER_LIMITS.envelopeSeconds, unit: 'seconds', rate: 'note' },
  'lfo.rate': { defaultValue: defaults.lfo.frequencyHz, ...SYNTH_PARAMETER_LIMITS.lfoFrequencyHz, unit: 'hz', rate: 'a-rate' },
  'lfo.pitchDepth': { defaultValue: defaults.lfo.pitchCents, ...SYNTH_PARAMETER_LIMITS.lfoPitchCents, unit: 'cents', rate: 'a-rate' },
  'lfo.filterDepth': { defaultValue: defaults.lfo.filterOctaves, ...SYNTH_PARAMETER_LIMITS.lfoFilterOctaves, unit: 'octaves', rate: 'a-rate' },
  'lfo.ampDepth': { defaultValue: defaults.lfo.amp, ...SYNTH_PARAMETER_LIMITS.lfoAmp, unit: 'ratio', rate: 'a-rate' },
  'lfo.panDepth': { defaultValue: defaults.lfo.pan, ...SYNTH_PARAMETER_LIMITS.lfoPan, unit: 'ratio', rate: 'a-rate' },
}

export type SynthAutomationKey = {
  kind: 'synth-instrument'
  trackId: string
  instanceId: string
  parameterId: SynthAutomationParameterId
}

export const isSynthAutomationParameterId = (value: string): value is SynthAutomationParameterId => (
  Object.hasOwn(SYNTH_AUTOMATION_DESCRIPTORS, value)
)

export const synthAutomationKey = (
  trackId: string,
  instanceId: string,
  parameterId: SynthAutomationParameterId,
): string => `synth-instrument:${encodeURIComponent(trackId)}:${encodeURIComponent(instanceId)}:${parameterId}`

export const parseSynthAutomationKey = (value: string): SynthAutomationKey | undefined => {
  const parts = value.split(':')
  if (parts.length < 4 || parts[0] !== 'synth-instrument' || !parts[1]) return undefined
  const parameterId = parts.at(-1)
  if (!parameterId || !isSynthAutomationParameterId(parameterId)) return undefined
  if (parts.length === 4) {
    try {
      const trackId = decodeURIComponent(parts[1])
      const instanceId = decodeURIComponent(parts[2])
      return trackId && instanceId
        ? { kind: 'synth-instrument', trackId, instanceId, parameterId }
        : undefined
    } catch {
      return undefined
    }
  }
  const instanceId = parts.slice(2, -1).join(':')
  return instanceId
    ? { kind: 'synth-instrument', trackId: parts[1], instanceId, parameterId }
    : undefined
}
