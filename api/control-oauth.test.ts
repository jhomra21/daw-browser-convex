import { describe, expect, test } from "bun:test";
import {
  CONTROL_ACCESS_TOKEN_SECONDS,
  CONTROL_REFRESH_TOKEN_SECONDS,
  canConsumeControlRefresh,
  controlBearerChallenge,
  getControlOAuthOrigin,
  getControlOAuthResource,
  isActiveControlBinding,
  normalizeVerifiedControlClaims,
  oauthAuthorizationServerMetadata,
  oauthProtectedResourceMetadata,
  proxyWithoutCookies,
  registrationRateHeaders,
  registrationRateSql,
  registrationRateWindow,
  validateControlAuthorizationRequest,
  validateControlClientRegistration,
  validateControlTokenRequest,
} from "./control-oauth";

const approvedOrigins = new Set(["https://app.example.test"]);

const validRegistration = {
  client_name: "Control client",
  redirect_uris: ["http://127.0.0.1:43123/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  scope: "control:read offline_access",
  require_pkce: true,
};

describe("control OAuth policy", () => {
  test("normalizes the canonical resource", () => {
    expect(getControlOAuthOrigin("https://daw.example.test/app/", "http://ignored.test/path")).toBe("https://daw.example.test");
    expect(getControlOAuthResource("https://daw.example.test/app/", "http://ignored.test/path")).toBe("https://daw.example.test/api");
    expect(controlBearerChallenge("https://daw.example.test")).toBe('Bearer resource_metadata="https://daw.example.test/.well-known/oauth-protected-resource/api"');
  });

  test("advertises OAuth-only metadata and token lifetimes", async () => {
    const origin = "https://daw.example.test";
    const authorization = await oauthAuthorizationServerMetadata(origin).json();
    const resource = await oauthProtectedResourceMetadata(origin).json();
    expect(authorization).toEqual({
      issuer: origin,
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      token_endpoint: `${origin}/api/auth/oauth2/token`,
      registration_endpoint: `${origin}/api/auth/oauth2/register`,
      revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["control:read", "control:write", "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
    expect(resource).toEqual({
      resource: `${origin}/api`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["control:read", "control:write", "offline_access"],
    });
    expect(CONTROL_ACCESS_TOKEN_SECONDS).toBe(900);
    expect(CONTROL_REFRESH_TOKEN_SECONDS).toBe(604800);
  });

  test("accepts only bounded public-client metadata", () => {
    expect(validateControlClientRegistration(validRegistration, approvedOrigins)).toBeNull();
    expect(validateControlClientRegistration({
      ...validRegistration,
      redirect_uris: ["https://app.example.test/callback"],
    }, approvedOrigins)).toBeNull();
  });

  test("rejects insecure registrations before Better Auth", () => {
    expect(validateControlClientRegistration({
      ...validRegistration,
      redirect_uris: ["http://localhost:43123/callback"],
    }, approvedOrigins)).toBe("unsupported redirect URI");
    expect(validateControlClientRegistration({
      ...validRegistration,
      redirect_uris: ["http://127.0.0.1:0/callback"],
    }, approvedOrigins)).toBe("unsupported redirect URI");
    expect(validateControlClientRegistration({
      ...validRegistration,
      redirect_uris: ["https://bad.example.invalid/callback#fragment"],
    }, approvedOrigins)).toBe("unsupported redirect URI");
    expect(validateControlClientRegistration({ ...validRegistration, require_pkce: false }, approvedOrigins)).toBe("PKCE is required");
    expect(validateControlClientRegistration({ ...validRegistration, response_types: ["token"] }, approvedOrigins)).toBe('response_types must be ["code"]');
    expect(validateControlClientRegistration({ ...validRegistration, grant_types: ["client_credentials"] }, approvedOrigins)).toBe("unsupported grant_types");
    expect(validateControlClientRegistration({ ...validRegistration, scope: "openid" }, approvedOrigins)).toBe("unsupported scope");
    expect(validateControlClientRegistration({ ...validRegistration, client_secret: "never" }, approvedOrigins)).toBe("unsupported client metadata");
  });

  test("requires exactly one canonical resource and S256 PKCE at authorization", () => {
    const resource = "https://daw.example.test/api";
    expect(validateControlAuthorizationRequest(
      new URL(`https://daw.example.test/api/auth/oauth2/authorize?resource=${encodeURIComponent(resource)}&code_challenge=challenge&code_challenge_method=S256`),
      resource,
    )).toBeNull();
    expect(validateControlAuthorizationRequest(
      new URL(`https://daw.example.test/api/auth/oauth2/authorize?resource=${encodeURIComponent(resource)}`),
      resource,
    )).toBe("S256 PKCE is required");
    expect(validateControlAuthorizationRequest(
      new URL(`https://daw.example.test/api/auth/oauth2/authorize?resource=${encodeURIComponent(resource)}&code_challenge=challenge&code_challenge_method=plain`),
      resource,
    )).toBe("only S256 PKCE is supported");
    expect(validateControlAuthorizationRequest(
      new URL(`https://daw.example.test/api/auth/oauth2/authorize?resource=${encodeURIComponent(resource)}&resource=${encodeURIComponent(resource)}&code_challenge=challenge&code_challenge_method=S256`),
      resource,
    )).toBe("resource must be the control API");
  });

  test("requires public-client PKCE at token exchange", () => {
    const resource = "https://daw.example.test/api";
    const valid = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "public-client",
      resource,
      code_verifier: "a".repeat(43),
    });
    expect(validateControlTokenRequest(valid, resource)).toBeNull();
    expect(validateControlTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "public-client",
      resource,
      code_verifier: "short",
    }), resource)).toBe("S256 PKCE is required");
    expect(validateControlTokenRequest(new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "public-client",
      resource,
      code_verifier: "a".repeat(43),
      client_secret: "not-a-secret",
    }), resource)).toBe("only public clients are supported");
    expect(validateControlTokenRequest(new URLSearchParams({
      grant_type: "client_credentials",
      resource,
    }), resource)).toBe("unsupported grant type");
  });

  test("rejects expired, revoked, wrong-resource, and underscoped bindings", () => {
    const binding = {
      resource: "https://daw.example.test/api",
      revokedAt: null,
      expiresAt: 100,
      scopes: "control:read offline_access",
    };
    expect(isActiveControlBinding(binding, binding.resource, "control:read", 99)).toBeTrue();
    expect(isActiveControlBinding(binding, "https://other.example.test/api", "control:read", 99)).toBeFalse();
    expect(isActiveControlBinding(binding, binding.resource, "control:write", 99)).toBeFalse();
    expect(isActiveControlBinding(binding, binding.resource, "control:read", 100)).toBeFalse();
    expect(isActiveControlBinding({ ...binding, revokedAt: 99 }, binding.resource, "control:read", 99)).toBeFalse();
  });

  test("persists only token hashes in the control binding migration", async () => {
    const migration = await Bun.file(new URL("../migrations/0003_control_oauth_provider.sql", import.meta.url)).text();
    expect(migration).toContain("accessTokenHash TEXT NOT NULL UNIQUE");
    expect(migration).toContain("refreshTokenHash TEXT UNIQUE");
    expect(migration).toContain("replacedById TEXT");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS controlOAuthTokenFamily");
    expect(migration).toContain("familyId TEXT NOT NULL REFERENCES controlOAuthTokenFamily(id) ON DELETE CASCADE");
    expect(migration).toContain("oauthClient");
    expect(migration).toContain("userId TEXT REFERENCES user(id) ON DELETE CASCADE");
    expect(migration).toContain("controlOAuthRegistrationRate");
    expect(migration).toContain("PRIMARY KEY (networkHash, windowStart)");
    expect(migration).not.toContain("accessToken TEXT");
    expect(migration).not.toContain("refreshToken TEXT");
  });

  test("prunes expired registration windows and reports persistent fixed-window limits", () => {
    const sql = registrationRateSql();
    expect(sql.cleanup).toBe("DELETE FROM controlOAuthRegistrationRate WHERE windowStart < ?");
    expect(sql.increment).toContain("ON CONFLICT(networkHash, windowStart) DO UPDATE SET count = count + 1");
    expect(registrationRateWindow(125)).toBe(120);
    expect(registrationRateHeaders(1, 120)).toEqual({
      "RateLimit-Limit": "5",
      "RateLimit-Remaining": "4",
      "RateLimit-Reset": "180",
    });
    expect(registrationRateHeaders(6, 120)["RateLimit-Remaining"]).toBe("0");
  });

  test("enforces the sixth registration request in a fixed window", () => {
    const counts = [1, 2, 3, 4, 5, 6];
    expect(counts.map((count) => registrationRateHeaders(count, 120)["RateLimit-Remaining"])).toEqual([
      "4", "3", "2", "1", "0", "0",
    ]);
    expect(counts.filter((count) => count > 5)).toEqual([6]);
  });

  test("strips cookies before non-browser OAuth proxy calls", () => {
    const request = new Request("https://daw.example.test/api/auth/oauth2/token", {
      method: "POST",
      headers: {
        cookie: "session=browser-session",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=authorization_code",
    });
    const forwarded = proxyWithoutCookies(request);
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  test("uses the installed Better Auth JWT and OAuth provider claim contract", async () => {
    const jwtTypes = await Bun.file(new URL("../node_modules/better-auth/dist/plugins/jwt/index.d.mts", import.meta.url)).text();
    const provider = await Bun.file(new URL("../node_modules/@better-auth/oauth-provider/dist/index.mjs", import.meta.url)).text();
    expect(jwtTypes).toContain("token: string;");
    expect(jwtTypes).toContain("issuer?: string;");
    expect(provider).toContain("azp: client.clientId");
    expect(provider).toContain('aud: typeof audience === "string" ? audience');
    expect(provider).toContain("scope: scopes.join(\" \")");
  });

  test("rejects forged or mismatched verified claim input", () => {
    const resource = "https://daw.example.test/api";
    const issuedAt = Math.floor(Date.now() / 1000);
    const valid = {
      sub: "user-id",
      azp: "client-id",
      aud: resource,
      scope: "control:read",
      sid: "session-id",
      iss: "https://daw.example.test",
      iat: issuedAt,
      exp: issuedAt + 900,
    };
    expect(normalizeVerifiedControlClaims(valid, resource)?.clientId).toBe("client-id");
    expect(normalizeVerifiedControlClaims({ ...valid, aud: "https://other.example.test/api" }, resource)).toBeNull();
    expect(normalizeVerifiedControlClaims({ ...valid, azp: 17 }, resource)).toBeNull();
    expect(normalizeVerifiedControlClaims({ ...valid, scope: "openid" }, resource)).toBeNull();
    expect(normalizeVerifiedControlClaims({ ...valid, exp: issuedAt }, resource)).toBeNull();
  });

  test("permits one live refresh transition and rejects replay, expiry, or revocation", () => {
    const binding = {
      clientId: "client-id",
      resource: "https://daw.example.test/api",
      refreshConsumedAt: null,
      refreshExpiresAt: 100,
      revokedAt: null,
    };
    expect(canConsumeControlRefresh(binding, "client-id", binding.resource, 99)).toBeTrue();
    expect(canConsumeControlRefresh({ ...binding, refreshConsumedAt: 99 }, "client-id", binding.resource, 99)).toBeFalse();
    expect(canConsumeControlRefresh({ ...binding, refreshExpiresAt: 99 }, "client-id", binding.resource, 99)).toBeFalse();
    expect(canConsumeControlRefresh({ ...binding, revokedAt: 99 }, "client-id", binding.resource, 99)).toBeFalse();
  });
});
