import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  controlCapabilitiesV1,
  controlLimitsV1,
  createDirectControlInvoker,
} from "@daw-browser/control"
import { api as convexApi } from "../../convex/_generated/api"
import type { ApiBindings } from "../app-types"
import type { ControlGateway } from "../control-handler"
import type { ControlBearer } from "../control-oauth"
import { createCloudControlHandlers } from "../control-handler"
import { registerControlRoutes } from "./control"
import { AudioUploadValidationError } from "../control-upload-audio-metadata"

const bearer: ControlBearer = {
  userId: "user-1",
  issuer: "https://control.example",
  tokenIdentifier: "token-1",
  clientId: "client-1",
  scopes: ["control:read", "control:write"],
}

const snapshot = {
  version: "v2",
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

test("inspects upload bytes before beginning the receipt or writing R2", async () => {
  const events: string[] = []
  const application = new Hono<ApiBindings>()
  registerControlRoutes(application, {
    resolveBearer: async () => bearer,
    inspectAudioMetadata: async () => {
      events.push("inspect")
      return {
        durationSec: 1,
        sampleRate: 44_100,
        channelCount: 2,
        detectedFormat: "WAVE",
        detectedMimeType: "audio/wav",
        detectedCodec: "pcm-s16",
      }
    },
    createGateway: async () => ({
      query: async () => snapshot,
      mutation: async (_reference) => {
        if (!events.includes("begin")) {
          events.push("begin")
          return { status: "pending", assetKey: "asset-1", r2Key: "asset-1/object" }
        }
        events.push("finalize")
        return {
          asset: {
            id: "asset-1",
            name: "Kick.wav",
            sourceKind: "upload",
            mimeType: "audio/wav",
            sizeBytes: 4,
            contentSha256: "0".repeat(64),
            durationSec: 1,
            sampleRate: 44_100,
            channelCount: 2,
            createdAt: 1,
            updatedAt: 1,
          },
          idempotencyReplay: false,
        }
      },
    }),
  })
  const form = new FormData()
  const bytes = new Uint8Array([1, 2, 3, 4])
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  form.append("file", new File([bytes], "Kick.wav", { type: "audio/wav" }))
  const response = await application.request("https://control.example/api/control/v1/projects/project-1/assets", {
    method: "POST",
    headers: { "Idempotency-Key": "asset-key-1", "Content-Length": "1000", "x-content-sha256": digest },
    body: form,
  }, {
    daw_audio_samples: {
      put: async () => {
        events.push("put")
      },
    },
  } satisfies ApiBindings["Bindings"])
  expect(response.status).toBe(201)
  expect(events).toEqual(["inspect", "begin", "put", "finalize"])
})

test("maps invalid control upload media to validation and parser failures to internal", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const request = async (inspectAudioMetadata: NonNullable<Parameters<typeof registerControlRoutes>[1]>["inspectAudioMetadata"]) => {
    const application = new Hono<ApiBindings>()
    registerControlRoutes(application, {
      resolveBearer: async () => bearer,
      inspectAudioMetadata,
    })
    const form = new FormData()
    form.append("file", new File([bytes], "Kick.wav", { type: "audio/wav" }))
    return application.request("https://control.example/api/control/v1/projects/project-1/assets", {
      method: "POST",
      headers: { "Idempotency-Key": "asset-key-1", "Content-Length": "1000", "x-content-sha256": digest },
      body: form,
    })
  }
  const invalid = await request(async () => {
    throw new AudioUploadValidationError("Uploaded audio could not be parsed.")
  })
  expect(invalid.status).toBe(422)
  const unexpected = await request(async () => {
    throw new Error("unexpected parser failure")
  })
  expect(unexpected.status).toBe(500)
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

  test("dispatches control routes through the canonical cloud provider handlers", async () => {
    const queries: unknown[] = []
    const mutations: unknown[] = []
    const application = app(
      async () => bearer,
      async (reference) => {
        queries.push(reference)
        if (reference === convexApi.control.previewV1) return previewResult
        if (reference === convexApi.control.historyV1) return history
        if (reference === convexApi.control.recoveriesV1) return { entries: [], continueCursor: "next", isDone: true }
        return { ...snapshot, version: "v2" }
      },
      async (reference) => {
        mutations.push(reference)
        if (reference === convexApi.control.requestApprovalV1) {
          return {
            version: "v1",
            approvalToken: "a".repeat(32),
            requestDigest: "0".repeat(64),
            baseRevision: 1,
            actionIndexes: [0],
            expiresAt: 2,
          }
        }
        return commitResult
      },
    )

    await application.request("https://control.example/api/control/v1/capabilities")
    await application.request("https://control.example/api/control/v2/capabilities")
    await application.request("https://control.example/api/control/v1/projects/project-1/snapshot")
    await application.request("https://control.example/api/control/v2/projects/project-1/snapshot")
    await application.request("https://control.example/api/control/v1/projects/project-1/preview", {
      method: "POST",
      body: JSON.stringify(previewRequest),
    })
    await application.request("https://control.example/api/control/v1/projects/project-1/approvals", {
      method: "POST",
      body: JSON.stringify(previewRequest),
    })
    await application.request("https://control.example/api/control/v1/projects/project-1/commit", {
      method: "POST",
      body: JSON.stringify(commitRequest),
    })
    await application.request("https://control.example/api/control/v1/projects/project-1/history")
    await application.request("https://control.example/api/control/v1/projects/project-1/recoveries")

    expect(queries).toEqual([
      convexApi.control.snapshotV2,
      convexApi.control.snapshotV2,
      convexApi.control.previewV1,
      convexApi.control.historyV1,
      convexApi.control.recoveriesV1,
    ])
    expect(mutations).toEqual([
      convexApi.control.requestApprovalV1,
      convexApi.control.commitV1,
    ])
  })

  test("keeps HTTP results equivalent to direct cloud invocation", async () => {
    const createGateway = (): ControlGateway => {
      let queryIndex = 0
      let mutationIndex = 0
      const queryResults = [snapshot, previewResult, history, { entries: [], continueCursor: "next", isDone: true }]
      return {
        query: async () => {
          const result = queryResults[queryIndex]
          queryIndex += 1
          if (result === undefined) throw new Error("Unexpected query.")
          return result
        },
        mutation: async () => {
          const result = mutationIndex === 0 ? {
            version: "v1",
            approvalToken: "a".repeat(32),
            requestDigest: "0".repeat(64),
            baseRevision: 1,
            actionIndexes: [0],
            expiresAt: 2,
          } : commitResult
          mutationIndex += 1
          return result
        },
      }
    }
    const gateway = createGateway()
    const direct = createDirectControlInvoker({
      handlers: createCloudControlHandlers({ gateway }),
      context: { target: "cloud", principal: { subject: "ignored-request-principal" } },
    })
    const routeGateway = createGateway()
    const application = app(async () => bearer, routeGateway.query, routeGateway.mutation)

    const directResults = await Promise.all([
      direct.invoke("control.capabilities", {}),
      direct.invoke("control.snapshot", { projectId: "project-1" }),
      direct.invoke("control.preview", previewRequest),
      direct.invoke("control.requestApproval", previewRequest),
      direct.invoke("control.commit", commitRequest),
      direct.invoke("control.history", { projectId: "project-1", limit: 50 }),
      direct.invoke("control.recoveries", { projectId: "project-1", limit: 50 }),
    ])
    const requests = [
      "https://control.example/api/control/v2/capabilities",
      "https://control.example/api/control/v2/projects/project-1/snapshot",
      "https://control.example/api/control/v1/projects/project-1/preview",
      "https://control.example/api/control/v1/projects/project-1/approvals",
      "https://control.example/api/control/v1/projects/project-1/commit",
      "https://control.example/api/control/v1/projects/project-1/history?limit=50",
      "https://control.example/api/control/v1/projects/project-1/recoveries?limit=50",
    ]
    const bodies = [undefined, undefined, previewRequest, previewRequest, commitRequest, undefined, undefined]
    for (const [index, url] of requests.entries()) {
      const response = await application.request(url, bodies[index] === undefined ? undefined : {
        method: "POST",
        body: JSON.stringify(bodies[index]),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(directResults[index])
    }
  })
})
