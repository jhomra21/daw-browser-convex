import { v } from "convex/values";

export const audioWarpValidator = v.object({
  enabled: v.boolean(),
  sourceBpm: v.optional(v.number()),
  sourceBeatOffset: v.optional(v.number()),
  markers: v.optional(v.array(v.object({
    id: v.string(),
    sourceBeat: v.number(),
    timelineBeat: v.number(),
  }))),
  mode: v.union(v.literal("repitch"), v.literal("stretch")),
});
