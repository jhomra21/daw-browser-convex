import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Minimal shared model for collaboration
// - We intentionally DO NOT store track names or any audio URLs here
// - All scoping is via a simple roomId string (avoids needing a timelines table)
export default defineSchema({
  tracks: defineTable({
    roomId: v.string(),
    index: v.number(),
    kind: v.optional(v.string()), // 'audio' | 'instrument'
  })
    .index("by_room", ["roomId"])
    .index("by_room_index", ["roomId", "index"]),

  mixerChannels: defineTable({
    roomId: v.string(),
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
    .index("by_room", ["roomId"])
    .index("by_track", ["trackId"]),

  clips: defineTable({
    roomId: v.string(),
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
    .index("by_room", ["roomId"])
    .index("by_track", ["trackId"]),

  samples: defineTable({
    roomId: v.string(),
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
    .index("by_room", ["roomId"])
    .index("by_room_assetKey", ["roomId", "assetKey"]),

  projects: defineTable({
    roomId: v.string(),
    ownerUserId: v.string(),
    name: v.string(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_room", ["roomId"])
    .index("by_room_owner", ["roomId", "ownerUserId"]),

  ownerships: defineTable({
    roomId: v.string(),
    ownerUserId: v.string(),
    clipId: v.optional(v.id("clips")),
    trackId: v.optional(v.id("tracks")),
  })
    .index("by_clip", ["clipId"])
    .index("by_track", ["trackId"])
    .index("by_room", ["roomId"])
    .index("by_owner", ["ownerUserId"])
    .index("by_room_owner", ["roomId", "ownerUserId"]),

  effects: defineTable({
    roomId: v.string(),
    targetType: v.string(),
    trackId: v.optional(v.id("tracks")),
    index: v.number(),
    type: v.string(),
    params: v.any(),
    createdAt: v.number(),
  })
    .index("by_track", ["trackId"])
    .index("by_room", ["roomId"])
    .index("by_track_order", ["trackId", "index"]),

  chatHistories: defineTable({
    roomId: v.string(),
    ownerUserId: v.string(),
    messages: v.array(
      v.object({
        role: v.string(),
        content: v.string(),
      })
    ),
    updatedAt: v.number(),
  })
    .index("by_room_owner", ["roomId", "ownerUserId"]),

  roomMessages: defineTable({
    roomId: v.string(),
    senderUserId: v.string(),
    content: v.string(),
    createdAt: v.number(),
    senderName: v.optional(v.string()),
    kind: v.optional(v.string()),
  })
    .index("by_room", ["roomId"])
    .index("by_room_createdAt", ["roomId", "createdAt"]),

  exports: defineTable({
    roomId: v.string(),
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
    .index("by_room_createdAt", ["roomId", "createdAt"])
    .index("by_room", ["roomId"])
});
