import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

const migration = async (name: string) => Bun.file(
  new URL(`../migrations/${name}`, import.meta.url),
).text();

describe("control OAuth migration", () => {
  test("cascades OAuth families and bindings when a user is deleted", async () => {
    const database = new Database(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(await migration("0001_better_auth_schema.sql"));
    database.exec(await migration("0003_control_oauth_provider.sql"));

    database.prepare(
      "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("user-1", "User", "user@example.test", 1, 1, 1);
    database.prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("session-1", 2, "session-token", 1, 1, "user-1");
    database.prepare(
      `INSERT INTO oauthClient (id, clientId, userId, redirectUris)
       VALUES (?, ?, ?, ?)`,
    ).run("client-row-1", "client-1", "user-1", "[]");
    database.prepare(
      `INSERT INTO controlOAuthTokenFamily (id, userId, clientId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("family-1", "user-1", "client-1", 1, 1);
    database.prepare(
      `INSERT INTO controlOAuthTokenBinding (
        id, accessTokenHash, familyId, userId, clientId, resource, scopes, issuer,
        expiresAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "binding-1",
      "a".repeat(64),
      "family-1",
      "user-1",
      "client-1",
      "https://daw.example.test/api",
      "control:read",
      "https://daw.example.test",
      2,
      1,
      1,
    );
    database.prepare(
      `INSERT INTO oauthAccessToken (
        id, clientId, userId, expiresAt, createdAt, scopes
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("access-row-1", "client-1", "user-1", 2, 1, "control:read");

    database.prepare("DELETE FROM user WHERE id = ?").run("user-1");

    for (const table of ["oauthClient", "oauthAccessToken", "controlOAuthTokenFamily", "controlOAuthTokenBinding"]) {
      const row = database.prepare(`SELECT count(*) count FROM ${table}`).get();
      expect(row).toEqual({ count: 0 });
    }
    database.close();
  });
});
