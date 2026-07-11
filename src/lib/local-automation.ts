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
    targetKey: typeof value.targetKey === 'string' ? value.targetKey : automationTargetKey(target, value.parameterId),
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
  if (!descriptor || (descriptor.owner !== 'mixer' && descriptor.owner !== 'sampler' && descriptor.owner !== 'granular' && !envelope.target.effectInstanceId)) return null
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
  const opaque: AutomationEnvelope[] = []
  for (const value of values) {
    const envelope = normalizeLocalAutomationEnvelope(value)
    if (!envelope) continue
    const recognized = recognizeLocalAutomationEnvelope(value)
    if (!recognized) {
      opaque.push(envelope)
      continue
    }
    const current = byLogicalKey.get(recognized.logicalKey)
    byLogicalKey.set(
      recognized.logicalKey,
      current ? preferAutomationEnvelope(current, recognized.envelope) : recognized.envelope,
    )
  }
  return [...byLogicalKey.values(), ...opaque]
}

export const loadLocalAutomationEnvelopes = async (projectId: string): Promise<AutomationEnvelope[]> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  const recognizedByLogicalKey = new Map<string, Array<{ rowId: string; envelope: AutomationEnvelope }>>()
  const opaque: AutomationEnvelope[] = []
  for (const row of rows) {
    const recognized = recognizeLocalAutomationEnvelope(row.value)
    if (!recognized) {
      const envelope = normalizeLocalAutomationEnvelope(row.value)
      if (envelope) opaque.push(envelope)
      continue
    }
    const matches = recognizedByLogicalKey.get(recognized.logicalKey) ?? []
    matches.push({ rowId: row.id, envelope: recognized.envelope })
    recognizedByLogicalKey.set(recognized.logicalKey, matches)
  }
  const recognized: AutomationEnvelope[] = []
  for (const [logicalKey, matches] of recognizedByLogicalKey) {
    const winner = matches.reduce((current, candidate) => (
      preferAutomationEnvelope(current.envelope, candidate.envelope) === candidate.envelope ? candidate : current
    ))
    recognized.push(winner.envelope)
    for (const match of matches) await tx.store.delete([AUTOMATION_KIND, match.rowId])
    await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, logicalKey, winner.envelope, winner.envelope.updatedAt))
  }
  await tx.done
  return [...recognized, ...opaque]
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
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  const incoming = recognizeLocalAutomationEnvelope(envelope)
  if (!incoming) throw new Error('Automation envelope does not have a recognized logical identity.')
  const matches = rows.flatMap((row) => {
    const recognized = recognizeLocalAutomationEnvelope(row.value)
    return recognized?.logicalKey === incoming.logicalKey
      ? [{ rowId: row.id, envelope: recognized.envelope }]
      : []
  })
  for (const match of matches) {
    await tx.store.delete([AUTOMATION_KIND, match.rowId])
  }
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
  const tx = db.transaction('entities', 'readwrite')
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  for (const row of rows) {
    const envelope = normalizeLocalAutomationEnvelope(row.value)
    if (row.id === targetKey || envelope?.targetKey === targetKey) {
      await tx.store.delete([AUTOMATION_KIND, row.id])
    }
  }
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
