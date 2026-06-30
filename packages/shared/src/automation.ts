export type AutomationInterpolation = 'linear' | 'hold'

export type AutomationTargetKind = 'track' | 'master'

export type AutomationPoint = {
  id: string
  timeSec: number
  value: number
  interpolation: AutomationInterpolation
}

export type AutomationTarget =
  | { kind: 'track'; trackId: string }
  | { kind: 'master' }

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

export const automationTargetKey = (target: AutomationTarget, parameterId: string): string => (
  target.kind === 'master' ? `master:${parameterId}` : `track:${target.trackId}:${parameterId}`
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
