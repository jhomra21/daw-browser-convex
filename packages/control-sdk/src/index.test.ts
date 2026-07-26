import { describe, expect, test } from "bun:test"
import { canonicalJson, controlCapabilitiesV1, type ControlPreviewRequestV1 } from "@daw-browser/control"
import {
  ControlApiError,
  ControlTransportError,
  createControlClient,
  normalizeControlOrigin,
  type ControlAccessToken,
  type ControlAccessTokenResolver,
  type ControlClient,
  type ControlClientOptions,
  type ControlFetch,
} from "./index"

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

const preview = {
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

const request: ControlPreviewRequestV1 = {
  version: "v1",
  projectId: "project-1",
  actions: [{ kind: "project.rename", name: "Renamed" }],
}

describe("control SDK", () => {
  test("calls each endpoint once with a fresh bearer and canonical request body", async () => {
    const urls: string[] = []
    const authorizations: string[] = []
    const bodies: string[] = []
    let calls = 0
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: () => `access-${++calls}`,
      fetch: async (input, init) => {
        urls.push(String(input))
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "")
        if (typeof init?.body === "string") bodies.push(init.body)
        if (urls.at(-1)?.endsWith("/capabilities")) return Response.json(controlCapabilitiesV1)
        if (urls.at(-1)?.endsWith("/snapshot")) return Response.json(snapshot)
        if (urls.at(-1)?.endsWith("/preview")) return Response.json(preview)
        if (urls.at(-1)?.endsWith("/commit")) return Response.json({
          ...preview,
          idempotencyReplay: false,
          recoveries: [],
          restored: [],
        })
        return Response.json({ entries: [], continueCursor: "next", isDone: true })
      },
    })

    await client.capabilities()
    await client.snapshot("project-1")
    await client.preview(request)
    await client.commit({ ...request, idempotencyKey: "request-1" })
    await client.history({ projectId: "project-1", limit: 1 })

    expect(urls).toEqual([
      "https://control.example/api/control/v1/capabilities",
      "https://control.example/api/control/v1/projects/project-1/snapshot",
      "https://control.example/api/control/v1/projects/project-1/preview",
      "https://control.example/api/control/v1/projects/project-1/commit",
      "https://control.example/api/control/v1/projects/project-1/history?limit=1",
    ])
    expect(authorizations).toEqual([
      "Bearer access-1",
      "Bearer access-2",
      "Bearer access-3",
      "Bearer access-4",
      "Bearer access-5",
    ])
    expect(bodies).toEqual([
      canonicalJson(request),
      canonicalJson({ ...request, idempotencyKey: "request-1" }),
    ])
  })

  test("exports consumer types and normalizes each valid base origin once", async () => {
    const resolver: ControlAccessTokenResolver = () => "fixture-access"
    const accessToken: ControlAccessToken = resolver
    const fetchTransport: ControlFetch = async (input) => {
      expect(String(input)).toBe("https://control.example/api/control/v1/capabilities")
      return Response.json(controlCapabilitiesV1)
    }
    let baseUrlReads = 0
    const options: ControlClientOptions = {
      get baseUrl() {
        baseUrlReads += 1
        return "https://control.example/"
      },
      accessToken,
      fetch: fetchTransport,
    }
    const client: ControlClient = createControlClient(options)

    await client.capabilities()

    expect(baseUrlReads).toBe(1)
    expect(normalizeControlOrigin("https://control.example/")).toBe("https://control.example")
    expect(normalizeControlOrigin("https://control.example:8443")).toBe("https://control.example:8443")
    expect(normalizeControlOrigin("http://localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeControlOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    expect(normalizeControlOrigin("http://[::1]:3000")).toBe("http://[::1]:3000")
  })

  test("rejects hostile base origins before requests can expose a bearer", () => {
    let fetches = 0
    for (const baseUrl of [
      "http://control.example",
      "http://[::2]",
      "ftp://control.example",
      "https://control.example/fixture",
      "https://control.example/base",
      "https://control.example/?query=value",
      "https://control.example/#fragment",
    ]) {
      expect(() => createControlClient({
        baseUrl,
        accessToken: "fixture-access",
        fetch: async () => {
          fetches += 1
          return Response.json(controlCapabilitiesV1)
        },
      })).toThrow("Control base URL")
    }
    expect(fetches).toBe(0)
  })

  test("uses a fixed project path and does not retry failures", async () => {
    let calls = 0
    let url = ""
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: "fixture-access",
      fetch: async (input) => {
        calls += 1
        url = String(input)
        return Response.json({ version: "v1", code: "revision-conflict", message: "Retry manually." }, { status: 409 })
      },
    })
    await expect(client.commit({ ...request, idempotencyKey: "request-1" })).rejects.toMatchObject({
      name: "ControlApiError",
      status: 409,
      code: "revision-conflict",
    })
    expect(calls).toBe(1)
    const parsed = new URL(url)
    expect(parsed.pathname).toBe("/api/control/v1/projects/project-1/commit")
    expect(parsed.search).toBe("")
    expect(parsed.hash).toBe("")
  })

  test("double-encodes accepted opaque project IDs without normalizing their routes", async () => {
    let requestedProjectId = ""
    const urls: URL[] = []
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: "fixture-access",
      fetch: async (input) => {
        urls.push(new URL(String(input)))
        return Response.json({
          ...snapshot,
          project: { ...snapshot.project, id: requestedProjectId },
        })
      },
    })
    const projectIds = ["project-1", "project%20name", "project%2Esegment", "project:opaque_~id"]
    for (const projectId of projectIds) {
      requestedProjectId = projectId
      await expect(client.snapshot(projectId)).resolves.toMatchObject({
        project: { id: projectId },
      })
      const url = urls.at(-1)
      if (url === undefined) throw new Error("Expected a captured request URL.")
      expect(url.pathname).toBe(`/api/control/v1/projects/${encodeURIComponent(projectId)}/snapshot`)
      expect(decodeURIComponent(url.pathname)).toBe(`/api/control/v1/projects/${projectId}/snapshot`)
    }
    expect(urls).toHaveLength(projectIds.length)
  })

  test("rejects malformed server bodies without exposing the bearer", async () => {
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: "fixture-access",
      fetch: async () => new Response("{", { headers: { "Content-Type": "application/json" } }),
    })
    await expect(client.capabilities()).rejects.toBeInstanceOf(ControlTransportError)

    const apiError = new ControlApiError(400, {
      version: "v1",
      code: "invalid-request",
      message: "Invalid request.",
    })
    expect(apiError.message).not.toContain("fixture-access")
  })

  test("rejects invalid outgoing requests before fetching", async () => {
    let calls = 0
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: "fixture-access",
      fetch: async () => {
        calls += 1
        return Response.json(controlCapabilitiesV1)
      },
    })
    for (const projectId of [
      "", ".", "..", "project/id", "project\\id", "project%2fid", "project%5Cid",
      "project?id", "project#id", "project%3fid", "project%23id", "project%00id",
      "project%1Fid", "project%7fid", "project\nid",
    ]) {
      expect(() => client.snapshot(projectId)).toThrow()
      expect(() => client.preview({ ...request, projectId })).toThrow()
      expect(() => client.commit({ ...request, projectId, idempotencyKey: "request-1" })).toThrow()
      expect(() => client.history({ projectId, limit: 1 })).toThrow()
    }
    expect(calls).toBe(0)
  })

  test("preserves canonical action-indexed API errors", async () => {
    const client = createControlClient({
      baseUrl: "https://control.example",
      accessToken: "fixture-access",
      fetch: async () => Response.json({
        version: "v1",
        code: "validation",
        message: "Action is invalid.",
        details: { field: "actions.2.name" },
        actionIndex: 2,
      }, { status: 422 }),
    })
    try {
      await client.preview(request)
      throw new Error("Expected the client to reject.")
    } catch (error) {
      expect(error).toBeInstanceOf(ControlApiError)
      if (!(error instanceof ControlApiError)) throw error
      expect(error.status).toBe(422)
      expect(error.data).toEqual({
        version: "v1",
        code: "validation",
        message: "Action is invalid.",
        details: { field: "actions.2.name" },
        actionIndex: 2,
      })
      expect(Object.isFrozen(error.data)).toBeTrue()
      expect(error.code).toBe("validation")
      expect(error.message).toBe("Action is invalid.")
      expect(error.details).toEqual({ field: "actions.2.name" })
      expect(error.actionIndex).toBe(2)
    }
  })
})
