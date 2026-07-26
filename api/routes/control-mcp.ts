import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  controlCapabilitiesV1,
  controlCapabilitiesV2,
  controlLimitsV1,
} from "@daw-browser/control"
import {
  createControlMcpServer,
  type ControlService,
} from "@daw-browser/control-mcp"
import { api as convexApi } from "../../convex/_generated/api"
import type { ApiContext, App } from "../app-types"
import { createControlConvexClient } from "../convex-auth"
import {
  resolveControlBearer,
  type ControlBearer,
  type ControlOAuthScope,
} from "../control-oauth"
import {
  controlInsufficientScopeHeaders,
  controlNoStore,
  controlUnauthorizedHeaders,
} from "../control-authorization"

type ControlMcpRouteDependencies = {
  resolveBearer?: (
    request: Request,
    env: ApiContext["env"],
    requiredScope: ControlOAuthScope,
  ) => Promise<ControlBearer | null>;
  createGateway?: (context: ApiContext, bearer: ControlBearer) => Promise<ControlService>;
}

const noStore = controlNoStore

const unauthorized = (context: ApiContext) => context.json({
  version: "v1",
  code: "authorization",
  message: "Bearer authentication is required.",
}, 401, {
  ...controlUnauthorizedHeaders(context.req.url),
})

const insufficientScope = (context: ApiContext) => context.json({
  error: "insufficient_scope",
  error_description: "Control write scope is required.",
}, 403, {
  ...controlInsufficientScopeHeaders(context.req.url, "control:write"),
})

const unsupportedMethod = () => new Response(null, {
  status: 405,
  headers: { ...noStore, Allow: "POST" },
})

const contentTypeIsJson = (request: Request) => (
  request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json"
)

type ParsedMcpBody = { value: unknown } | { response: Response }

const parseMcpBody = async (request: Request): Promise<ParsedMcpBody> => {
  if (!contentTypeIsJson(request)) {
    return { response: new Response("Content-Type must be application/json.", { status: 415, headers: noStore }) }
  }
  const contentLength = request.headers.get("content-length")
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > controlLimitsV1.maxSerializedBodyBytes)) {
    return { response: new Response("MCP body exceeds the serialized body limit.", { status: 413, headers: noStore }) }
  }
  const bytes = new Uint8Array(await request.clone().arrayBuffer())
  if (bytes.byteLength > controlLimitsV1.maxSerializedBodyBytes) {
    return { response: new Response("MCP body exceeds the serialized body limit.", { status: 413, headers: noStore }) }
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { response: new Response("Malformed MCP JSON body.", { status: 400, headers: noStore }) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const requiresWriteScope = (value: unknown) => {
  const requests = Array.isArray(value) ? value : [value]
  return requests.some((request) => (
    isRecord(request)
    && request.method === "tools/call"
    && isRecord(request.params)
    && (request.params.name === "control_preview" || request.params.name === "control_commit" || request.params.name === "control_request_approval")
    && (!isRecord(request.params.arguments) || request.params.arguments.target !== "host")
  ))
}

const controlGateway = async (context: ApiContext, bearer: ControlBearer): Promise<ControlService> => {
  const gateway = await createControlConvexClient(context, bearer)
  return {
    capabilities: async () => controlCapabilitiesV1,
    capabilitiesV2: async () => controlCapabilitiesV2,
    snapshot: async (input) => await gateway.query(convexApi.control.snapshotV1, input),
    snapshotV2: async (input) => await gateway.query(convexApi.control.snapshotV2, input),
    preview: async (input) => await gateway.query(convexApi.control.previewV1, { request: input }),
    commit: async (input) => await gateway.mutation(convexApi.control.commitV1, { request: input }),
    requestApproval: async (input) => await gateway.mutation(convexApi.control.requestApprovalV1, { request: input }),
    history: async (input) => await gateway.query(convexApi.control.historyV1, input),
    recoveries: async (input) => await gateway.query(convexApi.control.recoveriesV1, input),
  }
}

const lazyService = (
  context: ApiContext,
  bearer: ControlBearer,
  createGateway: (context: ApiContext, bearer: ControlBearer) => Promise<ControlService>,
): ControlService => {
  let gateway: Promise<ControlService> | undefined
  const resolveGateway = () => {
    gateway ??= createGateway(context, bearer)
    return gateway
  }
  return {
    capabilities: async () => controlCapabilitiesV1,
    capabilitiesV2: async () => controlCapabilitiesV2,
    snapshot: async (input) => (await resolveGateway()).snapshot(input),
    snapshotV2: async (input) => (await resolveGateway()).snapshotV2(input),
    preview: async (input) => (await resolveGateway()).preview(input),
    commit: async (input) => (await resolveGateway()).commit(input),
    requestApproval: async (input) => (await resolveGateway()).requestApproval(input),
    history: async (input) => (await resolveGateway()).history(input),
    recoveries: async (input) => (await resolveGateway()).recoveries(input),
  }
}

const withNoStore = (response: Response) => {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function registerControlMcpRoutes(app: App, dependencies: ControlMcpRouteDependencies = {}) {
  const resolveBearer = dependencies.resolveBearer ?? resolveControlBearer
  const createGateway = dependencies.createGateway ?? controlGateway

  app.all("/api/mcp", async (context) => {
    if (context.req.method !== "POST") {
      if (!await resolveBearer(context.req.raw, context.env, "control:read")) return unauthorized(context)
      return unsupportedMethod()
    }

    const parsedBody = await parseMcpBody(context.req.raw)
    if ("response" in parsedBody) return parsedBody.response
    const requiredScope = requiresWriteScope(parsedBody.value) ? "control:write" : "control:read"
    const bearer = await resolveBearer(context.req.raw, context.env, requiredScope)
    if (!bearer) {
      if (requiredScope === "control:write" && await resolveBearer(context.req.raw, context.env, "control:read")) {
        return insufficientScope(context)
      }
      return unauthorized(context)
    }

    const server = createControlMcpServer(
      lazyService(context, bearer, createGateway),
      { authorize: () => true },
    )
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    try {
      await server.connect(transport)
      return withNoStore(await transport.handleRequest(context.req.raw, { parsedBody: parsedBody.value }))
    } finally {
      await transport.close()
      await server.close()
    }
  })
}
