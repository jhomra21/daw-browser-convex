import { createDefaultSynthParams } from './synth-params'

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
  'output.gain': { defaultValue: defaults.gain, min: 0, max: 1.5, unit: 'ratio', rate: 'a-rate' },
  'output.pan': { defaultValue: defaults.pan, min: -1, max: 1, unit: 'ratio', rate: 'a-rate' },
  'osc1.level': { defaultValue: defaults.oscillators[0].level, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
  'osc1.detune': { defaultValue: defaults.oscillators[0].detuneCents, min: -100, max: 100, unit: 'cents', rate: 'a-rate' },
  'osc2.level': { defaultValue: defaults.oscillators[1].level, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
  'osc2.detune': { defaultValue: defaults.oscillators[1].detuneCents, min: -100, max: 100, unit: 'cents', rate: 'a-rate' },
  'noise.level': { defaultValue: defaults.noise.level, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
  'amp.attack': { defaultValue: defaults.ampEnvelope.attackSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'amp.decay': { defaultValue: defaults.ampEnvelope.decaySec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'amp.sustain': { defaultValue: defaults.ampEnvelope.sustain, min: 0, max: 1, unit: 'ratio', rate: 'note' },
  'amp.release': { defaultValue: defaults.ampEnvelope.releaseSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'filter.frequency': { defaultValue: defaults.filter.frequencyHz, min: 20, max: 20_000, unit: 'hz', rate: 'a-rate' },
  'filter.q': { defaultValue: defaults.filter.q, min: 0.0001, max: 30, unit: 'ratio', rate: 'a-rate' },
  'filter.envAmount': { defaultValue: defaults.filter.envelopeAmountOctaves, min: -6, max: 6, unit: 'octaves', rate: 'note' },
  'filter.attack': { defaultValue: defaults.filter.envelope.attackSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'filter.decay': { defaultValue: defaults.filter.envelope.decaySec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'filter.sustain': { defaultValue: defaults.filter.envelope.sustain, min: 0, max: 1, unit: 'ratio', rate: 'note' },
  'filter.release': { defaultValue: defaults.filter.envelope.releaseSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'lfo.rate': { defaultValue: defaults.lfo.frequencyHz, min: 0.01, max: 100, unit: 'hz', rate: 'a-rate' },
  'lfo.pitchDepth': { defaultValue: defaults.lfo.pitchCents, min: -1200, max: 1200, unit: 'cents', rate: 'a-rate' },
  'lfo.filterDepth': { defaultValue: defaults.lfo.filterOctaves, min: -6, max: 6, unit: 'octaves', rate: 'a-rate' },
  'lfo.ampDepth': { defaultValue: defaults.lfo.amp, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
  'lfo.panDepth': { defaultValue: defaults.lfo.pan, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
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
