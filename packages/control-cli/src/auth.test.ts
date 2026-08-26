import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createAccessTokenProvider,
  logout,
  normalizeBaseUrl,
  persistLoginCredentials,
  pkceChallenge,
} from "./auth"
import {
  credentialIdentity,
  createCredentialStore,
  type ControlCredentials,
} from "./credentials"

const directories: string[] = []

const expired: ControlCredentials = {
  version: "v1",
  baseUrl: "https://control.example",
  clientId: "client-1",
  accessToken: "expired-access",
  refreshToken: "refresh-token",
  expiresAt: 1,
  scopes: ["control:read", "control:write", "offline_access"],
  resource: "https://control.example/api",
  tokenEndpoint: "https://control.example/api/auth/oauth2/token",
  revocationEndpoint: "https://control.example/api/auth/oauth2/revoke",
}

const temporaryStore = async () => {
  const directory = await mkdtemp("/tmp/daw-control-cli-")
  directories.push(directory)
  return createCredentialStore(join(directory, "credentials.json"))
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("control OAuth primitives", () => {
  test("uses the SDK's secure loopback-aware origin normalizer and produces S256 PKCE", async () => {
    expect(normalizeBaseUrl("https://control.example/")).toBe("https://control.example")
    expect(() => normalizeBaseUrl("https://control.example/path")).toThrow()
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    expect(normalizeBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000")
    expect(() => normalizeBaseUrl("http://control.example")).toThrow()
    const verifier = "a".repeat(43)
    const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url")
    const challenge = await pkceChallenge(verifier)
    expect(challenge).toBe(expected)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("serializes refreshes across independent providers", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    let requests = 0
    const requestFetch = async () => {
      requests += 1
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        token_type: "Bearer",
        expires_in: 900,
        scope: "control:read control:write offline_access",
      })
    }
    const first = createAccessTokenProvider(credentialIdentity(expired), store, requestFetch)
    const second = createAccessTokenProvider(credentialIdentity(expired), createCredentialStore(store.path), requestFetch)
    await expect(Promise.all([first(), second()])).resolves.toEqual(["new-access", "new-access"])
    expect(requests).toBe(1)
    expect((await store.read())?.refreshToken).toBe("new-refresh")
  })

  test("fails closed without deleting a newer refresh successor", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    const successor = {
      ...expired,
      accessToken: "successor-access",
      refreshToken: "successor-refresh",
      expiresAt: Date.now() + 900_000,
    }
    const accessToken = createAccessTokenProvider(credentialIdentity(expired), store, async () => {
      await store.write(successor)
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    })
    await expect(accessToken()).rejects.toThrow("Run daw-control auth login")
    expect(await store.read()).toEqual(successor)
  })

  test("removes the rejected refresh generation", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    const accessToken = createAccessTokenProvider(credentialIdentity(expired), store, async () => Response.json(
      { error: "invalid_grant" },
      { status: 400 },
    ))
    await expect(accessToken()).rejects.toThrow("Run daw-control auth login")
    expect(await store.read()).toBeUndefined()
  })

  test("preserves credentials for transient refresh failures", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    for (const response of [
      new Response(null, { status: 503 }),
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    ]) {
      const accessToken = createAccessTokenProvider(credentialIdentity(expired), store, async () => response)
      await expect(accessToken()).rejects.toThrow("OAuth credential refresh failed")
      expect(await store.read()).toEqual(expired)
    }
  })

  test("rejects a cross-origin credential replacement before requesting a token", async () => {
    const store = await temporaryStore()
    await store.write({ ...expired, expiresAt: Date.now() + 900_000 })
    const accessToken = createAccessTokenProvider(credentialIdentity(expired), store, async () => {
      throw new Error("A changed credential must not be used.")
    })
    await store.write({
      ...expired,
      baseUrl: "https://other.example",
      resource: "https://other.example/api",
      tokenEndpoint: "https://other.example/api/auth/oauth2/token",
      revocationEndpoint: "https://other.example/api/auth/oauth2/revoke",
      expiresAt: Date.now() + 900_000,
    })
    await expect(accessToken()).rejects.toThrow("Credential identity changed")
  })

  test("recovers a stale lock and clears timeout waits", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    await writeFile(`${store.path}.refresh.lock`, JSON.stringify({
      owner: "stale",
      pid: 999_999,
      createdAt: 0,
    }), { mode: 0o600 })
    const stale = await store.acquireRefreshLock(20)
    await stale.release()
    const held = await store.acquireRefreshLock(20)
    await expect(createCredentialStore(store.path).acquireRefreshLock(20)).rejects.toThrow("Timed out waiting")
    await held.release()
    const successor = await store.acquireRefreshLock(20)
    await successor.release()
  })

  test("later login persistence wins after refresh, cleanup, or logout lock holders", async () => {
    const store = await temporaryStore()
    const login = {
      ...expired,
      accessToken: "login-access",
      refreshToken: "login-refresh",
      expiresAt: Date.now() + 900_000,
    }
    for (const operation of [
      async () => { await store.write({ ...expired, accessToken: "refreshed", refreshToken: "refreshed-token" }) },
      async () => { await store.remove() },
      async () => { await store.remove() },
    ]) {
      await store.write(expired)
      const lock = await store.acquireRefreshLock()
      const pendingLogin = persistLoginCredentials(createCredentialStore(store.path), login)
      await operation()
      await lock.release()
      await pendingLogin
      expect(await store.read()).toEqual(login)
    }
  })

  test("refresh waits for logout and cannot persist a successor", async () => {
    const store = await temporaryStore()
    await store.write(expired)
    let releaseRevocation: (() => void) | undefined
    const revocationStarted = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    const pendingLogout = logout(store, async () => {
      await revocationStarted
      return new Response(null, { status: 200 })
    })
    const refresh = createAccessTokenProvider(credentialIdentity(expired), createCredentialStore(store.path), async () => Response.json({
      access_token: "should-not-persist",
      refresh_token: "should-not-persist",
      token_type: "Bearer",
      expires_in: 900,
      scope: "control:read control:write offline_access",
    }))
    const pendingRefresh = refresh()
    releaseRevocation?.()
    await expect(pendingLogout).resolves.toEqual({ revoked: true })
    await expect(pendingRefresh).rejects.toThrow("OAuth credential refresh failed")
    expect(await store.read()).toBeUndefined()
  })
})
