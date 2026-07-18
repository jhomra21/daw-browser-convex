import {
  controlCommitResultSchemaV1,
  controlApprovalResultSchemaV1,
  controlApprovalRequirementV1,
  controlErrorSchemaV1,
  controlHistoryEntrySchemaV1,
  controlHistoryResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRequestDigestInputV1,
  controlRequestDigestV1,
  findDuplicateRecoveryActionIndexV1,
  parseControlHistoryQueryV1,
  parseControlRecoveriesQueryV1,
  assertControlSerializedBodyV1,
  parseControlCommitRequestV1,
  parseControlApprovalRequestV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  planControlRequestV1,
  projectSnapshotSchemaV1,
  type ResolvedRefV1,
} from "@daw-browser/control";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { executeControlPlanV1 } from "./controlExecution";
import { ControlDomainError, preflightControlRequestV1 } from "./controlPreflight";
import { readProjectControlSnapshotV1 } from "./controlSnapshot";
import { getProjectRole, requireAuthenticatedIdentity, requireProjectAccess } from "./projectAccess";
import { advanceProjectRevision } from "./projectRows";
import { loadRecovery } from "./controlRecovery";
import { listProjectTracksWithMixerChannels } from "./mixerChannels";

const maxControlCommitsPerProject = 1000;
const controlCommitMaxAgeMs = 90 * 24 * 60 * 60 * 1000;
const controlCommitPruneBatchSize = 256;
const controlCommitPruneMaxPages = 16;
const controlCommitRetentionSafetyCeiling = 2_048;
const controlApprovalPruneBatchSize = 128;
const maxActiveApprovalsPerActorProject = 16;
const maxActiveApprovalsPerProject = 64;

// Expired or pruned idempotency keys are intentionally no longer replayable.
const pruneControlCommits = async (
  ctx: any,
  projectId: string,
  currentCommitId: unknown,
) => {
  const now = Date.now();
  for (let page = 0; page < controlCommitPruneMaxPages; page += 1) {
    const oldest = await ctx.db
      .query("controlCommits")
      .withIndex("by_project_createdAt", (query: any) => query.eq("projectId", projectId))
      .order("asc")
      .take(controlCommitPruneBatchSize);
    let deleted = 0;
    for (const commit of oldest) {
      if (commit._id === currentCommitId || commit.createdAt >= now - controlCommitMaxAgeMs) continue;
      await ctx.db.delete(commit._id);
      deleted += 1;
    }
    if (deleted === 0 || oldest.length < controlCommitPruneBatchSize) break;
  }
  const newest = await ctx.db
    .query("controlCommits")
    .withIndex("by_project_createdAt", (query: any) => query.eq("projectId", projectId))
    .order("desc")
    .take(controlCommitRetentionSafetyCeiling + 1);
  if (newest.length > controlCommitRetentionSafetyCeiling) {
    throw new Error("Control commit retention exceeded its bounded pruning ceiling.");
  }
  let retained = 0;
  for (const commit of newest) {
    if (commit._id === currentCommitId || retained < maxControlCommitsPerProject - 1) {
      retained += 1;
      continue;
    }
    await ctx.db.delete(commit._id);
  }
}

const failure = (
  code: "invalid-request" | "validation" | "revision-conflict" | "idempotency-conflict" | "forbidden" | "authorization" | "not-found" | "limit-exceeded" | "approval-required" | "internal",
  message: string,
  actionIndex?: number,
  details?: Record<string, string>,
): never => {
  throw new ConvexError(controlErrorSchemaV1.parse({
    version: "v1",
    code,
    message,
    ...(actionIndex === undefined ? {} : { actionIndex }),
    ...(details === undefined ? {} : { details }),
  }))
}

const parsePreview = (input: unknown) => {
  let parsed: ReturnType<typeof parseControlPreviewRequestV1>
  try {
    parsed = parseControlPreviewRequestV1(input)
  } catch {
    return failure("invalid-request", "Invalid control preview request.")
  }
  const duplicate = findDuplicateRecoveryActionIndexV1(parsed.actions)
  if (duplicate !== undefined) failure("validation", "A recovery can only be restored once per request.", duplicate)
  return parsed
}

const parseCommit = (input: unknown) => {
  let parsed: ReturnType<typeof parseControlCommitRequestV1>
  try {
    parsed = parseControlCommitRequestV1(input)
  } catch {
    return failure("invalid-request", "Invalid control commit request.")
  }
  const duplicate = findDuplicateRecoveryActionIndexV1(parsed.actions)
  if (duplicate !== undefined) failure("validation", "A recovery can only be restored once per request.", duplicate)
  return parsed
}

const parseApproval = (input: unknown) => {
  let parsed: ReturnType<typeof parseControlApprovalRequestV1>
  try {
    parsed = parseControlApprovalRequestV1(input)
  } catch {
    return failure("invalid-request", "Invalid control approval request.")
  }
  const duplicate = findDuplicateRecoveryActionIndexV1(parsed.actions)
  if (duplicate !== undefined) failure("validation", "A recovery can only be restored once per request.", duplicate)
  return parsed
}

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const approvalToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const approvalError = (requirement: ReturnType<typeof controlApprovalRequirementV1>) => (
  failure("approval-required", "A valid approval token is required for destructive actions.", undefined, {
    actionIndexes: requirement.actionIndexes.join(","),
    actionKinds: requirement.actionKinds.join(","),
    baseRevision: String(requirement.baseRevision),
    requestDigest: requirement.requestDigest,
    impact: JSON.stringify(requirement.impact),
  })
)

const pruneApprovals = async (ctx: any, projectId: string, actorSubject: string) => {
  const now = Date.now()
  const expired = await ctx.db.query("controlApprovals")
    .withIndex("by_project_expiresAt", (query: any) => query.eq("projectId", projectId).lte("expiresAt", now))
    .take(controlApprovalPruneBatchSize)
  for (const approval of expired) await ctx.db.delete(approval._id)
  const projectRows = await ctx.db.query("controlApprovals")
    .withIndex("by_project_createdAt", (query: any) => query.eq("projectId", projectId))
    .order("asc")
    .take(controlApprovalPruneBatchSize)
  for (const approval of projectRows) {
    if (approval.consumedAt !== undefined) await ctx.db.delete(approval._id)
  }
  const actorRows = await ctx.db.query("controlApprovals")
    .withIndex("by_project_actor_createdAt", (query: any) => query.eq("projectId", projectId).eq("actorSubject", actorSubject))
    .order("asc")
    .take(maxActiveApprovalsPerActorProject)
  if (actorRows.length >= maxActiveApprovalsPerActorProject) failure("limit-exceeded", "Too many active destructive approvals.")
  const activeRows = await ctx.db.query("controlApprovals")
    .withIndex("by_project_createdAt", (query: any) => query.eq("projectId", projectId))
    .order("asc")
    .take(maxActiveApprovalsPerProject)
  if (activeRows.length >= maxActiveApprovalsPerProject) {
    failure("limit-exceeded", "Project destructive approval retention is full.")
  }
}

const parseSnapshotQuery = (input: unknown) => {
  try {
    return parseControlSnapshotQueryV1(input)
  } catch {
    return failure("invalid-request", "Invalid control snapshot request.")
  }
}

const parseHistoryQuery = (input: unknown) => {
  try {
    return parseControlHistoryQueryV1(input)
  } catch {
    return failure("invalid-request", "Invalid control history request.")
  }
}
const parseRecoveriesQuery = (input: unknown) => {
  try {
    return parseControlRecoveriesQueryV1(input)
  } catch {
    return failure("invalid-request", "Invalid recovery list request.")
  }
}

const paginateControlHistory = async (
  ctx: any,
  projectId: string,
  limit: number,
  cursor: string | undefined,
) => {
  const query = ctx.db
    .query("controlCommits")
    .withIndex("by_project_createdAt", (index: any) => index.eq("projectId", projectId))
    .order("desc")
  try {
    return await query.paginate({ numItems: limit, cursor: cursor ?? null })
  } catch {
    return failure("invalid-request", "Invalid control history cursor.")
  }
}
const paginateRecoveries = async (ctx: any, projectId: string, limit: number, cursor: string | undefined) => {
  try {
    return await ctx.db.query("controlRecoveries")
      .withIndex("by_project_createdAt", (index: any) => index.eq("projectId", projectId))
      .order("desc")
      .paginate({ numItems: limit, cursor: cursor ?? null })
  } catch {
    return failure("invalid-request", "Invalid recovery list cursor.")
  }
}

const boundedActorClaim = (value: string) => {
  if (value.length > 0 && value.length <= 256) return value
  return failure("authorization", "Authenticated identity claims are invalid.")
}

const controlActor = (identity: Awaited<ReturnType<typeof requireAuthenticatedIdentity>>) => ({
  subject: boundedActorClaim(identity.subject),
  issuer: boundedActorClaim(identity.dawControlActorIssuer ?? identity.issuer),
  tokenIdentifier: boundedActorClaim(identity.dawControlActorTokenIdentifier ?? identity.tokenIdentifier),
})

const plan = (
  snapshot: Parameters<typeof planControlRequestV1>[0],
  request: Parameters<typeof planControlRequestV1>[1],
  recoveries: ReadonlyMap<string, { payload: { kind: string; data: any } }> = new Map(),
) => {
  try {
    return planControlRequestV1(snapshot, request, recoveries)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error && "actionIndex" in error) {
      const value = error
      if (value.code === "validation" || value.code === "not-found") {
        return failure(value.code, String(value.message), typeof value.actionIndex === "number" ? value.actionIndex : undefined)
      }
    }
    return failure("internal", "Control planning failed.")
  }
}

const result = (
  requestDigest: string,
  request: { projectId: string },
  controlPlan: ReturnType<typeof planControlRequestV1>,
  idempotencyReplay: boolean,
  resolvedRefs: ResolvedRefV1[] = controlPlan.resolvedRefs,
  recoveries: Array<{ actionIndex: number; id: string; kind: string; expiresAt: number }> = [],
  restored: Array<{ actionIndex: number; recoveryId: string; entities: any[] }> = [],
) => controlCommitResultSchemaV1.parse({
  version: "v1",
  projectId: request.projectId,
  priorRevision: controlPlan.priorRevision,
  revision: controlPlan.revision,
  applied: controlPlan.applied,
  requestDigest,
  resolvedRefs,
  warnings: controlPlan.warnings,
  changeSummary: controlPlan.changeSummary,
  idempotencyReplay,
  recoveries,
  restored,
})

const requestedRecoveries = async (ctx: any, request: { projectId: string; actions: any[] }) => {
  const entries = await Promise.all(request.actions.flatMap((action) => (
    action.kind === "recovery.restore"
      ? [loadRecovery(ctx, { projectId: request.projectId, id: action.recovery.id })]
      : []
  )))
  return new Map(entries.map((entry) => [String(entry.row._id), entry]));
}

const recoveryTrackIds = (recovery: any): string[] => {
  const data = recovery.payload.data
  if (recovery.payload.kind === "clip.delete") return [String(data.clip.trackId)]
  if (recovery.payload.kind === "automation.delete") return data.automation.trackId ? [String(data.automation.trackId)] : []
  if (recovery.payload.kind === "sidechain.remove") return [String(data.sidechain.sourceTrackId), String(data.sidechain.targetTrackId)]
  if (recovery.payload.kind === "asset.delete") return []
  return [
    ...(data.effects?.flatMap((item: any) => item.effect.target.kind === "track" ? [item.effect.target.trackId] : []) ?? []),
    ...(data.automation?.flatMap((item: any) => item.automation.trackId === undefined ? [] : [item.automation.trackId]) ?? []),
    ...(data.sidechains?.flatMap((item: any) => [item.sidechain.sourceTrackId, item.sidechain.targetTrackId]) ?? []),
  ]
}

const preflightRecoveryLocks = async (
  ctx: any,
  input: { projectId: string; actorId: string; actions: any[]; recoveries: Map<string, any> },
) => {
  const tracks = await listProjectTracksWithMixerChannels(ctx, input.projectId)
  const locks = new Map(tracks.map((track) => [String(track._id), track.lockedBy]))
  for (const [actionIndex, action] of input.actions.entries()) {
    if (action.kind !== "recovery.restore") continue
    for (const trackId of new Set(recoveryTrackIds(input.recoveries.get(action.recovery.id)))) {
      const lockedBy = locks.get(trackId)
      if (lockedBy && lockedBy !== input.actorId) {
        throw new ControlDomainError("forbidden", "Affected track is locked by another user.", actionIndex, { trackId, lockedBy })
      }
    }
  }
}

export const previewV1 = query({
  args: { request: v.any() },
  handler: async (ctx, { request }) => {
    const parsed = parsePreview(request)
    let userId: string
    try {
      userId = (await requireAuthenticatedIdentity(ctx)).subject
    } catch {
      return failure("authorization", "Authentication is required.")
    }
    try {
      await preflightControlRequestV1(ctx, { projectId: parsed.projectId, actorId: userId, actions: parsed.actions })
    } catch (error) {
      if (error instanceof ControlDomainError) {
        return failure(error.code, error.message, error.actionIndex, error.details)
      }
      return failure("internal", "Control preflight failed.")
    }
    const snapshot = await readProjectControlSnapshotV1(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    const requestDigest = await controlRequestDigestV1(parsed)
    let recoveries: Map<string, any>
    try {
      recoveries = await requestedRecoveries(ctx, parsed)
      await preflightRecoveryLocks(ctx, { projectId: parsed.projectId, actorId: userId, actions: parsed.actions, recoveries })
    } catch (error) {
      if (error instanceof ControlDomainError) return failure(error.code, error.message, error.actionIndex, error.details)
      return failure("not-found", "Recovery is unavailable.")
    }
    const controlPlan = plan(snapshot, parsed, recoveries)
    const approval = controlApprovalRequirementV1(controlPlan, requestDigest)
    const {
      idempotencyReplay: _idempotencyReplay,
      recoveries: _recoveries,
      restored: _restored,
      ...preview
    } = result(requestDigest, parsed, controlPlan, false)
    return controlPreviewResultSchemaV1.parse({
      ...preview,
      approval,
    })
  },
})

export const requestApprovalV1 = mutation({
  args: { request: v.any() },
  handler: async (ctx, { request }) => {
    const parsed = parseApproval(request)
    let actor: ReturnType<typeof controlActor>
    try {
      actor = controlActor(await requireAuthenticatedIdentity(ctx))
    } catch {
      return failure("authorization", "Authentication is required.")
    }
    try {
      await preflightControlRequestV1(ctx, { projectId: parsed.projectId, actorId: actor.subject, actions: parsed.actions })
    } catch (error) {
      if (error instanceof ControlDomainError) return failure(error.code, error.message, error.actionIndex, error.details)
      return failure("internal", "Control preflight failed.")
    }
    const snapshot = await readProjectControlSnapshotV1(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      return failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    const requestDigest = await controlRequestDigestV1(parsed)
    let recoveries: Map<string, any>
    try {
      recoveries = await requestedRecoveries(ctx, parsed)
      await preflightRecoveryLocks(ctx, { projectId: parsed.projectId, actorId: actor.subject, actions: parsed.actions, recoveries })
    } catch (error) {
      if (error instanceof ControlDomainError) return failure(error.code, error.message, error.actionIndex, error.details)
      return failure("not-found", "Recovery is unavailable.")
    }
    const controlPlan = plan(snapshot, parsed, recoveries)
    const requirement = controlApprovalRequirementV1(controlPlan, requestDigest)
    if (!requirement.required) return failure("validation", "Approval requires a material destructive action.")
    await pruneApprovals(ctx, parsed.projectId, actor.subject)
    const token = approvalToken()
    const now = Date.now()
    const expiresAt = now + 10 * 60 * 1000
    await ctx.db.insert("controlApprovals", {
      projectId: parsed.projectId,
      actorSubject: actor.subject,
      requestDigest,
      baseRevision: requirement.baseRevision,
      actionIndexes: requirement.actionIndexes,
      tokenHash: await sha256(token),
      createdAt: now,
      expiresAt,
    })
    return controlApprovalResultSchemaV1.parse({
      version: "v1",
      approvalToken: token,
      requestDigest,
      baseRevision: requirement.baseRevision,
      actionIndexes: requirement.actionIndexes,
      expiresAt,
    })
  },
})

export const commitV1 = mutation({
  args: { request: v.any() },
  handler: async (ctx, { request }) => {
    const parsed = parseCommit(request)
    let actor: ReturnType<typeof controlActor>
    try {
      actor = controlActor(await requireAuthenticatedIdentity(ctx))
    } catch {
      return failure("authorization", "Authentication is required.")
    }
    const userId = actor.subject
    const requestDigest = await controlRequestDigestV1(parsed)
    const existing = await ctx.db
      .query("controlCommits")
      .withIndex("by_project_actor_idempotency", (query) => (
        query.eq("projectId", parsed.projectId).eq("actorSubject", userId).eq("idempotencyKey", parsed.idempotencyKey)
      ))
      .unique()
    if (existing) {
      if (existing.createdAt < Date.now() - controlCommitMaxAgeMs) {
        await ctx.db.delete(existing._id)
      } else {
        const role = await getProjectRole(ctx, parsed.projectId, userId)
        if (role !== "owner" && role !== "editor") {
          failure("forbidden", "You do not have write access to this project.")
        }
        if (existing.requestDigest !== requestDigest) failure("idempotency-conflict", "Idempotency key was already used with a different request.")
        return controlCommitResultSchemaV1.parse({
          ...existing.result,
          idempotencyReplay: true,
          recoveries: existing.result.recoveries ?? [],
          restored: existing.result.restored ?? [],
        })
      }
    }
    let writerRole: "owner" | "editor"
    try {
      const preflight = await preflightControlRequestV1(ctx, {
        projectId: parsed.projectId,
        actorId: userId,
        actions: parsed.actions,
      })
      writerRole = preflight.role
    } catch (error) {
      if (error instanceof ControlDomainError) {
        return failure(error.code, error.message, error.actionIndex, error.details)
      }
      return failure("internal", "Control preflight failed.")
    }
    const snapshot = await readProjectControlSnapshotV1(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    let recoveries: Map<string, any>
    try {
      recoveries = await requestedRecoveries(ctx, parsed)
      await preflightRecoveryLocks(ctx, { projectId: parsed.projectId, actorId: userId, actions: parsed.actions, recoveries })
    } catch (error) {
      if (error instanceof ControlDomainError) return failure(error.code, error.message, error.actionIndex, error.details)
      return failure("not-found", "Recovery is unavailable.")
    }
    const controlPlan = plan(snapshot, parsed, recoveries)
    const requirement = controlApprovalRequirementV1(controlPlan, requestDigest)
    if (requirement.required) {
      if (!parsed.approvalToken) return approvalError(requirement)
      const tokenHash = await sha256(parsed.approvalToken)
      const approval = await ctx.db.query("controlApprovals")
        .withIndex("by_tokenHash", (query: any) => query.eq("tokenHash", tokenHash))
        .unique()
      if (
        !approval
        || approval.actorSubject !== userId
        || approval.projectId !== parsed.projectId
        || approval.requestDigest !== requestDigest
        || approval.baseRevision !== controlPlan.priorRevision
        || approval.expiresAt <= Date.now()
        || approval.consumedAt !== undefined
        || approval.actionIndexes.join(",") !== requirement.actionIndexes.join(",")
      ) return approvalError(requirement)
      await ctx.db.patch(approval._id, { consumedAt: Date.now() })
    }
    let execution: Awaited<ReturnType<typeof executeControlPlanV1>>
    try {
      execution = await executeControlPlanV1(ctx, { projectId: parsed.projectId, actorId: userId, plan: controlPlan, recoveries })
      if (execution.changed !== controlPlan.applied) failure("internal", "Control execution changed-state mismatch.")
    } catch (error) {
      if (error instanceof ControlDomainError) {
        execution = failure(error.code, error.message, error.actionIndex, error.details)
      }
      execution = failure("internal", "Control execution failed.")
    }
    if (controlPlan.applied) await advanceProjectRevision(ctx, parsed.projectId)
    const committed = result(
      requestDigest,
      parsed,
      controlPlan,
      false,
      execution.resolvedRefs,
      execution.recoveries,
      execution.restored,
    )
    assertControlSerializedBodyV1(committed)
    const semanticRequest = controlRequestDigestInputV1(parsed)
    const commitId = await ctx.db.insert("controlCommits", {
      projectId: parsed.projectId,
      apiVersion: "v1",
      actorSubject: userId,
      actorIssuer: actor.issuer,
      actorTokenIdentifier: actor.tokenIdentifier,
      actorRole: writerRole,
      idempotencyKey: parsed.idempotencyKey,
      requestDigest,
      semanticRequest,
      priorRevision: committed.priorRevision,
      finalRevision: committed.revision,
      applied: committed.applied,
      result: committed,
      createdAt: Date.now(),
      status: "completed",
    })
    for (const recovery of execution.recoveries) {
      const recoveryId = ctx.db.normalizeId("controlRecoveries", recovery.id)
      if (recoveryId) await ctx.db.patch(recoveryId, { sourceCommitId: commitId })
    }
    try {
      await pruneControlCommits(ctx, parsed.projectId, commitId)
    } catch {
      failure("limit-exceeded", "Control commit retention could not be bounded safely.")
    }
    return committed
  },
})

export const snapshotV1 = query({
  args: { projectId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = parseSnapshotQuery(args)
    let userId: string
    try {
      userId = (await requireAuthenticatedIdentity(ctx)).subject
    } catch {
      return failure("authorization", "Authentication is required.")
    }
    try {
      await requireProjectAccess(ctx, parsed.projectId, userId)
    } catch {
      return failure("forbidden", "You do not have read access to this project.")
    }
    return projectSnapshotSchemaV1.parse(await readProjectControlSnapshotV1(ctx, parsed.projectId))
  },
})

export const historyV1 = query({
  args: {
    projectId: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = parseHistoryQuery(args)
    let userId: string
    try {
      userId = (await requireAuthenticatedIdentity(ctx)).subject
    } catch {
      return failure("authorization", "Authentication is required.")
    }
    try {
      await requireProjectAccess(ctx, parsed.projectId, userId)
    } catch {
      return failure("forbidden", "You do not have read access to this project.")
    }
    const page = await paginateControlHistory(ctx, parsed.projectId, parsed.limit, parsed.cursor)
    return controlHistoryResultSchemaV1.parse({
      entries: page.page.map((commit: any) => controlHistoryEntrySchemaV1.parse({
        id: String(commit._id),
        projectId: commit.projectId,
        actorSubject: commit.actorSubject,
        ...(commit.actorIssuer === undefined ? {} : { actorIssuer: commit.actorIssuer }),
        ...(commit.actorTokenIdentifier === undefined ? {} : { actorTokenIdentifier: commit.actorTokenIdentifier }),
        actorRole: commit.actorRole,
        idempotencyKey: commit.idempotencyKey,
        requestDigest: commit.requestDigest,
        priorRevision: commit.priorRevision,
        revision: commit.finalRevision,
        applied: commit.applied,
        createdAt: commit.createdAt,
        recoveries: commit.result?.recoveries ?? [],
        restored: commit.result?.restored ?? [],
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    })
  },
})

export const recoveriesV1 = query({
  args: { projectId: v.string(), cursor: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const parsed = parseRecoveriesQuery(args)
    let userId: string
    try {
      userId = (await requireAuthenticatedIdentity(ctx)).subject
      await requireProjectAccess(ctx, parsed.projectId, userId)
    } catch {
      return failure("forbidden", "You do not have read access to this project.")
    }
    const page = await paginateRecoveries(ctx, parsed.projectId, parsed.limit, parsed.cursor)
    const now = Date.now()
    return controlRecoveriesResultSchemaV1.parse({
      entries: page.page.filter((row: any) => row.consumedAt === undefined && row.expiresAt > now).map((row: any) => ({
        actionIndex: row.sourceActionIndex,
        id: String(row._id),
        kind: row.kind,
        expiresAt: row.expiresAt,
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    })
  },
})
