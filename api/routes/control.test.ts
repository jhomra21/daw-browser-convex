import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  controlCapabilitiesV1,
  controlLimitsV1,
} from "@daw-browser/control"
import type { ApiBindings } from "../app-types"
import type { ControlBearer } from "../control-oauth"
import { registerControlRoutes } from "./control"

const bearer: ControlBearer = {
  userId: "user-1",
  issuer: "https://control.example",
  tokenIdentifier: "token-1",
  clientId: "client-1",
  scopes: ["control:read", "control:write"],
}

const snapshot = {
  version: "v1",
  project: {
    id: "project-1",
    name: "Project",
    revision: 1,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 1,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
}

const previewRequest = {
  version: "v1",
  projectId: "project-1",
  actions: [{ kind: "project.rename", name: "Renamed" }],
}

const commitRequest = { ...previewRequest, idempotencyKey: "request-1" }

const previewResult = {
  version: "v1",
  projectId: "project-1",
  priorRevision: 1,
  revision: 2,
  applied: true,
  requestDigest: "0".repeat(64),
  resolvedRefs: [],
  warnings: [],
  changeSummary: { actionCount: 1, changes: [] },
}

const commitResult = { ...previewResult, idempotencyReplay: false, recoveries: [], restored: [] }

const history = { entries: [], continueCursor: "next", isDone: true }

const app = (
  resolve = async () => bearer,
  query = async () => snapshot,
  mutation = async () => commitResult,
) => {
  const application = new Hono<ApiBindings>()
  registerControlRoutes(application, {
    resolveBearer: resolve,
    createGateway: async () => ({ query, mutation }),
  })
  return application
}

describe("control REST routes", () => {
  test("uses bearer attribution for every canonical route", async () => {
    let calls = 0
    const application = app(
      async () => bearer,
      async () => {
        calls += 1
        return calls === 1 ? snapshot : calls === 2 ? previewResult : history
      },
    )
    expect((await application.request("https://control.example/api/control/v1/capabilities")).status).toBe(200)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/snapshot")).status).toBe(200)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: JSON.stringify(previewRequest),
    })).status).toBe(200)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/commit", {
      method: "POST",
      body: JSON.stringify(commitRequest),
    })).status).toBe(200)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/history?limit=1")).status).toBe(200)
  })

  test("rejects cookie-only and invalid bearer with the resource challenge", async () => {
    const application = app(async () => null)
    const response = await application.request("https://control.example/api/control/v1/capabilities", {
      headers: { Cookie: "better-auth.session_token=session" },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://control.example/.well-known/oauth-protected-resource/api"',
    )
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("returns an insufficient-scope challenge for preview and commit", async () => {
    const application = app(async (_request, _environment, scope) => (
      scope === "control:write" ? null : bearer
    ))
    const preview = await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: JSON.stringify(previewRequest),
    })
    const commit = await application.request("https://control.example/api/control/v1/projects/project-1/commit", {
      method: "POST",
      body: JSON.stringify(commitRequest),
    })
    expect(preview.status).toBe(403)
    expect(commit.status).toBe(403)
    expect(preview.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="control:write", resource_metadata="https://control.example/.well-known/oauth-protected-resource/api"',
    )
  })

  test("requires a bounded multipart length and sends insufficient-scope challenges for assets", async () => {
    const application = app()
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/assets", {
      method: "POST",
      headers: { "Idempotency-Key": "asset-key-1" },
    })).status).toBe(411)

    const readOnly = app(async (_request, _environment, scope) => (
      scope === "control:write" ? null : bearer
    ))
    const response = await readOnly.request("https://control.example/api/control/v1/projects/project-1/assets", {
      method: "POST",
      headers: { "Idempotency-Key": "asset-key-1", "Content-Length": "1" },
    })
    expect(response.status).toBe(403)
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"')
  })

  test("rejects mismatched, malformed, and oversized write requests", async () => {
    const application = app()
    expect((await application.request("https://control.example/api/control/v1/projects/project-2/preview", {
      method: "POST",
      body: JSON.stringify(previewRequest),
    })).status).toBe(400)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: "{",
    })).status).toBe(400)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: "x".repeat(controlLimitsV1.maxSerializedBodyBytes + 1),
    })).status).toBe(413)
    expect((await application.request("https://control.example/api/control/v1/projects/project-1/approvals", {
      method: "POST",
      body: JSON.stringify({ ...previewRequest, actor: "forbidden" }),
    })).status).toBe(400)
  })

  test("routes asset deletes through canonical commits and leaves token optional for no-ops", async () => {
    let received: unknown
    const application = app(async () => bearer, async () => snapshot, async (_reference, args) => {
      received = args
      return commitResult
    })
    const missing = await application.request("https://control.example/api/control/v1/projects/project-1/assets/missing", {
      method: "DELETE",
      headers: { "Idempotency-Key": "asset-delete-1" },
    })
    expect(missing.status).toBe(200)
    expect(received).toEqual({
      request: {
        version: "v1",
        projectId: "project-1",
        idempotencyKey: "asset-delete-1",
        actions: [{ kind: "asset.delete", asset: { source: "persisted", id: "missing" } }],
      },
    })
    const invalid = await application.request("https://control.example/api/control/v1/projects/project-1/assets/missing", {
      method: "DELETE",
      headers: { "Idempotency-Key": "bad key" },
    })
    expect(invalid.status).toBe(400)
  })

  test("rejects path-normalizing IDs without dispatching canonical calls", async () => {
    let queries = 0
    let mutations = 0
    const application = app(
      async () => bearer,
      async () => {
        queries += 1
        return snapshot
      },
      async () => {
        mutations += 1
        return commitResult
      },
    )
    for (const projectId of [".", "..", "%2E", "%2E%2E", "%2F", "%2f", "%5C", "%5c", "%252F", "%252f"]) {
      const response = await application.request(
        `https://control.example/api/control/v1/projects/${projectId}/snapshot`,
      )
      expect(response.status).toBeGreaterThanOrEqual(400)
    }
    const response = await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: JSON.stringify({ ...previewRequest, projectId: "project%2Fother" }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(queries).toBe(0)
    expect(mutations).toBe(0)
  })

  test("maps Convex errors and rejects malformed Convex successes", async () => {
    const forbidden = app(
      async () => bearer,
      async () => {
        throw { version: "v1", code: "forbidden", message: "No project access." }
      },
    )
    expect((await forbidden.request("https://control.example/api/control/v1/projects/project-1/snapshot")).status).toBe(403)

    const malformed = app(async () => bearer, async () => ({ unexpected: true }))
    expect((await malformed.request("https://control.example/api/control/v1/projects/project-1/snapshot")).status).toBe(500)
  })

  test("returns validated canonical capabilities", async () => {
    const response = await app().request("https://control.example/api/control/v1/capabilities")
    expect(await response.json()).toEqual(controlCapabilitiesV1)
  })
})
