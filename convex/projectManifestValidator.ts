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
    folderId: v.optional(v.string()),
    missing: v.optional(v.boolean()),
    originalFileName: v.optional(v.string()),
    originalLastModified: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    sourceKind: v.optional(v.union(v.literal("upload"), v.literal("url"), v.literal("recording"))),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    cloudKey: v.optional(v.string()),
  })),
  projectState: v.array(manifestStateRowValidator),
  syncState: v.array(manifestStateRowValidator),
  externalPluginArtifacts: v.optional(v.array(v.object({
    id: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
    kind: v.union(v.literal("plugin-state"), v.literal("plugin-freeze")),
    ownerId: v.string(),
    acl: v.union(v.literal("owner"), v.literal("project-members")),
    bucket: v.union(v.literal("local"), v.literal("r2-plugin-artifacts")),
    location: v.string(),
  }))),
});
