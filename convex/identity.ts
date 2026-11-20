import type { UserIdentity } from "convex/server";
import { convexIdentityClaims } from "@daw-browser/shared";
import { z } from "zod";
import { fail } from "./errors";

type AuthenticatedCtx = {
  auth: {
    getUserIdentity: () => Promise<UserIdentity | null>;
  };
};

export async function requireAuthenticatedUserId(ctx: AuthenticatedCtx) {
  return (await requireAuthenticatedIdentity(ctx)).subject;
}

export async function requireAuthenticatedIdentity(ctx: AuthenticatedCtx) {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) fail("authorization", "Authentication required.");

  const parsedIdentity = z.object({
    subject: z.string(),
    issuer: z.string(),
    tokenIdentifier: z.string(),
    [convexIdentityClaims.actorIssuer]: z.string().optional(),
    [convexIdentityClaims.actorTokenIdentifier]: z.string().optional(),
    [convexIdentityClaims.worker]: z.boolean().optional(),
  }).safeParse(identity);

  if (!parsedIdentity.success) fail("authorization", "Authentication claims are invalid.");

  return {
    subject: parsedIdentity.data.subject,
    issuer: parsedIdentity.data.issuer,
    tokenIdentifier: parsedIdentity.data.tokenIdentifier,
    dawControlActorIssuer: parsedIdentity.data[convexIdentityClaims.actorIssuer],
    dawControlActorTokenIdentifier: parsedIdentity.data[convexIdentityClaims.actorTokenIdentifier],
    dawWorker: parsedIdentity.data[convexIdentityClaims.worker] === true ? true : undefined,
  };
}

export async function requireWorkerIdentity(ctx: AuthenticatedCtx, deniedMessage = "Worker access required.") {
  const identity = await requireAuthenticatedIdentity(ctx);

  if (!identity.dawWorker) fail("forbidden", deniedMessage);

  return identity;
}
