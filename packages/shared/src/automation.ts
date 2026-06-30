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
