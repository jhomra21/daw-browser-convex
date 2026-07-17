import {
  canonicalJson,
  controlCapabilitiesSchemaV1,
  controlCommitResultSchemaV1,
  controlErrorSchemaV1,
  controlHistoryResultSchemaV1,
  controlPreviewResultSchemaV1,
  parseControlCommitRequestV1,
  parseControlHistoryQueryV1,
  parseControlPreviewRequestV1,
  parseControlSnapshotQueryV1,
  projectSnapshotSchemaV1,
  type ControlCapabilitiesV1,
  type ControlCommitRequestV1,
  type ControlCommitResultV1,
  type ControlErrorV1,
  type ControlHistoryQueryV1,
  type ControlHistoryResultV1,
  type ControlPreviewRequestV1,
  type ControlPreviewResultV1,
  type ProjectSnapshotV1,
} from "@daw-browser/control"

type AccessToken = string | (() => string | Promise<string>)
type ControlFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type ControlClientOptions = {
  baseUrl: string;
  accessToken: AccessToken;
  fetch?: ControlFetch;
}

export class ControlApiError extends Error {
  readonly status: number
  readonly code: ControlErrorV1["code"]
  readonly details: ControlErrorV1["details"]
  readonly actionIndex: ControlErrorV1["actionIndex"]

  constructor(status: number, error: ControlErrorV1) {
    super(error.message)
    this.name = "ControlApiError"
    this.status = status
    this.code = error.code
    this.details = error.details
    this.actionIndex = error.actionIndex
  }
}

export class ControlTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ControlTransportError"
  }
}

const readToken = async (accessToken: AccessToken) => (
  typeof accessToken === "function" ? await accessToken() : accessToken
)

const controlUrl = (baseUrl: string, pathname: string) => {
  const root = new URL(baseUrl)
  const [routePath, search] = pathname.split("?", 2)
  root.pathname = `${root.pathname.replace(/\/$/, "")}/api/control/v1${routePath}`
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

export const createControlClient = (options: ControlClientOptions) => {
  const baseUrl = new URL(options.baseUrl).toString()
  const requestFetch = options.fetch ?? globalThis.fetch
  if (!requestFetch) throw new ControlTransportError("A fetch implementation is required.")

  const request = async <Value>(
    pathname: string,
    schema: { parse: (value: unknown) => Value },
    init?: { method?: "GET" | "POST"; body?: string },
  ) => {
    const token = await readToken(options.accessToken)
    if (!token) throw new ControlTransportError("An access token is required.")
    return response(
      () => requestFetch(controlUrl(baseUrl, pathname), {
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
    snapshot: (projectId: string): Promise<ProjectSnapshotV1> => {
      const query = parseControlSnapshotQueryV1({ projectId })
      return request(`/projects/${encodeURIComponent(query.projectId)}/snapshot`, projectSnapshotSchemaV1)
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
    history: (input: ControlHistoryQueryV1): Promise<ControlHistoryResultV1> => {
      const query = parseControlHistoryQueryV1(input)
      const url = `/projects/${encodeURIComponent(query.projectId)}/history?${new URLSearchParams({
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        limit: String(query.limit),
      }).toString()}`
      return request(url, controlHistoryResultSchemaV1)
    },
  }
}
