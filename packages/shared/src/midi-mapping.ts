import {
  automationRatioToValue,
  getAutomationParameterDescriptor,
  type AutomationParameterDescriptor,
} from './automation-parameters'
import type { MidiMapping } from './midi'

export type MidiMappingSourceEvent =
  | { kind: 'cc'; controller: number; channel?: number; value: number }
  | { kind: 'pitch-bend'; channel?: number; value: number }
  | { kind: 'channel-pressure'; channel?: number; value: number }
  | { kind: 'poly-pressure'; channel?: number; pitch: number; value: number }

export type MidiMappingTarget = {
  parameterId: string
  effectInstanceId?: string
}

export type CompiledMidiMappingIndex = {
  match: (event: MidiMappingSourceEvent) => readonly MidiMapping[]
}

const sourceKey = (source: {
  kind: MidiMapping['source']['kind']
  controller?: number
  channel?: number
  pitch?: number
}) => [
  source.kind,
  source.controller ?? '*',
  source.channel ?? '*',
  source.pitch ?? '*',
].join('\u0000')

const sourceKeysForEvent = (event: MidiMappingSourceEvent) => {
  const controller = event.kind === 'cc' ? event.controller : undefined
  const pitch = event.kind === 'poly-pressure' ? event.pitch : undefined
  const channel = event.channel
  return [
    sourceKey({ kind: event.kind, controller, channel, pitch }),
    sourceKey({ kind: event.kind, controller, channel, pitch: undefined }),
    sourceKey({ kind: event.kind, controller, channel: undefined, pitch }),
    sourceKey({ kind: event.kind, controller, channel: undefined, pitch: undefined }),
  ]
}

export const compileMidiMappingSourceIndex = (
  mappings: readonly MidiMapping[],
): CompiledMidiMappingIndex => {
  const index = new Map<string, MidiMapping[]>()
  for (const mapping of mappings) {
    const key = sourceKey(mapping.source)
    const entries = index.get(key)
    if (entries) entries.push(mapping)
    else index.set(key, [mapping])
  }
  return {
    match: (event) => {
      const matched: MidiMapping[] = []
      const seen = new Set<string>()
      for (const key of sourceKeysForEvent(event)) {
        for (const mapping of index.get(key) ?? []) {
          if (seen.has(mapping.id)) continue
          seen.add(mapping.id)
          matched.push(mapping)
        }
      }
      return matched
    },
  }
}

const clampRatio = (value: number) => Math.min(1, Math.max(0, value))

export const midiMappingInputRatio = (event: MidiMappingSourceEvent): number => (
  event.kind === 'pitch-bend'
    ? clampRatio((event.value + 1) / 2)
    : clampRatio(event.value)
)

export const midiMappingOutputRatio = (
  mapping: Pick<MidiMapping, 'outputMin' | 'outputMax'>,
  inputRatio: number,
): number => mapping.outputMin + (clampRatio(inputRatio) * (mapping.outputMax - mapping.outputMin))

export const midiMappingTargetKey = (target: MidiMappingTarget) => (
  `${target.effectInstanceId ?? 'mixer'}\u0000${target.parameterId}`
)

export const midiMappingDescriptor = (
  target: MidiMappingTarget,
): AutomationParameterDescriptor | undefined => {
  const descriptor = getAutomationParameterDescriptor(target.parameterId)
  if (!descriptor || !descriptor.targetKinds.includes('track')) return undefined
  if (target.effectInstanceId === undefined) {
    return descriptor.owner === 'mixer' && target.parameterId === 'volume' ? descriptor : undefined
  }
  return descriptor.owner !== 'mixer'
    && descriptor.owner !== 'sampler'
    && descriptor.owner !== 'granular'
    && descriptor.owner !== 'synth'
    ? descriptor
    : undefined
}

export const isMidiMappingTargetSupported = (target: MidiMappingTarget): boolean => (
  midiMappingDescriptor(target) !== undefined
)

export const midiMappingValue = (
  mapping: MidiMapping,
  event: MidiMappingSourceEvent,
): number | undefined => {
  const descriptor = midiMappingDescriptor(mapping.target)
  if (!descriptor) return undefined
  return automationRatioToValue(
    descriptor,
    midiMappingOutputRatio(mapping, midiMappingInputRatio(event)),
  )
}
