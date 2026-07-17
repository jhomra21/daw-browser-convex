import {
  controlCapabilitiesSchemaV1,
  controlCapabilitiesV1,
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryResultSchemaV1,
  controlLimitsV1,
  controlPreviewResultSchemaV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  projectSnapshotSchemaV1,
} from "@daw-browser/control"
import { api as convexApi } from "../../convex/_generated/api"
import type { App, ApiContext } from "../app-types"
import { createControlConvexClient } from "../convex-auth"
import {
  resolveControlBearer,
  type ControlBearer,
  type ControlOAuthScope,
} from "../control-oauth"
import type { ControlErrorV1 } from "@daw-browser/control"

type ConvexGateway = {
  query: (reference: unknown, args: unknown) => Promise<unknown>;
  mutation: (reference: unknown, args: unknown) => Promise<unknown>;
}

type ControlRouteDependencies = {
  resolveBearer?: (
    request: Request,
    env: ApiContext["env"],
    requiredScope: ControlOAuthScope,
  ) => Promise<ControlBearer | null>;
  createGateway?: (context: ApiContext, bearer: ControlBearer) => Promise<ConvexGateway>;
}

type AuthResult = (
  { kind: "authenticated"; bearer: ControlBearer }
  | { kind: "rejected"; error: ControlErrorV1 }
)

const noStore = { "Cache-Control": "no-store" }

const controlChallenge = (url: string) => (
  `Bearer resource_metadata="${new URL(url).origin}/.well-known/oauth-protected-resource/api"`
)

const controlError = (
  code: ControlErrorV1["code"],
  message: string,
): ControlErrorV1 => ({ version: "v1", code, message })

const statusForError = (code: ReturnType<typeof controlError>["code"]) => {
  if (code === "authorization") return 401
  if (code === "forbidden" || code === "approval-required") return 403
  if (code === "not-found") return 404
  if (code === "revision-conflict" || code === "idempotency-conflict") return 409
  if (code === "invalid-request") return 400
  if (code === "validation" || code === "unsupported-action" || code === "limit-exceeded") return 422
  return 500
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const readControlError = (error: unknown) => {
  const candidates = [
    error,
    isRecord(error) ? error.data : undefined,
    isRecord(error) ? error.errorData : undefined,
  ]
  for (const candidate of candidates) {
    const parsed = controlErrorSchemaV1.safeParse(candidate)
    if (parsed.success) return parsed.data
  }
  return controlError("internal", "Control service failed.")
}

const respondError = (context: ApiContext, error: ReturnType<typeof controlError>) => (
  context.json(error, statusForError(error.code), noStore)
)

type JsonBody = { value: unknown } | { error: ControlErrorV1; status: 400 | 413 }

const readJsonBody = async (context: ApiContext): Promise<JsonBody> => {
  const contentLength = context.req.header("content-length")
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > controlLimitsV1.maxSerializedBodyBytes)) {
    return { error: controlError("limit-exceeded", "Control body exceeds the serialized body limit."), status: 413 }
  }
  const bytes = new Uint8Array(await context.req.raw.arrayBuffer())
  if (bytes.byteLength > controlLimitsV1.maxSerializedBodyBytes) {
    return { error: controlError("limit-exceeded", "Control body exceeds the serialized body limit."), status: 413 }
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { error: controlError("invalid-request", "Malformed control JSON body."), status: 400 }
  }
}

const controlGateway = async (context: ApiContext, bearer: ControlBearer) => {
  return await createControlConvexClient(context, bearer)
}

export function registerControlRoutes(app: App, dependencies: ControlRouteDependencies = {}) {
  const resolveBearer = dependencies.resolveBearer ?? resolveControlBearer
  const createGateway = dependencies.createGateway ?? controlGateway

  const authenticate = async (context: ApiContext, scope: ControlOAuthScope): Promise<AuthResult> => {
    const bearer = await resolveBearer(context.req.raw, context.env, scope)
    if (bearer) return { kind: "authenticated", bearer }
    if (scope === "control:write" && await resolveBearer(context.req.raw, context.env, "control:read")) {
      return { kind: "rejected", error: controlError("forbidden", "Control write scope is required.") }
    }
    return { kind: "rejected", error: controlError("authorization", "Bearer authentication is required.") }
  }

  app.get("/api/control/v1/capabilities", async (context) => {
    const bearer = await authenticate(context, "control:read")
    if (bearer.kind === "rejected") {
      if (bearer.error.code === "forbidden") return respondError(context, bearer.error)
      return context.json(bearer.error, 401, {
        ...noStore,
        "WWW-Authenticate": controlChallenge(context.req.url),
      })
    }
    return context.json(controlCapabilitiesSchemaV1.parse(controlCapabilitiesV1), 200, noStore)
  })

  app.get("/api/control/v1/projects/:projectId/snapshot", async (context) => {
    const bearer = await authenticate(context, "control:read")
    if (bearer.kind === "rejected") {
      if (bearer.error.code === "forbidden") return respondError(context, bearer.error)
      return context.json(bearer.error, 401, {
        ...noStore,
        "WWW-Authenticate": controlChallenge(context.req.url),
      })
    }
    try {
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId
      const gateway = await createGateway(context, bearer.bearer)
      return context.json(projectSnapshotSchemaV1.parse(await gateway.query(convexApi.control.snapshotV1, { projectId })), 200, noStore)
    } catch (error) {
      return respondError(context, readControlError(error))
    }
  })

  const writeRoute = (
    path: "/api/control/v1/projects/:projectId/preview" | "/api/control/v1/projects/:projectId/commit",
    operation: "preview" | "commit",
  ) => {
    app.post(path, async (context) => {
      const bearer = await authenticate(context, "control:write")
      if (bearer.kind === "rejected") {
        if (bearer.error.code === "forbidden") return respondError(context, bearer.error)
        return context.json(bearer.error, 401, {
          ...noStore,
          "WWW-Authenticate": controlChallenge(context.req.url),
        })
      }
      try {
        const body = await readJsonBody(context)
        if ("error" in body) return context.json(body.error, body.status, noStore)
        const request = operation === "preview"
          ? parseControlPreviewRequestV1(body.value)
          : parseControlCommitRequestV1(body.value)
        if (request.projectId !== context.req.param("projectId")) {
          return respondError(context, controlError("invalid-request", "Path projectId must match body projectId."))
        }
        const gateway = await createGateway(context, bearer.bearer)
        const result = operation === "preview"
          ? await gateway.query(convexApi.control.previewV1, { request })
          : await gateway.mutation(convexApi.control.commitV1, { request })
        const schema = operation === "preview" ? controlPreviewResultSchemaV1 : controlCommitResultSchemaV1
        return context.json(schema.parse(result), 200, noStore)
      } catch (error) {
        return respondError(context, readControlError(error))
      }
    })
  }

  writeRoute("/api/control/v1/projects/:projectId/preview", "preview")
  writeRoute("/api/control/v1/projects/:projectId/commit", "commit")

  app.get("/api/control/v1/projects/:projectId/history", async (context) => {
    const bearer = await authenticate(context, "control:read")
    if (bearer.kind === "rejected") {
      if (bearer.error.code === "forbidden") return respondError(context, bearer.error)
      return context.json(bearer.error, 401, {
        ...noStore,
        "WWW-Authenticate": controlChallenge(context.req.url),
      })
    }
    try {
      const query = parseControlHistoryQueryV1({
        projectId: context.req.param("projectId"),
        ...(context.req.query("cursor") === undefined ? {} : { cursor: context.req.query("cursor") }),
        ...(context.req.query("limit") === undefined ? {} : { limit: Number(context.req.query("limit")) }),
      })
      const gateway = await createGateway(context, bearer.bearer)
      return context.json(controlHistoryResultSchemaV1.parse(await gateway.query(convexApi.control.historyV1, query)), 200, noStore)
    } catch (error) {
      return respondError(context, readControlError(error))
    }
  })
}
