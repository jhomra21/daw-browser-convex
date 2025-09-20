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
  })
    .index("by_room", ["roomId"]) // list tracks in a room
    .index("by_room_index", ["roomId", "index"]), // optional composite for ordering

  clips: defineTable({
    roomId: v.string(),
    trackId: v.id("tracks"),
    startSec: v.number(),
    duration: v.number(),
  })
    .index("by_room", ["roomId"]) // list clips in a room
    .index("by_track", ["trackId"]), // list clips per track

  // Ownership mappings to enforce owner-only deletions.
  // Exactly one of clipId or trackId will be set for each row.
  ownerships: defineTable({
    roomId: v.string(),
    ownerSessionId: v.string(),
    clipId: v.optional(v.id("clips")),
    trackId: v.optional(v.id("tracks")),
  })
    .index("by_clip", ["clipId"]) // find owner for a clip
    .index("by_track", ["trackId"]) // find owner for a track
    .index("by_room", ["roomId"]), // list ownerships in a room (optional utility)
});
