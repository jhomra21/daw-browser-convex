import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { audioWarpValidator } from "./audioWarpValidator";
import { projectManifestValidator } from "./projectManifestValidator";

// Minimal shared model for collaboration
// - We intentionally DO NOT store track names or any audio URLs here
// - All scoping is via a simple projectId string (avoids needing a timelines table)
export default defineSchema({
  tracks: defineTable({
    projectId: v.string(),
    index: v.number(),
    kind: v.optional(v.string()), // 'audio' | 'instrument'
  })
    .index("by_room", ["projectId"])
    .index("by_room_index", ["projectId", "index"]),

  mixerChannels: defineTable({
    projectId: v.string(),
    trackId: v.id("tracks"),
    volume: v.number(),
    muted: v.optional(v.boolean()),
    soloed: v.optional(v.boolean()),
    lockedBy: v.optional(v.string()),
    lockedAt: v.optional(v.number()),
    channelRole: v.string(),
    outputTargetId: v.optional(v.id("tracks")),
    sends: v.array(v.object({
      targetId: v.id("tracks"),
      amount: v.number(),
    })),
  })
    .index("by_room", ["projectId"])
    .index("by_track", ["trackId"]),

  clips: defineTable({
    projectId: v.string(),
    trackId: v.id("tracks"),
    startSec: v.number(),
    duration: v.number(),
    sourceAssetKey: v.optional(v.string()),
    sourceKind: v.optional(v.string()),
    sourceDurationSec: v.optional(v.number()),
    sourceSampleRate: v.optional(v.number()),
    sourceChannelCount: v.optional(v.number()),
    leftPadSec: v.optional(v.number()),
    bufferOffsetSec: v.optional(v.number()),
    audioWarp: v.optional(audioWarpValidator),
    gain: v.optional(v.number()),
    name: v.optional(v.string()),
    sampleUrl: v.optional(v.string()),
    midi: v.optional(v.object({
      wave: v.string(),
      gain: v.optional(v.number()),
      notes: v.array(v.object({
        beat: v.number(),
        length: v.number(),
        pitch: v.number(),
        velocity: v.optional(v.number()),
      })),
    })),
    midiOffsetBeats: v.optional(v.number()),
  })
    .index("by_room", ["projectId"])
    .index("by_track", ["trackId"]),

  samples: defineTable({
    projectId: v.string(),
    assetKey: v.string(),
    sourceKind: v.string(),
    url: v.string(),
    name: v.optional(v.string()),
    duration: v.number(),
    sampleRate: v.number(),
    channelCount: v.number(),
    ownerUserId: v.string(),
    createdAt: v.number(),
  })
    .index("by_room", ["projectId"])
    .index("by_room_assetKey", ["projectId", "assetKey"]),

  projects: defineTable({
    projectId: v.string(),
    ownerUserId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    deletionPendingAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_room", ["projectId"])
    .index("by_room_createdAt", ["projectId", "createdAt"])
    .index("by_room_owner", ["projectId", "ownerUserId"]),

  ownerships: defineTable({
    projectId: v.string(),
    ownerUserId: v.string(),
    role: v.optional(v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"))),
    clipId: v.optional(v.id("clips")),
    trackId: v.optional(v.id("tracks")),
  })
    .index("by_clip", ["clipId"])
    .index("by_track", ["trackId"])
    .index("by_room", ["projectId"])
    .index("by_owner", ["ownerUserId"])
    .index("by_owner_project_marker", ["ownerUserId", "trackId", "clipId"])
    .index("by_room_owner", ["projectId", "ownerUserId"]),

  shareInvites: defineTable({
    projectId: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
    token: v.string(),
    createdBy: v.string(),
    revokedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_room", ["projectId"]),

  cloudBackups: defineTable({
    projectId: v.string(),
    ownerUserId: v.string(),
    manifest: projectManifestValidator,
    manifestVersion: v.string(),
    updatedAt: v.number(),
    manifestUpdatedAt: v.number(),
    entityCount: v.number(),
    assetCount: v.number(),
  })
    .index("by_room", ["projectId"])
    .index("by_room_updatedAt", ["projectId", "updatedAt"])
    .index("by_room_owner", ["projectId", "ownerUserId"]),

  r2DeleteQueue: defineTable({
    projectId: v.string(),
    r2Key: v.string(),
    kind: v.union(v.literal("backup-asset"), v.literal("sample"), v.literal("export"), v.literal("project-prefix")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["r2Key"])
    .index("by_due", ["nextAttemptAt"])
    .index("by_room", ["projectId"])
    .index("by_room_due", ["projectId", "nextAttemptAt"]),

  sharedOperationResults: defineTable({
    projectId: v.string(),
    userId: v.string(),
    operationId: v.string(),
    result: v.any(),
    createdAt: v.number(),
  })
    .index("by_room_user_operation", ["projectId", "userId", "operationId"]),

  effects: defineTable({
    projectId: v.string(),
    targetType: v.string(),
    trackId: v.optional(v.id("tracks")),
    index: v.number(),
    type: v.string(),
    params: v.any(),
    createdAt: v.number(),
  })
    .index("by_track", ["trackId"])
    .index("by_room", ["projectId"])
    .index("by_track_order", ["trackId", "index"]),

  chatHistories: defineTable({
    projectId: v.string(),
    ownerUserId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
      })
    ),
    updatedAt: v.number(),
  })
    .index("by_room_owner", ["projectId", "ownerUserId"]),

  projectMessages: defineTable({
    projectId: v.string(),
    senderUserId: v.string(),
    content: v.string(),
    createdAt: v.number(),
    senderName: v.optional(v.string()),
    kind: v.optional(v.string()),
  })
    .index("by_room", ["projectId"])
    .index("by_room_createdAt", ["projectId", "createdAt"]),

  exports: defineTable({
    projectId: v.string(),
    name: v.string(),
    url: v.string(),
    r2Key: v.string(),
    format: v.string(),
    duration: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    sizeBytes: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.string(),
  })
    .index("by_room_createdAt", ["projectId", "createdAt"])
    .index("by_room", ["projectId"])
});
