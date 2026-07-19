import { expect, test } from "bun:test"
import { credentialIdentity, type ControlCredentials } from "./credentials"
import { authorizeControlMcpScope } from "./server"

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

test("cloud write authorization rejects deleted, replaced, and scope-revoked credentials", async () => {
  const expected = credentialIdentity(credentials())
  const authorize = (current: ControlCredentials | undefined) => (
    authorizeControlMcpScope("control:write", expected, { read: async () => current })
  )
  expect(await authorize(credentials())).toBeTrue()
  expect(await authorize(undefined)).toBeFalse()
  expect(await authorize(credentials({ clientId: "client-2" }))).toBeFalse()
  expect(await authorize(credentials({ scopes: ["control:read"] }))).toBeFalse()
  expect(await authorizeControlMcpScope("control:read", expected, { read: async () => undefined })).toBeTrue()
})
