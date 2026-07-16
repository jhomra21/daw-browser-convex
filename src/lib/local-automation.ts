import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  isAutomationParameterOwnedByTarget,
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
  const effectInstanceId = typeof target.effectInstanceId === 'string' ? target.effectInstanceId : undefined
  if (target.kind === 'master') return { kind: 'master', effectInstanceId }
  if (target.kind === 'track' && typeof target.trackId === 'string') return { kind: 'track', trackId: target.trackId, effectInstanceId }
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

type RecognizedLocalAutomationEnvelope = {
  envelope: AutomationEnvelope
  logicalKey: string
}

const recognizeLocalAutomationEnvelope = (value: unknown): RecognizedLocalAutomationEnvelope | null => {
  const envelope = normalizeLocalAutomationEnvelope(value)
  if (!envelope) return null
  const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
  if (!descriptor || (descriptor.owner !== 'mixer' && descriptor.owner !== 'sampler' && descriptor.owner !== 'granular' && descriptor.owner !== 'synth' && !envelope.target.effectInstanceId)) return null
  return {
    envelope: {
      ...envelope,
      targetKey: automationTargetKey(envelope.target, envelope.parameterId),
    },
    logicalKey: automationTargetKey(envelope.target, envelope.parameterId),
  }
}

const preferAutomationEnvelope = (
  current: AutomationEnvelope,
  candidate: AutomationEnvelope,
): AutomationEnvelope => (
  candidate.updatedAt > current.updatedAt
  || (candidate.updatedAt === current.updatedAt && candidate.id.localeCompare(current.id) < 0)
    ? candidate
    : current
)

export const normalizeLocalAutomationEnvelopes = (
  values: readonly unknown[],
): AutomationEnvelope[] => {
  const byLogicalKey = new Map<string, AutomationEnvelope>()
  for (const value of values) {
    const recognized = recognizeLocalAutomationEnvelope(value)
    if (!recognized) continue
    const current = byLogicalKey.get(recognized.logicalKey)
    byLogicalKey.set(
      recognized.logicalKey,
      current ? preferAutomationEnvelope(current, recognized.envelope) : recognized.envelope,
    )
  }
  return [...byLogicalKey.values()]
}

export const loadLocalAutomationEnvelopes = async (projectId: string): Promise<AutomationEnvelope[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', AUTOMATION_KIND)
  return normalizeLocalAutomationEnvelopes(rows.map((row) => row.value))
}

export const setLocalAutomationEnvelope = async (
  projectId: string,
  envelope: AutomationEnvelope,
): Promise<AutomationEnvelope> => {
  if (!isAutomationParameterOwnedByTarget(envelope.parameterId, envelope.target)) {
    throw new Error('Automation parameter ownership does not match its target.')
  }
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const incoming = recognizeLocalAutomationEnvelope(envelope)
  if (!incoming) throw new Error('Automation envelope does not have a recognized logical identity.')
  await tx.store.put(createLocalProjectEntityRow(
    AUTOMATION_KIND,
    incoming.logicalKey,
    incoming.envelope,
    incoming.envelope.updatedAt,
  ))
  await tx.done
  notifyLocalProjectChanged(projectId)
  return incoming.envelope
}

export const deleteLocalAutomationEnvelope = async (
  projectId: string,
  targetKey: string,
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  await db.delete('entities', [AUTOMATION_KIND, targetKey])
  notifyLocalProjectChanged(projectId)
}

export const replaceLocalAutomationEnvelopes = async (
  projectId: string,
  envelopes: AutomationEnvelope[],
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  for (const row of rows) {
    if (recognizeLocalAutomationEnvelope(row.value)) {
      await tx.store.delete([AUTOMATION_KIND, row.id])
    }
  }
  for (const envelope of normalizeLocalAutomationEnvelopes(envelopes)) {
    const recognized = recognizeLocalAutomationEnvelope(envelope)
    if (recognized) {
      await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, recognized.logicalKey, recognized.envelope, recognized.envelope.updatedAt))
    }
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
