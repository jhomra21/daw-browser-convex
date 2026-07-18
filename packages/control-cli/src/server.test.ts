import { expect, test } from "bun:test"
import { authorizeControlMcpScope } from "./server"
import { credentialIdentity, type ControlCredentials } from "./credentials"

const credentials = (overrides: Partial<ControlCredentials> = {}): ControlCredentials => ({
  version: "v1",
  baseUrl: "https://control.example",
  clientId: "client-1",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1,
  scopes: ["control:read", "control:write"],
  resource: "https://control.example/api",
  tokenEndpoint: "https://control.example/token",
  revocationEndpoint: "https://control.example/revoke",
  ...overrides,
})

test("control MCP write authorization follows current credential identity and scope", async () => {
  const startup = credentialIdentity(credentials())
  const authorize = (current: ControlCredentials | undefined) => (
    authorizeControlMcpScope("control:write", startup, { read: async () => current })
  )

  expect(await authorize(credentials())).toBe(true)
  expect(await authorize(undefined)).toBe(false)
  expect(await authorize(credentials({ clientId: "client-2" }))).toBe(false)
  expect(await authorize(credentials({ scopes: ["control:read"] }))).toBe(false)
  expect(await authorizeControlMcpScope("control:read", startup, { read: async () => undefined })).toBe(true)
})
