import { createDefaultGranularParams } from './granular-params'

export const GRANULAR_AUTOMATION_PARAMETER_IDS = [
  'grainSize',
  'density',
  'position',
  'spray',
  'pitch',
  'reverseProbability',
  'stereoSpread',
] as const

export type GranularAutomationParameterId = typeof GRANULAR_AUTOMATION_PARAMETER_IDS[number]

const defaults = createDefaultGranularParams()

export const GRANULAR_AUTOMATION_DESCRIPTORS = {
  grainSize: { defaultValue: defaults.grainSizeMs, min: 5, max: 1000, unit: 'milliseconds' },
  density: { defaultValue: defaults.densityHz, min: 0.25, max: 200, unit: 'hz' },
  position: { defaultValue: defaults.position, min: 0, max: 1, unit: 'ratio' },
  spray: { defaultValue: defaults.spray, min: 0, max: 1, unit: 'ratio' },
  pitch: { defaultValue: defaults.pitchSemitones, min: -48, max: 48, unit: 'semitones' },
  reverseProbability: { defaultValue: defaults.reverseProbability, min: 0, max: 1, unit: 'ratio' },
  stereoSpread: { defaultValue: defaults.stereoSpread, min: 0, max: 1, unit: 'ratio' },
} satisfies Readonly<Record<GranularAutomationParameterId, {
  defaultValue: number
  min: number
  max: number
  unit: 'milliseconds' | 'hz' | 'ratio' | 'semitones'
}>>

export const isGranularAutomationParameterId = (value: string): value is GranularAutomationParameterId => (
  Object.hasOwn(GRANULAR_AUTOMATION_DESCRIPTORS, value)
)

export const granularAutomationKey = (
  trackId: string,
  instanceId: string,
  parameterId: GranularAutomationParameterId,
) => `instrument:${trackId}:${instanceId}:${parameterId}`

export const parseGranularAutomationKey = (value: string): {
  kind: 'instrument'
  trackId: string
  instanceId: string
  parameterId: GranularAutomationParameterId
} | undefined => {
  const parts = value.split(':')
  if (parts.length < 4 || parts[0] !== 'instrument' || !parts[1]) return undefined
  const parameterId = parts.at(-1)
  const instanceId = parts.slice(2, -1).join(':')
  if (!parameterId || !instanceId || !isGranularAutomationParameterId(parameterId)) return undefined
  return { kind: 'instrument', trackId: parts[1], instanceId, parameterId }
}
