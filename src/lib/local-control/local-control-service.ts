import {
  controlApprovalRequirementV1,
  controlApprovalResultSchemaV1,
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryEntrySchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  controlRequestDigestSyncV1,
  localControlCapabilitiesV1,
  localControlCapabilitiesV2,
  parseControlApprovalRequestV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlRecoveriesQueryV1,
  parseControlSnapshotQueryV1,
  planControlRequestV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  type ControlErrorV1,
  type ControlPlanV1,
  type ProjectSnapshotV2,
  type RecoveryPayload,
} from '@daw-browser/control'
import { sha256 } from '@noble/hashes/sha2.js'
import { isJsonString, type JsonValue } from '@daw-browser/shared'
import { z } from 'zod'
import type { removeLocalAssetFileUnlocked } from '~/lib/local-assets'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import type { PendingWriteKind } from '~/lib/local-project-write-flushers'
import type {
  LocalControlApprovalRow,
  LocalControlCommitRow,
  LocalControlRecoveryRow,
} from '~/lib/local-project-db'
import { withLocalProjectAssetLock } from '~/lib/local-project-asset-lock'
import {
  executeLocalControlRequestInTransactionV1,
  rewriteLocalControlActionReferences,
} from './local-control-execution'
import { localControlAssetGcLeaseMs, runLocalControlAssetGc } from './local-control-asset-gc'
import { parseLocalControlCursor, encodeLocalControlCursor } from './local-control-cursor'
import { captureLocalRecoveryPayload, resolveLocalRecoveryAssets, serializeLocalRecoveryPayload } from './local-control-recovery'
import { parseLocalControlRecoveryRow } from './local-control-rows'
import {
  LocalControlTransactionError,
  type LocalControlTransactionResult,
  withLocalControlTransactionOptions,
  type withLocalControlTransaction,
} from './local-control-state'

const commitLifetimeMs = 90 * 24 * 60 * 60 * 1_000
const approvalLifetimeMs = 10 * 60 * 1_000
const apiVersion = 'v1'
const hashApprovalToken = (value: string) => (
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
)
const compareNewest = (left: { createdAt: number; id: string }, right: { createdAt: number; id: string }) => (
  right.createdAt - left.createdAt || right.id.localeCompare(left.id)
)
const isBoundedText = (value: JsonValue | undefined): value is string => isJsonString(value)
  && value.length >= 1 && value.length <= 256
type ControlParserInput = Parameters<typeof parseControlPreviewRequestV1>[0]
type ErrorInput = Parameters<typeof controlErrorSchemaV1.safeParse>[0]
const controlPlanningErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  actionIndex: z.number().optional(),
})
const localControlCommitRowSchema = z.object({
  version: z.literal(1),
  status: z.literal('completed'),
  id: z.string(),
  projectId: z.string(),
  createdAt: z.number().int().nonnegative(),
  actorSubject: z.string().min(1).max(256),
  actorIssuer: z.string().min(1).max(256).optional(),
  actorTokenIdentifier: z.string().min(1).max(256).optional(),
  actorRole: z.literal('owner'),
  idempotencyKey: z.string(),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  result: z.json(),
  priorRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  applied: z.boolean(),
})
const localControlApprovalRowSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  expiresAt: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  actorSubject: z.string().min(1).max(256),
  requestDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  baseRevision: z.number().int().nonnegative(),
  actionIndexes: z.array(z.number().int().nonnegative()).min(1),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/u),
  consumedAt: z.number().int().nonnegative().optional(),
})
const assetGcJobLimit = 1_000
const maintenanceByProject = new Map<string, Promise<void>>()

export class LocalControlServiceError extends Error {
  readonly data: ControlErrorV1

  constructor(data: ControlErrorV1) {
    super(data.message)
    this.name = 'LocalControlServiceError'
    this.data = data
  }
}

const fail = (
  code: ControlErrorV1['code'],
  message: string,
  actionIndex?: number,
  details?: Record<string, string>,
): never => {
  throw new LocalControlServiceError(controlErrorSchemaV1.parse({
    version: 'v1', code, message,
    actionIndex,
    details,
  }))
}

const parse = <Value>(callback: () => Value, message: string) => {
  try {
    return callback()
  } catch {
    return fail('invalid-request', message)
  }
}

const duplicateRecoveryIndex = (actions: readonly { kind: string; recovery?: { id: string } }[]) => {
  const seen = new Set<string>()
  for (const [index, action] of actions.entries()) {
    if (action.kind !== 'recovery.restore' || action.recovery === undefined) continue
    if (seen.has(action.recovery.id)) return index
    seen.add(action.recovery.id)
  }
  return undefined
}

const parseRequest = <Value extends { actions: readonly { kind: string; recovery?: { id: string } }[] }>(
  input: ControlParserInput,
  parser: (value: ControlParserInput) => Value,
  label: string,
) => {
  const request = parse(() => parser(input), `Invalid ${label} request.`)
  const duplicate = duplicateRecoveryIndex(request.actions)
  if (duplicate !== undefined) fail('validation', 'A recovery can only be restored once per request.', duplicate)
  return request
}

const projectSnapshotV1 = (snapshot: ProjectSnapshotV2) => (
  projectSnapshotSchemaV1.parse({
    ...snapshot,
    version: 'v1',
    clips: snapshot.clips.map((clip) => ({
      ...clip,
      midi: clip.midi === undefined ? undefined : {
          wave: clip.midi.wave,
          gain: clip.midi.gain,
          notes: clip.midi.notes.map(({ beat, length, pitch, velocity }) => ({
            beat, length, pitch, velocity,
          })),
        },
    })),
  })
)

const loadedRecoveries = (
  rows: readonly LocalControlRecoveryRow[],
  projectId: string,
  actions: readonly { kind: string; recovery?: { id: string } }[],
  now: number,
) => {
  const wanted = new Set(actions.flatMap((action) => (
    action.kind === 'recovery.restore' && action.recovery ? [action.recovery.id] : []
  )))
  const values = new Map<string, { payload: RecoveryPayload }>()
  for (const row of rows) {
    if (!wanted.has(row.id)) continue
    const parsed = parseLocalControlRecoveryRow(row)
    if (!parsed || parsed.projectId !== projectId || parsed.consumedAt !== undefined || parsed.expiresAt <= now) {
      return fail('not-found', 'Recovery is unavailable.')
    }
    values.set(parsed.id, { payload: parsed.recovery })
  }
  if (values.size !== wanted.size) fail('not-found', 'Recovery is unavailable.')
  return values
}

const plan = (
  snapshot: ControlPlanV1['snapshot'],
  request: Parameters<typeof planControlRequestV1>[1],
  recoveries: ReadonlyMap<string, { payload: RecoveryPayload }>,
) => {
  try {
    return planControlRequestV1(snapshot, request, recoveries)
  } catch (error) {
    const parsedError = controlPlanningErrorSchema.safeParse(error)
    if (parsedError.success) {
      const actionIndex = parsedError.data.actionIndex
      if (parsedError.data.code === 'validation' || parsedError.data.code === 'not-found' || parsedError.data.code === 'limit-exceeded') {
        return fail(parsedError.data.code, parsedError.data.message, actionIndex)
      }
    }
    return fail('internal', 'Control planning failed.')
  }
}

const requestResult = (
  requestDigest: string,
  request: { projectId: string },
  controlPlan: ReturnType<typeof planControlRequestV1>,
) => ({
  version: apiVersion,
  projectId: request.projectId,
  priorRevision: controlPlan.priorRevision,
  revision: controlPlan.revision,
  applied: controlPlan.applied,
  requestDigest,
  resolvedRefs: controlPlan.resolvedRefs,
  warnings: controlPlan.warnings,
  changeSummary: controlPlan.changeSummary,
})

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const parseCommitRow = (value: LocalControlCommitRow): LocalControlCommitRow | undefined => {
  try {
    const row = localControlCommitRowSchema.parse(value)
    const result = controlCommitResultSchemaV1.parse(row.result)
    if (
      result.idempotencyReplay
      || result.projectId !== row.projectId
      || result.requestDigest !== row.requestDigest
      || result.priorRevision !== row.priorRevision
      || result.revision !== row.revision
      || result.applied !== row.applied
    ) return undefined
    return {
      id: row.id, version: 1, projectId: row.projectId, createdAt: row.createdAt,
      actorSubject: row.actorSubject,
      actorIssuer: row.actorIssuer,
      actorTokenIdentifier: row.actorTokenIdentifier,
      actorRole: 'owner', idempotencyKey: value.idempotencyKey, requestDigest: value.requestDigest,
      result, priorRevision: row.priorRevision, revision: row.revision,
      applied: row.applied, status: 'completed',
    }
  } catch {
    return undefined
  }
}

const parseApprovalRow = (value: LocalControlApprovalRow): LocalControlApprovalRow | undefined => {
  const row = localControlApprovalRowSchema.safeParse(value)
  if (!row.success) return undefined
  return {
    id: row.data.id,
    version: 1,
    projectId: row.data.projectId,
    expiresAt: row.data.expiresAt,
    createdAt: row.data.createdAt,
    actorSubject: row.data.actorSubject,
    requestDigest: row.data.requestDigest,
    baseRevision: row.data.baseRevision,
    actionIndexes: [...row.data.actionIndexes],
    tokenHash: row.data.tokenHash,
    consumedAt: row.data.consumedAt,
  }
}

const serviceOperation = async <Value>(
  callback: () => Promise<Value>,
  isAvailabilityFailure?: (error: ErrorInput) => boolean,
): Promise<Value> => {
  try {
    return await callback()
  } catch (error) {
    if (isAvailabilityFailure?.(error)) throw error
    if (error instanceof LocalControlServiceError) throw error
    if (error instanceof LocalControlTransactionError) {
      if (error.kind === 'not-found') return fail('not-found', 'Local project was not found.')
      if (error.kind === 'limit-exceeded') {
        return fail('limit-exceeded', 'Local control retention exceeded its safety ceiling.')
      }
      return fail('internal', 'Local control state is malformed.')
    }
    const parsedError = controlPlanningErrorSchema.safeParse(error)
    if (parsedError.success) {
      const actionIndex = parsedError.data.actionIndex
      if (parsedError.data.code === 'validation' || parsedError.data.code === 'not-found' || parsedError.data.code === 'limit-exceeded') {
        return fail(parsedError.data.code, parsedError.data.message, actionIndex)
      }
    }
    return fail('internal', 'Local control operation failed.')
  }
}

const runAssetGcMaintenance = (
  projectId: string,
  removeAssetFile?: typeof removeLocalAssetFileUnlocked,
) => {
  const existing = maintenanceByProject.get(projectId)
  if (existing) return existing
  const maintenance = runLocalControlAssetGc(projectId, { removeAssetFile })
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      if (maintenanceByProject.get(projectId) === maintenance) maintenanceByProject.delete(projectId)
    })
  maintenanceByProject.set(projectId, maintenance)
  return maintenance
}

const validateProjectedAssetGcLimit = (
  assetGcCount: number,
  controlPlan: ReturnType<typeof planControlRequestV1>,
  actions: readonly { kind: string; recovery?: { id: string } }[],
  recoveries: ReadonlyMap<string, { payload: RecoveryPayload }>,
) => {
  const additions = controlPlan.actions.filter((entry) => (
    entry.changed && entry.action.kind === 'asset.delete'
  )).length
  const removals = controlPlan.actions.filter((entry) => {
    if (!entry.changed || entry.action.kind !== 'recovery.restore') return false
    const recovery = actions[entry.actionIndex]?.recovery
    return recovery !== undefined && recoveries.get(recovery.id)?.payload.kind === 'asset.delete'
  }).length
  if (assetGcCount + additions - removals > assetGcJobLimit) {
    fail('limit-exceeded', 'Local control asset GC limit exceeded.')
  }
}

const isRecoverableAction = (action: Parameters<typeof planControlRequestV1>[1]['actions'][number]) => (
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

const validateLocalDestructivePreflight = (
  context: Parameters<Parameters<typeof withLocalControlTransaction>[2]>[0],
  request: { projectId: string; actions: Parameters<typeof planControlRequestV1>[1]['actions'] },
  controlPlan: ReturnType<typeof planControlRequestV1>,
  recoveries: ReadonlyMap<string, { payload: RecoveryPayload }>,
  actorSubject: string,
) => {
  validateProjectedAssetGcLimit(context.rows.assetGc.length, controlPlan, request.actions, recoveries)
  const plannedRefs = new Map(controlPlan.resolvedRefs.map((ref) => [ref.clientRef, ref.id]))
  try {
    const restoredRecoveries = new Map<string, { payload: RecoveryPayload }>()
    planControlRequestV1(context.snapshot, request, recoveries, {
      onActionPlanned: (entry) => {
        if (!entry.changed) return
        const action = entry.action
        if (action.kind === 'recovery.restore') {
          const gc = context.rows.assetGc.find((row) => row.recoveryId === action.recovery.id)
          if (gc?.claimedAt !== undefined && gc.claimedAt > Date.now() - localControlAssetGcLeaseMs) {
            fail('validation', 'Recovery asset bytes are being deleted.', entry.actionIndex)
          }
          const recovery = recoveries.get(action.recovery.id)
          if (recovery) restoredRecoveries.set(action.recovery.id, recovery)
          return
        }
        if (!isRecoverableAction(action)) return
        // Recovery capture must see the same reference form that the executor
        // will use after resolving client references, without allocating rows.
        const rewrittenAction = rewriteLocalControlActionReferences(action, new Map(), plannedRefs)
        const payload = captureLocalRecoveryPayload({
          projectId: request.projectId,
          actorSubject,
          action: rewrittenAction,
          actionIndex: entry.actionIndex,
          snapshot: projectSnapshotSchemaV2.parse({ ...entry.beforeSnapshot, version: 'v2' }),
          assets: resolveLocalRecoveryAssets(
            projectSnapshotSchemaV2.parse({ ...entry.beforeSnapshot, version: 'v2' }),
            context.rows.assets,
            restoredRecoveries,
          ),
        })
        if (payload !== undefined) {
          serializeLocalRecoveryPayload(payload)
          return
        }
        fail('limit-exceeded', 'Recovery payload cannot be captured.', entry.actionIndex)
      },
    })
  } catch (error) {
    if (error instanceof LocalControlServiceError) throw error
    fail('limit-exceeded', 'Recovery payload exceeds recovery limits.')
  }
}

const prune = (
  context: Parameters<Parameters<typeof withLocalControlTransaction>[2]>[0],
  projectId: string,
  actorSubject: string,
  currentCommitId?: string,
  pendingRecoveries: readonly LocalControlRecoveryRow[] = [],
  pendingAssetGcRecoveryIds: ReadonlySet<string> = new Set(),
  consumedRecoveryIds: ReadonlySet<string> = new Set(),
) => {
  const now = Date.now()
  const commits = context.rows.commits.filter((row) => row.projectId === projectId)
  if (commits.length > 2049 || context.rows.approvals.length > 129 || context.rows.recoveries.length > 2049) {
    fail('limit-exceeded', 'Local control retention exceeded its safety ceiling.')
  }
  for (const row of commits) {
    const parsed = parseCommitRow(row)
    if (!parsed && row.actorSubject === actorSubject) fail('internal', 'Control commit ledger is malformed.')
    if (row.createdAt < now - commitLifetimeMs && row.id !== currentCommitId) context.remove.commit(row.id)
  }
  const retained = commits
    .filter((row) => row.createdAt >= now - commitLifetimeMs && row.id !== currentCommitId)
    .sort(compareNewest)
  for (const row of retained.slice(999)) context.remove.commit(row.id)

  for (const row of context.rows.approvals) {
    const parsed = parseApprovalRow(row)
    if (!parsed) {
      if (row.projectId === projectId) fail('internal', 'Control approval retention is malformed.')
      continue
    }
    if (parsed.projectId === projectId && (parsed.expiresAt <= now || parsed.consumedAt !== undefined)) {
      context.remove.approval(parsed.id)
    }
  }
  const recoveries = context.rows.recoveries.filter((row) => row.projectId === projectId)
  const assetGcRecoveryIds = new Set(context.rows.assetGc.map((row) => row.recoveryId))
  for (const id of pendingAssetGcRecoveryIds) assetGcRecoveryIds.add(id)
  for (const id of consumedRecoveryIds) assetGcRecoveryIds.delete(id)
  for (const row of recoveries) {
    const parsed = parseLocalControlRecoveryRow(row)
    if (!parsed) {
      if (row.actorSubject === actorSubject) fail('internal', 'Control recovery retention is malformed.')
      continue
    }
    if ((parsed.expiresAt <= now || parsed.consumedAt !== undefined) && !assetGcRecoveryIds.has(parsed.id)) {
      context.remove.recovery(parsed.id)
    }
  }
  const active = [...recoveries, ...pendingRecoveries]
    .filter((row) => !consumedRecoveryIds.has(row.id))
    .filter((row) => {
      const parsed = parseLocalControlRecoveryRow(row)
      return parsed !== undefined && parsed.expiresAt > now && parsed.consumedAt === undefined
    })
    .sort(compareNewest)
  const existingRecoveryIds = new Set(recoveries.map((row) => row.id))
  const retainWithin = (
    activeRows: readonly LocalControlRecoveryRow[],
    cap: number,
  ) => {
    const protectedCount = activeRows.filter((row) => assetGcRecoveryIds.has(row.id)).length
    const excess = activeRows.length - cap
    if (protectedCount > cap || excess <= 0) {
      if (protectedCount <= cap) return
      fail('limit-exceeded', 'Local control retention exceeded its safety ceiling.')
    }
    const candidates = activeRows
      .filter((row) => !assetGcRecoveryIds.has(row.id) && existingRecoveryIds.has(row.id))
    if (candidates.length < excess) {
      fail('limit-exceeded', 'Local control retention exceeded its safety ceiling.')
    }
    for (const row of candidates.slice(-excess)) context.remove.recovery(row.id)
  }
  retainWithin(active, 1000)
  const actorActive = active.filter((row) => row.actorSubject === actorSubject)
  retainWithin(actorActive, 128)
}

export const createLocalControlService = (input: {
  actor: { subject: string; issuer?: string; tokenIdentifier?: string }
  projectId?: string
  assertAvailable?: () => void
  excludePendingWriteKinds?: readonly PendingWriteKind[]
  removeAssetFile?: typeof removeLocalAssetFileUnlocked
}) => {
  if (
    !isBoundedText(input.actor.subject)
    || input.actor.issuer !== undefined && !isBoundedText(input.actor.issuer)
    || input.actor.tokenIdentifier !== undefined && !isBoundedText(input.actor.tokenIdentifier)
  ) {
    fail('authorization', 'Local control actor subject is invalid.')
  }
  const actor = input.actor
  const availabilityFailures = new WeakSet<object>()
  const availabilityFailureSchema = z.custom<object>((value) => value === Object(value))
  const assertAvailable = () => {
    try {
      input.assertAvailable?.()
    } catch (error) {
      const availabilityFailure = availabilityFailureSchema.safeParse(error)
      if (availabilityFailure.success) availabilityFailures.add(availabilityFailure.data)
      throw error
    }
  }
  const isAvailabilityFailure = (error: ErrorInput) => {
    const availabilityFailure = availabilityFailureSchema.safeParse(error)
    return availabilityFailure.success && availabilityFailures.has(availabilityFailure.data)
  }
  const withTransaction = async <Value>(
    projectId: string,
    callback: (context: LocalControlTransactionResult) => Value,
  ) => {
    await flushLocalProjectPendingWrites(projectId, {
      excludeKinds: input.excludePendingWriteKinds,
    })
    assertAvailable()
    return await withLocalControlTransactionOptions(
      projectId,
      callback,
      {
        excludePendingWriteKinds: input.excludePendingWriteKinds,
        flushPendingWrites: false,
      },
    )
  }
  const preview = async (inputValue: JsonValue) => {
    const request = parseRequest(inputValue, parseControlPreviewRequestV1, 'control preview')
    const requestDigest = controlRequestDigestSyncV1(request)
    assertAvailable()
    return withTransaction(request.projectId, (context) => {
      assertAvailable()
      if (request.expectedRevision !== undefined && request.expectedRevision !== context.snapshot.project.revision) {
        fail('revision-conflict', 'Project revision does not match the expected revision.')
      }
      const controlPlan = plan(context.snapshot, request, loadedRecoveries(
        context.rows.recoveries, request.projectId, request.actions, Date.now(),
      ))
      return controlPreviewResultSchemaV1.parse({
        ...requestResult(requestDigest, request, controlPlan),
        approval: controlApprovalRequirementV1(controlPlan, requestDigest),
      })
    })
  }

  const requestApproval = async (inputValue: JsonValue) => {
    const request = parseRequest(inputValue, parseControlApprovalRequestV1, 'control approval')
    const requestDigest = controlRequestDigestSyncV1(request)
    assertAvailable()
    return withTransaction(request.projectId, (context) => {
      assertAvailable()
      if (request.expectedRevision !== undefined && request.expectedRevision !== context.snapshot.project.revision) {
        fail('revision-conflict', 'Project revision does not match the expected revision.')
      }
      const controlPlan = plan(context.snapshot, request, loadedRecoveries(
        context.rows.recoveries, request.projectId, request.actions, Date.now(),
      ))
      validateLocalDestructivePreflight(
        context,
        request,
        controlPlan,
        loadedRecoveries(context.rows.recoveries, request.projectId, request.actions, Date.now()),
        actor.subject,
      )
      const requirement = controlApprovalRequirementV1(controlPlan, requestDigest)
      if (!requirement.required) fail('validation', 'Approval requires a material destructive action.')
      const approvalToken = token()
      const tokenHash = hashApprovalToken(approvalToken)
      const now = Date.now()
      const approvals = context.rows.approvals.map(parseApprovalRow)
      if (approvals.some((row) => row === undefined)) fail('internal', 'Control approval retention is malformed.')
      const active = approvals.flatMap((row) => row !== undefined && row.projectId === request.projectId
        && row.expiresAt > now && row.consumedAt === undefined ? [row] : [])
      if (active.filter((row) => row.actorSubject === actor.subject).length >= 16) {
        fail('limit-exceeded', 'Too many active destructive approvals.')
      }
      if (active.length >= 64) fail('limit-exceeded', 'Project destructive approval retention is full.')
      for (const row of context.rows.approvals) {
        const parsed = parseApprovalRow(row)
        if (parsed?.projectId === request.projectId && (parsed.expiresAt <= now || parsed.consumedAt !== undefined)) {
          context.remove.approval(parsed.id)
        }
      }
      const expiresAt = now + approvalLifetimeMs
      context.write.approval({
        id: `local-approval:${crypto.randomUUID()}`, version: 1, projectId: request.projectId,
        actorSubject: actor.subject, requestDigest, baseRevision: requirement.baseRevision,
        actionIndexes: [...requirement.actionIndexes], tokenHash, createdAt: now, expiresAt,
      })
      return controlApprovalResultSchemaV1.parse({
        version: 'v1', approvalToken, requestDigest, baseRevision: requirement.baseRevision,
        actionIndexes: requirement.actionIndexes, expiresAt,
      })
    })
  }

  const commit = async (inputValue: JsonValue) => {
    const request = parseRequest(inputValue, parseControlCommitRequestV1, 'control commit')
    const requestDigest = controlRequestDigestSyncV1(request)
    const approvalTokenHash = request.approvalToken === undefined
      ? undefined
      : hashApprovalToken(request.approvalToken)
    assertAvailable()
    await flushLocalProjectPendingWrites(request.projectId, {
      excludeKinds: input.excludePendingWriteKinds,
    })
    assertAvailable()
    const outcome = await withLocalProjectAssetLock(request.projectId, () => {
      assertAvailable()
      return withLocalControlTransactionOptions(request.projectId, (context) => {
        assertAvailable()
      const matching = context.rows.commits.filter((row) => (
        row.projectId === request.projectId && row.actorSubject === actor.subject
        && row.idempotencyKey === request.idempotencyKey
      ))
      if (matching.length > 1 || matching.some((row) => !parseCommitRow(row))) {
        fail('internal', 'Control idempotency ledger is malformed.')
      }
      const existing = matching[0]
      if (existing) {
        if (existing.createdAt >= Date.now() - commitLifetimeMs) {
          const parsed = parseCommitRow(existing)
          if (parsed === undefined) return fail('internal', 'Control idempotency ledger is malformed.')
          if (parsed.requestDigest !== requestDigest) {
            fail('idempotency-conflict', 'Idempotency key was already used for a different request.')
          }
          const result = controlCommitResultSchemaV1.parse(parsed.result)
          return { result: controlCommitResultSchemaV1.parse({ ...result, idempotencyReplay: true }), notify: false }
        }
        context.remove.commit(existing.id)
      }
      if (request.expectedRevision !== undefined && request.expectedRevision !== context.snapshot.project.revision) {
        fail('revision-conflict', 'Project revision does not match the expected revision.')
      }
      const recoveries = loadedRecoveries(context.rows.recoveries, request.projectId, request.actions, Date.now())
      const controlPlan = plan(context.snapshot, request, recoveries)
      validateLocalDestructivePreflight(context, request, controlPlan, recoveries, actor.subject)
      const requirement = controlApprovalRequirementV1(controlPlan, requestDigest)
      if (requirement.required) {
        if (approvalTokenHash === undefined) {
          fail('approval-required', 'A valid approval token is required for destructive actions.')
        }
        const approvals = context.rows.approvals.map(parseApprovalRow)
        if (approvals.some((row) => row === undefined)) fail('internal', 'Control approval ledger is malformed.')
        const approval = approvals.find((row) => row?.tokenHash === approvalTokenHash)
        if (!approval || approval.actorSubject !== actor.subject || approval.projectId !== request.projectId
          || approval.requestDigest !== requestDigest || approval.baseRevision !== controlPlan.priorRevision
          || approval.expiresAt <= Date.now() || approval.consumedAt !== undefined
          || approval.actionIndexes.join(',') !== requirement.actionIndexes.join(',')) {
          return fail('approval-required', 'A valid approval token is required for destructive actions.')
        }
        context.write.approval({ ...approval, consumedAt: Date.now() })
      }
      const execution = executeLocalControlRequestInTransactionV1(context, {
        projectId: request.projectId, actions: [...request.actions], actorSubject: actor.subject,
      })
      if (execution.changed !== controlPlan.applied) fail('internal', 'Control execution changed-state mismatch.')
      const result = controlCommitResultSchemaV1.parse({
        ...requestResult(requestDigest, request, controlPlan),
        resolvedRefs: execution.resolvedRefs,
        idempotencyReplay: false,
        recoveries: execution.recoveries,
        restored: execution.restored,
      })
      const commitId = `local-commit:${crypto.randomUUID()}`
      context.write.commit({
        id: commitId, version: 1, projectId: request.projectId, createdAt: Date.now(),
        actorSubject: actor.subject, actorIssuer: actor.issuer,
        actorTokenIdentifier: actor.tokenIdentifier,
        actorRole: 'owner', idempotencyKey: request.idempotencyKey, requestDigest,
        result, priorRevision: result.priorRevision, revision: result.revision,
        applied: result.applied, status: 'completed',
      })
      for (const recovery of execution.recoveryRows) {
        context.write.recovery({ ...recovery, sourceCommitId: commitId })
      }
      prune(
        context,
        request.projectId,
        actor.subject,
        commitId,
        execution.recoveryRows,
        new Set(execution.recoveryRows.flatMap((recovery) => (
          recovery.kind === 'asset.delete' ? [recovery.id] : []
        ))),
        new Set(execution.restored.map((restored) => restored.recoveryId)),
      )
      return { result, notify: result.applied }
      }, {
        excludePendingWriteKinds: input.excludePendingWriteKinds,
        flushPendingWrites: false,
      })
    })
    let gcFinalized = false
    try {
      if (input.excludePendingWriteKinds === undefined) {
        gcFinalized = (await runLocalControlAssetGc(request.projectId, {
          notify: false,
          removeAssetFile: input.removeAssetFile,
        })).finalized
      }
    } catch {}
    if (outcome.notify || gcFinalized) notifyLocalProjectChanged(request.projectId)
    return outcome.result
  }

  const snapshot = async (inputValue: JsonValue) => {
    const request = parse(() => parseControlSnapshotQueryV1(inputValue), 'Invalid control snapshot request.')
    assertAvailable()
    await flushLocalProjectPendingWrites(request.projectId, {
      excludeKinds: input.excludePendingWriteKinds,
    })
    assertAvailable()
    if (input.excludePendingWriteKinds === undefined) {
      await runAssetGcMaintenance(request.projectId, input.removeAssetFile)
    }
    assertAvailable()
    return withTransaction(request.projectId, (context) => {
      assertAvailable()
      return projectSnapshotV1(context.snapshot)
    })
  }
  const snapshotV2 = async (inputValue: JsonValue) => {
    const request = parse(() => parseControlSnapshotQueryV1(inputValue), 'Invalid control snapshot request.')
    assertAvailable()
    await flushLocalProjectPendingWrites(request.projectId, {
      excludeKinds: input.excludePendingWriteKinds,
    })
    assertAvailable()
    if (input.excludePendingWriteKinds === undefined) {
      await runAssetGcMaintenance(request.projectId, input.removeAssetFile)
    }
    assertAvailable()
    return withTransaction(request.projectId, (context) => {
      assertAvailable()
      return projectSnapshotSchemaV2.parse(context.snapshot)
    })
  }

  const page = async (inputValue: JsonValue, kind: 'history' | 'recoveries') => {
    const request = parse(() => (
      kind === 'history' ? parseControlHistoryQueryV1(inputValue) : parseControlRecoveriesQueryV1(inputValue)
    ), `Invalid ${kind} request.`)
    const cursor = parse(() => parseLocalControlCursor(request.cursor, kind), `Invalid ${kind} cursor.`)
    assertAvailable()
    await flushLocalProjectPendingWrites(request.projectId, {
      excludeKinds: input.excludePendingWriteKinds,
    })
    assertAvailable()
    if (input.excludePendingWriteKinds === undefined) {
      await runAssetGcMaintenance(request.projectId, input.removeAssetFile)
    }
    assertAvailable()
    return withTransaction(request.projectId, (context) => {
      assertAvailable()
      if (kind === 'history') {
        const rows = context.rows.commits.filter((row) => row.projectId === request.projectId).sort(compareNewest)
        const filtered = cursor === undefined ? rows : rows.filter((row) => (
          row.createdAt < cursor.createdAt || row.createdAt === cursor.createdAt && row.id < cursor.id
        ))
        const entries = filtered.slice(0, request.limit).map((row) => {
          const parsed = parseCommitRow(row)
          if (!parsed) return fail('internal', 'Control history is malformed.')
          const result = controlCommitResultSchemaV1.parse(parsed.result)
          return controlHistoryEntrySchemaV1.parse({
            id: parsed.id, projectId: parsed.projectId, actorSubject: parsed.actorSubject,
            actorIssuer: parsed.actorIssuer,
            actorTokenIdentifier: parsed.actorTokenIdentifier,
            actorRole: parsed.actorRole, idempotencyKey: parsed.idempotencyKey,
            requestDigest: parsed.requestDigest, priorRevision: parsed.priorRevision,
            revision: parsed.revision, applied: parsed.applied, createdAt: parsed.createdAt,
            recoveries: result.recoveries, restored: result.restored,
          })
        })
        const last = entries.at(-1)
        const isDone = filtered.length <= entries.length
        return controlHistoryResultSchemaV1.parse({
          entries, isDone,
          continueCursor: encodeLocalControlCursor({
            version: 1, kind, createdAt: last?.createdAt ?? cursor?.createdAt ?? 0,
            id: last?.id ?? cursor?.id ?? 'terminal', terminal: isDone ? true : undefined,
          }),
        })
      }
      const now = Date.now()
      const rows = context.rows.recoveries
        .filter((row) => row.projectId === request.projectId && row.consumedAt === undefined && row.expiresAt > now)
        .sort(compareNewest)
      const filtered = cursor === undefined ? rows : rows.filter((row) => (
        row.createdAt < cursor.createdAt || row.createdAt === cursor.createdAt && row.id < cursor.id
      ))
      const entries = filtered.slice(0, request.limit).map((row) => {
        const parsed = parseLocalControlRecoveryRow(row)
        if (!parsed) return fail('internal', 'Recovery history is malformed.')
        return {
          actionIndex: parsed.sourceActionIndex, id: parsed.id, kind: parsed.kind,
          expiresAt: parsed.expiresAt, createdAt: parsed.createdAt,
        }
      })
      const last = entries.at(-1)
      const isDone = filtered.length <= entries.length
      return controlRecoveriesResultSchemaV1.parse({
        entries: entries.map(({ createdAt: _createdAt, ...entry }) => entry), isDone,
        continueCursor: encodeLocalControlCursor({
          version: 1, kind, createdAt: last?.createdAt ?? cursor?.createdAt ?? 0,
          id: last?.id ?? cursor?.id ?? 'terminal', terminal: isDone ? true : undefined,
        }),
      })
    })
  }

  return {
    capabilities: () => localControlCapabilitiesV1,
    capabilitiesV2: () => localControlCapabilitiesV2,
    snapshot: (inputValue: JsonValue) => serviceOperation(() => snapshot(inputValue), isAvailabilityFailure),
    snapshotV2: (inputValue: JsonValue) => serviceOperation(() => snapshotV2(inputValue), isAvailabilityFailure),
    preview: (inputValue: JsonValue) => serviceOperation(() => preview(inputValue), isAvailabilityFailure),
    commit: (inputValue: JsonValue) => serviceOperation(() => commit(inputValue), isAvailabilityFailure),
    requestApproval: (inputValue: JsonValue) => serviceOperation(() => requestApproval(inputValue), isAvailabilityFailure),
    history: (inputValue: JsonValue) => serviceOperation(() => page(inputValue, 'history'), isAvailabilityFailure),
    recoveries: (inputValue: JsonValue) => serviceOperation(() => page(inputValue, 'recoveries'), isAvailabilityFailure),
  }
}
