import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import type { MidiMapping } from "@daw-browser/shared";

import { api } from "./_generated/api";
import { createMidiClipRow, requireSingleProjectId, setClipMidiRow, setClipNameRow, setClipSourceRow } from "./clips";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./clips.ts": () => import("./clips"),
  "./projects.ts": () => import("./projects"),
};
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

const owner = "owner-1";
const midiMapping = (index: number): MidiMapping => ({
  id: `mapping-${index}`,
  source: { kind: "cc", controller: index },
  target: { parameterId: "gain" },
  outputMin: 0,
  outputMax: 1,
});

test("restores audio with an authoritative asset and canonical sample URL", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    await ctx.db.patch(trackId, { kind: "audio" });
    await ctx.db.insert("samples", {
      projectId: "project-1", assetKey: "authoritative-key", sourceKind: "upload",
      name: "audio.wav", mimeType: "audio/wav", sizeBytes: 1, contentSha256: "hash", r2Key: "r2",
      ownerUserId: owner, createdAt: 1, updatedAt: 1,
    });
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1,
      sourceAssetKey: "authoritative-key", sourceKind: "upload", sourceDurationSec: 1,
      sourceSampleRate: 48_000, sourceChannelCount: 2, sampleUrl: "https://stale.example/audio.wav",
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "restore-authoritative-audio",
  });
  const recoveryId = deleted.recoveries[0]?.recoveryId;
  if (!recoveryId) throw new Error("Expected deletion recovery.");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, {
    recoveryId: String(recoveryId),
  });
  expect(restored.status).toBe("applied");
  if (!restored.clipId) throw new Error("Expected restored audio clip.");
  const restoredClip = await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("clips", restored.clipId);
    return id ? await ctx.db.get(id) : null;
  });
  expect(restoredClip?.sampleUrl).toBe("/api/samples/project-1/authoritative-key");
});

test("restores historical sample URL audio without authoritative source metadata", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    await ctx.db.patch(trackId, { kind: "audio" });
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1,
      sampleUrl: "https://legacy.example/audio.wav",
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "restore-historical-audio",
  });
  const recoveryId = deleted.recoveries[0]?.recoveryId;
  if (!recoveryId) throw new Error("Expected deletion recovery.");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, {
    recoveryId: String(recoveryId),
  });
  expect(restored.status).toBe("applied");
  const restoredClip = await t.run(async (ctx) => {
    const id = restored.clipId ? ctx.db.normalizeId("clips", restored.clipId) : null;
    return id ? await ctx.db.get(id) : null;
  });
  expect(restoredClip).toMatchObject({ sampleUrl: "https://legacy.example/audio.wav" });
});

test("replacing an authoritative clip source clears its obsolete sample URL", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    await ctx.db.insert("samples", {
      projectId: "project-1", assetKey: "replacement", sourceKind: "upload",
      name: "replacement.wav", mimeType: "audio/wav", sizeBytes: 1, contentSha256: "replacement", r2Key: "replacement",
      duration: 2, sampleRate: 48_000, channelCount: 2,
      ownerUserId: owner, createdAt: 1, updatedAt: 1,
    });
    return await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1,
      sourceAssetKey: "old", sourceKind: "url", sourceDurationSec: 1, sourceSampleRate: 44_100, sourceChannelCount: 1,
      sampleUrl: "https://legacy.example/old.wav",
    });
  });
  await t.run((ctx) => setClipSourceRow(ctx, {
    projectId: "project-1", clipId, assetKey: "replacement", sourceKind: "upload",
    durationSec: 2, sampleRate: 48_000, channelCount: 2,
  }));
  const updated = await t.run((ctx) => ctx.db.get(clipId));
  expect(updated?.sourceAssetKey).toBe("replacement");
  expect(updated).not.toHaveProperty("sampleUrl");
});

test("restores a deleted clip to its recreated track through history reference", async () => {
  const t = newTest();
  const originalTrackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    await ctx.db.patch(originalTrackId, { historyRef: "track-history-ref" });
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId: originalTrackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "delete-before-track-undo",
  });
  const recoveryId = deleted.recoveries[0]?.recoveryId;
  if (!recoveryId) throw new Error("Expected deletion recovery.");
  const restoredTrackId = await t.run(async (ctx) => {
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", originalTrackId)).unique();
    if (channel) await ctx.db.delete(channel._id);
    await ctx.db.delete(originalTrackId);
    const id = await ctx.db.insert("tracks", {
      projectId: "project-1", name: "MIDI restored", index: 0, kind: "instrument", historyRef: "track-history-ref",
    });
    await ctx.db.insert("mixerChannels", {
      projectId: "project-1", trackId: id, volume: 0.8, channelRole: "track", sends: [],
    });
    return id;
  });
  const restored = await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, {
    recoveryId: String(recoveryId),
  });
  expect(restored.status).toBe("applied");
  const restoredClip = await t.run(async (ctx) => {
    const id = restored.clipId ? ctx.db.normalizeId("clips", restored.clipId) : null;
    return id ? await ctx.db.get(id) : null;
  });
  expect(restoredClip?.trackId).toBe(restoredTrackId);
});

test("rejects deleted clip restoration when the destination track is locked by another actor", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "locked-restore",
  });
  const recoveryId = deleted.recoveries[0]?.recoveryId;
  if (!recoveryId) throw new Error("Expected deletion recovery.");
  await t.run(async (ctx) => {
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", trackId)).unique();
    if (!channel) throw new Error("Expected track channel.");
    await ctx.db.patch(channel._id, { lockedBy: "other-user", lockedAt: Date.now() });
  });

  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, {
    recoveryId: String(recoveryId),
  })).toEqual({ status: "rejected" });
});

const seedWritableTrack = async (t: TestConvex) => {
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId: "project-1" });
  return await t.run(async (ctx) => {
    const trackId = await ctx.db.insert("tracks", {
      projectId: "project-1",
      name: "MIDI",
      index: 0,
      kind: "instrument",
    });
    await ctx.db.insert("mixerChannels", {
      projectId: "project-1",
      trackId,
      volume: 0.8,
      channelRole: "track",
      sends: [],
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, trackId });
    return trackId;
  });
};

const projectRevision = async (
  t: TestConvex,
  projectId: string,
) => await t.run(async (ctx) => {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .unique();
  return project?.revision;
});

test("sets MIDI and timing atomically with shared-operation idempotency and access checks", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const input = {
    projectId: "project-1", clipId: String(clipId), startSec: 2, duration: 3,
    midi: { wave: "square", notes: [{ beat: 0, length: 1, pitch: 64 }] },
    operationId: "set-midi-and-timing",
  };
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.serverSetMidiAndTiming, input))
    .toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.serverSetMidiAndTiming, input))
    .toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await t.run(async (ctx) => await ctx.db.get(clipId))).toMatchObject({
    startSec: 2, duration: 3, midi: { wave: "square", notes: [{ pitch: 64 }] },
  });
  expect(await t.withIdentity({ subject: "other-user" }).mutation(api.clips.serverSetMidiAndTiming, {
    ...input, operationId: "set-midi-and-timing-forbidden",
  })).toEqual({ status: "rejected" });
});

test("accepts empty and single-project clip batches", () => {
  expect(requireSingleProjectId([])).toBeUndefined();
  expect(requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-1" },
  ])).toBe("project-1");
});

test("rejects mixed-project clip batches before mutation work", () => {
  expect(() => requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-2" },
  ])).toThrow("Batch clip writes must target one project.");
});

test("row helpers leave revision ownership to authenticated mutation wrappers", async () => {
  const t = newTest();
  const { clipId } = await t.run(async (ctx) => {
    await ctx.db.insert("projects", {
      projectId: "project-1",
      storageNamespace: "test-namespace",
      ownerUserId: owner,
      name: "Project",
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 0,
    });
    const trackId = await ctx.db.insert("tracks", {
      projectId: "project-1",
      name: "MIDI",
      index: 0,
      kind: "instrument",
    });
    await ctx.db.insert("mixerChannels", {
      projectId: "project-1",
      trackId,
      volume: 0.8,
      channelRole: "track",
      sends: [],
    });
    const creation = await createMidiClipRow(ctx, {
      projectId: "project-1",
      trackId,
      startSec: 0,
      duration: 1,
      ownerUserId: owner,
      midi: { wave: "sine", notes: [] },
    });
    if (!creation.value) throw new Error("Clip was not created.");
    return { clipId: creation.value };
  });

  expect(await t.run(async (ctx) => await ctx.db
    .query("ownerships")
    .withIndex("by_clip", (q) => q.eq("clipId", clipId))
    .unique())).toMatchObject({ projectId: "project-1", ownerUserId: owner, clipId });
  expect(await t.run(async (ctx) => await ctx.db
    .query("samples")
    .withIndex("by_room", (q) => q.eq("projectId", "project-1"))
    .collect())).toHaveLength(0);
  expect(await projectRevision(t, "project-1")).toBe(0);

  expect(await t.run(async (ctx) => await setClipNameRow(ctx, {
    projectId: "project-1",
    clipId,
    name: "Helper rename",
  }))).toEqual({ changed: true });
  expect(await projectRevision(t, "project-1")).toBe(0);

  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.setName, {
    clipId,
    name: "Wrapper rename",
  })).toBeNull();
  expect(await projectRevision(t, "project-1")).toBe(1);
});

test("direct create boundaries reject MIDI limits before writing", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const midi = {
    wave: "sine",
    notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
    cc: [{ beat: 0, controller: 1, value: 0 }],
  };
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.create, {
    projectId: "project-1", trackId, startSec: 0, duration: 1, midi,
  })).rejects.toThrow("performance events");
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.createMany, {
    items: [{ projectId: "project-1", trackId, startSec: 0, duration: 1, midi }],
  })).rejects.toThrow("performance events");
});

test("direct create boundaries reject per-array and mapping MIDI limits", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const base = { projectId: "project-1", trackId, startSec: 0, duration: 1 };
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.create, {
    ...base,
    midi: { wave: "sine", notes: Array.from({ length: 501 }, (_, beat) => ({ beat, length: 1, pitch: 60 })) },
  })).rejects.toThrow("event arrays");
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.createMany, {
    items: [{
      ...base,
      midi: {
        wave: "sine",
        notes: [],
        mappings: Array.from({ length: 65 }, (_, index) => midiMapping(index)),
      },
    }],
  })).rejects.toThrow("mappings");
});

test("replaces legacy persisted MIDI without applying new write limits to the current row", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => await ctx.db.insert("clips", {
    projectId: "project-1",
    trackId,
    startSec: 0,
    duration: 1,
    midi: {
      wave: "sine",
      notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
      cc: [{ beat: 0, controller: 1, value: 0 }],
    },
  }));
  expect(await t.run(async (ctx) => await setClipMidiRow(ctx, {
    projectId: "project-1",
    clipId,
    midi: { wave: "sine", notes: [{ beat: 0, length: 1, pitch: 61 }] },
  }))).toEqual({ changed: true });
  await expect(t.run(async (ctx) => await setClipMidiRow(ctx, {
    projectId: "project-1",
    clipId,
    midi: {
      wave: "sine",
      notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
      cc: [{ beat: 0, controller: 1, value: 0 }],
    },
  }))).rejects.toThrow("performance events");
});

test("restores authenticated idempotent legacy history without relaxing ordinary creates", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const request = {
    projectId: "project-1",
    trackId: String(trackId),
    startSec: 0,
    duration: 1,
    clipKind: "midi",
    operationId: "legacy-history-restore",
    midi: {
      wave: "custom-legacy",
      gain: 7,
      notes: [{ beat: 0, length: -1, pitch: 200 }, ...Array.from({ length: 501 }, (_, beat) => ({ beat: beat + 1, length: 1, pitch: 60 }))],
    },
  };
  expect(await t.withIdentity({ subject: "other-user" }).mutation(api.clips.restoreLegacyHistory, request)).toBeNull();
  const restored = await t.withIdentity({ subject: owner }).mutation(api.clips.restoreLegacyHistory, request);
  expect(restored).not.toBeNull();
  if (restored === null) throw new Error("Expected legacy history restore to return a clip ID.");
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.restoreLegacyHistory, request)).toBe(restored);
  const clip = await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("clips", restored);
    return id ? await ctx.db.get(id) : null;
  });
  expect(clip?.midi).toMatchObject({ wave: "custom-legacy", gain: 7 });
  expect(clip?.midi?.notes).toHaveLength(502);
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.create, {
    ...request,
    trackId,
    operationId: "ordinary-create-must-stay-strict",
  })).rejects.toThrow();
});

test("restores an exact historical clip only through its owning deletion recovery", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1",
      trackId,
      startSec: 0,
      duration: 1,
      midi: {
        wave: "custom-legacy",
        gain: 7,
        notes: [
          { beat: 0, length: 1, pitch: 60 },
          { beat: 1, length: -1, pitch: 200 },
          ...Array.from({ length: 501 }, (_, beat) => ({ beat: beat + 2, length: 1, pitch: 60 })),
        ],
      },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "delete-legacy-midi",
  });
  const recoveryId = String(deleted.recoveries[0]?.recoveryId);
  expect(await t.withIdentity({ subject: "other-user" }).mutation(api.clips.restoreDeleted, { recoveryId }))
    .toEqual({ status: "rejected" });

  const restored = await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, { recoveryId });
  expect(restored.status).toBe("applied");
  if (!restored.clipId) throw new Error("Expected restored clip id.");
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, { recoveryId }))
    .toMatchObject({ status: "noop", clipId: restored.clipId });
  const restoredClip = await t.run(async (ctx) => {
    const restoredClipId = ctx.db.normalizeId("clips", restored.clipId);
    return restoredClipId ? await ctx.db.get(restoredClipId) : null;
  });
  expect(restoredClip?.midi).toMatchObject({ wave: "custom-legacy", gain: 7 });
  expect(restoredClip?.midi?.notes).toHaveLength(503);
  expect(restoredClip?.midi?.notes[1]).toMatchObject({ length: -1, pitch: 200 });
});

test("rejects tampered clip deletion recovery payloads", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds: [clipId], operationId: "delete-tampered",
  });
  const recoveryId = deleted.recoveries[0]?.recoveryId;
  if (!recoveryId) throw new Error("Expected deletion recovery.");
  await t.run(async (ctx) => await ctx.db.patch(recoveryId, { payloadDigest: "tampered" }));
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.restoreDeleted, {
    recoveryId: String(recoveryId),
  })).toEqual({ status: "rejected" });
});

test("replays a delete operation with its original recovery descriptors", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });
  const input = {
    projectId: "project-1",
    clipIds: [String(clipId)],
    operationId: "response-loss-delete",
  };
  const first = await t.withIdentity({ subject: owner }).mutation(api.clips.serverRemoveMany, input);
  const replay = await t.withIdentity({ subject: owner }).mutation(api.clips.serverRemoveMany, input);
  expect(replay).toEqual(first);
  expect(await t.run(async (ctx) => await ctx.db
    .query("clipDeletionRecoveries")
    .withIndex("by_project_createdAt", (q) => q.eq("projectId", "project-1"))
    .collect())).toHaveLength(1);
});

test("rejects recovery batches above retained actor capacity before deleting clips", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipIds = await t.run(async (ctx) => await Promise.all(
    Array.from({ length: 129 }, async (_, index) => {
      const clipId = await ctx.db.insert("clips", {
        projectId: "project-1", trackId, startSec: index, duration: 1, midi: { wave: "sine", notes: [] },
      });
      await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId });
      return clipId;
    }),
  ));
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1", clipIds, operationId: "recovery-over-capacity",
  })).rejects.toThrow("recovery limit");
  expect(await t.run(async (ctx) => await Promise.all(clipIds.map((clipId) => ctx.db.get(clipId))))).toHaveLength(129);
});

test("rejects malformed and missing bulk delete targets without partial deletion or receipts", async () => {
  const t = newTest();
  const trackId = await seedWritableTrack(t);
  const clipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 0, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-1", ownerUserId: owner, clipId: id });
    return id;
  });

  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.serverRemoveMany, {
    projectId: "project-1",
    clipIds: [String(clipId), "not-a-clip-id"],
    operationId: "malformed-delete",
  })).rejects.toThrow("Invalid clip deletion ID");
  const missingClipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-1", trackId, startSec: 1, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.delete(id);
    return id;
  });
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1",
    clipIds: [clipId, missingClipId],
    operationId: "missing-delete",
  })).rejects.toThrow();
  await t.withIdentity({ subject: "owner-2" }).mutation(api.projects.createOwnedRoom, {
    projectId: "project-2",
  });
  const foreignClipId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("clips", {
      projectId: "project-2", trackId, startSec: 2, duration: 1, midi: { wave: "sine", notes: [] },
    });
    await ctx.db.insert("ownerships", { projectId: "project-2", ownerUserId: "owner-2", clipId: id });
    return id;
  });
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-1",
    clipIds: [clipId, foreignClipId],
    operationId: "cross-project-delete",
  })).rejects.toThrow("requested project");
  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.removeMany, {
    projectId: "project-2",
    clipIds: [foreignClipId],
    operationId: "unauthorized-delete",
  })).rejects.toThrow("cannot delete");

  expect(await t.run(async (ctx) => await ctx.db.get(clipId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db.get(foreignClipId))).not.toBeNull();
  expect(await t.run(async (ctx) => await ctx.db
    .query("clipDeletionRecoveries")
    .withIndex("by_project_createdAt", (q) => q.eq("projectId", "project-1"))
    .collect())).toHaveLength(0);
  expect(await t.run(async (ctx) => await ctx.db
    .query("sharedOperationResults")
    .collect())).toHaveLength(0);
});
