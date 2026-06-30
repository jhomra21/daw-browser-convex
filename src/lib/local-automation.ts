import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  isAutomationInterpolation,
  isAutomationParameterSupportedForTarget,
  normalizeAutomationPoints,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
} from '@daw-browser/shared'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const AUTOMATION_KIND = 'automation-envelope'

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const normalizeLocalAutomationPoint = (value: unknown) => {
  if (
    !isObject(value)
    || typeof value.id !== 'string'
    || typeof value.timeSec !== 'number'
    || typeof value.value !== 'number'
  ) return null
  return {
    id: value.id,
    timeSec: value.timeSec,
    value: value.value,
    interpolation: isAutomationInterpolation(value.interpolation) ? value.interpolation : 'linear',
  }
}

const normalizeLocalAutomationTarget = (target: Record<string, unknown>): AutomationTarget | null => {
  if (target.kind === 'master') return { kind: 'master' }
  if (target.kind === 'track' && typeof target.trackId === 'string') return { kind: 'track', trackId: target.trackId }
  return null
}

const normalizeLocalAutomationEnvelope = (value: unknown): AutomationEnvelope | null => {
  if (
    !isObject(value)
    || typeof value.id !== 'string'
    || typeof value.projectId !== 'string'
    || !isObject(value.target)
    || typeof value.parameterId !== 'string'
    || typeof value.enabled !== 'boolean'
    || !Array.isArray(value.points)
    || typeof value.updatedAt !== 'number'
  ) return null
  const target = normalizeLocalAutomationTarget(value.target)
  const descriptor = getAutomationParameterDescriptor(value.parameterId)
  if (!target || !descriptor || !isAutomationParameterSupportedForTarget(value.parameterId, target.kind)) return null
  const points: AutomationPoint[] = []
  for (const point of value.points) {
    const normalized = normalizeLocalAutomationPoint(point)
    if (!normalized) return null
    points.push(normalized)
  }
  return {
    id: value.id,
    projectId: value.projectId,
    target,
    targetKey: automationTargetKey(target, value.parameterId),
    parameterId: value.parameterId,
    enabled: value.enabled,
    points: normalizeAutomationPoints(points, descriptor),
    updatedAt: value.updatedAt,
  }
}

export const loadLocalAutomationEnvelopes = async (projectId: string): Promise<AutomationEnvelope[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', AUTOMATION_KIND)
  return rows.flatMap((row) => {
    const envelope = normalizeLocalAutomationEnvelope(row.value)
    return envelope ? [envelope] : []
  })
}

export const setLocalAutomationEnvelope = async (
  projectId: string,
  envelope: AutomationEnvelope,
): Promise<AutomationEnvelope> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, envelope.targetKey, envelope, envelope.updatedAt))
  await tx.done
  notifyLocalProjectChanged(projectId)
  return envelope
}

export const deleteLocalAutomationEnvelope = async (
  projectId: string,
  targetKey: string,
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  await tx.store.delete([AUTOMATION_KIND, targetKey])
  await tx.done
  notifyLocalProjectChanged(projectId)
}

export const replaceLocalAutomationEnvelopes = async (
  projectId: string,
  envelopes: AutomationEnvelope[],
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  for (const row of rows) await tx.store.delete([AUTOMATION_KIND, row.id])
  for (const envelope of envelopes) {
    await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, envelope.targetKey, envelope, envelope.updatedAt))
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
