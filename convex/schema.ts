import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { audioWarpValidator } from "./audioWarpValidator";
import { clipFadesValidator } from "./clipFadesValidator";
import { projectManifestValidator } from "./projectManifestValidator";

// Shared collaboration model scoped by a stable projectId.
export default defineSchema({
  tracks: defineTable({
    projectId: v.string(),
    name: v.string(),
    index: v.number(),
    kind: v.optional(v.string()), // 'audio' | 'instrument'
    historyRef: v.optional(v.string()),
    groupId: v.optional(v.id("tracks")),
    collapsed: v.optional(v.boolean()),
    color: v.optional(v.string()),
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
      tap: v.optional(v.union(v.literal("pre-fx"), v.literal("pre-fader"), v.literal("post-fader"))),
    })),
  })
    .index("by_room", ["projectId"])
    .index("by_track", ["trackId"]),

  projectMixerSettings: defineTable({
    projectId: v.string(),
    masterVolume: v.number(),
    updatedAt: v.number(),
  })
    .index("by_room", ["projectId"]),

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
    fades: v.optional(clipFadesValidator),
    color: v.optional(v.string()),
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
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    contentSha256: v.string(),
    r2Key: v.string(),
    duration: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    ownerUserId: v.string(),
    folderId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_room", ["projectId"])
    .index("by_room_assetKey", ["projectId", "assetKey"])
    .index("by_room_folder", ["projectId", "folderId"]),

  assetFolders: defineTable({
    projectId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"]),

  assetUploadReceipts: defineTable({
    projectId: v.string(),
    actorUserId: v.string(),
    idempotencyKey: v.string(),
    contentSha256: v.string(),
    assetKey: v.string(),
    r2Key: v.string(),
    semanticDigest: v.string(),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("failed")),
    mimeType: v.string(),
    sizeBytes: v.number(),
    name: v.string(),
    folderId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_project_actor_idempotency", ["projectId", "actorUserId", "idempotencyKey"])
    .index("by_project_status_updatedAt", ["projectId", "status", "updatedAt"])
    .index("by_status_updatedAt", ["status", "updatedAt"])
    .index("by_asset", ["projectId", "assetKey"])
    .index("by_project_folder_status", ["projectId", "folderId", "status"]),

  projects: defineTable({
    projectId: v.string(),
    storageNamespace: v.string(),
    ownerUserId: v.string(),
    name: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    revision: v.number(),
    tempoBpm: v.number(),
    timeSignatureNumerator: v.number(),
    timeSignatureDenominator: v.number(),
    loopEnabled: v.boolean(),
    loopStartSec: v.number(),
    loopEndSec: v.number(),
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

  controlCommits: defineTable({
    projectId: v.string(),
    apiVersion: v.literal("v1"),
    actorSubject: v.string(),
    actorIssuer: v.optional(v.string()),
    actorTokenIdentifier: v.optional(v.string()),
    actorRole: v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer")),
    idempotencyKey: v.string(),
    requestDigest: v.string(),
    semanticRequest: v.string(),
    priorRevision: v.number(),
    finalRevision: v.number(),
    applied: v.boolean(),
    result: v.any(),
    createdAt: v.number(),
    status: v.literal("completed"),
  })
    .index("by_project_actor_idempotency", ["projectId", "actorSubject", "idempotencyKey"])
    .index("by_project_createdAt", ["projectId", "createdAt"]),

  effects: defineTable({
    projectId: v.string(),
    targetType: v.string(),
    trackId: v.optional(v.id("tracks")),
    index: v.number(),
    type: v.string(),
    instanceId: v.optional(v.string()),
    params: v.any(),
    createdAt: v.number(),
  })
    .index("by_track", ["trackId"])
    .index("by_room", ["projectId"])
    .index("by_room_target", ["projectId", "targetType"])
    .index("by_track_order", ["trackId", "index"]),

  sidechainRoutes: defineTable({
    projectId: v.string(),
    sourceTrackId: v.id("tracks"),
    targetTrackId: v.id("tracks"),
    effectInstanceId: v.string(),
  })
    .index("by_room", ["projectId"])
    .index("by_source", ["sourceTrackId"])
    .index("by_target", ["targetTrackId"])
    .index("by_room_target_effect", ["projectId", "targetTrackId", "effectInstanceId"]),

  automationEnvelopes: defineTable({
    projectId: v.string(),
    targetKind: v.union(v.literal("track"), v.literal("master")),
    trackId: v.optional(v.id("tracks")),
    effectInstanceId: v.optional(v.string()),
    targetKey: v.string(),
    parameterId: v.string(),
    enabled: v.boolean(),
    points: v.array(v.object({
      id: v.string(),
      timeSec: v.number(),
      value: v.number(),
      interpolation: v.union(v.literal("linear"), v.literal("hold")),
    })),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_track", ["projectId", "trackId"])
    .index("by_project_target_key", ["projectId", "targetKey"]),

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
