import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createAuth } from "./auth";
import { registerControlOAuthRoutes, resolveControlBearer } from "./control-oauth";

type Result = {
  success: boolean;
  meta: { changes: number };
  results: unknown[];
};

class Statement {
  private values: unknown[] = [];

  constructor(
    private database: Database,
    private query: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first(column?: string) {
    const row = this.database.prepare(this.query).get(...this.values);
    if (!row || !column) return row;
    return row[column];
  }

  async all() {
    const results = this.database.prepare(this.query).all(...this.values);
    return { success: true, meta: { changes: 0 }, results };
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: result.changes }, results: [] };
  }

  async raw() {
    return this.database.prepare(this.query).values(...this.values);
  }
}

class LocalD1 {
  constructor(private database: Database) {}

  prepare(query: string) {
    return new Statement(this.database, query);
  }

  async batch(statements: Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results: Result[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class LocalKv {
  private values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

const origin = "https://daw.example.test";
const resource = `${origin}/api`;
const userId = "user-1";
const clientId = "client-1";
const sessionId = "session-1";
const now = () => Math.floor(Date.now() / 1000);

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const migration = (name: string) => Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text();

const database = new Database(":memory:");
const d1 = new LocalD1(database);
const environment = {
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth",
  BETTER_AUTH_URL: origin,
  GOOGLE_CLIENT_ID: "test-google-client",
  GOOGLE_CLIENT_SECRET: "test-google-secret",
  daw_convex_auth: d1,
  daw_convex_auth_kv: new LocalKv(),
};

const request = (token: string, authorization = `Bearer ${token}`) => new Request(`${origin}/api/control`, {
  headers: { authorization },
});

const insertIdentity = () => {
  const timestamp = Date.now();
  database.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(userId, "User", "user@example.test", 1, timestamp, timestamp);
  database.prepare(
    "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, (now() + 3600) * 1000, "session-token", timestamp, timestamp, userId);
  database.prepare(
    "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("session-2", (now() + 3600) * 1000, "session-token-2", timestamp, timestamp, userId);
  database.prepare("INSERT INTO oauthClient (id, clientId, userId, redirectUris) VALUES (?, ?, ?, ?)")
    .run("oauth-client-row", clientId, userId, "[]");
  database.prepare("INSERT INTO oauthClient (id, clientId, userId, redirectUris) VALUES (?, ?, ?, ?)")
    .run("other-oauth-client-row", "other-client", userId, "[]");
  database.prepare(
    "INSERT INTO controlOAuthTokenFamily (id, userId, clientId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
  ).run("family-1", userId, clientId, now(), now());
};

const sign = async (payload: Record<string, unknown>) => {
  const { token } = await createAuth(environment).api.signJWT({
    body: { payload: { ...payload, jti: crypto.randomUUID() } },
  });
  return token;
};

const bind = async (token: string, options?: {
  client?: string;
  session?: string;
  scopes?: string;
  expiresAt?: number;
  revokedAt?: number;
  compromised?: boolean;
}) => {
  const timestamp = now();
  const id = `binding-${crypto.randomUUID()}`;
  if (options?.compromised) {
    database.prepare("UPDATE controlOAuthTokenFamily SET compromisedAt = ? WHERE id = ?").run(timestamp, "family-1");
  }
  database.prepare(
    `INSERT INTO controlOAuthTokenBinding (
      id, accessTokenHash, familyId, userId, clientId, sessionId, resource, scopes, issuer,
      expiresAt, revokedAt, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    await sha256(token),
    "family-1",
    userId,
    options?.client ?? clientId,
    options?.session ?? sessionId,
    resource,
    options?.scopes ?? "control:read",
    origin,
    options?.expiresAt ?? timestamp + 900,
    options?.revokedAt ?? null,
    timestamp,
    timestamp,
  );
  return id;
};

beforeAll(async () => {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(await migration("0001_better_auth_schema.sql"));
  database.exec(await migration("0003_control_oauth_provider.sql"));
  insertIdentity();
});

describe("resolveControlBearer", () => {
  test("contains a refresh successor when the family is compromised after exchange", async () => {
    const timestamp = now();
    const raceUser = "race-user";
    const raceClient = "race-client";
    const raceSession = "race-session";
    const raceFamily = "race-family";
    const priorRefresh = "prior-refresh";
    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(raceUser, "Race User", "race@example.test", 1, Date.now(), Date.now());
    database.prepare(
      "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(raceSession, (timestamp + 3600) * 1000, "race-session-token", Date.now(), Date.now(), raceUser);
    database.prepare("INSERT INTO oauthClient (id, clientId, userId, redirectUris) VALUES (?, ?, ?, ?)")
      .run("race-client-row", raceClient, raceUser, "[]");
    database.prepare(
      "INSERT INTO controlOAuthTokenFamily (id, userId, clientId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(raceFamily, raceUser, raceClient, timestamp, timestamp);
    database.prepare(
      `INSERT INTO controlOAuthTokenBinding (
        id, accessTokenHash, refreshTokenHash, familyId, userId, clientId, sessionId, resource, scopes, issuer,
        expiresAt, refreshExpiresAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "race-prior",
      await sha256("race-prior-access"),
      await sha256(priorRefresh),
      raceFamily,
      raceUser,
      raceClient,
      raceSession,
      resource,
      "control:read offline_access",
      origin,
      timestamp + 900,
      timestamp + 3600,
      timestamp,
      timestamp,
    );

    let tokenHandler: ((context: { env: typeof environment; req: { raw: Request; url: string } }) => Promise<Response>) | undefined;
    registerControlOAuthRoutes({
      get() {},
      post(path: string, handler: (context: { env: typeof environment; req: { raw: Request; url: string } }) => Promise<Response>) {
        if (path === "/api/auth/oauth2/token") tokenHandler = handler;
      },
    }, () => ({
      handler: async () => {
        const accessToken = await sign({
          sub: raceUser, azp: raceClient, sid: raceSession, scope: "control:read offline_access", iat: now(), exp: now() + 900,
        });
        database.prepare(
          "INSERT INTO oauthAccessToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("race-access", "stored-access", raceClient, raceSession, raceUser, (now() + 900) * 1000, Date.now(), "control:read offline_access");
        database.prepare(
          "INSERT INTO oauthRefreshToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("race-refresh", "stored-refresh", raceClient, raceSession, raceUser, (now() + 3600) * 1000, Date.now(), "control:read offline_access");
        database.prepare("UPDATE controlOAuthTokenFamily SET compromisedAt = ? WHERE id = ?").run(now(), raceFamily);
        return Response.json({
          access_token: accessToken,
          refresh_token: "successor-refresh",
          token_type: "Bearer",
          expires_in: 900,
          scope: "control:read offline_access",
        });
      },
    }));
    if (!tokenHandler) throw new Error("OAuth token route was not registered");

    const response = await tokenHandler({
      env: environment,
      req: {
        raw: new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: raceClient,
            resource,
            refresh_token: priorRefresh,
          }),
        }),
        url: `${origin}/api/auth/oauth2/token`,
      },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_grant",
      error_description: "refresh token family compromised",
    });
    expect(database.prepare(
      "SELECT count(*) count FROM controlOAuthTokenBinding WHERE familyId = ? AND revokedAt IS NULL",
    ).get(raceFamily)).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) count FROM oauthAccessToken WHERE clientId = ?").get(raceClient)).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) count FROM oauthRefreshToken WHERE clientId = ?").get(raceClient)).toEqual({ count: 0 });

    const replayFamily = "replay-family";
    const replayRefresh = "replay-refresh";
    database.prepare(
      "INSERT INTO controlOAuthTokenFamily (id, userId, clientId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(replayFamily, raceUser, raceClient, timestamp, timestamp);
    database.prepare(
      `INSERT INTO controlOAuthTokenBinding (
        id, accessTokenHash, refreshTokenHash, familyId, userId, clientId, sessionId, resource, scopes, issuer,
        expiresAt, refreshExpiresAt, refreshConsumedAt, replacedById, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "replay-prior", await sha256("replay-prior-access"), await sha256(replayRefresh), replayFamily,
      raceUser, raceClient, raceSession, resource, "control:read offline_access", origin,
      timestamp + 900, timestamp + 3600, timestamp, null, timestamp, timestamp,
    );
    database.prepare(
      `INSERT INTO controlOAuthTokenBinding (
        id, accessTokenHash, familyId, userId, clientId, sessionId, resource, scopes, issuer, expiresAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "replay-successor", await sha256("replay-successor-access"), replayFamily, raceUser, raceClient,
      raceSession, resource, "control:read offline_access", origin, timestamp + 900, timestamp, timestamp,
    );
    database.prepare("UPDATE controlOAuthTokenBinding SET replacedById = ? WHERE id = ?")
      .run("replay-successor", "replay-prior");
    database.prepare(
      "INSERT INTO oauthAccessToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("replay-access", "replay-stored-access", raceClient, raceSession, raceUser, (now() + 900) * 1000, Date.now(), "control:read offline_access");
    database.prepare(
      "INSERT INTO oauthRefreshToken (id, token, clientId, sessionId, userId, expiresAt, createdAt, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("replay-refresh-row", "replay-stored-refresh", raceClient, raceSession, raceUser, (now() + 3600) * 1000, Date.now(), "control:read offline_access");
    const replayResponse = await tokenHandler({
      env: environment,
      req: {
        raw: new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: raceClient,
            resource,
            refresh_token: replayRefresh,
          }),
        }),
        url: `${origin}/api/auth/oauth2/token`,
      },
    });
    expect(replayResponse.status).toBe(400);
    expect(database.prepare(
      "SELECT revokedAt FROM controlOAuthTokenBinding WHERE id = ?",
    ).get("replay-successor")).toEqual({ revokedAt: expect.any(Number) });
    expect(database.prepare("SELECT count(*) count FROM oauthAccessToken WHERE clientId = ?").get(raceClient)).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) count FROM oauthRefreshToken WHERE clientId = ?").get(raceClient)).toEqual({ count: 0 });
  });

  test("accepts a provider-signed, persisted access token and rejects claim or authority drift", async () => {
    const valid = await sign({
      sub: userId,
      azp: clientId,
      sid: sessionId,
      scope: "control:read",
      iat: now(),
      exp: now() + 900,
    });
    const validBindingId = await bind(valid);
    expect((await resolveControlBearer(request(valid), environment, "control:read"))?.userId).toBe(userId);

    const forged = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
    await bind(forged);
    expect(await resolveControlBearer(request(forged), environment, "control:read")).toBeNull();

    const wrongIssuer = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iss: "https://wrong.example.test", iat: now(), exp: now() + 900,
    });
    await bind(wrongIssuer);
    expect(await resolveControlBearer(request(wrongIssuer), environment, "control:read")).toBeNull();

    const wrongAudience = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", aud: "https://wrong.example.test/api", iat: now(), exp: now() + 900,
    });
    await bind(wrongAudience);
    expect(await resolveControlBearer(request(wrongAudience), environment, "control:read")).toBeNull();

    const mismatchedClient = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now(), exp: now() + 900,
    });
    await bind(mismatchedClient, { client: "other-client" });
    expect(await resolveControlBearer(request(mismatchedClient), environment, "control:read")).toBeNull();

    const revokedSuccessor = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now(), exp: now() + 900,
    });
    const revokedSuccessorId = await bind(revokedSuccessor, { revokedAt: now() });
    database.prepare("UPDATE controlOAuthTokenBinding SET replacedById = ? WHERE id = ?")
      .run(revokedSuccessorId, validBindingId);
    expect(await resolveControlBearer(request(revokedSuccessor), environment, "control:read")).toBeNull();

    const underscoped = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now(), exp: now() + 900,
    });
    await bind(underscoped);
    expect(await resolveControlBearer(request(underscoped), environment, "control:write")).toBeNull();

    const expiredAccess = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now() - 901, exp: now() - 1,
    });
    await bind(expiredAccess, { expiresAt: now() + 900 });
    expect(await resolveControlBearer(request(expiredAccess), environment, "control:read")).toBeNull();

    expect(await resolveControlBearer(request(valid, "Basic credentials"), environment, "control:read")).toBeNull();
    expect(await resolveControlBearer(request(valid, `Bearer ${valid} extra`), environment, "control:read")).toBeNull();
    expect(await resolveControlBearer(new Request(`${origin}/api/control`), environment, "control:read")).toBeNull();

    const duplicated = new Headers();
    duplicated.append("authorization", `Bearer ${valid}`);
    duplicated.append("authorization", `Bearer ${valid}`);
    expect(await resolveControlBearer(new Request(`${origin}/api/control`, { headers: duplicated }), environment, "control:read")).toBeNull();

    const mismatchedSession = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now(), exp: now() + 900,
    });
    await bind(mismatchedSession, { session: "session-2" });
    expect(await resolveControlBearer(request(mismatchedSession), environment, "control:read")).toBeNull();

    database.prepare("UPDATE oauthClient SET disabled = 1 WHERE clientId = ?").run(clientId);
    expect(await resolveControlBearer(request(valid), environment, "control:read")).toBeNull();
    database.prepare("UPDATE oauthClient SET disabled = NULL WHERE clientId = ?").run(clientId);

    database.prepare("UPDATE session SET expiresAt = ? WHERE id = ?").run((now() - 1) * 1000, sessionId);
    expect(await resolveControlBearer(request(valid), environment, "control:read")).toBeNull();
    database.prepare("UPDATE session SET expiresAt = ? WHERE id = ?").run((now() + 3600) * 1000, sessionId);

    const compromised = await sign({
      sub: userId, azp: clientId, sid: sessionId, scope: "control:read", iat: now(), exp: now() + 900,
    });
    await bind(compromised, { compromised: true });
    expect(await resolveControlBearer(request(compromised), environment, "control:read")).toBeNull();

    database.prepare("DELETE FROM user WHERE id = ?").run(userId);
    expect(await resolveControlBearer(request(valid), environment, "control:read")).toBeNull();
  });
});
