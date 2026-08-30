import {
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  automationTargetKey,
  type AutomationEnvelope,
  type AutomationTarget,
} from '@daw-browser/shared'

export const createAutomationSeedEnvelope = (input: {
  projectId: string
  target: AutomationTarget
  parameterId: string
  initialValue?: number
}): AutomationEnvelope | undefined => {
  const descriptor = getAutomationParameterDescriptor(input.parameterId)
  if (!descriptor) return undefined
  const point = {
    id: crypto.randomUUID(),
    timeSec: 0,
    value: input.initialValue ?? descriptor.defaultValue,
    interpolation: descriptor.interpolation ?? 'linear',
  }
  return {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    target: input.target,
    targetKey: automationTargetKey(input.target, input.parameterId),
    parameterId: input.parameterId,
    enabled: true,
    points: normalizeAutomationPoints([point], descriptor),
    updatedAt: Date.now(),
  }
}
