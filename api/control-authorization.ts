import type { ControlErrorV1 } from "@daw-browser/control"

export const controlNoStore = { "Cache-Control": "no-store" }

const resourceMetadata = (url: string) => (
  `${new URL(url).origin}/.well-known/oauth-protected-resource/api`
)

const controlBearerChallenge = (url: string) => (
  `Bearer resource_metadata="${resourceMetadata(url)}"`
)

const controlInsufficientScopeChallenge = (
  url: string,
  scope: "control:read" | "control:write",
) => (
  `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${resourceMetadata(url)}"`
)

export const controlUnauthorizedHeaders = (url: string) => ({
  ...controlNoStore,
  "WWW-Authenticate": controlBearerChallenge(url),
})

export const controlInsufficientScopeHeaders = (
  url: string,
  scope: "control:read" | "control:write",
) => ({
  ...controlNoStore,
  "WWW-Authenticate": controlInsufficientScopeChallenge(url, scope),
})

export const controlAuthorizationError = (
  code: Extract<ControlErrorV1["code"], "authorization" | "forbidden">,
) => (
  code === "authorization"
    ? { version: "v1", code, message: "Bearer authentication is required." }
    : { version: "v1", code, message: "Control write scope is required." }
) satisfies ControlErrorV1
