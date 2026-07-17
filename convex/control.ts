import {
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryEntrySchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  controlRequestDigestInputV1,
  controlRequestDigestV1,
  parseControlHistoryQueryV1,
  assertControlSerializedBodyV1,
  parseControlCommitRequestV1,
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

const maxControlCommitsPerProject = 1000;
const controlCommitMaxAgeMs = 90 * 24 * 60 * 60 * 1000;
const controlCommitPruneBatchSize = 256;
const controlCommitPruneMaxPages = 16;
const controlCommitRetentionSafetyCeiling = 2_048;

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
  code: "invalid-request" | "validation" | "revision-conflict" | "idempotency-conflict" | "forbidden" | "authorization" | "not-found" | "limit-exceeded" | "internal",
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
  try {
    return parseControlPreviewRequestV1(input)
  } catch {
    return failure("invalid-request", "Invalid control preview request.")
  }
}

const parseCommit = (input: unknown) => {
  try {
    return parseControlCommitRequestV1(input)
  } catch {
    return failure("invalid-request", "Invalid control commit request.")
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

const boundedActorClaim = (value: string) => {
  if (value.length > 0 && value.length <= 256) return value
  return failure("authorization", "Authenticated identity claims are invalid.")
}

const controlActor = (identity: Awaited<ReturnType<typeof requireAuthenticatedIdentity>>) => ({
  subject: boundedActorClaim(identity.subject),
  issuer: boundedActorClaim(identity.dawControlActorIssuer ?? identity.issuer),
  tokenIdentifier: boundedActorClaim(identity.dawControlActorTokenIdentifier ?? identity.tokenIdentifier),
})

const plan = (snapshot: Parameters<typeof planControlRequestV1>[0], request: Parameters<typeof planControlRequestV1>[1]) => {
  try {
    return planControlRequestV1(snapshot, request)
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
})

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
    const controlPlan = plan(snapshot, parsed)
    const { idempotencyReplay: _idempotencyReplay, ...preview } = result(requestDigest, parsed, controlPlan, false)
    return controlPreviewResultSchemaV1.parse({
      ...preview,
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
        return controlCommitResultSchemaV1.parse({ ...existing.result, idempotencyReplay: true })
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
    const controlPlan = plan(snapshot, parsed)
    let execution: Awaited<ReturnType<typeof executeControlPlanV1>>
    try {
      execution = await executeControlPlanV1(ctx, { projectId: parsed.projectId, actorId: userId, plan: controlPlan })
      if (execution.changed !== controlPlan.applied) failure("internal", "Control execution changed-state mismatch.")
    } catch (error) {
      if (error instanceof ControlDomainError) {
        execution = failure(error.code, error.message, error.actionIndex, error.details)
      }
      execution = failure("internal", "Control execution failed.")
    }
    if (controlPlan.applied) await advanceProjectRevision(ctx, parsed.projectId)
    const committed = result(requestDigest, parsed, controlPlan, false, execution.resolvedRefs)
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
      })),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    })
  },
})
