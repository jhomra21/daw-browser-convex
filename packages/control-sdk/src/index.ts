import {
  canonicalJson,
  controlCapabilitiesSchemaV1,
  controlCapabilitiesSchemaV2,
  controlCommitResultSchemaV1,
  controlApprovalResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryResultSchemaV1,
  controlRecoveriesResultSchemaV1,
  controlPreviewResultSchemaV1,
  parseControlCommitRequestV1,
  parseControlApprovalRequestV1,
  parseControlHistoryQueryV1,
  parseControlRecoveriesQueryV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  projectSnapshotSchemaV1,
  projectSnapshotSchemaV2,
  type ControlCapabilitiesV1,
  type ControlCapabilitiesV2,
  type ControlCommitRequestV1,
  type ControlCommitResultV1,
  type ControlApprovalRequestV1,
  type ControlApprovalResultV1,
  type ControlErrorV1,
  type ControlHistoryQueryV1,
  type ControlHistoryResultV1,
  type ControlRecoveriesQueryV1,
  type ControlRecoveriesResultV1,
  type ControlPreviewRequestV1,
  type ControlPreviewResultV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
} from "@daw-browser/control"

export type ControlAccessTokenResolver = () => string | Promise<string>
export type ControlAccessToken = string | ControlAccessTokenResolver
export type ControlFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ControlClientOptions = {
  baseUrl: string;
  accessToken: ControlAccessToken;
  fetch?: ControlFetch;
}

export type ControlClient = {
  capabilities: () => Promise<ControlCapabilitiesV1>;
  capabilitiesV2: () => Promise<ControlCapabilitiesV2>;
  snapshot: (projectId: string) => Promise<ProjectSnapshotV1>;
  snapshotV2: (projectId: string) => Promise<ProjectSnapshotV2>;
  preview: (input: ControlPreviewRequestV1) => Promise<ControlPreviewResultV1>;
  commit: (input: ControlCommitRequestV1) => Promise<ControlCommitResultV1>;
  requestApproval: (input: ControlApprovalRequestV1) => Promise<ControlApprovalResultV1>;
  history: (input: ControlHistoryQueryV1) => Promise<ControlHistoryResultV1>;
  recoveries: (input: ControlRecoveriesQueryV1) => Promise<ControlRecoveriesResultV1>;
}

export class ControlApiError extends Error {
  readonly data: ControlErrorV1
  readonly status: number
  readonly code: ControlErrorV1["code"]
  readonly details: ControlErrorV1["details"]
  readonly actionIndex: ControlErrorV1["actionIndex"]

  constructor(status: number, error: ControlErrorV1) {
    super(error.message)
    this.name = "ControlApiError"
    this.data = Object.freeze({
      ...error,
      ...(error.details === undefined ? {} : { details: Object.freeze({ ...error.details }) }),
    })
    this.status = status
    this.code = this.data.code
    this.details = this.data.details
    this.actionIndex = this.data.actionIndex
  }
}

export class ControlTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ControlTransportError"
  }
}

const readToken = async (accessToken: ControlAccessToken) => (
  typeof accessToken === "function" ? await accessToken() : accessToken
)

export const normalizeControlOrigin = (value: string) => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Control base URL must be a valid origin.")
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || value.includes("?") || value.includes("#")) {
    throw new Error("Control base URL must be an origin.")
  }
  const loopbackHttp = url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("Control base URL must use HTTPS except for loopback HTTP.")
  }
  return url.origin
}

const controlUrl = (origin: string, pathname: string, version = "v1") => {
  const root = new URL(origin)
  const [routePath, search] = pathname.split("?", 2)
  root.pathname = `${root.pathname.replace(/\/$/, "")}/api/control/${version}${routePath}`
  root.search = search === undefined ? "" : `?${search}`
  root.hash = ""
  return root
}

const parseResponseBody = async (response: Response): Promise<unknown> => {
  try {
    return await response.json()
  } catch {
    throw new ControlTransportError("Control service returned malformed JSON.")
  }
}

const response = async <Value>(
  request: () => Promise<Response>,
  schema: { parse: (value: unknown) => Value },
): Promise<Value> => {
  let received: Response
  try {
    received = await request()
  } catch {
    throw new ControlTransportError("Control request failed.")
  }
  const body = await parseResponseBody(received)
  if (!received.ok) {
    const error = controlErrorSchemaV1.safeParse(body)
    if (error.success) throw new ControlApiError(received.status, error.data)
    throw new ControlTransportError("Control service returned an invalid error response.")
  }
  try {
    return schema.parse(body)
  } catch {
    throw new ControlTransportError("Control service returned an invalid success response.")
  }
}

export const createControlClient = (options: ControlClientOptions): ControlClient => {
  const baseUrl = normalizeControlOrigin(options.baseUrl)
  const requestFetch = options.fetch ?? globalThis.fetch
  if (!requestFetch) throw new ControlTransportError("A fetch implementation is required.")

  const request = async <Value>(
    pathname: string,
    schema: { parse: (value: unknown) => Value },
    init?: { method?: "GET" | "POST"; body?: string },
    version = "v1",
  ) => {
    const token = await readToken(options.accessToken)
    if (!token) throw new ControlTransportError("An access token is required.")
    return response(
      () => requestFetch(controlUrl(baseUrl, pathname, version), {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init?.body === undefined ? {} : { body: init.body }),
        credentials: "omit",
      }),
      schema,
    )
  }

  return {
    capabilities: (): Promise<ControlCapabilitiesV1> => (
      request("/capabilities", controlCapabilitiesSchemaV1)
    ),
    capabilitiesV2: (): Promise<ControlCapabilitiesV2> => (
      request("/capabilities", controlCapabilitiesSchemaV2, undefined, "v2")
    ),
    snapshot: (projectId: string): Promise<ProjectSnapshotV1> => {
      const query = parseControlSnapshotQueryV1({ projectId })
      return request(`/projects/${encodeURIComponent(query.projectId)}/snapshot`, projectSnapshotSchemaV1)
    },
    snapshotV2: (projectId: string): Promise<ProjectSnapshotV2> => {
      const query = parseControlSnapshotQueryV1({ projectId })
      return request(`/projects/${encodeURIComponent(query.projectId)}/snapshot`, projectSnapshotSchemaV2, undefined, "v2")
    },
    preview: (input: ControlPreviewRequestV1): Promise<ControlPreviewResultV1> => {
      const requestBody = parseControlPreviewRequestV1(input)
      return request(
        `/projects/${encodeURIComponent(requestBody.projectId)}/preview`,
        controlPreviewResultSchemaV1,
        { method: "POST", body: canonicalJson(requestBody) },
      )
    },
    commit: (input: ControlCommitRequestV1): Promise<ControlCommitResultV1> => {
      const requestBody = parseControlCommitRequestV1(input)
      return request(
        `/projects/${encodeURIComponent(requestBody.projectId)}/commit`,
        controlCommitResultSchemaV1,
        { method: "POST", body: canonicalJson(requestBody) },
      )
    },
    requestApproval: (input: ControlApprovalRequestV1): Promise<ControlApprovalResultV1> => {
      const requestBody = parseControlApprovalRequestV1(input)
      return request(
        `/projects/${encodeURIComponent(requestBody.projectId)}/approvals`,
        controlApprovalResultSchemaV1,
        { method: "POST", body: canonicalJson(requestBody) },
      )
    },
    history: (input: ControlHistoryQueryV1): Promise<ControlHistoryResultV1> => {
      const query = parseControlHistoryQueryV1(input)
      const url = `/projects/${encodeURIComponent(query.projectId)}/history?${new URLSearchParams({
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: String(query.limit),
      }).toString()}`
      return request(url, controlHistoryResultSchemaV1)
    },
    recoveries: (input: ControlRecoveriesQueryV1): Promise<ControlRecoveriesResultV1> => {
      const query = parseControlRecoveriesQueryV1(input)
      const url = `/projects/${encodeURIComponent(query.projectId)}/recoveries?${new URLSearchParams({
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: String(query.limit),
      }).toString()}`
      return request(url, controlRecoveriesResultSchemaV1)
    },
  }
}
