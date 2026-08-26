import { createDefaultSamplerParams } from './sampler-params'

export const SAMPLER_AUTOMATION_PARAMETER_IDS = [
  'output.gain',
  'output.pan',
  'amp.attack',
  'amp.decay',
  'amp.sustain',
  'amp.release',
  'filter.frequency',
  'filter.q',
  'filter.envAmount',
  'lfo.rate',
  'lfo.pitchDepth',
  'lfo.filterDepth',
  'lfo.ampDepth',
  'lfo.panDepth',
] as const

export type SamplerAutomationParameterId = typeof SAMPLER_AUTOMATION_PARAMETER_IDS[number]

export type SamplerAutomationDescriptor = {
  defaultValue: number
  min: number
  max: number
  unit: 'ratio' | 'seconds' | 'hz' | 'cents'
  rate: 'a-rate' | 'note'
}

const defaults = createDefaultSamplerParams()

export const SAMPLER_AUTOMATION_DESCRIPTORS = {
  'output.gain': { defaultValue: 1, min: 0, max: 4, unit: 'ratio', rate: 'a-rate' },
  'output.pan': { defaultValue: 0, min: -1, max: 1, unit: 'ratio', rate: 'a-rate' },
  'amp.attack': { defaultValue: defaults.ampEnvelope.attackSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'amp.decay': { defaultValue: defaults.ampEnvelope.decaySec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'amp.sustain': { defaultValue: defaults.ampEnvelope.sustain, min: 0, max: 1, unit: 'ratio', rate: 'note' },
  'amp.release': { defaultValue: defaults.ampEnvelope.releaseSec, min: 0, max: 60, unit: 'seconds', rate: 'note' },
  'filter.frequency': { defaultValue: defaults.filterFrequencyHz, min: 20, max: 20_000, unit: 'hz', rate: 'a-rate' },
  'filter.q': { defaultValue: defaults.filterQ, min: 0.05, max: 30, unit: 'ratio', rate: 'a-rate' },
  'filter.envAmount': { defaultValue: defaults.filterEnvelope.amount, min: -1, max: 1, unit: 'ratio', rate: 'note' },
  'lfo.rate': { defaultValue: defaults.lfo.frequencyHz, min: 0.01, max: 100, unit: 'hz', rate: 'a-rate' },
  'lfo.pitchDepth': { defaultValue: defaults.lfo.pitchCents, min: -2400, max: 2400, unit: 'cents', rate: 'a-rate' },
  'lfo.filterDepth': { defaultValue: defaults.lfo.filterHz, min: -20_000, max: 20_000, unit: 'hz', rate: 'a-rate' },
  'lfo.ampDepth': { defaultValue: defaults.lfo.amp, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
  'lfo.panDepth': { defaultValue: defaults.lfo.pan, min: 0, max: 1, unit: 'ratio', rate: 'a-rate' },
} satisfies Readonly<Record<SamplerAutomationParameterId, SamplerAutomationDescriptor>>

export type InstrumentAutomationKey = {
  kind: 'instrument'
  trackId: string
  instanceId: string
  parameterId: SamplerAutomationParameterId
}

export const isSamplerAutomationParameterId = (value: string): value is SamplerAutomationParameterId => (
  Object.hasOwn(SAMPLER_AUTOMATION_DESCRIPTORS, value)
)

export const instrumentAutomationKey = (
  trackId: string,
  instanceId: string,
  parameterId: SamplerAutomationParameterId,
): string => `instrument:${trackId}:${instanceId}:${parameterId}`

export const parseInstrumentAutomationKey = (value: string): InstrumentAutomationKey | undefined => {
  const parts = value.split(':')
  if (parts.length < 4 || parts[0] !== 'instrument' || !parts[1]) return undefined
  const parameterId = parts.at(-1)
  const instanceId = parts.slice(2, -1).join(':')
  if (!parameterId || !instanceId) return undefined
  if (!isSamplerAutomationParameterId(parameterId)) return undefined
  return { kind: 'instrument', trackId: parts[1], instanceId, parameterId }
}
