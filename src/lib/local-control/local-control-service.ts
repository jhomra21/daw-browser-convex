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
  parseControlApprovalRequestV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlRecoveriesQueryV1,
  parseControlSnapshotQueryV1,
  planControlRequestV1,
  projectSnapshotSchemaV1,
  type ControlErrorV1,
  type ControlPlanV1,
  type RecoveryPayloadV1,
} from '@daw-browser/control'
import { sha256 } from '@noble/hashes/sha2.js'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import type {
  LocalControlApprovalRow,
  LocalControlCommitRow,
  LocalControlRecoveryRow,
} from '~/lib/local-project-db'
import { withLocalProjectAssetLock } from '~/lib/local-project-asset-lock'
import { executeLocalControlRequestInTransactionV1 } from './local-control-execution'
import { runLocalControlAssetGc } from './local-control-asset-gc'
import { parseLocalControlCursor, encodeLocalControlCursor } from './local-control-cursor'
import { parseLocalControlRecoveryRow } from './local-control-rows'
import { LocalControlTransactionError, withLocalControlTransaction } from './local-control-state'

const commitLifetimeMs = 90 * 24 * 60 * 60 * 1_000
const approvalLifetimeMs = 10 * 60 * 1_000
const apiVersion = 'v1'
const hashApprovalToken = (value: string) => (
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
)
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const compareNewest = (left: { createdAt: number; id: string }, right: { createdAt: number; id: string }) => (
  right.createdAt - left.createdAt || right.id.localeCompare(left.id)
)
const isBoundedText = (value: unknown) => typeof value === 'string' && value.length >= 1 && value.length <= 256
const isNonnegativeInteger = (value: unknown) => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)
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
    ...(actionIndex === undefined ? {} : { actionIndex }),
    ...(details === undefined ? {} : { details }),
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
  input: unknown,
  parser: (value: unknown) => Value,
  label: string,
) => {
  const request = parse(() => parser(input), `Invalid ${label} request.`)
  const duplicate = duplicateRecoveryIndex(request.actions)
  if (duplicate !== undefined) fail('validation', 'A recovery can only be restored once per request.', duplicate)
  return request
}

const loadedRecoveries = (
  rows: readonly LocalControlRecoveryRow[],
  projectId: string,
  actions: readonly { kind: string; recovery?: { id: string } }[],
  now: number,
) => {
  const wanted = new Set(actions.flatMap((action) => (
    action.kind === 'recovery.restore' && action.recovery ? [action.recovery.id] : []
  )))
  const values = new Map<string, { payload: RecoveryPayloadV1 }>()
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
  recoveries: ReadonlyMap<string, { payload: RecoveryPayloadV1 }>,
) => {
  try {
    return planControlRequestV1(snapshot, request, recoveries)
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      const actionIndex = typeof error.actionIndex === 'number' ? error.actionIndex : undefined
      if (error.code === 'validation' || error.code === 'not-found' || error.code === 'limit-exceeded') {
        return fail(error.code, error.message, actionIndex)
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

const parseCommitRow = (value: unknown): LocalControlCommitRow | undefined => {
  if (!isRecord(value) || value.version !== 1 || value.status !== 'completed'
    || typeof value.id !== 'string' || typeof value.projectId !== 'string'
    || typeof value.createdAt !== 'number' || !isNonnegativeInteger(value.createdAt)
    || typeof value.actorSubject !== 'string' || !isBoundedText(value.actorSubject)
    || (value.actorIssuer !== undefined && (typeof value.actorIssuer !== 'string' || !isBoundedText(value.actorIssuer)))
    || (value.actorTokenIdentifier !== undefined && (typeof value.actorTokenIdentifier !== 'string' || !isBoundedText(value.actorTokenIdentifier)))
    || value.actorRole !== 'owner' || typeof value.idempotencyKey !== 'string'
    || typeof value.requestDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.requestDigest)
    || typeof value.priorRevision !== 'number' || !isNonnegativeInteger(value.priorRevision)
    || typeof value.revision !== 'number' || !isNonnegativeInteger(value.revision)
    || typeof value.applied !== 'boolean') return undefined
  try {
    const result = controlCommitResultSchemaV1.parse(value.result)
    if (
      result.idempotencyReplay
      || result.projectId !== value.projectId
      || result.requestDigest !== value.requestDigest
      || result.priorRevision !== value.priorRevision
      || result.revision !== value.revision
      || result.applied !== value.applied
    ) return undefined
    return {
      id: value.id, version: 1, projectId: value.projectId, createdAt: value.createdAt,
      actorSubject: value.actorSubject,
      ...(value.actorIssuer === undefined ? {} : { actorIssuer: value.actorIssuer }),
      ...(value.actorTokenIdentifier === undefined ? {} : { actorTokenIdentifier: value.actorTokenIdentifier }),
      actorRole: 'owner', idempotencyKey: value.idempotencyKey, requestDigest: value.requestDigest,
      result, priorRevision: value.priorRevision, revision: value.revision,
      applied: value.applied, status: 'completed',
    }
  } catch {
    return undefined
  }
}

const parseApprovalRow = (value: unknown): LocalControlApprovalRow | undefined => {
  if (
    !isRecord(value) || value.version !== 1 || typeof value.id !== 'string'
    || typeof value.projectId !== 'string' || typeof value.expiresAt !== 'number' || !isNonnegativeInteger(value.expiresAt)
    || typeof value.createdAt !== 'number' || !isNonnegativeInteger(value.createdAt)
    || typeof value.actorSubject !== 'string' || !isBoundedText(value.actorSubject)
    || typeof value.requestDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.requestDigest)
    || typeof value.baseRevision !== 'number' || !isNonnegativeInteger(value.baseRevision) || !Array.isArray(value.actionIndexes)
    || value.actionIndexes.length === 0 || value.actionIndexes.some((index) => !isNonnegativeInteger(index))
    || typeof value.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.tokenHash)
    || value.consumedAt !== undefined && (typeof value.consumedAt !== 'number' || !isNonnegativeInteger(value.consumedAt))
  ) return undefined
  return {
    id: value.id,
    version: 1,
    projectId: value.projectId,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    actorSubject: value.actorSubject,
    requestDigest: value.requestDigest,
    baseRevision: value.baseRevision,
    actionIndexes: [...value.actionIndexes],
    tokenHash: value.tokenHash,
    ...(value.consumedAt === undefined ? {} : { consumedAt: value.consumedAt }),
  }
}

const serviceOperation = async <Value>(callback: () => Promise<Value>): Promise<Value> => {
  try {
    return await callback()
  } catch (error) {
    if (error instanceof LocalControlServiceError) throw error
    if (error instanceof LocalControlTransactionError) {
      if (error.kind === 'not-found') return fail('not-found', 'Local project was not found.')
      if (error.kind === 'limit-exceeded') {
        return fail('limit-exceeded', 'Local control retention exceeded its safety ceiling.')
      }
      return fail('internal', 'Local control state is malformed.')
    }
    if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
      const actionIndex = typeof error.actionIndex === 'number' ? error.actionIndex : undefined
      if (error.code === 'validation' || error.code === 'not-found' || error.code === 'limit-exceeded') {
        return fail(error.code, error.message, actionIndex)
      }
    }
    return fail('internal', 'Local control operation failed.')
  }
}

const runAssetGcMaintenance = (projectId: string) => {
  const existing = maintenanceByProject.get(projectId)
  if (existing) return existing
  const maintenance = runLocalControlAssetGc(projectId)
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
  recoveries: ReadonlyMap<string, { payload: RecoveryPayloadV1 }>,
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
      if (isRecord(row) && row.projectId === projectId) fail('internal', 'Control approval retention is malformed.')
      continue
    }
    if (parsed.projectId === projectId && (parsed.expiresAt <= now || parsed.consumedAt !== undefined)) {
      context.remove.approval(parsed.id)
    }
  }
  const recoveries = context.rows.recoveries.filter((row) => row.projectId === projectId)
  const assetGcRecoveryIds = new Set(context.rows.assetGc.flatMap((row) => (
    typeof row.recoveryId === 'string' ? [row.recoveryId] : []
  )))
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
}) => {
  if (
    !isBoundedText(input.actor.subject)
    || input.actor.issuer !== undefined && !isBoundedText(input.actor.issuer)
    || input.actor.tokenIdentifier !== undefined && !isBoundedText(input.actor.tokenIdentifier)
  ) {
    fail('authorization', 'Local control actor subject is invalid.')
  }
  const actor = input.actor
  if (input.projectId !== undefined) void runAssetGcMaintenance(input.projectId)

  const preview = async (inputValue: unknown) => {
    const request = parseRequest(inputValue, parseControlPreviewRequestV1, 'control preview')
    const requestDigest = controlRequestDigestSyncV1(request)
    return withLocalControlTransaction(request.projectId, 'readwrite', (context) => {
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

  const requestApproval = async (inputValue: unknown) => {
    const request = parseRequest(inputValue, parseControlApprovalRequestV1, 'control approval')
    const approvalToken = token()
    const tokenHash = hashApprovalToken(approvalToken)
    const requestDigest = controlRequestDigestSyncV1(request)
    return withLocalControlTransaction(request.projectId, 'readwrite', (context) => {
      if (request.expectedRevision !== undefined && request.expectedRevision !== context.snapshot.project.revision) {
        fail('revision-conflict', 'Project revision does not match the expected revision.')
      }
      const controlPlan = plan(context.snapshot, request, loadedRecoveries(
        context.rows.recoveries, request.projectId, request.actions, Date.now(),
      ))
      const requirement = controlApprovalRequirementV1(controlPlan, requestDigest)
      if (!requirement.required) fail('validation', 'Approval requires a material destructive action.')
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

  const commit = async (inputValue: unknown) => {
    const request = parseRequest(inputValue, parseControlCommitRequestV1, 'control commit')
    const requestDigest = controlRequestDigestSyncV1(request)
    const approvalTokenHash = request.approvalToken === undefined
      ? undefined
      : hashApprovalToken(request.approvalToken)
    const outcome = await withLocalProjectAssetLock(request.projectId, () => withLocalControlTransaction(request.projectId, 'readwrite', (context) => {
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
      validateProjectedAssetGcLimit(
        context.rows.assetGc.length,
        controlPlan,
        request.actions,
        recoveries,
      )
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
        actorSubject: actor.subject, ...(actor.issuer === undefined ? {} : { actorIssuer: actor.issuer }),
        ...(actor.tokenIdentifier === undefined ? {} : { actorTokenIdentifier: actor.tokenIdentifier }),
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
    }))
    let gcFinalized = false
    try {
      gcFinalized = (await runLocalControlAssetGc(request.projectId, { notify: false })).finalized
    } catch {}
    if (outcome.notify || gcFinalized) notifyLocalProjectChanged(request.projectId)
    return outcome.result
  }

  const snapshot = async (inputValue: unknown) => {
    const request = parse(() => parseControlSnapshotQueryV1(inputValue), 'Invalid control snapshot request.')
    await runAssetGcMaintenance(request.projectId)
    return withLocalControlTransaction(request.projectId, 'readwrite', (context) => projectSnapshotSchemaV1.parse(context.snapshot))
  }

  const page = async (inputValue: unknown, kind: 'history' | 'recoveries') => {
    const request = parse(() => (
      kind === 'history' ? parseControlHistoryQueryV1(inputValue) : parseControlRecoveriesQueryV1(inputValue)
    ), `Invalid ${kind} request.`)
    const cursor = parse(() => parseLocalControlCursor(request.cursor, kind), `Invalid ${kind} cursor.`)
    await runAssetGcMaintenance(request.projectId)
    return withLocalControlTransaction(request.projectId, 'readwrite', (context) => {
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
            ...(parsed.actorIssuer === undefined ? {} : { actorIssuer: parsed.actorIssuer }),
            ...(parsed.actorTokenIdentifier === undefined ? {} : { actorTokenIdentifier: parsed.actorTokenIdentifier }),
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
            id: last?.id ?? cursor?.id ?? 'terminal', ...(isDone ? { terminal: true } : {}),
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
          id: last?.id ?? cursor?.id ?? 'terminal', ...(isDone ? { terminal: true } : {}),
        }),
      })
    })
  }

  return {
    capabilities: () => localControlCapabilitiesV1,
    snapshot: (inputValue: unknown) => serviceOperation(() => snapshot(inputValue)),
    preview: (inputValue: unknown) => serviceOperation(() => preview(inputValue)),
    commit: (inputValue: unknown) => serviceOperation(() => commit(inputValue)),
    requestApproval: (inputValue: unknown) => serviceOperation(() => requestApproval(inputValue)),
    history: (inputValue: unknown) => serviceOperation(() => page(inputValue, 'history')),
    recoveries: (inputValue: unknown) => serviceOperation(() => page(inputValue, 'recoveries')),
  }
}
