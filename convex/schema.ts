import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Minimal shared model for collaboration
// - We intentionally DO NOT store track names or any audio URLs here
// - All scoping is via a simple roomId string (avoids needing a timelines table)
export default defineSchema({
  tracks: defineTable({
    roomId: v.string(),
    index: v.number(),
    volume: v.number(), // 0..1
    // Optional shared mix state; only applied when clients opt-in to sync
    muted: v.optional(v.boolean()),
    soloed: v.optional(v.boolean()),
    lockedBy: v.optional(v.string()),
    lockedAt: v.optional(v.number()),
  })
    .index("by_room", ["roomId"]) // list tracks in a room
    .index("by_room_index", ["roomId", "index"]), // optional composite for ordering

  clips: defineTable({
    roomId: v.string(),
    trackId: v.id("tracks"),
    startSec: v.number(),
    duration: v.number(),
    // Optional left padding (seconds) before audio begins within the clip window
    leftPadSec: v.optional(v.number()),
    // Optional shared display name for the clip (e.g., original filename)
    name: v.optional(v.string()),
    // Optional URL where the audio sample is stored (e.g. R2-backed endpoint)
    sampleUrl: v.optional(v.string()),
  })
    .index("by_room", ["roomId"]) // list clips in a room
    .index("by_track", ["trackId"]), // list clips per track

  samples: defineTable({
    roomId: v.string(),
    url: v.string(),
    name: v.optional(v.string()),
    duration: v.optional(v.number()),
    ownerUserId: v.string(),
    createdAt: v.number(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_url", ["roomId", "url"]),

  // Per-user project metadata (e.g., project names). Each owner has their own
  // label for a roomId.
  projects: defineTable({
    roomId: v.string(),
    ownerUserId: v.string(),
    name: v.string(),
    createdAt: v.number(), // epoch millis
  })
    .index("by_owner", ["ownerUserId"]) // list projects by owner
    .index("by_room", ["roomId"]) // find all owners for a room (rarely used)
    .index("by_room_owner", ["roomId", "ownerUserId"]), // upsert/find by pair

  // Ownership mappings to enforce owner-only deletions.
  // Exactly one of clipId or trackId will be set for each row.
  ownerships: defineTable({
    roomId: v.string(),
    ownerUserId: v.string(),
    clipId: v.optional(v.id("clips")),
    trackId: v.optional(v.id("tracks")),
  })
    .index("by_clip", ["clipId"]) // find owner for a clip
    .index("by_track", ["trackId"]) // find owner for a track
    .index("by_room", ["roomId"]) // list ownerships in a room (optional utility)
    .index("by_owner", ["ownerUserId"]), // list ownerships by owner (for projects)

  // Effects chain (ordered). Supports 'eq' and 'reverb' types today (extensible).
  effects: defineTable({
    roomId: v.string(),
    // target: either a specific track or the room master bus
    targetType: v.string(), // 'track' | 'master'
    trackId: v.optional(v.id("tracks")),
    index: v.number(), // order in chain (0..)
    type: v.string(), // e.g. 'eq' (future: compressor, reverb, etc.)
    // NOTE: Keep params flexible to support multiple effect types (eq, reverb, ...)
    // Existing rows with EQ params remain valid.
    params: v.any(),
    createdAt: v.number(), // epoch millis
  })
    .index("by_track", ["trackId"]) // list effects for a track
    .index("by_room", ["roomId"]) // list effects in a room
    .index("by_track_order", ["trackId", "index"]), // chain ordering
});


