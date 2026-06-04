import { v } from "convex/values";

const manifestEntityRowValidator = v.object({
  kind: v.string(),
  id: v.string(),
  value: v.any(),
  updatedAt: v.number(),
});

const manifestStateRowValidator = v.object({
  key: v.string(),
  value: v.any(),
  updatedAt: v.number(),
});

export const projectManifestValidator = v.object({
  schemaVersion: v.number(),
  projectId: v.string(),
  name: v.string(),
  mode: v.union(v.literal("backup"), v.literal("shared")),
  updatedAt: v.number(),
  entityCount: v.number(),
  assetCount: v.number(),
  entities: v.array(manifestEntityRowValidator),
  assets: v.array(v.object({
    id: v.string(),
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    missing: v.optional(v.boolean()),
    originalFileName: v.optional(v.string()),
    originalLastModified: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    cloudKey: v.optional(v.string()),
  })),
  projectState: v.array(manifestStateRowValidator),
  syncState: v.array(manifestStateRowValidator),
});
