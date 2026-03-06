import { betterAuth } from "better-auth";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

type AuthDatabaseBinding = {
  prepare?: unknown;
};

function hasAuthEnvBindings(env: Env): boolean {
  const database = env?.daw_convex_auth as AuthDatabaseBinding | undefined;
  return Boolean(database) && typeof database?.prepare === "function" && Boolean(env?.daw_convex_auth_kv);
}

function buildAuth(env: Env) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL || "http://localhost:3000",
    database: {
      db: new Kysely<any>({
        dialect: new D1Dialect({ database: env.daw_convex_auth }),
      }),
      type: "sqlite",
      transaction: false,
    },
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
    },
    secondaryStorage: {
      get: async (key: string) => {
        return await env.daw_convex_auth_kv.get(key);
      },
      set: async (key: string, value: string, ttl?: number) => {
        const minTtl = typeof ttl === "number" ? Math.max(60, Math.ceil(ttl)) : undefined;
        const options = minTtl ? { expirationTtl: minTtl } : undefined;
        await env.daw_convex_auth_kv.put(key, value, options);
      },
      delete: async (key: string) => {
        await env.daw_convex_auth_kv.delete(key);
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
      // github: {
      //   clientId: env.GITHUB_CLIENT_ID,
      //   clientSecret: env.GITHUB_CLIENT_SECRET,
      // },
    },
  });
}

type AuthInstance = ReturnType<typeof buildAuth>;

let cachedAuth: AuthInstance | null = null;

export function createAuth(env: Env): AuthInstance {
  const canReuseCachedAuth = hasAuthEnvBindings(env);
  if (canReuseCachedAuth && cachedAuth) {
    return cachedAuth;
  }

  const instance = buildAuth(env);
  if (canReuseCachedAuth) {
    cachedAuth = instance;
  }

  return instance;
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
