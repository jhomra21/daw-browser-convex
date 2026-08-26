import {
  credentialIdentity,
  createCredentialStore,
  sameCredentialIdentity,
  type ControlCredentialIdentity,
  type ControlCredentials,
} from "./credentials"
import { normalizeControlOrigin } from "@daw-browser/control-sdk"
import { z } from "zod"

const requestedScopes = ["control:read", "control:write", "offline_access"]
const refreshSkewMs = 60_000

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type AuthorizationMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint: string;
}

type OAuthToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export class CredentialIdentityChangedError extends Error {
  constructor() {
    super("Credential identity changed. Restart or log in again.")
    this.name = "CredentialIdentityChangedError"
  }
}

class OAuthRefreshRejectedError extends Error {}

export const persistLoginCredentials = async (
  store: ReturnType<typeof createCredentialStore>,
  credentials: ControlCredentials,
) => {
  const lock = await store.acquireRefreshLock()
  try {
    await store.write(credentials)
  } finally {
    await lock.release()
  }
}

const oauthResourceMetadataSchema = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()),
  scopes_supported: z.array(z.string()),
}).passthrough()
const oauthAuthorizationMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  revocation_endpoint: z.string().url(),
  response_types_supported: z.array(z.string()),
  grant_types_supported: z.array(z.string()),
  token_endpoint_auth_methods_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()),
}).passthrough()
const oauthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().finite().positive(),
  scope: z.string().optional(),
}).passthrough()
const oauthErrorSchema = z.object({ error: z.string() }).passthrough()
const oauthRegistrationSchema = z.object({ client_id: z.string().min(1) }).passthrough()

const secureRandom = (bytes: number) => {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  return Buffer.from(value).toString("base64url")
}

export const pkceChallenge = async (verifier: string) => (
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url")
)

export const normalizeBaseUrl = normalizeControlOrigin

const urlAtOrigin = (value: string, origin: string, field: string) => {
  const url = new URL(value)
  if (url.origin !== origin || url.protocol !== new URL(origin).protocol) throw new Error(`OAuth metadata has an invalid ${field}.`)
  return url.toString()
}

const metadata = async (origin: string, requestFetch: FetchLike): Promise<AuthorizationMetadata> => {
  const [resourceResponse, authorizationResponse] = await Promise.all([
    requestFetch(`${origin}/.well-known/oauth-protected-resource/api`),
    requestFetch(`${origin}/.well-known/oauth-authorization-server`),
  ])
  if (!resourceResponse.ok || !authorizationResponse.ok) throw new Error("OAuth metadata discovery failed.")
  const [resourceResult, authorizationResult] = await Promise.all([
    resourceResponse.json().then((body) => oauthResourceMetadataSchema.safeParse(body)),
    authorizationResponse.json().then((body) => oauthAuthorizationMetadataSchema.safeParse(body)),
  ])
  if (!resourceResult.success || resourceResult.data.resource !== `${origin}/api`) throw new Error("OAuth protected resource metadata is invalid.")
  const resource = resourceResult.data
  const authorization = authorizationResult.success ? authorizationResult.data : undefined
  if (!resource.authorization_servers.length || resource.authorization_servers.length !== 1 || resource.authorization_servers[0] !== origin
    || !requestedScopes.every((scope) => resource.scopes_supported.includes(scope))) {
    throw new Error("OAuth protected resource metadata is unsupported.")
  }
  if (!authorization || authorization.issuer !== origin) throw new Error("OAuth authorization metadata is invalid.")
  if (!authorization.response_types_supported.includes("code")
    || !authorization.grant_types_supported.includes("authorization_code")
    || !authorization.grant_types_supported.includes("refresh_token")
    || !authorization.token_endpoint_auth_methods_supported.includes("none")
    || !authorization.code_challenge_methods_supported.includes("S256")
    || !requestedScopes.every((scope) => authorization.scopes_supported.includes(scope))) {
    throw new Error("OAuth authorization metadata is unsupported.")
  }
  return {
    issuer: origin,
    authorizationEndpoint: urlAtOrigin(authorization.authorization_endpoint, origin, "authorization_endpoint"),
    tokenEndpoint: urlAtOrigin(authorization.token_endpoint, origin, "token_endpoint"),
    registrationEndpoint: urlAtOrigin(authorization.registration_endpoint, origin, "registration_endpoint"),
    revocationEndpoint: urlAtOrigin(authorization.revocation_endpoint, origin, "revocation_endpoint"),
  }
}

const parseToken = async (response: Response, expectedScopes: string[]): Promise<OAuthToken> => {
  const body = await response.json().catch(() => undefined)
  if (!response.ok) {
    if (oauthErrorSchema.safeParse(body).data?.error === "invalid_grant") throw new OAuthRefreshRejectedError()
    throw new Error("OAuth token request failed.")
  }
  const parsed = oauthTokenSchema.safeParse(body)
  if (!parsed.success) throw new Error("OAuth token response is invalid.")
  const scopes = (parsed.data.scope ?? expectedScopes.join(" ")).split(" ").filter(Boolean)
  if (!expectedScopes.every((scope) => scopes.includes(scope))) throw new Error("OAuth token response has insufficient scopes.")
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: Date.now() + parsed.data.expires_in * 1000,
    scopes,
  }
}

const tokenRequest = async (
  endpoint: string,
  values: Record<string, string>,
  requestFetch: FetchLike,
  expectedScopes: string[],
) => {
  const response = await requestFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(values),
    credentials: "omit",
  })
  return parseToken(response, expectedScopes)
}

const registerClient = async (
  endpoint: string,
  redirectUri: string,
  requestFetch: FetchLike,
) => {
  const response = await requestFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "DAW Browser Control CLI",
      redirect_uris: [redirectUri],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
      scope: requestedScopes.join(" "),
      require_pkce: true,
    }),
    credentials: "omit",
  })
  const body = oauthRegistrationSchema.safeParse(await response.json().catch(() => undefined))
  if (!response.ok || !body.success) {
    throw new Error("OAuth client registration failed.")
  }
  return body.data.client_id
}

type Callback = { code: string } | { error: true }

const startCallback = async (state: string) => {
  const path = `/${secureRandom(24)}`
  let resolveCallback: (value: Callback) => void = () => undefined
  const callback = new Promise<Callback>((resolve) => { resolveCallback = resolve })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== path) return new Response("Not found.", { status: 404 })
      if (url.searchParams.get("state") !== state || url.searchParams.get("error") || !url.searchParams.get("code")) {
        resolveCallback({ error: true })
        return new Response("Authorization failed. You can close this window.", { status: 400 })
      }
      resolveCallback({ code: url.searchParams.get("code") ?? "" })
      return new Response("Authorization complete. You can close this window.")
    },
  })
  return {
    redirectUri: `http://127.0.0.1:${server.port}${path}`,
    callback,
    close: () => server.stop(true),
  }
}

export const login = async (
  baseUrl: string,
  options: {
    store?: ReturnType<typeof createCredentialStore>;
    fetch?: FetchLike;
    writeStderr?: (line: string) => void;
    timeoutMs?: number;
  } = {},
) => {
  const origin = normalizeBaseUrl(baseUrl)
  const requestFetch = options.fetch ?? fetch
  const store = options.store ?? createCredentialStore()
  const discovered = await metadata(origin, requestFetch)
  const state = secureRandom(32)
  const verifier = secureRandom(64)
  const callback = await startCallback(state)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const clientId = await registerClient(discovered.registrationEndpoint, callback.redirectUri, requestFetch)
    const authorizationUrl = new URL(discovered.authorizationEndpoint)
    authorizationUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      resource: `${origin}/api`,
      scope: requestedScopes.join(" "),
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
    }).toString()
    options.writeStderr?.(`${authorizationUrl}\n`)
    const timedOut = new Promise<Callback>((resolve) => {
      // OAuth is interactive; a bounded timer prevents a callback listener from leaking indefinitely.
      timeout = setTimeout(() => resolve({ error: true }), options.timeoutMs ?? 300_000)
    })
    const result = await Promise.race([callback.callback, timedOut])
    if ("error" in result) throw new Error("OAuth authorization failed or timed out.")
    const token = await tokenRequest(discovered.tokenEndpoint, {
      grant_type: "authorization_code",
      code: result.code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      resource: `${origin}/api`,
    }, requestFetch, requestedScopes)
    await persistLoginCredentials(store, {
      version: "v1",
      baseUrl: origin,
      clientId,
      ...token,
      resource: `${origin}/api`,
      tokenEndpoint: discovered.tokenEndpoint,
      revocationEndpoint: discovered.revocationEndpoint,
    })
  } finally {
    if (timeout) clearTimeout(timeout)
    callback.close()
  }
}

export const createAccessTokenProvider = (
  identity: ControlCredentialIdentity,
  store = createCredentialStore(),
  requestFetch: FetchLike = fetch,
) => {
  let refreshing: Promise<string> | undefined
  return async () => {
    const credentials = await store.read()
    if (!credentials) throw new Error("Run daw-control auth login first.")
    if (!sameCredentialIdentity(identity, credentials)) throw new CredentialIdentityChangedError()
    if (credentials.expiresAt > Date.now() + refreshSkewMs) return credentials.accessToken
    refreshing ??= (async () => {
      let lock: Awaited<ReturnType<typeof store.acquireRefreshLock>> | undefined
      let refreshToken: string | undefined
      try {
        lock = await store.acquireRefreshLock()
        const current = await store.read()
        if (!current) throw new Error("Run daw-control auth login first.")
        if (!sameCredentialIdentity(identity, current)) throw new CredentialIdentityChangedError()
        if (current.expiresAt > Date.now() + refreshSkewMs) return current.accessToken
        refreshToken = current.refreshToken
        const token = await tokenRequest(current.tokenEndpoint, {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: current.clientId,
          resource: current.resource,
        }, requestFetch, current.scopes)
        const latest = await store.read()
        if (!latest) throw new Error("Run daw-control auth login first.")
        if (!sameCredentialIdentity(identity, latest)) throw new CredentialIdentityChangedError()
        if (latest.refreshToken !== refreshToken) {
          if (latest.expiresAt > Date.now() + refreshSkewMs) return latest.accessToken
          throw new Error("Credential refresh generation changed. Restart or log in again.")
        }
        const next: ControlCredentials = { ...latest, ...token }
        await store.write(next)
        return next.accessToken
      } catch (error) {
        if (error instanceof CredentialIdentityChangedError) throw error
        if (error instanceof OAuthRefreshRejectedError && refreshToken) {
          await store.removeIfRefreshTokenMatches(refreshToken)
          throw new Error("OAuth credentials are no longer valid. Run daw-control auth login.")
        }
        throw new Error("OAuth credential refresh failed. Try again.")
      } finally {
        await lock?.release()
        refreshing = undefined
      }
    })()
    return refreshing
  }
}

export const logout = async (
  store = createCredentialStore(),
  requestFetch: FetchLike = fetch,
) => {
  const lock = await store.acquireRefreshLock()
  try {
    const credentials = await store.read()
    if (!credentials) return { revoked: false }
    const identity = credentialIdentity(credentials)
    const revoke = async (token: string) => {
      const response = await requestFetch(credentials.revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: credentials.clientId }),
        credentials: "omit",
        signal: AbortSignal.timeout(10_000),
      })
      return response.ok
    }
    const results = await Promise.allSettled([revoke(credentials.refreshToken), revoke(credentials.accessToken)])
    await store.removeIfMatches(identity, credentials.refreshToken, credentials.accessToken)
    return { revoked: results.every((result) => result.status === "fulfilled" && result.value) }
  } finally {
    await lock.release()
  }
}
