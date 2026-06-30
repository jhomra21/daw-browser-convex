import type { AutomationPoint, AutomationTargetKind } from './automation'
import { isAutomationInterpolation } from './automation'
import {
  createDefaultDelayParams,
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
  SATURATOR_COLOR_FREQUENCY_HZ_MAX,
  SATURATOR_COLOR_FREQUENCY_HZ_MIN,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_DRIVE_DB_MIN,
  SATURATOR_DRY_WET_MAX,
  SATURATOR_DRY_WET_MIN,
  SATURATOR_OUTPUT_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
} from './effects-params'

export type AutomationParameterDescriptor = {
  id: string
  label: string
  group: string
  device: string
  targetKinds: AutomationTargetKind[]
  min: number
  max: number
  defaultValue: number
  scale: 'linear' | 'log'
  unit?: 'db' | 'hz' | 'percent' | 'seconds'
}

export type AutomationParameterOption = {
  id: string
  label: string
  group: string
  device: string
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const staticDescriptors: AutomationParameterDescriptor[] = [
  { id: 'volume', label: 'Volume', group: 'Mixer', device: 'Mixer', targetKinds: ['track', 'master'], min: 0, max: 1.5, defaultValue: 1, scale: 'linear', unit: 'percent' },
]

const effectDescriptors: AutomationParameterDescriptor[] = [
  { id: 'saturator.driveDb', label: 'Saturator Drive', group: 'Audio Effects', device: 'Saturator', targetKinds: ['track', 'master'], min: SATURATOR_DRIVE_DB_MIN, max: SATURATOR_DRIVE_DB_MAX, defaultValue: createDefaultSaturatorParams().driveDb, scale: 'linear', unit: 'db' },
  { id: 'saturator.outputDb', label: 'Saturator Output', group: 'Audio Effects', device: 'Saturator', targetKinds: ['track', 'master'], min: SATURATOR_OUTPUT_DB_MIN, max: SATURATOR_OUTPUT_DB_MAX, defaultValue: createDefaultSaturatorParams().outputDb, scale: 'linear', unit: 'db' },
  { id: 'saturator.dryWet', label: 'Saturator Dry/Wet', group: 'Audio Effects', device: 'Saturator', targetKinds: ['track', 'master'], min: SATURATOR_DRY_WET_MIN, max: SATURATOR_DRY_WET_MAX, defaultValue: createDefaultSaturatorParams().dryWet, scale: 'linear', unit: 'percent' },
  { id: 'saturator.colorFrequencyHz', label: 'Saturator Color Frequency', group: 'Audio Effects', device: 'Saturator', targetKinds: ['track', 'master'], min: SATURATOR_COLOR_FREQUENCY_HZ_MIN, max: SATURATOR_COLOR_FREQUENCY_HZ_MAX, defaultValue: createDefaultSaturatorParams().colorFrequencyHz, scale: 'log', unit: 'hz' },
  { id: 'delay.timeMs', label: 'Delay Time', group: 'Audio Effects', device: 'Delay', targetKinds: ['track', 'master'], min: DELAY_TIME_MS_MIN, max: DELAY_TIME_MS_MAX, defaultValue: createDefaultDelayParams().timeMs, scale: 'linear' },
  { id: 'delay.feedback', label: 'Delay Feedback', group: 'Audio Effects', device: 'Delay', targetKinds: ['track', 'master'], min: DELAY_FEEDBACK_MIN, max: DELAY_FEEDBACK_MAX, defaultValue: createDefaultDelayParams().feedback, scale: 'linear', unit: 'percent' },
  { id: 'delay.dryWet', label: 'Delay Dry/Wet', group: 'Audio Effects', device: 'Delay', targetKinds: ['track', 'master'], min: DELAY_DRY_WET_MIN, max: DELAY_DRY_WET_MAX, defaultValue: createDefaultDelayParams().dryWet, scale: 'linear', unit: 'percent' },
  { id: 'delay.lowCutHz', label: 'Delay Low Cut', group: 'Audio Effects', device: 'Delay', targetKinds: ['track', 'master'], min: DELAY_LOW_CUT_HZ_MIN, max: DELAY_LOW_CUT_HZ_MAX, defaultValue: createDefaultDelayParams().lowCutHz, scale: 'log', unit: 'hz' },
  { id: 'delay.highCutHz', label: 'Delay High Cut', group: 'Audio Effects', device: 'Delay', targetKinds: ['track', 'master'], min: DELAY_HIGH_CUT_HZ_MIN, max: DELAY_HIGH_CUT_HZ_MAX, defaultValue: createDefaultDelayParams().highCutHz, scale: 'log', unit: 'hz' },
  { id: 'reverb.wet', label: 'Reverb Dry/Wet', group: 'Audio Effects', device: 'Reverb', targetKinds: ['track', 'master'], min: REVERB_WET_MIN, max: REVERB_WET_MAX, defaultValue: createDefaultReverbParams().wet, scale: 'linear', unit: 'percent' },
  { id: 'reverb.preDelayMs', label: 'Reverb Predelay', group: 'Audio Effects', device: 'Reverb', targetKinds: ['track', 'master'], min: REVERB_PRE_DELAY_MS_MIN, max: REVERB_PRE_DELAY_MS_MAX, defaultValue: createDefaultReverbParams().preDelayMs, scale: 'linear' },
  { id: 'reverb.stereoWidth', label: 'Reverb Width', group: 'Audio Effects', device: 'Reverb', targetKinds: ['track', 'master'], min: REVERB_STEREO_WIDTH_MIN, max: REVERB_STEREO_WIDTH_MAX, defaultValue: createDefaultReverbParams().stereoWidth, scale: 'linear' },
]

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
  const eq = parseEqBandParameterId(parameterId)
  if (!eq) return undefined
  if (eq.property === 'frequencyHz') {
    return { id: parameterId, label: 'EQ Frequency', group: 'Audio Effects', device: 'EQ Eight', targetKinds: ['track', 'master'], min: 20, max: 20000, defaultValue: 1000, scale: 'log', unit: 'hz' }
  }
  if (eq.property === 'gainDb') {
    return { id: parameterId, label: 'EQ Gain', group: 'Audio Effects', device: 'EQ Eight', targetKinds: ['track', 'master'], min: -24, max: 24, defaultValue: 0, scale: 'linear', unit: 'db' }
  }
  return { id: parameterId, label: 'EQ Q', group: 'Audio Effects', device: 'EQ Eight', targetKinds: ['track', 'master'], min: 0.1, max: 18, defaultValue: 1, scale: 'linear' }
}

export const isAutomationParameterSupportedForTarget = (
  parameterId: string,
  targetKind: AutomationTargetKind,
) => getAutomationParameterDescriptor(parameterId)?.targetKinds.includes(targetKind) ?? false

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
  points: AutomationPoint[],
  timeSec: number,
  fallbackValue: number,
): number => {
  if (points.length === 0) return fallbackValue
  const ordered = [...points].sort((a, b) => a.timeSec - b.timeSec)
  const first = ordered[0]
  if (!first || timeSec <= first.timeSec) return first?.value ?? fallbackValue
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const next = ordered[index]
    if (!previous || !next || timeSec > next.timeSec) continue
    if (previous.interpolation === 'hold') return previous.value
    const span = next.timeSec - previous.timeSec
    if (span <= 0) return next.value
    const progress = (timeSec - previous.timeSec) / span
    return previous.value + ((next.value - previous.value) * progress)
  }
  return ordered[ordered.length - 1]?.value ?? fallbackValue
}
