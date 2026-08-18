import {
  automationTargetKey,
  getAutomationParameterDescriptor,
  isAutomationParameterOwnedByTarget,
  isAutomationInterpolation,
  isAutomationParameterSupportedForTarget,
  normalizeAutomationPoints,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonValue,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
  type JsonObject,
  type JsonValue,
  type JsonValueInput,
} from '@daw-browser/shared'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const AUTOMATION_KIND = 'automation-envelope'

const normalizeLocalAutomationPoint = (value: JsonValue): AutomationPoint | null => {
  if (
    !isJsonObject(value)
    || !isJsonString(value.id)
    || !isJsonNumber(value.timeSec)
    || !isJsonNumber(value.value)
  ) return null
  return {
    id: value.id,
    timeSec: value.timeSec,
    value: value.value,
    interpolation: isAutomationInterpolation(value.interpolation) ? value.interpolation : 'linear',
  }
}

const normalizeLocalAutomationTarget = (target: JsonObject): AutomationTarget | null => {
  const effectInstanceId = isJsonString(target.effectInstanceId) ? target.effectInstanceId : undefined
  if (target.kind === 'master') {
    return effectInstanceId ? { kind: 'master', effectInstanceId } : { kind: 'master' }
  }
  if (target.kind === 'track' && isJsonString(target.trackId)) {
    return effectInstanceId
      ? { kind: 'track', trackId: target.trackId, effectInstanceId }
      : { kind: 'track', trackId: target.trackId }
  }
  return null
}

const normalizeLocalAutomationEnvelope = (value: JsonValueInput): AutomationEnvelope | null => {
  const parsed = parseJsonValue(value)
  if (
    !isJsonObject(parsed)
    || !isJsonString(parsed.id)
    || !isJsonString(parsed.projectId)
    || !isJsonObject(parsed.target)
    || !isJsonString(parsed.parameterId)
    || !isJsonBoolean(parsed.enabled)
    || !Array.isArray(parsed.points)
    || !isJsonNumber(parsed.updatedAt)
  ) return null
  const target = normalizeLocalAutomationTarget(parsed.target)
  const descriptor = getAutomationParameterDescriptor(parsed.parameterId)
  if (!target || !descriptor || !isAutomationParameterSupportedForTarget(parsed.parameterId, target.kind)) return null
  const points: AutomationPoint[] = []
  for (const point of parsed.points) {
    const normalized = normalizeLocalAutomationPoint(point)
    if (!normalized) return null
    points.push(normalized)
  }
  return {
    id: parsed.id,
    projectId: parsed.projectId,
    target,
    targetKey: automationTargetKey(target, parsed.parameterId),
    parameterId: parsed.parameterId,
    enabled: parsed.enabled,
    points: normalizeAutomationPoints(points, descriptor),
    updatedAt: parsed.updatedAt,
  }
}

type RecognizedLocalAutomationEnvelope = {
  envelope: AutomationEnvelope
  logicalKey: string
}

const recognizeLocalAutomationEnvelope = (value: JsonValueInput): RecognizedLocalAutomationEnvelope | null => {
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
  values: readonly JsonValueInput[],
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
