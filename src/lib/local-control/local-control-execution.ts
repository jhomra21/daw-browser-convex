import {
  controlActionSchemaV1,
  hashCanonicalJsonSyncV1,
  findDuplicateRecoveryActionIndexV1,
  parseControlPreviewRequestV1,
  projectSnapshotSchemaV2,
  type ControlActionV1,
  type RecoveryPayload,
} from '@daw-browser/control'
import {
  planControlRequestV1,
  rebaseRecoveryAutomationParameterIdV1,
  type ControlPlannerCapabilities,
  type ControlPlanV1,
} from '@daw-browser/control-core'
import {
  automationTargetKey,
  createAudioEffectInstanceId,
  createInstrumentInstanceId,
  createLocalClipId,
  createLocalTrackId,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from '@daw-browser/shared'
import {
  externalPluginEntityKind,
  externalProcessorSchema,
  type ExternalProcessor,
} from '@daw-browser/external-plugins'
import {
  applyLocalExternalProcessorDeletionPlanToLocalControl,
  planLocalExternalProcessorDeletion,
} from '~/lib/external-plugins'
import { z } from 'zod'
import {
  localEffectRowId,
  localSidechainRouteRowId,
  type LocalEffectKind,
} from '~/lib/local-effects'
import type {
  LocalControlRecoveryRow,
  LocalProjectEntityRow,
  LocalProjectExternalPluginArtifactRow,
  LocalProjectStoredValue,
} from '~/lib/local-project-db'
import { materializeLocalControlSnapshot, parseLocalProjectStoredJsonValue } from './local-control-model'
import { withLocalControlTransaction, type LocalControlTransactionResult } from './local-control-state'
import {
  captureLocalExternalProcessorRecoveryBundles,
  captureLocalRecoveryPayload,
  hashLocalExternalProcessorRecoveryBundles,
  localRecoveryLifetimeMs,
  localExternalRecoveryUsage,
  localRecoveryArtifactsMatch,
  resolveLocalRecoveryAssets,
  serializeLocalRecoveryPayload,
  validateLocalProjectExternalRecoveryBytes,
  validateLocalExternalProcessorRecoveryBundles,
} from './local-control-recovery'
import { projectLocalControlSnapshotV2 } from './local-control-projector'
import { parseLocalControlRecoveryRow } from './local-control-rows'
import { localControlAssetGcLeaseMs } from './local-control-asset-gc'

const jsonValueSchema = z.json()

export const localControlPlannerCapabilities: Readonly<ControlPlannerCapabilities> = Object.freeze({
  externalVstRecovery: 'supported',
})

const digestFor = (snapshot: ControlPlanV1['snapshot']) => {
  const { revision: _revision, updatedAt: _updatedAt, ...project } = snapshot.project
  return hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify({
    project,
    tracks: snapshot.tracks,
    clips: snapshot.clips,
    processors: snapshot.processors,
    automation: snapshot.automation,
    sidechains: snapshot.sidechains,
    assets: snapshot.assets,
    assetFolders: snapshot.assetFolders,
  })))
}

export const rewriteLocalControlActionReferences = (
  action: ControlActionV1,
  ids: ReadonlyMap<string, string>,
  clientRefs: ReadonlyMap<string, string>,
): ControlActionV1 => {
  const rewrite = (value: JsonValue): JsonValue => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (!isJsonObject(value)) return value
    const record = value
    if (record.source === 'persisted' && isJsonString(record.id)) {
      return { ...record, id: ids.get(record.id) ?? record.id }
    }
    if (record.source === 'client' && isJsonString(record.clientRef)) {
      const id = clientRefs.get(record.clientRef)
      return id === undefined ? record : { source: 'persisted', id }
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, rewrite(entry)]))
  }
  const actionValue = jsonValueSchema.parse(JSON.parse(JSON.stringify(action)))
  return controlActionSchemaV1.parse(rewrite(actionValue))
}

const isRecoverable = (action: ControlActionV1) => (
  action.kind === 'track.delete'
  || action.kind === 'track.ungroup'
  || action.kind === 'clip.delete'
  || action.kind === 'effect.remove'
  || action.kind === 'instrument.remove'
  || action.kind === 'arpeggiator.remove'
  || action.kind === 'automation.delete'
  || action.kind === 'sidechain.remove'
  || action.kind === 'asset.delete'
  || action.kind === 'timeline.range.delete'
)

const recoveryMappings = (
  payload: RecoveryPayload,
  recoveryId: string,
  ids: ReadonlyMap<string, string>,
  instanceIds: ReadonlyMap<string, string>,
) => {
  const payloadValue = jsonValueSchema.parse(JSON.parse(JSON.stringify(payload)))
  if (!isJsonObject(payloadValue) || !isJsonObject(payloadValue.data)) return []
  const data = payloadValue.data
  const record = data
  const mappings: Array<{ entity: string; sourceId: string; restoredId: string }> = []
  const append = (entity: string, entries: JsonValue | undefined, prefix: string) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (!isJsonObject(entry)) continue
      const sourceId = entry.id
      if (!isJsonString(sourceId)) continue
      const restoredId = ids.get(`recovery:${prefix}:${recoveryId}:${sourceId}`)
      if (restoredId) mappings.push({ entity, sourceId, restoredId })
    }
  }
  append('track', record.tracks, 'track')
  append('clip', record.clips, 'clip')
  append('clip', record.deletedClips, 'clip')
  append('effect', record.effects, 'effect')
  const appendAutomation = (sourceId: JsonValue | undefined, automation: JsonValue | undefined) => {
    if (!isJsonString(sourceId) || !isJsonObject(automation)) return
    const target = automation.targetKind === 'master'
      ? {
          kind: 'master' as const,
          effectInstanceId: isJsonString(automation.effectInstanceId)
            ? replace(automation.effectInstanceId, instanceIds)
            : undefined,
        }
      : isJsonString(automation.trackId)
        ? {
            kind: 'track' as const,
            trackId: ids.get(`recovery:track:${recoveryId}:${automation.trackId}`) ?? automation.trackId,
            effectInstanceId: isJsonString(automation.effectInstanceId)
              ? replace(automation.effectInstanceId, instanceIds)
              : undefined,
          }
        : undefined
    if (target && isJsonString(automation.parameterId)) {
      mappings.push({
        entity: 'automation',
        sourceId,
        restoredId: automationTargetKey(
          target,
          rebaseRecoveryAutomationParameterIdV1(
            automation.parameterId,
            target.kind === 'track' ? target.trackId : undefined,
          ),
        ),
      })
    }
  }
  const appendSidechain = (sourceId: JsonValue | undefined, sidechain: JsonValue | undefined) => {
    if (!isJsonObject(sidechain) || !isJsonString(sourceId) || !isJsonString(sidechain.targetTrackId) || !isJsonString(sidechain.effectInstanceId)) return
    mappings.push({
      entity: 'sidechain',
      sourceId,
      restoredId: localSidechainRouteRowId(
        ids.get(`recovery:track:${recoveryId}:${sidechain.targetTrackId}`) ?? sidechain.targetTrackId,
        replace(sidechain.effectInstanceId, instanceIds) ?? sidechain.effectInstanceId,
      ),
    })
  }
  if (Array.isArray(record.automation)) {
    for (const entry of record.automation) {
      if (isJsonObject(entry)) appendAutomation(entry.id, entry.automation)
    }
  }
  if (Array.isArray(record.sidechains)) {
    for (const entry of record.sidechains) {
      if (isJsonObject(entry)) appendSidechain(entry.id, entry.sidechain)
    }
  }
  const appendSingle = (entity: string, sourceId: JsonValue | undefined, prefix: string) => {
    if (!isJsonString(sourceId)) return
    const restoredId = ids.get(`recovery:${prefix}:${recoveryId}:${sourceId}`)
      ?? ids.get(`recovery:${prefix}:${recoveryId}`)
    if (restoredId) mappings.push({ entity, sourceId, restoredId })
  }
  appendSingle('automation', record.automationId, 'automation')
  appendSingle('sidechain', record.sidechainId, 'sidechain')
  appendAutomation(record.automationId, record.automation)
  appendSidechain(record.sidechainId, record.sidechain)
  if (isJsonString(record.clipId)) {
    const restoredId = ids.get(`recovery:clip:${recoveryId}`)
    if (restoredId) mappings.push({ entity: 'clip', sourceId: record.clipId, restoredId })
  }
  if (isJsonString(record.assetId)) mappings.push({
    entity: 'asset',
    sourceId: record.assetId,
    restoredId: ids.get(`recovery:asset:${recoveryId}`) ?? record.assetId,
  })
  return mappings
}

const replace = (value: string | undefined, ids: ReadonlyMap<string, string>) => (
  value === undefined ? undefined : ids.get(value) ?? value
)
const isGenerated = (value: string) => value.startsWith('control:') || value.startsWith('recovery:')
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const jsonObjectFromStoredValue = (value: LocalProjectStoredValue) => {
  const parsed = parseLocalProjectStoredJsonValue(value)
  return isJsonObject(parsed) ? parsed : undefined
}
const localSampleUrls = (entities: readonly { kind: string; id: string; value: LocalProjectStoredValue }[]) => new Map(
  entities.flatMap((entity) => {
    const value = entity.kind === 'clip' ? jsonObjectFromStoredValue(entity.value) : undefined
    return value && isJsonString(value.sampleUrl) ? [[entity.id, value.sampleUrl] as const] : []
  }),
)
const localClipHistoryRefs = (entities: readonly { kind: string; id: string; value: LocalProjectStoredValue }[]) => new Map(
  entities.flatMap((entity) => {
    const value = entity.kind === 'clip' ? jsonObjectFromStoredValue(entity.value) : undefined
    return value && isJsonString(value.historyRef) ? [[entity.id, value.historyRef] as const] : []
  }),
)
const recoveryClipHistoryRefs = (payload: RecoveryPayload) => {
  const payloadValue = jsonValueSchema.parse(JSON.parse(JSON.stringify(payload)))
  if (!isJsonObject(payloadValue) || !isJsonObject(payloadValue.data)) return []
  const data = payloadValue.data
  const clips = [
    ...(Array.isArray(data.clips) ? data.clips : []),
    ...(Array.isArray(data.deletedClips) ? data.deletedClips : []),
    ...(isJsonString(data.clipId) && isJsonObject(data.clip) ? [{ id: data.clipId, clip: data.clip }] : []),
  ]
  return clips.flatMap((entry) => {
    if (!isJsonObject(entry) || !isJsonString(entry.id)) return []
    const clip = isJsonObject(entry.clip) ? entry.clip : isJsonObject(entry.before) ? entry.before : undefined
    return clip && isJsonString(clip.historyRef) ? [[entry.id, clip.historyRef] as const] : []
  })
}

const rewriteInstanceIds = (value: JsonValue, instanceIds: ReadonlyMap<string, string>): JsonValue => {
  if (Array.isArray(value)) return value.map((entry) => rewriteInstanceIds(entry, instanceIds))
  if (!isJsonObject(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'instanceId' && isJsonString(entry)
      ? replace(entry, instanceIds) ?? entry
      : rewriteInstanceIds(entry, instanceIds),
  ]))
}

const localEffectKind = (kind: string, master = false): LocalEffectKind | undefined => {
  if (kind === 'instrument') return 'instrument'
  if (kind === 'arpeggiator') return 'arp'
  return kind === 'utility' || kind === 'eq' || kind === 'autofilter' || kind === 'gate'
    || kind === 'compressor' || kind === 'saturator' || kind === 'limiter' || kind === 'lofi'
    || kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo'
    || kind === 'autopan' || kind === 'ensemble' || kind === 'delay' || kind === 'reverb'
    || kind === 'spectral'
    ? master ? `master-${kind}` : kind
    : undefined
}

const materializedSnapshot = (
  snapshot: ControlPlanV1['snapshot'],
  ids: ReadonlyMap<string, string>,
  instanceIds: ReadonlyMap<string, string>,
): ControlPlanV1['snapshot'] => {
  const materialized = {
    ...snapshot,
    tracks: snapshot.tracks.map((track) => ({
    ...track,
    id: replace(track.id, ids) ?? track.id,
    groupId: replace(track.groupId, ids),
    outputTargetId: replace(track.outputTargetId, ids),
    sends: track.sends.map((send: { targetTrackId: string; amount: number; tap?: 'pre-fx' | 'pre-fader' | 'post-fader' }) => ({ ...send, targetTrackId: replace(send.targetTrackId, ids) ?? send.targetTrackId })),
    })),
    clips: snapshot.clips.map((clip) => ({
    ...clip,
    id: replace(clip.id, ids) ?? clip.id,
    trackId: replace(clip.trackId, ids) ?? clip.trackId,
    })),
    processors: snapshot.processors.map((processor) => ({
    ...processor,
    id: replace(processor.id, ids) ?? processor.id,
    target: 'master' in processor.target
      ? processor.target
      : { trackId: replace(processor.target.trackId, ids) ?? processor.target.trackId },
    instanceId: processor.processor.kind === 'external-vst3'
      ? processor.instanceId
      : replace(processor.instanceId, instanceIds) ?? processor.instanceId,
    processor: {
      ...processor.processor,
      params: processor.processor.kind === 'external-vst3'
        ? processor.processor.params
        : rewriteInstanceIds(processor.processor.params, instanceIds),
    },
    })),
    automation: snapshot.automation.map((entry) => ({
    ...entry,
    target: 'master' in entry.target
      ? entry.target
      : { trackId: replace(entry.target.trackId, ids) ?? entry.target.trackId },
    effectInstanceId: replace(entry.effectInstanceId, instanceIds) ?? entry.effectInstanceId,
    })),
    sidechains: snapshot.sidechains.map((entry) => ({
    ...entry,
    sourceTrackId: replace(entry.sourceTrackId, ids) ?? entry.sourceTrackId,
    targetTrackId: replace(entry.targetTrackId, ids) ?? entry.targetTrackId,
    effectInstanceId: replace(entry.effectInstanceId, instanceIds) ?? entry.effectInstanceId,
    })),
  }
  materialized.tracks.sort((left, right) => left.index - right.index || compareText(left.id, right.id))
  materialized.clips.sort((left, right) => left.startSec - right.startSec || compareText(left.id, right.id))
  materialized.processors.sort((left, right) => compareText(
    'master' in left.target ? 'master' : `track:${left.target.trackId}`,
    'master' in right.target ? 'master' : `track:${right.target.trackId}`,
  ) || left.index - right.index
    || compareText(left.processor.kind, right.processor.kind)
    || compareText(left.instanceId ?? '', right.instanceId ?? '')
    || compareText(left.id, right.id))
  materialized.automation.sort((left, right) => compareText(
    'master' in left.target ? 'master' : `track:${left.target.trackId}`,
    'master' in right.target ? 'master' : `track:${right.target.trackId}`,
  ) || compareText(left.parameterId, right.parameterId)
    || compareText(left.effectInstanceId ?? '', right.effectInstanceId ?? ''))
  materialized.sidechains.sort((left, right) => (
    compareText(left.targetTrackId, right.targetTrackId)
    || compareText(left.effectInstanceId, right.effectInstanceId)
    || compareText(left.sourceTrackId, right.sourceTrackId)
  ))
  return projectSnapshotSchemaV2.parse(materialized)
}

const canonicalEntityKeys = (snapshot: ControlPlanV1['snapshot']) => new Set([
  ...snapshot.tracks.map((item) => `track:${item.id}`),
  ...snapshot.clips.map((item) => `clip:${item.id}`),
  ...snapshot.processors.map((item) => (
    item.processor.kind === 'external-vst3'
      ? `external-plugin:${item.id}`
      : `effect:${item.id}`
  )),
  ...snapshot.automation.map((item) => `automation-envelope:${automationTargetKey(
    'master' in item.target
      ? { kind: 'master', effectInstanceId: item.effectInstanceId }
      : { kind: 'track', trackId: item.target.trackId, effectInstanceId: item.effectInstanceId },
    item.parameterId,
  )}`),
  ...snapshot.sidechains.map((item) => `sidechain-route:${localSidechainRouteRowId(
    item.targetTrackId,
    item.effectInstanceId,
  )}`),
])

const externalProcessorSnapshot = (processor: ExternalProcessor, id: string): ControlPlanV1['snapshot']['processors'][number] => ({
  id,
  target: processor.targetId === 'master' ? { master: true } : { trackId: processor.targetId },
  instanceId: processor.instanceId,
  index: processor.index,
  processor: {
    kind: 'external-vst3',
    params: {
      identity: {
        name: processor.manifest.identity.name,
        vendor: processor.manifest.identity.vendor,
        classId: processor.manifest.identity.classId,
        role: processor.manifest.role,
      },
      bypassed: processor.bypassed,
      parameterOverrides: processor.parameterOverrides,
      parameters: processor.manifest.parameters.map((parameter) => ({
        id: parameter.id,
        readOnly: parameter.readOnly,
      })),
    },
  },
})

const removedCanonicalEntityKeys = (
  before: ControlPlanV1['snapshot'],
  after: ControlPlanV1['snapshot'],
) => {
  const afterKeys = canonicalEntityKeys(after)
  return new Set(Array.from(canonicalEntityKeys(before)).filter((key) => !afterKeys.has(key)))
}

export const executeLocalControlRequestInTransactionV1 = (
  context: LocalControlTransactionResult,
  input: { projectId: string; actions: ControlActionV1[]; actorSubject?: string },
) => {
  const request = parseControlPreviewRequestV1({
    version: 'v1',
    projectId: input.projectId,
    actions: input.actions,
  })
  const duplicateRecoveryActionIndex = findDuplicateRecoveryActionIndexV1(request.actions)
  if (duplicateRecoveryActionIndex !== undefined) {
    throw { code: 'validation', message: 'Recovery IDs must be restored at most once per request.', actionIndex: duplicateRecoveryActionIndex }
  }
  const actorSubject = input.actorSubject ?? 'local'
  const ids = new Map<string, string>()
  const instanceIds = new Map<string, string>()
  const clientRefs = new Map<string, string>()
  const recoveries: Array<{ actionIndex: number; id: string; kind: string; expiresAt: number }> = []
  const recoveryRows: LocalControlRecoveryRow[] = []
  const restored: Array<{ actionIndex: number; recoveryId: string; entities: Array<{ entity: string; sourceId: string; restoredId: string }> }> = []
  const assetFallbacks = new Map<string, typeof context.rows.assets[number]>()
  const restoredRecoveries = new Map<string, { payload: RecoveryPayload; externalProcessors?: LocalControlRecoveryRow['externalProcessors'] }>()
  const sampleUrlFallbacks = new Map<string, string>()
  const historyRefFallbacks = new Map<string, string>()
  const restoredExternalEntities = new Map<string, LocalProjectEntityRow>()
  const restoredExternalArtifacts = new Map<string, LocalProjectExternalPluginArtifactRow>()
  const existingExternalArtifacts = new Map(
    context.rows.externalPluginArtifacts.map((artifact) => [artifact.id, artifact]),
  )
  const sampleUrlByClipId = localSampleUrls(context.rows.entities)
  let current = context.snapshot
  let changed = false
  const invalidRecoveryIds = new Set<string>()
  const migratedLegacySynthIds = new Set<string>()
  let retainedExternalRecoveryBytes = context.rows.recoveries.reduce((total, row) => {
    if (row.projectId !== request.projectId || row.consumedAt !== undefined || row.expiresAt <= Date.now()) return total
    const parsed = parseLocalControlRecoveryRow(row)
    if (!parsed?.externalProcessors) return total
    return total + localExternalRecoveryUsage(parsed.externalProcessors).byteLength
  }, 0)
  const recoveryById = new Map(context.rows.recoveries.flatMap((row) => {
    const parsed = parseLocalControlRecoveryRow(row)
    if (!parsed) {
      const parsedRow = jsonValueSchema.safeParse(row)
      if (parsedRow.success && isJsonObject(parsedRow.data) && isJsonString(parsedRow.data.id)) {
        invalidRecoveryIds.add(parsedRow.data.id)
      }
      return []
    }
    if (parsed.projectId !== request.projectId || parsed.consumedAt !== undefined || parsed.expiresAt <= Date.now()) return []
    return [[parsed.id, {
      payload: parsed.recovery,
      externalProcessors: parsed.externalProcessors,
      localSampleUrls: parsed.localSampleUrls,
    }] as const]
  }))
  for (const action of request.actions) {
    if (action.kind === 'recovery.restore' && invalidRecoveryIds.has(action.recovery.id)) {
      throw new Error('Recovery payload integrity check failed.')
    }
  }
  const fullActionSnapshots = new Map<number, {
    changed: boolean
    afterSnapshot: ControlPlanV1['snapshot']
  }>()
  const fullPlan = planControlRequestV1(context.snapshot, request, recoveryById, {
    trace: {
      onActionPlanned: (entry) => {
        fullActionSnapshots.set(entry.actionIndex, {
          changed: entry.changed,
          afterSnapshot: entry.afterSnapshot,
        })
      },
    },
    capabilities: localControlPlannerCapabilities,
  })
  for (const [actionIndex, originalAction] of request.actions.entries()) {
    if (originalAction.kind === 'recovery.restore' && invalidRecoveryIds.has(originalAction.recovery.id)) {
      throw new Error('Recovery payload integrity check failed.')
    }
    const action = rewriteLocalControlActionReferences(originalAction, ids, clientRefs)
    const stepPlan = planControlRequestV1(
      current,
      { projectId: request.projectId, actions: [action] },
      recoveryById,
      {
        actionIndexOffset: actionIndex,
        capabilities: localControlPlannerCapabilities,
      },
    )
    const entry = stepPlan.actions[0]
    if (!entry) throw new Error('Local control planner returned no action.')
    const fullEntry = fullPlan.actions[actionIndex]
    if (!fullEntry || entry.changed !== fullEntry.changed) {
      throw new Error(`Local control action parity disagrees for action ${actionIndex}.`)
    }
    if (action.kind === 'timeline.range.delete' && entry.timelineRangeDelete) {
      for (const creation of entry.timelineRangeDelete.clipCreates) {
        if (!ids.has(creation.placeholderId)) ids.set(creation.placeholderId, createLocalClipId())
      }
    }
    if (entry.changed && isRecoverable(action)) {
      const payload = captureLocalRecoveryPayload({
        projectId: request.projectId,
        actorSubject,
        action,
        actionIndex,
        snapshot: current,
        assets: resolveLocalRecoveryAssets(current, [
          ...context.rows.assets,
          ...assetFallbacks.values(),
        ], restoredRecoveries),
        materializedClipIds: ids,
        clipHistoryRefs: localClipHistoryRefs(context.rows.entities),
      })
      if (!payload) {
        throw { code: 'limit-exceeded', message: 'Recovery payload cannot be captured.', actionIndex }
      }
      {
        const id = `local-recovery:${crypto.randomUUID()}`
        const createdAt = Date.now()
        const serialized = serializeLocalRecoveryPayload(payload)
        const expiresAt = createdAt + localRecoveryLifetimeMs
        const recoveryRow: LocalControlRecoveryRow = {
          id,
          version: 1,
          projectId: request.projectId,
          actorSubject,
          sourceActionIndex: actionIndex,
          kind: payload.kind,
          payload: serialized.payload,
          payloadHash: serialized.payloadHash,
          localSampleUrls: Object.fromEntries(localSampleUrls(context.rows.entities)),
          createdAt,
          expiresAt,
        }
        if (action.kind === 'track.delete' || action.kind === 'track.ungroup') {
          const externalProcessors = captureLocalExternalProcessorRecoveryBundles({
            action,
            snapshot: current,
            entities: context.rows.entities,
            artifacts: context.rows.externalPluginArtifacts,
          })
          if (externalProcessors.length > 0) {
            let usage: ReturnType<typeof localExternalRecoveryUsage>
            try {
              usage = localExternalRecoveryUsage(externalProcessors)
            } catch {
              throw {
                code: 'limit-exceeded',
                message: 'Recovery external artifact limits exceeded.',
                actionIndex,
              }
            }
            try {
              validateLocalProjectExternalRecoveryBytes(retainedExternalRecoveryBytes + usage.byteLength)
            } catch {
              throw {
                code: 'limit-exceeded',
                message: 'Local project external recovery bytes exceeded.',
                actionIndex,
              }
            }
            recoveryRow.externalProcessors = externalProcessors
            recoveryRow.externalProcessorsHash = hashLocalExternalProcessorRecoveryBundles(externalProcessors)
            retainedExternalRecoveryBytes += usage.byteLength
          }
        }
        context.write.recovery(recoveryRow)
        recoveryRows.push(recoveryRow)
        if (payload.kind === 'asset.delete') {
          if (!('storagePath' in payload.data.asset)) throw new Error('Cloud recovery assets cannot be restored locally.')
          context.write.assetGc({
            id: `local-asset-gc:${id}`,
            version: 1,
            projectId: request.projectId,
            assetId: payload.data.assetId,
            eligibleAt: expiresAt,
            storagePath: payload.data.asset.storagePath,
            recoveryId: id,
          })
        }
        recoveries.push({ actionIndex, id, kind: payload.kind, expiresAt })
      }
    }
    for (const ref of stepPlan.resolvedRefs) {
      if (ref.entity === 'effect') continue
      if (ids.has(ref.id)) continue
      ids.set(ref.id, ref.entity === 'track' ? createLocalTrackId()
        : createLocalClipId())
    }
    for (const ref of stepPlan.resolvedRefs) {
      const id = ids.get(ref.id)
      if (id) clientRefs.set(ref.clientRef, id)
    }
    for (const track of stepPlan.snapshot.tracks) {
      if (isGenerated(track.id) && !ids.has(track.id)) ids.set(track.id, createLocalTrackId())
    }
    for (const clip of stepPlan.snapshot.clips) {
      if (isGenerated(clip.id) && !ids.has(clip.id)) ids.set(clip.id, createLocalClipId())
    }
    for (const processor of stepPlan.snapshot.processors) {
      if (isGenerated(processor.instanceId ?? '') && !instanceIds.has(processor.instanceId ?? '')) {
        instanceIds.set(
          processor.instanceId ?? '',
          processor.processor.kind === 'instrument'
            ? createInstrumentInstanceId()
            : createAudioEffectInstanceId(),
        )
      }
      if (isGenerated(processor.id)) {
        const targetId = 'master' in processor.target
          ? 'master'
          : ids.get(processor.target.trackId) ?? processor.target.trackId
        const kind = localEffectKind(processor.processor.kind, targetId === 'master')
        if (!kind) throw new Error(`Unsupported local processor kind "${processor.processor.kind}".`)
        const instanceId = instanceIds.get(processor.instanceId ?? '') ?? processor.instanceId
        ids.set(
          processor.id,
          localEffectRowId(
            targetId,
            kind,
            kind === 'instrument' || kind === 'arp' ? undefined : instanceId,
          ),
        )
      }
    }
    if (action.kind === 'instrument.set' && action.target.track.source === 'persisted') {
      const trackId = action.target.track.id
      for (const processor of current.processors) {
        if (
          'trackId' in processor.target
          && processor.target.trackId === trackId
          && processor.processor.kind === 'instrument'
          && processor.id === `${trackId}:synth`
        ) {
          const id = localEffectRowId(trackId, 'instrument')
          ids.set(processor.id, id)
          migratedLegacySynthIds.add(processor.id)
        }
      }
    }
    for (const ref of stepPlan.resolvedRefs) {
      if (ref.entity !== 'effect') continue
      const id = ids.get(ref.id)
      if (!id) throw new Error('Local effect ID is unavailable.')
      clientRefs.set(ref.clientRef, id)
    }
    const next = materializedSnapshot(stepPlan.snapshot, ids, instanceIds)
    const traced = fullActionSnapshots.get(actionIndex)
    if (!traced || traced.changed !== entry.changed) {
      throw new Error(`Local control planner trace disagrees for action ${actionIndex}.`)
    }
    const expected = materializedSnapshot(traced.afterSnapshot, ids, instanceIds)
    if (digestFor(next) !== digestFor(expected)) {
      throw new Error(`Local control sequential parity disagrees for action ${actionIndex}.`)
    }
    if (entry.changed) {
      if (entry.timelineRangeDelete) {
        for (const creation of entry.timelineRangeDelete.clipCreates) {
          const sourceId = ids.get(creation.sourceClipId) ?? creation.sourceClipId
          const createdId = ids.get(creation.placeholderId)
          const sampleUrl = sampleUrlByClipId.get(sourceId)
          if (createdId && sampleUrl) {
            sampleUrlFallbacks.set(createdId, sampleUrl)
            sampleUrlByClipId.set(createdId, sampleUrl)
          }
        }
      }
      if (originalAction.kind === 'recovery.restore') {
        const recovery = recoveryById.get(originalAction.recovery.id)
        if (recovery?.externalProcessors) {
          const trackMappings = new Map(
            recoveryMappings(recovery.payload, originalAction.recovery.id, ids, instanceIds)
              .filter((mapping) => mapping.entity === 'track')
              .map((mapping) => [mapping.sourceId, mapping.restoredId]),
          )
          for (const bundle of validateLocalExternalProcessorRecoveryBundles(recovery.externalProcessors)) {
            const processor = externalProcessorSchema.parse(bundle.entity.value)
            const entity = {
              ...bundle.entity,
              value: {
                ...processor,
                targetId: trackMappings.get(processor.targetId) ?? processor.targetId,
              },
            }
            if (context.rows.entities.some((row) => row.kind === entity.kind && row.id === entity.id)
              || restoredExternalEntities.has(entity.id)) {
              throw new Error(`External processor "${entity.id}" already exists during recovery.`)
            }
            restoredExternalEntities.set(entity.id, entity)
            for (const artifact of bundle.artifacts) {
              const existingArtifact = restoredExternalArtifacts.get(artifact.id)
                ?? existingExternalArtifacts.get(artifact.id)
              if (existingArtifact !== undefined) {
                if (!localRecoveryArtifactsMatch(existingArtifact, artifact)) {
                  throw new Error(`External processor artifact "${artifact.id}" differs during recovery.`)
                }
                continue
              }
              restoredExternalArtifacts.set(artifact.id, artifact)
              context.write.externalPluginArtifact(artifact)
            }
          }
        }
        if (recovery?.localSampleUrls) {
          for (const [sourceId, sampleUrl] of Object.entries(recovery.localSampleUrls)) {
            const restoredId = ids.get(`recovery:clip:${originalAction.recovery.id}:${sourceId}`)
              ?? ids.get(`recovery:clip:${originalAction.recovery.id}`)
            if (restoredId) sampleUrlFallbacks.set(restoredId, sampleUrl)
          }
        }
        if (recovery) {
          for (const [sourceId, historyRef] of recoveryClipHistoryRefs(recovery.payload)) {
            const restoredId = ids.get(`recovery:clip:${originalAction.recovery.id}:${sourceId}`)
              ?? ids.get(`recovery:clip:${originalAction.recovery.id}`)
            if (restoredId) historyRefFallbacks.set(restoredId, historyRef)
          }
        }
      }
      const projectedNext = originalAction.kind === 'recovery.restore'
        ? materializedSnapshot({
            ...next,
            processors: [...next.processors, ...Array.from(restoredExternalEntities.values()).flatMap((row) => {
              const parsed = externalProcessorSchema.safeParse(row.value)
              return parsed.success ? [externalProcessorSnapshot(parsed.data, row.id)] : []
            }).filter((processor) => !next.processors.some((entry) => entry.id === processor.id))],
          }, new Map(), new Map())
        : next
      const materialized = materializeLocalControlSnapshot({
        entities: [...context.rows.entities, ...restoredExternalEntities.values()],
        assets: context.rows.assets,
        projectState: context.rows.projectState,
      }, projectedNext, Date.now(), new Map(), new Set(context.snapshot.assets
        .filter((asset) => !projectedNext.assets.some((entry) => entry.id === asset.id))
        .map((asset) => asset.id)), new Set([
        ...removedCanonicalEntityKeys(context.snapshot, projectedNext),
        ...context.snapshot.processors
          .filter((processor) => (
            processor.processor.kind === 'external-vst3'
            && !projectedNext.processors.some((entry) => entry.id === processor.id)
          ))
          .map((processor) => `${externalPluginEntityKind}:${processor.id}`),
        ...Array.from(migratedLegacySynthIds, (id) => `effect:${id}`),
      ]), migratedLegacySynthIds, sampleUrlFallbacks, historyRefFallbacks)
      const projected = projectLocalControlSnapshotV2({
        projectId: request.projectId,
        fallbackMetadata: {
          version: 1,
          name: next.project.name,
          updatedAt: Date.now(),
          timeSignature: next.project.timeSignature,
        },
        entities: materialized.entities,
        assets: materialized.assets,
        projectState: materialized.projectState,
        revision: context.snapshot.project.revision,
      })
      if (digestFor(projectedNext) !== digestFor(projected)) throw new Error(`Local control projection disagrees for action ${actionIndex}.`)
    }
    if (originalAction.kind === 'recovery.restore' && entry.changed) {
      const recovery = recoveryById.get(originalAction.recovery.id)
      if (!recovery) throw new Error('Recovery is unavailable.')
      if (recovery.externalProcessors) {
        retainedExternalRecoveryBytes -= localExternalRecoveryUsage(recovery.externalProcessors).byteLength
      }
      const gc = context.rows.assetGc.find((row) => row.recoveryId === originalAction.recovery.id)
      if (gc?.claimedAt !== undefined && gc.claimedAt > Date.now() - localControlAssetGcLeaseMs) {
        throw {
          code: 'validation',
          message: 'Recovery asset bytes are being deleted.',
          actionIndex,
        }
      }
      context.write.recovery({
        ...context.rows.recoveries.find((row) => row.id === originalAction.recovery.id)!,
        consumedAt: Date.now(),
      })
      if (recovery.payload.kind === 'asset.delete') {
        const asset = recovery.payload.data.asset
        if (!('storagePath' in asset)) throw new Error('Cloud recovery assets cannot be restored locally.')
        assetFallbacks.set(asset.assetKey, {
          id: asset.assetKey,
          name: asset.name,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          storagePath: asset.storagePath,
          sourceKind: asset.sourceKind,
          contentHash: asset.contentSha256,
          durationSec: asset.duration,
          sampleRate: asset.sampleRate,
          channelCount: asset.channelCount,
          folderId: asset.folderId,
          missing: asset.missing,
          originalFileName: asset.originalFileName,
          originalLastModified: asset.originalLastModified,
          createdAt: asset.createdAt,
          updatedAt: asset.updatedAt,
        })
        context.remove.assetGc(`local-asset-gc:${originalAction.recovery.id}`)
      }
      restoredRecoveries.set(originalAction.recovery.id, recovery)
      recoveryById.delete(originalAction.recovery.id)
      restored.push({
        actionIndex,
        recoveryId: originalAction.recovery.id,
        entities: recoveryMappings(recovery.payload, originalAction.recovery.id, ids, instanceIds),
      })
    }
    const localExternalProcessors = Array.from(restoredExternalEntities.values()).flatMap((row) => {
      const parsed = externalProcessorSchema.safeParse(row.value)
      return parsed.success ? [externalProcessorSnapshot(parsed.data, row.id)] : []
    })
    current = {
      ...current,
      ...next,
      processors: [
        ...next.processors,
        ...localExternalProcessors.filter((processor) => !next.processors.some((entry) => entry.id === processor.id)),
      ],
      version: 'v2',
      project: { ...next.project, revision: context.snapshot.project.revision },
    }
    changed = changed || entry.changed
  }
  if (changed !== fullPlan.applied) throw new Error('Local control full plan disagrees with sequential execution.')
  if (changed) {
    const finalSnapshot = {
      ...current,
      project: { ...current.project, revision: context.snapshot.project.revision + 1 },
    }
    const removedAssetIds = new Set(context.snapshot.assets
      .filter((asset) => !finalSnapshot.assets.some((entry) => entry.id === asset.id))
      .map((asset) => asset.id))
    const model = materializeLocalControlSnapshot({
      entities: [...context.rows.entities, ...restoredExternalEntities.values()],
      assets: [...context.rows.assets],
      projectState: [...context.rows.projectState],
    }, finalSnapshot, Date.now(), assetFallbacks, removedAssetIds, new Set([
      ...removedCanonicalEntityKeys(context.snapshot, finalSnapshot),
      ...Array.from(migratedLegacySynthIds, (id) => `effect:${id}`),
    ]), migratedLegacySynthIds, sampleUrlFallbacks, historyRefFallbacks, new Map(
      Array.from(restoredExternalEntities.values()).flatMap((row) => {
        const parsed = externalProcessorSchema.safeParse(row.value)
        return parsed.success ? [[row.id, parsed.data] as const] : []
      }),
    ))
    const retainedExternalKeys = new Set(model.entities
      .filter((row) => row.kind === externalPluginEntityKind)
      .map((row) => `${row.kind}\u0000${row.id}`))
    const removedExternalRows = context.rows.entities.filter((row) => (
      row.kind === externalPluginEntityKind
      && !retainedExternalKeys.has(`${row.kind}\u0000${row.id}`)
    ))
    if (removedExternalRows.length > 0) {
      const deletionPlan = planLocalExternalProcessorDeletion({
        selectedExternalRows: removedExternalRows,
        retainedMixedEffectRows: [...context.rows.entities, ...restoredExternalEntities.values()]
          .filter((row) => row.kind === 'effect' || row.kind === externalPluginEntityKind),
      })
      applyLocalExternalProcessorDeletionPlanToLocalControl(deletionPlan, {
        deleteEntity: (kind, id) => context.remove.entity(kind, id),
        deleteArtifact: (id) => context.remove.externalPluginArtifact(id),
        putEntity: (row) => context.write.entity(row),
      })
    }
    for (const row of model.replaced.entities) {
      if (row.kind !== externalPluginEntityKind) context.remove.entity(row.kind, row.id)
    }
    for (const id of model.replaced.assets) context.remove.asset(id)
    for (const key of model.replaced.projectState) context.remove.projectState(key)
    for (const row of model.entities) context.write.entity(row)
    for (const row of model.assets) context.write.asset(row)
    for (const row of model.projectState) context.write.projectState(row)
    context.write.controlState({
      version: 1,
      revision: finalSnapshot.project.revision,
      digest: digestFor(finalSnapshot),
      updatedAt: Date.now(),
    })
  }
  return {
    changed,
    resolvedRefs: fullPlan.resolvedRefs.flatMap((ref) => {
      const id = ids.get(ref.id)
      const survives = id !== undefined && (
        ref.entity === 'track' ? current.tracks.some((entry) => entry.id === id)
          : ref.entity === 'clip' ? current.clips.some((entry) => entry.id === id)
            : current.processors.some((entry) => entry.id === id)
      )
      return id && survives ? [{ ...ref, id, persisted: true }] : []
    }),
    recoveries,
    recoveryRows,
    restored,
    plan: fullPlan,
  }
}

export const executeLocalControlRequestV1 = (
  input: { projectId: string; actions: ControlActionV1[]; actorSubject?: string },
) => withLocalControlTransaction(
  input.projectId,
  'readwrite',
  (context) => executeLocalControlRequestInTransactionV1(context, input),
)
