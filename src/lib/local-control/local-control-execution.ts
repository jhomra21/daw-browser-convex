import {
  controlActionSchemaV1,
  hashCanonicalJsonSyncV1,
  findDuplicateRecoveryActionIndexV1,
  parseControlPreviewRequestV1,
  planControlRequestV1,
  rebaseRecoveryAutomationParameterIdV1,
  type ControlActionV1,
  type ControlPlanV1,
} from '@daw-browser/control'
import {
  automationTargetKey,
  createAudioEffectInstanceId,
  createInstrumentInstanceId,
  createLocalClipId,
  createLocalTrackId,
} from '@daw-browser/shared'
import { localEffectRowId, localSidechainRouteRowId, type LocalEffectRow } from '~/lib/local-effects'
import type { LocalControlRecoveryRow } from '~/lib/local-project-db'
import { materializeLocalControlSnapshot } from './local-control-model'
import { withLocalControlTransaction, type LocalControlTransactionResult } from './local-control-state'
import {
  captureLocalRecoveryPayload,
  localRecoveryLifetimeMs,
  serializeLocalRecoveryPayload,
} from './local-control-recovery'
import { projectLocalControlSnapshotV1 } from './local-control-projector'
import { parseLocalControlRecoveryRow } from './local-control-rows'
import { localControlAssetGcLeaseMs } from './local-control-asset-gc'

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

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

const rewriteActionReferences = (
  action: ControlActionV1,
  ids: ReadonlyMap<string, string>,
  clientRefs: ReadonlyMap<string, string>,
): ControlActionV1 => {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value !== 'object' || value === null) return value
    if (!isRecord(value)) return value
    const record = value
    if (record.source === 'persisted' && typeof record.id === 'string') {
      return { ...record, id: ids.get(record.id) ?? record.id }
    }
    if (record.source === 'client' && typeof record.clientRef === 'string') {
      const id = clientRefs.get(record.clientRef)
      return id === undefined ? record : { source: 'persisted', id }
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, rewrite(entry)]))
  }
  return controlActionSchemaV1.parse(rewrite(action))
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
)

const recoveryMappings = (
  payload: unknown,
  recoveryId: string,
  ids: ReadonlyMap<string, string>,
  instanceIds: ReadonlyMap<string, string>,
) => {
  if (!isRecord(payload)) return []
  const data = payload.data
  if (!isRecord(data)) return []
  const record = data
  const mappings: Array<{ entity: string; sourceId: string; restoredId: string }> = []
  const append = (entity: string, entries: unknown, prefix: string) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const sourceId = entry.id
      if (typeof sourceId !== 'string') continue
      const restoredId = ids.get(`recovery:${prefix}:${recoveryId}:${sourceId}`)
      if (restoredId) mappings.push({ entity, sourceId, restoredId })
    }
  }
  append('track', record.tracks, 'track')
  append('clip', record.clips, 'clip')
  append('effect', record.effects, 'effect')
  const appendAutomation = (sourceId: unknown, automation: unknown) => {
    if (typeof sourceId !== 'string' || !isRecord(automation)) return
    const target = automation.targetKind === 'master'
      ? {
          kind: 'master' as const,
          effectInstanceId: typeof automation.effectInstanceId === 'string'
            ? replace(automation.effectInstanceId, instanceIds)
            : undefined,
        }
      : typeof automation.trackId === 'string'
        ? {
            kind: 'track' as const,
            trackId: ids.get(`recovery:track:${recoveryId}:${automation.trackId}`) ?? automation.trackId,
            effectInstanceId: typeof automation.effectInstanceId === 'string'
              ? replace(automation.effectInstanceId, instanceIds)
              : undefined,
          }
        : undefined
    if (target && typeof automation.parameterId === 'string') {
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
  const appendSidechain = (sourceId: unknown, sidechain: unknown) => {
    if (!isRecord(sidechain) || typeof sourceId !== 'string' || typeof sidechain.targetTrackId !== 'string' || typeof sidechain.effectInstanceId !== 'string') return
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
      if (isRecord(entry)) appendAutomation(entry.id, entry.automation)
    }
  }
  if (Array.isArray(record.sidechains)) {
    for (const entry of record.sidechains) {
      if (isRecord(entry)) appendSidechain(entry.id, entry.sidechain)
    }
  }
  const appendSingle = (entity: string, sourceId: unknown, prefix: string) => {
    if (typeof sourceId !== 'string') return
    const restoredId = ids.get(`recovery:${prefix}:${recoveryId}:${sourceId}`)
      ?? ids.get(`recovery:${prefix}:${recoveryId}`)
    if (restoredId) mappings.push({ entity, sourceId, restoredId })
  }
  appendSingle('automation', record.automationId, 'automation')
  appendSingle('sidechain', record.sidechainId, 'sidechain')
  appendAutomation(record.automationId, record.automation)
  appendSidechain(record.sidechainId, record.sidechain)
  if (typeof record.clipId === 'string') {
    const restoredId = ids.get(`recovery:clip:${recoveryId}`)
    if (restoredId) mappings.push({ entity: 'clip', sourceId: record.clipId, restoredId })
  }
  if (typeof record.assetId === 'string') mappings.push({
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

const rewriteInstanceIds = (value: unknown, instanceIds: ReadonlyMap<string, string>): unknown => {
  if (Array.isArray(value)) return value.map((entry) => rewriteInstanceIds(entry, instanceIds))
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'instanceId' && typeof entry === 'string'
      ? replace(entry, instanceIds) ?? entry
      : rewriteInstanceIds(entry, instanceIds),
  ]))
}

const localEffectKind = (kind: string, master = false): LocalEffectRow['effect'] | undefined => {
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
    instanceId: replace(processor.instanceId, instanceIds) ?? processor.instanceId,
    processor: {
      ...processor.processor,
      params: rewriteInstanceIds(processor.processor.params, instanceIds),
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
  return materialized
}

const canonicalEntityKeys = (snapshot: ControlPlanV1['snapshot']) => new Set([
  ...snapshot.tracks.map((item) => `track:${item.id}`),
  ...snapshot.clips.map((item) => `clip:${item.id}`),
  ...snapshot.processors.map((item) => `effect:${item.id}`),
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
  let current = context.snapshot
  let changed = false
  const invalidRecoveryIds = new Set<string>()
  const migratedLegacySynthIds = new Set<string>()
  const recoveryById = new Map(context.rows.recoveries.flatMap((row) => {
    const parsed = parseLocalControlRecoveryRow(row)
    if (!parsed) {
      if (isRecord(row) && typeof row.id === 'string') invalidRecoveryIds.add(row.id)
      return []
    }
    if (parsed.projectId !== request.projectId || parsed.consumedAt !== undefined || parsed.expiresAt <= Date.now()) return []
    return [[parsed.id, { payload: parsed.recovery }] as const]
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
    onActionPlanned: (entry) => {
      fullActionSnapshots.set(entry.actionIndex, {
        changed: entry.changed,
        afterSnapshot: entry.afterSnapshot,
      })
    },
  })
  for (const [actionIndex, originalAction] of request.actions.entries()) {
    if (originalAction.kind === 'recovery.restore' && invalidRecoveryIds.has(originalAction.recovery.id)) {
      throw new Error('Recovery payload integrity check failed.')
    }
    const action = rewriteActionReferences(originalAction, ids, clientRefs)
    const stepPlan = planControlRequestV1(
      current,
      { projectId: request.projectId, actions: [action] },
      recoveryById,
      undefined,
      actionIndex,
    )
    const entry = stepPlan.actions[0]
    if (!entry) throw new Error('Local control planner returned no action.')
    const fullEntry = fullPlan.actions[actionIndex]
    if (!fullEntry || entry.changed !== fullEntry.changed) {
      throw new Error(`Local control action parity disagrees for action ${actionIndex}.`)
    }
    if (entry.changed && isRecoverable(action)) {
      const payload = captureLocalRecoveryPayload({
        projectId: request.projectId,
        actorSubject,
        action,
        snapshot: current,
        assets: context.rows.assets,
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
          createdAt,
          expiresAt,
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
      const materialized = materializeLocalControlSnapshot({
        entities: context.rows.entities,
        assets: context.rows.assets,
        projectState: context.rows.projectState,
      }, next, Date.now(), new Map(), new Set(context.snapshot.assets
        .filter((asset) => !next.assets.some((entry) => entry.id === asset.id))
        .map((asset) => asset.id)), new Set([
        ...removedCanonicalEntityKeys(context.snapshot, next),
        ...Array.from(migratedLegacySynthIds, (id) => `effect:${id}`),
      ]), migratedLegacySynthIds)
      const projected = projectLocalControlSnapshotV1({
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
      if (digestFor(next) !== digestFor(projected)) throw new Error(`Local control projection disagrees for action ${actionIndex}.`)
    }
    if (originalAction.kind === 'recovery.restore' && entry.changed) {
      const recovery = recoveryById.get(originalAction.recovery.id)
      if (!recovery) throw new Error('Recovery is unavailable.')
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
      recoveryById.delete(originalAction.recovery.id)
      restored.push({
        actionIndex,
        recoveryId: originalAction.recovery.id,
        entities: recoveryMappings(recovery.payload, originalAction.recovery.id, ids, instanceIds),
      })
    }
    current = {
      ...current,
      ...next,
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
      entities: [...context.rows.entities],
      assets: [...context.rows.assets],
      projectState: [...context.rows.projectState],
    }, finalSnapshot, Date.now(), assetFallbacks, removedAssetIds, new Set([
      ...removedCanonicalEntityKeys(context.snapshot, finalSnapshot),
      ...Array.from(migratedLegacySynthIds, (id) => `effect:${id}`),
    ]), migratedLegacySynthIds)
    for (const row of model.replaced.entities) context.remove.entity(row.kind, row.id)
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
