import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";
import { Kysely } from "kysely";

// Cache the Better Auth instance across warm Cloudflare Worker invocations
type AuthInstance = ReturnType<typeof betterAuth>;
let cachedAuth: AuthInstance | null = null;

export function createAuth(env: Env) {
    // Only cache when env bindings are available (helps during local dev reloads)
    const isEnvValid =
        Boolean(env?.daw_convex_auth) &&
        typeof (env as any).daw_convex_auth?.prepare === "function" &&
        Boolean(env?.daw_convex_auth_kv);

    if (isEnvValid && cachedAuth) {
        return cachedAuth;
    }

    const instance = betterAuth({
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
        // Use KV as secondary storage following Better Auth pattern
        secondaryStorage: {
            get: async (key: string) => {
                return await env.daw_convex_auth_kv.get(key);
            },
            set: async (key: string, value: string, ttl?: number) => {
                const options = ttl ? { expirationTtl: ttl } : undefined;
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
                // prompt: "select_account", // optional
            },
            // Add GitHub when you have the credentials
            // github: { 
            //   clientId: env.GITHUB_CLIENT_ID, 
            //   clientSecret: env.GITHUB_CLIENT_SECRET, 
            // } 
        }
    });

    if (isEnvValid) {
        cachedAuth = instance;
    }

    return instance;
}

// Export type inference helpers
export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth['$Infer']['Session'];