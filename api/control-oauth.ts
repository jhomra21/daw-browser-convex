import type { Context } from "hono";
import type { ApiBindings } from "./app-types";

export type ControlOAuthScope = "control:read" | "control:write" | "offline_access";

export const CONTROL_OAUTH_SCOPES: ControlOAuthScope[] = ["control:read", "control:write", "offline_access"];
export const CONTROL_ACCESS_TOKEN_SECONDS = 900;
export const CONTROL_REFRESH_TOKEN_SECONDS = 604800;
const DCR_WINDOW_SECONDS = 60;
const DCR_MAX_REQUESTS = 5;

type BindingRow = {
  id: string;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  familyId: string;
  userId: string;
  clientId: string;
  sessionId: string | null;
  resource: string;
  scopes: string;
  expiresAt: number;
  refreshExpiresAt: number | null;
  refreshConsumedAt: number | null;
  replacedById: string | null;
  revokedAt: number | null;
  issuer: string;
};

type FamilyRow = {
  id: string;
  userId: string;
  clientId: string;
  compromisedAt: number | null;
  revokedAt: number | null;
};

type VerifiedControlClaims = {
  userId: string;
  clientId: string;
  scopes: string[];
  sessionId: string | null;
  issuer: string;
  expiresAt: number;
  issuedAt: number;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

type JsonRecord = Record<string, unknown>;

export type ControlBearer = {
  userId: string;
  issuer: string;
  tokenIdentifier: string;
  clientId: string;
  scopes: string[];
};

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const unixSeconds = () => Math.floor(Date.now() / 1000);

const parseScopes = (value: string) => value.split(" ").filter((scope) => scope.length > 0);

const isControlOAuthScope = (scope: string): scope is ControlOAuthScope => (
  scope === "control:read" || scope === "control:write" || scope === "offline_access"
);

const hasSupportedScopes = (scopes: string[]) => scopes.every(isControlOAuthScope);

export const getControlOAuthOrigin = (baseUrl: string | undefined, requestUrl: string) => {
  const fallback = new URL(requestUrl);
  const configured = baseUrl ? new URL(baseUrl) : fallback;
  return configured.origin;
};

export const getControlOAuthResource = (baseUrl: string | undefined, requestUrl: string) => `${getControlOAuthOrigin(baseUrl, requestUrl)}/api`;

export const controlBearerChallenge = (origin: string) => `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api"`;

const oauthError = (error: string, description: string, status = 400) => Response.json(
  { error, error_description: description },
  { status, headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
);

const requestIpHash = async (request: Request) => {
  const ip = request.headers.get("cf-connecting-ip");
  return ip && ip.length <= 128 ? sha256(ip) : null;
};

export const registrationRateWindow = (now: number) => Math.floor(now / DCR_WINDOW_SECONDS) * DCR_WINDOW_SECONDS;

export const registrationRateSql = () => ({
  cleanup: "DELETE FROM controlOAuthRegistrationRate WHERE windowStart < ?",
  increment: `INSERT INTO controlOAuthRegistrationRate (networkHash, windowStart, count)
    VALUES (?, ?, 1)
    ON CONFLICT(networkHash, windowStart) DO UPDATE SET count = count + 1
    RETURNING count`,
});

export const registrationRateHeaders = (count: number, windowStart: number) => ({
  "RateLimit-Limit": String(DCR_MAX_REQUESTS),
  "RateLimit-Remaining": String(Math.max(0, DCR_MAX_REQUESTS - count)),
  "RateLimit-Reset": String(windowStart + DCR_WINDOW_SECONDS),
});

const formData = async (request: Pick<Request, "headers" | "text">) => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) return null;
  return new URLSearchParams(await request.text());
};

const isPkceVerifier = (value: string | null) => value !== null && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);

export const validateControlAuthorizationRequest = (url: URL, resource: string): string | null => {
  if (url.searchParams.getAll("resource").length !== 1 || url.searchParams.get("resource") !== resource) return "resource must be the control API";
  if (url.searchParams.getAll("code_challenge").length !== 1 || !url.searchParams.get("code_challenge")) return "S256 PKCE is required";
  if (url.searchParams.getAll("code_challenge_method").length !== 1 || url.searchParams.get("code_challenge_method") !== "S256") return "only S256 PKCE is supported";
  return null;
};

export const validateControlTokenRequest = (body: URLSearchParams, resource: string): string | null => {
  if (body.getAll("resource").length !== 1 || body.get("resource") !== resource) return "resource must be the control API";
  const grant = body.get("grant_type");
  if (grant !== "authorization_code" && grant !== "refresh_token") return "unsupported grant type";
  if (body.get("client_secret")) return "only public clients are supported";
  if (grant === "authorization_code" && (!body.get("client_id") || !isPkceVerifier(body.get("code_verifier")))) return "S256 PKCE is required";
  return null;
};

const supportedGrantTypes = (values: unknown) => {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return false;
  return values.length === 1 && values[0] === "authorization_code"
    || values.length === 2 && values[0] === "authorization_code" && values[1] === "refresh_token";
};

const approvedHttpsOrigins = (value: string | undefined) => new Set(
  value?.split(",").map((origin) => origin.trim()).filter((origin) => {
    try {
      return new URL(origin).origin === origin && new URL(origin).protocol === "https:";
    } catch {
      return false;
    }
  }) ?? [],
);

const validRedirectUri = (value: string, approvedOrigins: Set<string>) => {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && Number(url.port) > 0) return true;
    return url.protocol === "https:" && approvedOrigins.has(url.origin);
  } catch {
    return false;
  }
};

export const validateControlClientRegistration = (
  body: unknown,
  approvedOrigins: Set<string>,
): string | null => {
  if (!isRecord(body)) return "metadata must be a JSON object";
  const allowedKeys = new Set([
    "client_name", "client_uri", "logo_uri", "contacts", "tos_uri", "policy_uri",
    "software_id", "software_version", "redirect_uris", "token_endpoint_auth_method",
    "grant_types", "response_types", "scope", "require_pkce",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return "unsupported client metadata";
  if (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code") return "response_types must be [\"code\"]";
  if (!supportedGrantTypes(body.grant_types)) return "unsupported grant_types";
  if (body.token_endpoint_auth_method !== "none") return "token_endpoint_auth_method must be none";
  if (body.require_pkce !== true) return "PKCE is required";
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0 || body.redirect_uris.length > 8) return "redirect_uris must contain 1-8 URIs";
  if (body.redirect_uris.some((uri) => typeof uri !== "string" || uri.length > 2048 || !validRedirectUri(uri, approvedOrigins))) return "unsupported redirect URI";
  if (typeof body.scope !== "string" || body.scope.length === 0 || body.scope.length > 200 || !hasSupportedScopes(parseScopes(body.scope))) return "unsupported scope";
  for (const key of ["client_name", "client_uri", "logo_uri", "tos_uri", "policy_uri", "software_id", "software_version"]) {
    const value = body[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 512)) return `invalid ${key}`;
  }
  if (body.contacts !== undefined && (!Array.isArray(body.contacts) || body.contacts.length > 8 || body.contacts.some((item) => typeof item !== "string" || item.length > 320))) return "invalid contacts";
  return null;
};

const tokenResponse = async (response: Response): Promise<TokenResponse | null> => {
  if (!response.ok) return null;
  const value: unknown = await response.clone().json().catch(() => null);
  if (!isRecord(value)
    || typeof value.access_token !== "string"
    || typeof value.token_type !== "string"
    || typeof value.expires_in !== "number"
    || (value.refresh_token !== undefined && typeof value.refresh_token !== "string")
    || (value.scope !== undefined && typeof value.scope !== "string")) return null;
  return {
    access_token: value.access_token,
    token_type: value.token_type,
    expires_in: value.expires_in,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    scope: typeof value.scope === "string" ? value.scope : undefined,
  };
};

const db = (env: ApiBindings["Bindings"]) => env.daw_convex_auth;

export const normalizeVerifiedControlClaims = (
  payload: Record<string, unknown> | null,
  resource: string,
): VerifiedControlClaims | null => {
  if (
    !payload
    || typeof payload.sub !== "string"
    || typeof payload.azp !== "string"
    || typeof payload.scope !== "string"
    || typeof payload.iss !== "string"
    || typeof payload.exp !== "number"
    || typeof payload.iat !== "number"
    || typeof payload.sid !== "string"
    || payload.aud !== resource
  ) return null;
  const scopes = parseScopes(payload.scope);
  if (!hasSupportedScopes(scopes) || payload.exp <= unixSeconds()) return null;
  return {
    userId: payload.sub,
    clientId: payload.azp,
    scopes,
    sessionId: payload.sid,
    issuer: payload.iss,
    expiresAt: payload.exp,
    issuedAt: payload.iat,
  };
};

const verifyControlAccessToken = async (
  env: ApiBindings["Bindings"],
  token: string,
  origin: string,
  resource: string,
): Promise<VerifiedControlClaims | null> => {
  try {
    const { createAuth } = await import("./auth");
    const { payload } = await createAuth(env).api.verifyJWT({
      body: { token, issuer: origin },
    });
    return normalizeVerifiedControlClaims(payload, resource);
  } catch {
    return null;
  }
};

export const controlBindingMatchesClaims = (
  binding: BindingRow,
  claims: VerifiedControlClaims,
  resource: string,
) => (
  binding.userId === claims.userId
  && binding.clientId === claims.clientId
  && binding.resource === resource
  && binding.issuer === claims.issuer
  && binding.expiresAt === claims.expiresAt
  && binding.sessionId === claims.sessionId
  && binding.scopes === claims.scopes.join(" ")
);

export const isActiveControlBinding = (
  binding: Pick<BindingRow, "resource" | "revokedAt" | "expiresAt" | "scopes">,
  resource: string,
  requiredScope: ControlOAuthScope,
  now: number,
) => (
  binding.resource === resource
  && binding.revokedAt === null
  && binding.expiresAt > now
  && parseScopes(binding.scopes).includes(requiredScope)
);

export const canConsumeControlRefresh = (
  binding: Pick<BindingRow, "clientId" | "resource" | "refreshConsumedAt" | "refreshExpiresAt" | "revokedAt">,
  clientId: string,
  resource: string,
  now: number,
) => (
  binding.clientId === clientId
  && binding.resource === resource
  && binding.refreshConsumedAt === null
  && binding.revokedAt === null
  && binding.refreshExpiresAt !== null
  && binding.refreshExpiresAt > now
);

const createBindingStatements = async (
  env: ApiBindings["Bindings"],
  token: TokenResponse,
  resource: string,
  origin: string,
  familyId?: string,
  prior?: BindingRow,
) => {
  const claims = await verifyControlAccessToken(env, token.access_token, origin, resource);
  if (!claims || token.expires_in !== CONTROL_ACCESS_TOKEN_SECONDS || claims.expiresAt - claims.issuedAt !== CONTROL_ACCESS_TOKEN_SECONDS) return null;
  if (token.scope !== undefined && token.scope !== claims.scopes.join(" ")) return null;
  if (!await hasAuthoritativeIdentity(env, claims)) return null;
  if (prior && (
    claims.userId !== prior.userId
    || claims.clientId !== prior.clientId
    || claims.sessionId !== prior.sessionId
    || claims.scopes.some((scope) => !parseScopes(prior.scopes).includes(scope))
  )) return null;

  const id = crypto.randomUUID();
  const resolvedFamilyId = familyId ?? id;
  const accessTokenHash = await sha256(token.access_token);
  const refreshTokenHash = token.refresh_token ? await sha256(token.refresh_token) : null;
  const now = unixSeconds();
  const statement = db(env).prepare(
    `INSERT INTO controlOAuthTokenBinding (
      id, accessTokenHash, refreshTokenHash, familyId, userId, clientId, sessionId,
      resource, scopes, issuer, expiresAt, refreshExpiresAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, accessTokenHash, refreshTokenHash, resolvedFamilyId, claims.userId, claims.clientId,
    claims.sessionId, resource, claims.scopes.join(" "), claims.issuer, claims.expiresAt,
    refreshTokenHash ? now + CONTROL_REFRESH_TOKEN_SECONDS : null, now, now,
  );
  const familyStatement = familyId ? null : db(env).prepare(
    `INSERT INTO controlOAuthTokenFamily (
      id, userId, clientId, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?)`,
  ).bind(resolvedFamilyId, claims.userId, claims.clientId, now, now);
  return { id, statement, familyStatement, claims };
};

const getBindingByHash = async (env: ApiBindings["Bindings"], tokenHash: string) => {
  const result = await db(env).prepare(
    `SELECT binding.*
     FROM controlOAuthTokenBinding binding
     JOIN controlOAuthTokenFamily family ON family.id = binding.familyId
     WHERE binding.accessTokenHash = ?
       AND family.compromisedAt IS NULL
       AND family.revokedAt IS NULL`,
  ).bind(tokenHash).first<BindingRow>();
  return result ?? null;
};

const compromiseAndInvalidateControlFamily = async (
  env: ApiBindings["Bindings"],
  family: Pick<FamilyRow, "clientId" | "userId">,
  familyId: string,
  now: number,
) => {
  try {
    await db(env).batch([
      db(env).prepare(
        `UPDATE controlOAuthTokenFamily
         SET compromisedAt = COALESCE(compromisedAt, ?), revokedAt = COALESCE(revokedAt, ?), updatedAt = ?
         WHERE id = ?`,
      ).bind(now, now, now, familyId),
      db(env).prepare(
        `UPDATE controlOAuthTokenBinding
         SET revokedAt = COALESCE(revokedAt, ?), updatedAt = ?
         WHERE familyId = ?`,
      ).bind(now, now, familyId),
      db(env).prepare("DELETE FROM oauthAccessToken WHERE clientId = ? AND userId = ?").bind(family.clientId, family.userId),
      db(env).prepare("DELETE FROM oauthRefreshToken WHERE clientId = ? AND userId = ?").bind(family.clientId, family.userId),
    ]);
  } catch {
    // The caller must return an OAuth error even when the storage boundary fails.
  }
};

const hasAuthoritativeIdentity = async (env: ApiBindings["Bindings"], claims: VerifiedControlClaims) => {
  const [client, user, session] = await Promise.all([
    db(env).prepare(
      "SELECT clientId FROM oauthClient WHERE clientId = ? AND (disabled IS NULL OR disabled = 0)",
    ).bind(claims.clientId).first<{ clientId: string }>(),
    db(env).prepare("SELECT id FROM user WHERE id = ?").bind(claims.userId).first<{ id: string }>(),
    db(env).prepare(
      "SELECT id FROM session WHERE id = ? AND userId = ? AND expiresAt > ?",
    ).bind(claims.sessionId, claims.userId, unixSeconds() * 1000).first<{ id: string }>(),
  ]);
  return Boolean(client && user && session);
};

export async function resolveControlBearer(
  request: Request,
  env: ApiBindings["Bindings"],
  requiredScope: ControlOAuthScope,
): Promise<ControlBearer | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const [scheme, token, extra] = authorization.split(" ");
  if (scheme !== "Bearer" || !token || extra) return null;

  const binding = await getBindingByHash(env, await sha256(token));
  const origin = getControlOAuthOrigin(env.BETTER_AUTH_URL, request.url);
  const resource = getControlOAuthResource(env.BETTER_AUTH_URL, request.url);
  if (!binding || !isActiveControlBinding(binding, resource, requiredScope, unixSeconds())) return null;
  const claims = await verifyControlAccessToken(env, token, origin, resource);
  if (!claims || !controlBindingMatchesClaims(binding, claims, resource)) return null;
  const scopes = parseScopes(binding.scopes);
  if (!await hasAuthoritativeIdentity(env, claims)) return null;
  return {
    userId: binding.userId,
    issuer: claims.issuer,
    tokenIdentifier: binding.id,
    clientId: binding.clientId,
    scopes,
  };
}

export const proxyWithoutCookies = (request: Request) => {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return new Request(request, { headers });
};

export const oauthAuthorizationServerMetadata = (origin: string) => Response.json({
  issuer: origin,
  authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
  token_endpoint: `${origin}/api/auth/oauth2/token`,
  registration_endpoint: `${origin}/api/auth/oauth2/register`,
  revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: CONTROL_OAUTH_SCOPES,
  authorization_response_iss_parameter_supported: true,
}, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400" } });

export const oauthProtectedResourceMetadata = (origin: string) => Response.json({
  resource: `${origin}/api`,
  authorization_servers: [origin],
  bearer_methods_supported: ["header"],
  scopes_supported: CONTROL_OAUTH_SCOPES,
}, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400" } });

export const registerControlOAuthRoutes = (app: { get: Function; post: Function }, createAuth: (env: ApiBindings["Bindings"]) => { handler: (request: Request) => Promise<Response> }) => {
  app.get("/.well-known/oauth-authorization-server", (c: Context<ApiBindings>) => oauthAuthorizationServerMetadata(getControlOAuthOrigin(c.env.BETTER_AUTH_URL, c.req.url)));
  app.get("/.well-known/oauth-protected-resource/api", (c: Context<ApiBindings>) => oauthProtectedResourceMetadata(getControlOAuthOrigin(c.env.BETTER_AUTH_URL, c.req.url)));

  app.get("/api/auth/oauth2/authorize", async (c: Context<ApiBindings>) => {
    const url = new URL(c.req.url);
    const resource = getControlOAuthResource(c.env.BETTER_AUTH_URL, c.req.url);
    const invalid = validateControlAuthorizationRequest(url, resource);
    if (invalid) return oauthError(invalid === "resource must be the control API" ? "invalid_target" : "invalid_request", invalid);
    const response = await createAuth(c.env).handler(c.req.raw);
    const location = response.headers.get("location");
    if (!location) return response;
    const redirect = new URL(location, c.req.url);
    if (redirect.origin === getControlOAuthOrigin(c.env.BETTER_AUTH_URL, c.req.url) && redirect.pathname === "/oauth/consent") {
      redirect.searchParams.set("resource", resource);
      const headers = new Headers(response.headers);
      headers.set("location", redirect.toString());
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  });

  app.post("/api/auth/oauth2/register", async (c: Context<ApiBindings>) => {
    const ipHash = await requestIpHash(c.req.raw);
    if (!ipHash) return oauthError("invalid_request", "trusted client address is required");
    const now = unixSeconds();
    const windowStart = registrationRateWindow(now);
    const sql = registrationRateSql();
    const statements = [
      db(c.env).prepare(sql.cleanup).bind(windowStart),
      db(c.env).prepare(sql.increment).bind(ipHash, windowStart),
    ];
    const results = await db(c.env).batch<{ count: number }>(statements);
    const rate = results[1].results[0];
    const count = rate?.count;
    const rateHeaders = registrationRateHeaders(count ?? DCR_MAX_REQUESTS, windowStart);
    if (count === undefined || count > DCR_MAX_REQUESTS) {
      return new Response(JSON.stringify({
        error: "slow_down",
        error_description: "dynamic client registration rate limit exceeded",
      }), {
        status: 429,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(1, windowStart + DCR_WINDOW_SECONDS - now)),
        },
      });
    }
    const body: unknown = await c.req.raw.clone().json().catch(() => null);
    const invalid = validateControlClientRegistration(body, approvedHttpsOrigins(c.env.CONTROL_OAUTH_APPROVED_REDIRECT_ORIGINS));
    if (invalid) return new Response(JSON.stringify({ error: "invalid_client_metadata", error_description: invalid }), { status: 400, headers: { ...rateHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    const response = await createAuth(c.env).handler(proxyWithoutCookies(c.req.raw));
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(rateHeaders)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  });

  app.post("/api/auth/oauth2/token", async (c: Context<ApiBindings>) => {
    const request = proxyWithoutCookies(c.req.raw);
    const body = await formData(request.clone());
    const resource = getControlOAuthResource(c.env.BETTER_AUTH_URL, c.req.url);
    if (!body) return oauthError("invalid_request", "form encoding is required");
    const invalid = validateControlTokenRequest(body, resource);
    if (invalid) return oauthError(invalid === "resource must be the control API" ? "invalid_target" : invalid === "unsupported grant type" ? "unsupported_grant_type" : invalid === "only public clients are supported" ? "invalid_client" : "invalid_request", invalid);
    if (request.headers.has("authorization")) return oauthError("invalid_client", "only public clients are supported");
    const grant = body.get("grant_type");

    let prior: BindingRow | null = null;
    if (grant === "refresh_token") {
      const refresh = body.get("refresh_token");
      if (!refresh) return oauthError("invalid_request", "refresh_token is required");
      const refreshHash = await sha256(refresh);
      prior = await db(c.env).prepare(
        "SELECT * FROM controlOAuthTokenBinding WHERE refreshTokenHash = ?",
      ).bind(refreshHash).first<BindingRow>() ?? null;
      if (!prior) return oauthError("invalid_grant", "invalid refresh token");
      const now = unixSeconds();
      if (
        prior.clientId !== (body.get("client_id") ?? "")
        || prior.resource !== resource
        || prior.refreshExpiresAt === null
        || prior.refreshExpiresAt <= now
      ) return oauthError("invalid_grant", "invalid refresh token");
      const operations = await db(c.env).batch([
        db(c.env).prepare(
          `UPDATE controlOAuthTokenBinding
           SET refreshConsumedAt = ?, updatedAt = ?
           WHERE id = ?
             AND clientId = ?
             AND resource = ?
             AND refreshConsumedAt IS NULL
             AND revokedAt IS NULL
             AND refreshExpiresAt > ?
             AND EXISTS (
               SELECT 1 FROM controlOAuthTokenFamily
               WHERE id = controlOAuthTokenBinding.familyId
                 AND compromisedAt IS NULL
                 AND revokedAt IS NULL
             )`,
        ).bind(now, now, prior.id, body.get("client_id") ?? "", resource, now),
      ]).catch(() => null);
      if (!operations || operations[0]?.meta.changes !== 1) {
        await compromiseAndInvalidateControlFamily(c.env, prior, prior.familyId, now);
        return oauthError("invalid_grant", "invalid refresh token");
      }
    }
    const response = await createAuth(c.env).handler(request);
    const token = await tokenResponse(response);
    const binding = token ? await createBindingStatements(
      c.env,
      token,
      resource,
      getControlOAuthOrigin(c.env.BETTER_AUTH_URL, c.req.url),
      prior?.familyId,
      prior ?? undefined,
    ) : null;
    if (!token || !binding) {
      if (prior) await compromiseAndInvalidateControlFamily(c.env, prior, prior.familyId, unixSeconds());
      return token ? oauthError("server_error", "token binding failed", 500) : response;
    }
    if (prior) {
      const now = unixSeconds();
      const operations = await db(c.env).batch([
        db(c.env).prepare(
          `INSERT INTO controlOAuthTokenBinding (
            id, accessTokenHash, refreshTokenHash, familyId, userId, clientId, sessionId,
            resource, scopes, issuer, expiresAt, refreshExpiresAt, createdAt, updatedAt
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM controlOAuthTokenFamily
            WHERE id = ? AND compromisedAt IS NULL AND revokedAt IS NULL
          )`,
        ).bind(
          binding.id,
          await sha256(token.access_token),
          token.refresh_token ? await sha256(token.refresh_token) : null,
          prior.familyId,
          binding.claims.userId,
          binding.claims.clientId,
          binding.claims.sessionId,
          resource,
          binding.claims.scopes.join(" "),
          binding.claims.issuer,
          binding.claims.expiresAt,
          token.refresh_token ? unixSeconds() + CONTROL_REFRESH_TOKEN_SECONDS : null,
          now,
          now,
          prior.familyId,
        ),
        db(c.env).prepare(
          `UPDATE controlOAuthTokenBinding
           SET replacedById = ?, updatedAt = ?
           WHERE id = ?
             AND replacedById IS NULL
             AND EXISTS (
               SELECT 1
               FROM controlOAuthTokenBinding successor
               JOIN controlOAuthTokenFamily family ON family.id = successor.familyId
               WHERE successor.id = ?
                 AND successor.familyId = controlOAuthTokenBinding.familyId
                 AND family.compromisedAt IS NULL
                 AND family.revokedAt IS NULL
             )`,
        ).bind(binding.id, now, prior.id, binding.id),
      ]).catch(() => null);
      if (!operations || operations[0]?.meta.changes !== 1 || operations[1]?.meta.changes !== 1) {
        await compromiseAndInvalidateControlFamily(c.env, prior, prior.familyId, now);
        return oauthError("invalid_grant", "refresh token family compromised");
      }
    } else {
      if (!binding.familyStatement) return oauthError("server_error", "token binding failed", 500);
      await db(c.env).batch([binding.familyStatement, binding.statement]);
    }
    return response;
  });

  app.post("/api/auth/oauth2/revoke", async (c: Context<ApiBindings>) => {
    const request = proxyWithoutCookies(c.req.raw);
    const body = await formData(request.clone());
    const clientId = body?.get("client_id");
    const token = body?.get("token");
    if (body && clientId && token && !body.get("client_secret") && !request.headers.has("authorization")) {
      const tokenHash = await sha256(token);
      const binding = await db(c.env).prepare(
        "SELECT * FROM controlOAuthTokenBinding WHERE (accessTokenHash = ? OR refreshTokenHash = ?) AND clientId = ?",
      ).bind(tokenHash, tokenHash, clientId).first<BindingRow>();
      if (binding) {
        const now = unixSeconds();
        await compromiseAndInvalidateControlFamily(c.env, binding, binding.familyId, now);
      }
      await createAuth(c.env).handler(request).catch(() => null);
    }
    return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
  });
};
