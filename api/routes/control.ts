import {
  controlCapabilitiesSchemaV1,
  controlCapabilitiesV1,
  controlCommitResultSchemaV1,
  controlApprovalResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryResultSchemaV1,
  controlLimitsV1,
  controlPreviewResultSchemaV1,
  assetFolderResultSchemaV1,
  assetUploadResultSchemaV1,
  parseControlCommitRequestV1,
  parseControlApprovalRequestV1,
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
import { createR2ObjectResponse } from "../r2-object-response"

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
const assetUploadHeader = "x-content-sha256"
const maxAssetUploadBytes = 10 * 1024 * 1024
const supportedAssetMimeTypes = new Set([
  "audio/mpeg", "audio/wav", "audio/x-wav", "audio/flac",
  "audio/ogg", "audio/mp4", "audio/aac", "audio/webm",
])
const supportedAssetExtensions = new Map([
  ["audio/mpeg", [".mp3"]],
  ["audio/wav", [".wav"]],
  ["audio/x-wav", [".wav"]],
  ["audio/flac", [".flac"]],
  ["audio/ogg", [".ogg"]],
  ["audio/mp4", [".m4a", ".mp4"]],
  ["audio/aac", [".aac"]],
  ["audio/webm", [".webm"]],
])

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

const assetDigest = async (file: File) => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const readAssetUpload = async (context: ApiContext) => {
  const contentLength = context.req.header("content-length");
  if (!contentLength) throw controlError("invalid-request", "Content-Length is required for multipart asset uploads.");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxAssetUploadBytes + 16 * 1024)) {
    throw controlError("limit-exceeded", "Asset upload exceeds the 10 MiB limit.");
  }
  const form = await context.req.formData();
  const file = form.get("file");
  const declaredDigest = context.req.header(assetUploadHeader);
  const name = form.get("name")?.toString() || (file instanceof File ? file.name : "");
  const folderId = form.get("folderId")?.toString();
  if (!(file instanceof File) || !declaredDigest || !/^[0-9a-f]{64}$/.test(declaredDigest)) {
    throw controlError("invalid-request", "A file and lowercase SHA-256 digest header are required.");
  }
  if (file.size < 1 || file.size > maxAssetUploadBytes) throw controlError("limit-exceeded", "Asset upload exceeds the 10 MiB limit.");
  if (!supportedAssetMimeTypes.has(file.type)) throw controlError("validation", "Unsupported audio MIME type.");
  const extensions = supportedAssetExtensions.get(file.type);
  if (!extensions?.some((extension) => file.name.toLowerCase().endsWith(extension))) {
    throw controlError("validation", "Asset file extension does not match its audio MIME type.");
  }
  const contentSha256 = await assetDigest(file);
  if (contentSha256 !== declaredDigest) throw controlError("validation", "Asset digest does not match uploaded bytes.");
  return { file, contentSha256, name, ...(folderId ? { folderId } : {}) };
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

  const respondWriteAuthorization = (context: ApiContext, error: ControlErrorV1) => (
    error.code === "forbidden"
      ? context.json(error, 403, {
          ...noStore,
          "WWW-Authenticate": `Bearer error="insufficient_scope", scope="control:write", resource_metadata="${new URL(context.req.url).origin}/.well-known/oauth-protected-resource/api"`,
        })
      : context.json(error, 401, {
          ...noStore,
          "WWW-Authenticate": controlChallenge(context.req.url),
        })
  )

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
    path: "/api/control/v1/projects/:projectId/preview" | "/api/control/v1/projects/:projectId/commit" | "/api/control/v1/projects/:projectId/approvals",
    operation: "preview" | "commit" | "approval",
  ) => {
    app.post(path, async (context) => {
      const bearer = await authenticate(context, "control:write")
      if (bearer.kind === "rejected") {
        return respondWriteAuthorization(context, bearer.error)
      }
      try {
        const body = await readJsonBody(context)
        if ("error" in body) return context.json(body.error, body.status, noStore)
        let request
        try {
          request = operation === "preview"
            ? parseControlPreviewRequestV1(body.value)
            : operation === "approval"
              ? parseControlApprovalRequestV1(body.value)
              : parseControlCommitRequestV1(body.value)
        } catch {
          return respondError(context, controlError("invalid-request", "Invalid control request."))
        }
        if (request.projectId !== context.req.param("projectId")) {
          return respondError(context, controlError("invalid-request", "Path projectId must match body projectId."))
        }
        const gateway = await createGateway(context, bearer.bearer)
        const result = operation === "preview"
          ? await gateway.query(convexApi.control.previewV1, { request })
          : operation === "approval"
            ? await gateway.mutation(convexApi.control.requestApprovalV1, { request })
            : await gateway.mutation(convexApi.control.commitV1, { request })
        const schema = operation === "preview"
          ? controlPreviewResultSchemaV1
          : operation === "approval" ? controlApprovalResultSchemaV1 : controlCommitResultSchemaV1
        return context.json(schema.parse(result), 200, noStore)
      } catch (error) {
        return respondError(context, readControlError(error))
      }
    })
  }

  writeRoute("/api/control/v1/projects/:projectId/preview", "preview")
  writeRoute("/api/control/v1/projects/:projectId/commit", "commit")
  writeRoute("/api/control/v1/projects/:projectId/approvals", "approval")

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

  const authorizeAssetRoute = async (context: ApiContext, scope: ControlOAuthScope) => {
    const bearer = await authenticate(context, scope);
    if (bearer.kind === "authenticated") return bearer.bearer;
    if (scope === "control:write") return respondWriteAuthorization(context, bearer.error);
    return context.json(bearer.error, 401, { ...noStore, "WWW-Authenticate": controlChallenge(context.req.url) });
  };

  app.post("/api/control/v1/projects/:projectId/assets", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    const idempotencyKey = context.req.header("idempotency-key");
    if (!idempotencyKey) return respondError(context, controlError("invalid-request", "Idempotency-Key is required."));
    if (!context.req.header("content-length")) {
      return context.json(controlError("invalid-request", "Content-Length is required for multipart asset uploads."), 411, noStore);
    }
    try {
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const upload = await readAssetUpload(context);
      const gateway = await createGateway(context, authorized);
      const begun = await gateway.mutation(convexApi.assets.beginUpload, {
        projectId, idempotencyKey, contentSha256: upload.contentSha256, name: upload.name, mimeType: upload.file.type,
        sizeBytes: upload.file.size, ...(upload.folderId === undefined ? {} : { folderId: upload.folderId }),
      });
      if (!isRecord(begun) || typeof begun.r2Key !== "string" || typeof begun.assetKey !== "string") {
        throw controlError("internal", "Upload receipt response is invalid.");
      }
      if (begun.status !== "completed") {
        try {
          await context.env.daw_audio_samples.put(begun.r2Key, upload.file.stream(), {
            httpMetadata: { contentType: upload.file.type },
            customMetadata: { contentSha256: upload.contentSha256 },
          });
        } catch {
          await gateway.mutation(convexApi.assets.failUpload, { projectId, idempotencyKey, contentSha256: upload.contentSha256 });
          throw controlError("internal", "Asset object upload failed.");
        }
      }
      let result: unknown;
      try {
        result = await gateway.mutation(convexApi.assets.finalizeUpload, { projectId, idempotencyKey, contentSha256: upload.contentSha256 });
      } catch {
        throw controlError("internal", "Asset finalization failed.");
      }
      return context.json(assetUploadResultSchemaV1.parse(result), 201, noStore);
    } catch (error) {
      return respondError(context, readControlError(error));
    }
  });

  app.get("/api/control/v1/projects/:projectId/assets/:assetId/content", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:read");
    if (authorized instanceof Response) return authorized;
    try {
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const gateway = await createGateway(context, authorized);
      const locator = await gateway.query(convexApi.assets.getContentLocator, { projectId, assetKey: context.req.param("assetId") });
      if (!isRecord(locator) || typeof locator.r2Key !== "string") return respondError(context, controlError("not-found", "Asset not found."));
      const object = await context.env.daw_audio_samples.get(locator.r2Key, { range: context.req.raw.headers });
      if (!object) return respondError(context, controlError("not-found", "Asset content not found."));
      return createR2ObjectResponse(object, "private, no-store");
    } catch (error) {
      return respondError(context, readControlError(error));
    }
  });

  app.delete("/api/control/v1/projects/:projectId/assets/:assetId", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    const idempotencyKey = context.req.header("idempotency-key");
    const approvalToken = context.req.header("approval-token");
    if (!idempotencyKey) return respondError(context, controlError("invalid-request", "Idempotency-Key is required."));
    try {
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const gateway = await createGateway(context, authorized);
      const expectedRevision = context.req.header("if-match-revision");
      let request
      try {
        request = parseControlCommitRequestV1({
          version: "v1", projectId, idempotencyKey,
          ...(approvalToken === undefined ? {} : { approvalToken }),
          ...(expectedRevision === undefined ? {} : { expectedRevision: Number(expectedRevision) }),
          actions: [{ kind: "asset.delete", asset: { source: "persisted", id: context.req.param("assetId") } }],
        });
      } catch {
        return respondError(context, controlError("invalid-request", "Invalid asset delete request."));
      }
      return context.json(controlCommitResultSchemaV1.parse(await gateway.mutation(convexApi.control.commitV1, { request })), 200, noStore);
    } catch (error) { return respondError(context, readControlError(error)); }
  });

  app.post("/api/control/v1/projects/:projectId/asset-folders", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    try {
      const body = await readJsonBody(context);
      if ("error" in body) return context.json(body.error, body.status, noStore);
      if (!isRecord(body.value) || typeof body.value.name !== "string") return respondError(context, controlError("invalid-request", "Folder name is required."));
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const result = await (await createGateway(context, authorized)).mutation(convexApi.assets.createFolder, { projectId, name: body.value.name });
      return context.json(assetFolderResultSchemaV1.parse(result), 201, noStore);
    } catch (error) { return respondError(context, readControlError(error)); }
  });

  app.patch("/api/control/v1/projects/:projectId/asset-folders/:folderId", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    try {
      const body = await readJsonBody(context);
      if ("error" in body) return context.json(body.error, body.status, noStore);
      if (!isRecord(body.value) || typeof body.value.name !== "string") return respondError(context, controlError("invalid-request", "Folder name is required."));
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const result = await (await createGateway(context, authorized)).mutation(convexApi.assets.renameFolder, { projectId, folderId: context.req.param("folderId"), name: body.value.name });
      return context.json(assetFolderResultSchemaV1.parse(result), 200, noStore);
    } catch (error) { return respondError(context, readControlError(error)); }
  });

  app.delete("/api/control/v1/projects/:projectId/asset-folders/:folderId", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    try {
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const result = await (await createGateway(context, authorized)).mutation(convexApi.assets.deleteFolder, { projectId, folderId: context.req.param("folderId") });
      return context.json(result, 200, noStore);
    } catch (error) { return respondError(context, readControlError(error)); }
  });

  app.patch("/api/control/v1/projects/:projectId/assets/:assetId/folder", async (context) => {
    const authorized = await authorizeAssetRoute(context, "control:write");
    if (authorized instanceof Response) return authorized;
    try {
      const body = await readJsonBody(context);
      if ("error" in body) return context.json(body.error, body.status, noStore);
      if (!isRecord(body.value) || (body.value.folderId !== undefined && typeof body.value.folderId !== "string")) {
        return respondError(context, controlError("invalid-request", "folderId must be a string or omitted."));
      }
      const projectId = parseControlSnapshotQueryV1({ projectId: context.req.param("projectId") }).projectId;
      const result = await (await createGateway(context, authorized)).mutation(convexApi.assets.moveAssetToFolder, {
        projectId, assetKey: context.req.param("assetId"), ...(typeof body.value.folderId === "string" ? { folderId: body.value.folderId } : {}),
      });
      return context.json(result, 200, noStore);
    } catch (error) { return respondError(context, readControlError(error)); }
  });
}
