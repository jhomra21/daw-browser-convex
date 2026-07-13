export type AutomationInterpolation = 'linear' | 'hold'

export type AutomationTargetKind = 'track' | 'master'

export type AutomationPoint = {
  id: string
  timeSec: number
  value: number
  interpolation: AutomationInterpolation
}

export type AutomationTarget =
  | { kind: 'track'; trackId: string; effectInstanceId?: string }
  | { kind: 'master'; effectInstanceId?: string }

export type AutomationEnvelope = {
  id: string
  projectId: string
  target: AutomationTarget
  targetKey: string
  parameterId: string
  enabled: boolean
  points: AutomationPoint[]
  updatedAt: number
}

export const AUTOMATION_TARGET_KEY_V2_PREFIX = 'automation:v2:'

export const automationTargetKey = (target: AutomationTarget, parameterId: string): string => (
  `${AUTOMATION_TARGET_KEY_V2_PREFIX}${JSON.stringify([
    target.kind,
    target.kind === 'track' ? target.trackId : null,
    target.effectInstanceId ?? null,
    parameterId,
  ])}`
)

export const automationTargetMatchesEffectInstance = (
  target: unknown,
  effectInstanceId: string,
): boolean => (
  typeof target === 'object'
  && target !== null
  && !Array.isArray(target)
  && Reflect.get(target, 'effectInstanceId') === effectInstanceId
)

export const isAutomationInterpolation = (value: unknown): value is AutomationInterpolation => (
  value === 'linear' || value === 'hold'
)

export const automationEnvelopeValueRange = (
  envelope: AutomationEnvelope | undefined,
  bounds?: { min: number; max: number },
): { min: number; max: number } | undefined => {
  if (!envelope || envelope.points.length === 0) return undefined
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const point of envelope.points) {
    min = Math.min(min, point.value)
    max = Math.max(max, point.value)
  }
  if (!bounds) return { min, max }
  return {
    min: Math.max(bounds.min, Math.min(bounds.max, min)),
    max: Math.max(bounds.min, Math.min(bounds.max, max)),
  }
}

export const automationTargetKeysForManualOverride = (
  current: ReadonlySet<string>,
  targetKey: string,
): Set<string> => {
  if (current.has(targetKey)) return new Set(current)
  return new Set([...current, targetKey])
}

export const automationTargetKeysAfterReEnable = (
  current: ReadonlySet<string>,
  targetKeys: Iterable<string>,
): Set<string> => {
  const next = new Set(current)
  for (const targetKey of targetKeys) next.delete(targetKey)
  return next
}

export const filterAutomationEnvelopesForScheduling = (
  envelopes: AutomationEnvelope[],
  overriddenTargetKeys: ReadonlySet<string>,
): AutomationEnvelope[] => (
  overriddenTargetKeys.size === 0
    ? envelopes
    : envelopes.filter((envelope) => !overriddenTargetKeys.has(envelope.targetKey))
)
