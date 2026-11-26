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
  automationValuesVersionStamp,
  effectParamsByInstanceId,
  migrateAutomationPointValues,
  parseJsonValue,
  type AutomationEnvelope,
  type AutomationPoint,
  type AutomationTarget,
  type JsonObject,
  type JsonValue,
  type JsonValueInput,
} from '@daw-browser/shared'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { listLocalEffects } from '~/lib/local-effects'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { AUTOMATION_ROW_KIND } from '~/lib/local-project-rows'

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

type EffectOwners = ReadonlyMap<string, JsonValue>

const normalizeLocalAutomationEnvelope = (value: JsonValueInput, owners: EffectOwners | undefined): AutomationEnvelope | null => {
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
    // The stored valuesVersion is consumed here: callers only ever see point values in current units.
    points: normalizeAutomationPoints(
      migrateAutomationPointValues(
        parsed.parameterId,
        points,
        isJsonNumber(parsed.valuesVersion) ? parsed.valuesVersion : undefined,
        undefined,
        target.effectInstanceId === undefined ? undefined : owners?.get(target.effectInstanceId),
      ),
      descriptor,
    ),
    updatedAt: parsed.updatedAt,
  }
}

/** The stored form of an envelope: current-unit points plus the version stamp for effect lanes. */
export const localAutomationRowValue = (envelope: AutomationEnvelope) => ({ ...envelope, ...automationValuesVersionStamp(envelope.parameterId) })

type RecognizedLocalAutomationEnvelope = {
  envelope: AutomationEnvelope
  logicalKey: string
}

const recognizeLocalAutomationEnvelope = (value: JsonValueInput, owners?: EffectOwners): RecognizedLocalAutomationEnvelope | null => {
  const envelope = normalizeLocalAutomationEnvelope(value, owners)

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

/** `owners` are the stored params of the project's effects by instance id; a lane whose effect is missing from them migrates without its owner's params. */
export const normalizeLocalAutomationEnvelopes = (
  values: readonly JsonValueInput[],
  owners?: EffectOwners,
): AutomationEnvelope[] => {
  const byLogicalKey = new Map<string, AutomationEnvelope>()

  for (const value of values) {
    const recognized = recognizeLocalAutomationEnvelope(value, owners)

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
  const [rows, effects] = await Promise.all([
    db.getAllFromIndex('entities', 'by-kind', AUTOMATION_ROW_KIND),
    listLocalEffects(projectId),
  ])

  return normalizeLocalAutomationEnvelopes(rows.map((row) => row.value), effectParamsByInstanceId(effects))
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
  // The caller's points are already in current units; the stamp keeps the read-side migration from rescaling them.
  const incoming = recognizeLocalAutomationEnvelope(localAutomationRowValue(envelope))

  if (!incoming) throw new Error('Automation envelope does not have a recognized logical identity.')
  await tx.store.put(createLocalProjectEntityRow(
    AUTOMATION_ROW_KIND,
    incoming.logicalKey,
    localAutomationRowValue(incoming.envelope),
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
  await db.delete('entities', [AUTOMATION_ROW_KIND, targetKey])
  notifyLocalProjectChanged(projectId)
}
