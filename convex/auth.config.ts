import type { AuthConfig } from "convex/server";

const issuer = process.env.CONVEX_AUTH_ISSUER || "http://localhost:3000/api/convex-auth";
const jwks = process.env.CONVEX_AUTH_JWKS;

export default {
  providers: [
    {
      type: "customJwt",
      applicationID: "daw-browser-convex",
      issuer,
      jwks: jwks
        ? `data:application/json,${encodeURIComponent(jwks)}`
        : `${issuer}/.well-known/jwks.json`,
      algorithm: "ES256",
    },
  ],
} satisfies AuthConfig;
