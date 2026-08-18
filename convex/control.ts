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
  canonicalCapturedRecoveryPayloadV2,
  parseControlCommitRequestV1,
  parseControlApprovalRequestV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  planControlRequestV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  recoveryCapturedPayloadSchemaV2,
  type ControlPlanV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
  type RecoveryPayload,
  type ResolvedRefV1,
} from "@daw-browser/control";
import { isJsonObject, type JsonValue } from "@daw-browser/shared";
import { mergeRecoveryTrackOrderV1 } from "@daw-browser/control/recovery-track-order";
import { z } from "zod";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { executeControlPlanV1 } from "./controlExecution";
import { ControlDomainError, preflightControlRequestV1 } from "./controlPreflight";
import { readProjectControlSnapshotV1, readProjectControlSnapshotV2 } from "./controlSnapshot";
import { getProjectRole, requireAuthenticatedIdentity, requireProjectAccess } from "./projectAccess";
import { advanceProjectRevision } from "./projectRows";
import { captureRecoveryPayload, isRecoverableAction, loadRecovery } from "./controlRecovery";
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
  currentCommitId: Id<"controlCommits">,
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
    actionIndex,
    details,
  }))
}

const parsePreview = (input: JsonValue) => {
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

const parseCommit = (input: JsonValue) => {
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

const parseApproval = (input: JsonValue) => {
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

const parseSnapshotQuery = (input: JsonValue) => {
  try {
    return parseControlSnapshotQueryV1(input)
  } catch {
    return failure("invalid-request", "Invalid control snapshot request.")
  }
}

const parseHistoryQuery = (input: JsonValue) => {
  try {
    return parseControlHistoryQueryV1(input)
  } catch {
    return failure("invalid-request", "Invalid control history request.")
  }
}
const parseRecoveriesQuery = (input: JsonValue) => {
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

const controlPlanErrorSchema = z.object({
  code: z.enum(["validation", "not-found", "limit-exceeded"]),
  message: z.string(),
  actionIndex: z.number().optional(),
});

type PlanningSnapshot = ProjectSnapshotV1 | ProjectSnapshotV2;
type PlannerRecovery = { payload: RecoveryPayload };
type LoadedRecovery = Awaited<ReturnType<typeof loadRecovery>>;

const plan = <Snapshot extends PlanningSnapshot>(
  snapshot: Snapshot,
  request: Parameters<typeof planControlRequestV1>[1],
  recoveries: ReadonlyMap<string, PlannerRecovery> = new Map(),
): ControlPlanV1<Snapshot> => {
  try {
    return planControlRequestV1(snapshot, request, recoveries)
  } catch (error) {
    const parsedError = controlPlanErrorSchema.safeParse(error);
    if (parsedError.success) {
      return failure(
        parsedError.data.code,
        parsedError.data.message.slice(0, 512),
        parsedError.data.actionIndex,
      );
    }
    return failure("internal", "Control planning failed.")
  }
}

const result = <Snapshot extends PlanningSnapshot>(
  requestDigest: string,
  request: { projectId: string },
  controlPlan: ControlPlanV1<Snapshot>,
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

const hasClientReference = (value: JsonValue): boolean => {
  if (Array.isArray(value)) return value.some(hasClientReference)
  if (!isJsonObject(value)) return false
  if (value.source === "client") return true
  return Object.values(value).some(hasClientReference)
}

const validateRecoveryDrafts = async (
  ctx: any,
  input: { projectId: string; actions: any[] },
) => {
  for (const [actionIndex, action] of input.actions.entries()) {
    if (!isRecoverableAction(action) || hasClientReference(JSON.parse(JSON.stringify(action)))) continue
    const data = await captureRecoveryPayload(ctx, {
      projectId: input.projectId,
      action,
      actionIndex,
      resolveRef: (table, ref) => {
        if (ref.source !== "persisted") throw new Error("Recovery draft has an unresolved reference.");
        const id = ctx.db.normalizeId(table, ref.id);
        if (!id) throw new Error("Recovery draft has an invalid reference.");
        return id;
      },
    })
    if (data) {
      canonicalCapturedRecoveryPayloadV2(recoveryCapturedPayloadSchemaV2.parse({
        version: 2,
        kind: action.kind,
        data: JSON.parse(JSON.stringify(data)),
      }))
    }
  }
}

const recoveryTrackIds = (recovery: PlannerRecovery): string[] => {
  const routingTargets = (state: {
    groupId?: string;
    mixer?: { outputTargetId?: string; sends?: Array<{ targetId: string }> };
  }) => [
    ...(state.groupId === undefined ? [] : [state.groupId]),
    ...(state.mixer?.outputTargetId === undefined ? [] : [state.mixer.outputTargetId]),
    ...(state.mixer?.sends ?? []).map((send) => send.targetId),
  ]
  const { payload } = recovery
  if (payload.kind === "clip.delete") return [String(payload.data.clip.trackId)]
  if (payload.kind === "automation.delete") {
    return payload.data.automation.trackId ? [String(payload.data.automation.trackId)] : []
  }
  if (payload.kind === "sidechain.remove") {
    return [String(payload.data.sidechain.sourceTrackId), String(payload.data.sidechain.targetTrackId)]
  }
  if (payload.kind === "asset.delete") return []
  if (payload.kind === "timeline.range.delete") return payload.data.range.trackIds.map(String)
  if (payload.kind === "track.delete") {
    return [
      ...payload.data.survivors.map((entry) => entry.id),
      ...payload.data.tracks.flatMap((entry) => routingTargets(entry.track)),
      ...payload.data.survivors.flatMap((entry) => routingTargets(entry.before)),
      ...payload.data.sidechains.flatMap((entry) => [entry.sidechain.sourceTrackId, entry.sidechain.targetTrackId]),
    ]
  }
  if (payload.kind === "track.ungroup") {
    return [
      ...payload.data.children.map((entry) => entry.id),
      ...payload.data.tracks.flatMap((entry) => routingTargets(entry.track)),
      ...payload.data.children.flatMap((entry) => routingTargets(entry.before)),
      ...payload.data.sidechains.flatMap((entry) => [entry.sidechain.sourceTrackId, entry.sidechain.targetTrackId]),
    ]
  }
  return [
    ...payload.data.effects.flatMap((item) => item.effect.target.kind === "track" ? [item.effect.target.trackId] : []),
    ...payload.data.automation.flatMap((item) => item.automation.trackId === undefined ? [] : [item.automation.trackId]),
    ...payload.data.sidechains.flatMap((item) => [item.sidechain.sourceTrackId, item.sidechain.targetTrackId]),
  ]
}

const recoveryIndexShiftedTrackIds = (
  recovery: PlannerRecovery,
  tracks: Array<{ _id: unknown; index: number }>,
) => {
  if (recovery.payload.kind !== "track.delete" && recovery.payload.kind !== "track.ungroup") return [];
  const recovered = recovery.payload.data.tracks.map((entry) => ({
    id: entry.id,
    index: entry.track.index,
  }));
  const recoveredIds = new Set(recovered.map((track: { id: string }) => track.id));
  const currentIndexById = new Map(tracks.map((track) => [String(track._id), track.index]));
  const finalOrder = mergeRecoveryTrackOrderV1(
    tracks.map((track) => ({ id: String(track._id), index: track.index })),
    recovered,
  );
  return finalOrder.flatMap((track) => {
    if (recoveredIds.has(track.id)) return [];
    return currentIndexById.get(track.id) === track.index ? [] : [track.id];
  });
};

const preflightRecoveryLocks = async (
  ctx: any,
  input: {
    projectId: string;
    actorId: string;
    actions: Parameters<typeof planControlRequestV1>[1]["actions"];
    recoveries: Map<string, LoadedRecovery>;
  },
) => {
  const tracks = await listProjectTracksWithMixerChannels(ctx, input.projectId)
  const locks = new Map(tracks.map((track) => [String(track._id), track.lockedBy]))
  for (const [actionIndex, action] of input.actions.entries()) {
    if (action.kind !== "recovery.restore") continue
    const recovery = input.recoveries.get(action.recovery.id)
    if (!recovery) continue
    const affectedTrackIds = new Set([
      ...recoveryTrackIds(recovery),
      ...recoveryIndexShiftedTrackIds(recovery, tracks),
    ])
    for (const trackId of affectedTrackIds) {
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
    const snapshot = await readProjectControlSnapshotV2(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    const requestDigest = await controlRequestDigestV1(parsed)
    let recoveries: Map<string, LoadedRecovery>
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
    const snapshot = await readProjectControlSnapshotV2(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      return failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    const requestDigest = await controlRequestDigestV1(parsed)
    try {
      await validateRecoveryDrafts(ctx, { projectId: parsed.projectId, actions: parsed.actions })
    } catch {
      return failure("limit-exceeded", "Recovery payload exceeds recovery limits.")
    }
    let recoveries: Map<string, LoadedRecovery>
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
    const snapshot = await readProjectControlSnapshotV2(ctx, parsed.projectId)
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== snapshot.project.revision) {
      failure("revision-conflict", "Project revision does not match the expected revision.")
    }
    let recoveries: Map<string, LoadedRecovery>
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

export const snapshotV2 = query({
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
    return projectSnapshotSchemaV2.parse(await readProjectControlSnapshotV2(ctx, parsed.projectId))
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
        actorIssuer: commit.actorIssuer,
        actorTokenIdentifier: commit.actorTokenIdentifier,
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
