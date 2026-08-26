import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";

import { issueConvexAuthToken } from "./convex-auth";

const user = {
  id: "user-convex-auth",
  email: "user@example.com",
  name: "Convex Auth User",
};

const createIssuanceContext = async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const context = {
    env: {
      CONVEX_AUTH_PRIVATE_JWK: JSON.stringify(privateJwk),
      CONVEX_AUTH_ISSUER: "https://auth.example.com/api/convex-auth",
    },
    requestUrl: "https://app.example.com/api/convex-auth/token",
  };
  return { context, publicKey };
};

const verifyToken = async (token: string, publicKey: CryptoKey) => await jwtVerify(token, publicKey, {
  issuer: "https://auth.example.com/api/convex-auth",
  audience: "daw-browser-convex",
});

test("issues ordinary, attributed, and worker Convex authentication tokens", async () => {
  const { context, publicKey } = await createIssuanceContext();

  const ordinary = await verifyToken(await issueConvexAuthToken(context, user), publicKey);
  expect(ordinary.protectedHeader.alg).toBe("ES256");
  expect(ordinary.payload.sub).toBe(user.id);
  expect(ordinary.payload.iss).toBe("https://auth.example.com/api/convex-auth");
  expect(ordinary.payload.aud).toBe("daw-browser-convex");
  expect(ordinary.payload.dawControlActorIssuer).toBeUndefined();
  expect(ordinary.payload.dawControlActorTokenIdentifier).toBeUndefined();

  const attributed = await verifyToken(await issueConvexAuthToken(context, user, {
    actor: {
      issuer: "trusted-control-issuer",
      tokenIdentifier: "trusted-control-token",
    },
  }), publicKey);
  expect(attributed.payload.dawControlActorIssuer).toBe("trusted-control-issuer");
  expect(attributed.payload.dawControlActorTokenIdentifier).toBe("trusted-control-token");

  const worker = await verifyToken(await issueConvexAuthToken(context, user, { worker: true }), publicKey);
  expect(worker.payload.dawWorker).toBe(true);
});

test("accepts bounded control actor claims and rejects invalid ones before token issuance", async () => {
  const { context, publicKey } = await createIssuanceContext();

  for (const value of ["x", "x".repeat(256)]) {
    const token = await issueConvexAuthToken(context, user, {
      actor: { issuer: value, tokenIdentifier: value },
    });
    const verified = await verifyToken(token, publicKey);
    expect(verified.payload.dawControlActorIssuer).toBe(value);
    expect(verified.payload.dawControlActorTokenIdentifier).toBe(value);
  }

  for (const value of ["", "x".repeat(257)]) {
    await expect(issueConvexAuthToken(context, user, {
      actor: { issuer: value, tokenIdentifier: "valid-token" },
    })).rejects.toThrow("Control actor issuer");
    await expect(issueConvexAuthToken(context, user, {
      actor: { issuer: "valid-issuer", tokenIdentifier: value },
    })).rejects.toThrow("Control actor token identifier");
  }
});
