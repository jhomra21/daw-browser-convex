import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import {
  CONTROL_ACCESS_TOKEN_SECONDS,
  CONTROL_OAUTH_SCOPES,
  CONTROL_REFRESH_TOKEN_SECONDS,
  getControlOAuthOrigin,
  getControlOAuthResource,
} from "./control-oauth";

function hasAuthEnvBindings(env: Env): boolean {
  return Boolean(env?.daw_convex_auth) && Boolean(env?.daw_convex_auth_kv);
}

function buildAuth(env: Env) {
  const controlOrigin = getControlOAuthOrigin(env.BETTER_AUTH_URL, "http://localhost");
  const controlResource = getControlOAuthResource(env.BETTER_AUTH_URL, "http://localhost");
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
        const minTtl = ttl === undefined ? undefined : Math.max(60, Math.ceil(ttl));
        const options = minTtl ? { expirationTtl: minTtl } : undefined;
        await env.daw_convex_auth_kv.put(key, value, options);
      },
      delete: async (key: string) => {
        await env.daw_convex_auth_kv.delete(key);
      },
    },
    session: {
      storeSessionInDatabase: true,
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
    plugins: [
      jwt({
        jwt: {
          issuer: controlOrigin,
          audience: controlResource,
        },
      }),
      oauthProvider({
        scopes: CONTROL_OAUTH_SCOPES,
        validAudiences: [controlResource],
        accessTokenExpiresIn: CONTROL_ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: CONTROL_REFRESH_TOKEN_SECONDS,
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["control:read"],
        clientRegistrationAllowedScopes: CONTROL_OAUTH_SCOPES,
        consentPage: `${controlOrigin}/oauth/consent`,
        loginPage: `${controlOrigin}/Login`,
        storeTokens: "hashed",
        rateLimit: {
          register: false,
        },
      }),
    ],
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
