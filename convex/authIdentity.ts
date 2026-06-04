import { v } from "convex/values";
import { query } from "./_generated/server";

export const current = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.string(),
      issuer: v.string(),
      tokenIdentifier: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return {
      userId: identity.subject,
      issuer: identity.issuer,
      tokenIdentifier: identity.tokenIdentifier,
    };
  },
});
