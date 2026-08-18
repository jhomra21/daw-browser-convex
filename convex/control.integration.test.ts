import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { canonicalRecoveryPayloadV1, controlCapabilitiesV1, hashRecoveryPayloadSyncV1, parseCapturedRecoveryPayload, parseControlPreviewRequestV1, parseRecoveryPayload, planControlRequestV1, projectSnapshotSchemaV1, type ControlActionV1 } from "@daw-browser/control";
import {
  automationTargetKey,
  createDefaultSynthParams,
  normalizeAudioEffectParamsForUpdate,
  normalizeOwnedProcessorParams,
  synthAutomationKey,
} from "@daw-browser/shared";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { enqueueR2DeleteRows } from "./r2Deletes";
import { readProjectControlSnapshotV1 } from "./controlSnapshot";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./control.ts": () => import("./control"),
  "./projects.ts": () => import("./projects"),
  "./r2Deletes.ts": () => import("./r2Deletes"),
};

const owner = "owner-1";
const projectId = "project-1";

const request = (actions: unknown[], idempotencyKey = "commit-key-1") => ({
  version: "v1",
  projectId,
  idempotencyKey,
  actions,
});

const approvedRequest = async (
  t: Awaited<ReturnType<typeof setup>>,
  actions: unknown[],
  idempotencyKey: string,
) => {
  const approval = await t.withIdentity({ subject: owner }).mutation(api.control.requestApprovalV1, {
    request: { version: "v1", projectId, actions },
  });
  return { ...request(actions, idempotencyKey), approvalToken: approval.approvalToken };
};

const setup = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  return t;
};

const addTrack = async (
  t: Awaited<ReturnType<typeof setup>>,
  input: { name: string; index: number; kind?: string; channelRole?: string; groupId?: Id<"tracks">; lockedBy?: string },
) => await t.run(async (ctx) => {
  const trackId = await ctx.db.insert("tracks", {
    projectId,
    name: input.name,
    index: input.index,
    kind: input.kind,
    groupId: input.groupId,
  });
  await ctx.db.insert("mixerChannels", {
    projectId,
    trackId,
    volume: 0.8,
    channelRole: input.channelRole ?? "track",
    sends: [],
    lockedBy: input.lockedBy,
    lockedAt: input.lockedBy ? Date.now() : undefined,
  });
  await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, trackId });
  return trackId;
});

test("preview is write-free and commit replays persisted client refs", async () => {
  const t = await setup();
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: {
      version: "v1",
      projectId,
      actions: [{ kind: "track.create", clientRef: "new-track", trackKind: "audio", name: "Created" }],
    },
  });
  expect(preview.applied).toBe(true);
  expect(await t.run((ctx) => ctx.db.query("tracks").collect())).toHaveLength(0);

  const first = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "track.create", clientRef: "new-track", trackKind: "audio", name: "Created" }]),
  });
  const track = first.resolvedRefs[0];
  expect(track?.persisted).toBe(true);
  expect(track?.id).toBeTruthy();
  const replay = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "track.create", clientRef: "new-track", trackKind: "audio", name: "Created" }]),
  });
  expect(replay).toEqual({ ...first, idempotencyReplay: true });
});

test("plans and executes a legacy MIDI no-op against the expanded cloud snapshot", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Instrument", index: 0, kind: "instrument" });
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", {
      projectId,
      trackId: track,
      startSec: 0,
      duration: 1,
      name: "Expanded MIDI",
      midi: {
        wave: "sine",
        gain: 0.5,
        inputChannel: 2,
        notes: [{ id: "note-1", beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 2 }],
        cc: [{ id: "cc-1", beat: 0, controller: 1, value: 0.5, channel: 2 }],
        pitchBends: [],
        channelPressure: [],
        polyPressure: [],
        mappings: [{ id: "mapping-1", source: { kind: "cc", controller: 1, channel: 2 }, target: { parameterId: "gain" }, outputMin: 0, outputMax: 1 }],
      },
    });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const action = {
    kind: "clip.midi.set",
    clip: { source: "persisted" as const, id: String(clip) },
    wave: "sine",
    gain: 0.5,
    notes: [{ beat: 0, length: 1, pitch: 60, velocity: 0.5 }],
  };
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [action] },
  });
  expect(preview.applied).toBe(false);
  const committed = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([action], "expanded-midi-noop"),
  });
  expect(committed.applied).toBe(false);
  const v2 = await t.withIdentity({ subject: owner }).query(api.control.snapshotV2, { projectId });
  expect(v2.clips[0]?.midi).toMatchObject({
    inputChannel: 2,
    notes: [{ id: "note-1", channel: 2 }],
    cc: [{ id: "cc-1", channel: 2 }],
  });
  const v1 = await t.withIdentity({ subject: owner }).query(api.control.snapshotV1, { projectId });
  expect(v1.clips[0]?.midi).not.toHaveProperty("cc");
});

test("edits one legacy cloud MIDI note without dropping historical fields", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Legacy instrument", index: 0, kind: "instrument" });
  const notes = Array.from({ length: 501 }, (_, index) => ({
    id: `note-${index}`, beat: index, length: 1, pitch: 60, velocity: 0.5, channel: 1,
  }));
  notes[0] = { id: "invalid-note", beat: -2, length: -1, pitch: 200, velocity: 2, channel: 1 };
  const legacy = {
    wave: "custom-legacy",
    gain: 7,
    notes,
    cc: [{ id: "cc-1", beat: 0, controller: 1, value: 0.5, channel: 1 }],
    mappings: [{ id: "mapping-1", source: { kind: "cc" as const, controller: 1, channel: 1 }, target: { parameterId: "gain" }, outputMin: 0, outputMax: 1 }],
  };
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", {
      projectId, trackId: track, startSec: 0, duration: 1, name: "Legacy MIDI", midi: legacy,
    });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{
      kind: "clip.midi.set",
      clip: { source: "persisted" as const, id: String(clip) },
      wave: "custom-legacy",
      gain: 7,
      notes: notes.map((note) => note.id === "invalid-note"
        ? { ...note, beat: 0, length: 1, pitch: 60, velocity: 0.5 }
        : note),
    }], "legacy-midi-edit"),
  });
  const midi = (await t.withIdentity({ subject: owner }).query(api.control.snapshotV2, { projectId }))
    .clips.find((entry) => entry.id === String(clip))?.midi;
  expect(midi).toMatchObject({ wave: "custom-legacy", gain: 7, cc: legacy.cc, mappings: legacy.mappings });
  expect(midi?.notes).toHaveLength(501);
  expect(midi?.notes.find((note) => note.id === "invalid-note")).toMatchObject({
    id: "invalid-note", beat: 0, length: 1, pitch: 60, velocity: 0.5, channel: 1,
  });
});

test("projects historical finite MIDI values through both cloud snapshot versions", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Legacy instrument", index: 0, kind: "instrument" });
  await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", {
      projectId, trackId: track, startSec: 0, duration: 1, name: "Legacy MIDI",
      midi: {
        wave: "custom-legacy", gain: 7,
        notes: [{ beat: -2, length: -1, pitch: 200, velocity: 2 }],
      },
    });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
  });
  const v1 = await t.withIdentity({ subject: owner }).query(api.control.snapshotV1, { projectId });
  const v2 = await t.withIdentity({ subject: owner }).query(api.control.snapshotV2, { projectId });
  const expected = { wave: "custom-legacy", gain: 7, notes: [{ beat: -2, length: -1, pitch: 200, velocity: 2 }] };
  expect(projectSnapshotSchemaV1.parse(v1).clips[0]?.midi).toEqual(expected);
  expect(v2.clips[0]?.midi).toMatchObject(expected);
});

test("restores a deleted clip through an opaque single-use recovery descriptor", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Audio", index: 0 });
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", { projectId, trackId: track, startSec: 1, duration: 2, name: "Recover" });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const deletion = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "clip.delete", clip: { source: "persisted", id: String(clip) } }], "recovery-delete"),
  });
  const descriptor = deletion.recoveries[0];
  expect(descriptor?.id).toBeTruthy();
  expect(JSON.stringify(deletion)).not.toContain("r2Key");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor!.id } }], "recovery-restore"),
  });
  expect(restored.restored[0]?.entities[0]?.sourceId).toBe(String(clip));
  expect(restored.restored[0]?.entities[0]?.restoredId).not.toBe(String(clip));
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor!.id } }], "recovery-reuse"),
  })).rejects.toThrow("Recovery is unavailable.");
});

test("restores range-deleted clips and automation after verifying semantic drift digests", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Range recovery", index: 0, kind: "audio" });
  const originalPoints = [
    { id: "range-a", timeSec: 0, value: 0, interpolation: "linear" as const },
    { id: "range-b", timeSec: 2, value: 1, interpolation: "linear" as const },
    { id: "range-c", timeSec: 4, value: 0, interpolation: "linear" as const },
  ];
  const clips = await t.run(async (ctx) => {
    const split = await ctx.db.insert("clips", {
      projectId, trackId: track, historyRef: "split-history", startSec: 0, duration: 4, name: "Split", bufferOffsetSec: 0, midiOffsetBeats: 0,
    });
    const deleted = await ctx.db.insert("clips", {
      projectId, trackId: track, historyRef: "deleted-history", startSec: 1.25, duration: 0.5, name: "Deleted", bufferOffsetSec: 0, midiOffsetBeats: 0,
    });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId: split });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId: deleted });
    await ctx.db.insert("automationEnvelopes", {
      projectId,
      targetKind: "track",
      trackId: track,
      targetKey: automationTargetKey({ kind: "track", trackId: String(track) }, "volume"),
      parameterId: "volume",
      enabled: true,
      points: originalPoints,
      updatedAt: 1,
    });
    return { split: String(split), deleted: String(deleted) };
  });
  const action = {
    kind: "timeline.range.delete" as const,
    tracks: [{ source: "persisted" as const, id: String(track) }],
    startSec: 1,
    endSec: 3,
  };
  const deletion = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [action], "range-recovery-delete"),
  });
  const descriptor = deletion.recoveries[0];
  if (!descriptor) throw new Error("Expected range recovery.");
  expect(descriptor.kind).toBe("timeline.range.delete");
  await t.run(async (ctx) => {
    const recoveryId = ctx.db.normalizeId("controlRecoveries", descriptor.id);
    const row = recoveryId ? await ctx.db.get(recoveryId) : null;
    if (!row) throw new Error("Expected stored range recovery.");
    const payload = parseCapturedRecoveryPayload(row.payload);
    if (payload.kind !== "timeline.range.delete") throw new Error("Expected range recovery payload.");
    expect(Object.keys(payload.data).sort()).toEqual([
      "automation", "createdClips", "deletedClips", "range", "updatedClips",
    ]);
    expect(payload.data.range).toEqual({ trackIds: [String(track)], startSec: 1, endSec: 3 });
    expect(payload.data.deletedClips[0]).toMatchObject({ id: clips.deleted, before: { name: "Deleted", historyRef: "deleted-history" } });
    expect(payload.data.updatedClips[0]).toMatchObject({ id: clips.split, before: { name: "Split", historyRef: "split-history" } });
    expect(payload.data.createdClips).toHaveLength(1);
    const created = payload.data.createdClips[0]!;
    expect(created.id).not.toContain("control:");
    expect(await ctx.db.get(ctx.db.normalizeId("clips", created.id)!)).not.toBeNull();
    expect(payload.data.automation[0]?.id).toMatch(/.+/);
  });
  expect(await t.run((ctx) => ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect())).toHaveLength(2);
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "range-recovery-restore"),
  });
  expect(restored.restored[0]?.entities).toEqual([
    expect.objectContaining({ entity: "clip", sourceId: clips.deleted }),
  ]);
  await t.run(async (ctx) => {
    const currentClips = await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    expect(currentClips).toHaveLength(2);
    expect(currentClips.find((clip) => String(clip._id) === clips.split)).toMatchObject({
      startSec: 0,
      duration: 4,
      name: "Split",
    });
    expect(currentClips.some((clip) => clip.name === "Deleted" && clip.startSec === 1.25 && clip.duration === 0.5)).toBe(true);
    expect(currentClips.find((clip) => clip.name === "Deleted")?.historyRef).toBe("deleted-history");
    const automation = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", projectId)).unique();
    expect(automation?.points).toEqual(originalPoints);
  });
});

test("resolves created clip placeholders for a later range split and recovery", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Instrument", index: 0, kind: "instrument" });
  const actions = [
    {
      kind: "clip.midi.create",
      clientRef: "created-clip",
      track: { source: "persisted", id: String(track) },
      startSec: 0,
      duration: 4,
      wave: "sine",
      notes: [{ beat: 0, length: 1, pitch: 60 }],
    },
    {
      kind: "timeline.range.delete",
      tracks: [{ source: "persisted", id: String(track) }],
      startSec: 1,
      endSec: 3,
    },
  ];
  const committed = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request(actions, "create-then-range-delete"),
  });
  const recovery = committed.recoveries[0];
  if (!recovery) throw new Error("Expected range recovery.");
  expect(await t.run(async (ctx) => (
    await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
  ))).toMatchObject([
    { startSec: 0, duration: 1 },
    { startSec: 3, duration: 1 },
  ]);
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: recovery.id } }], "restore-created-range-split"),
  });
  expect(await t.run(async (ctx) => (
    await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()
  ))).toMatchObject([{ startSec: 0, duration: 4 }]);
});

test("keeps recovery restore and range deletion planner and executor references aligned", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Restore then delete", index: 0 });
  await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", {
      projectId, trackId: track, startSec: 1, duration: 1, name: "Recovered then deleted",
    });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [
      {
        kind: "timeline.range.delete",
        tracks: [{ source: "persisted", id: String(track) }],
        startSec: 0.5,
        endSec: 2.5,
      },
    ], "restore-range-initial-delete"),
  });
  const recovery = deleted.recoveries[0];
  if (!recovery) throw new Error("Expected clip recovery.");
  const actions = [
    { kind: "recovery.restore" as const, recovery: { id: recovery.id } },
    {
      kind: "timeline.range.delete" as const,
      tracks: [{ source: "persisted" as const, id: String(track) }],
      startSec: 0.5,
      endSec: 2.5,
    },
  ];
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions },
  });
  expect(preview.applied).toBe(true);
  const committed = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request(actions, "restore-range-commit"),
  });
  const recaptured = committed.recoveries.find((entry) => entry.kind === "timeline.range.delete");
  if (!recaptured) throw new Error("Expected range recovery.");
  expect(await t.run((ctx) => ctx.db.query("clips")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).collect())).toEqual([]);
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: recaptured.id } }], "restore-range-rollback"),
  });
  expect(await t.run((ctx) => ctx.db.query("clips")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).collect())).toMatchObject([
    { name: "Recovered then deleted", startSec: 1, duration: 1 },
  ]);
});

test("lists and restores an unexpired stored V1 clip recovery", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "V1 recovery track", index: 0 });
  const recoveryId = await t.run(async (ctx) => {
    const payload = canonicalRecoveryPayloadV1({
      version: 1,
      kind: "clip.delete",
      data: {
        clipId: "legacy-clip",
        ownership: { projectId, ownerUserId: owner },
        clip: {
          projectId,
          trackId: String(track),
          startSec: 2,
          duration: 3,
          name: "Stored V1 clip",
        },
      },
    });
    return await ctx.db.insert("controlRecoveries", {
      projectId,
      actorSubject: owner,
      sourceActionIndex: 0,
      kind: "clip.delete",
      payload,
      payloadHash: hashRecoveryPayloadSyncV1(payload),
      impact: { clips: 1, processors: 0, automation: 0, sidechains: 0, assets: 0 },
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
  });
  const recoveryIdText = String(recoveryId);
  expect((await t.withIdentity({ subject: owner }).query(api.control.recoveriesV1, { projectId })).entries)
    .toEqual([expect.objectContaining({ id: recoveryIdText, kind: "clip.delete" })]);
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: recoveryIdText } }], "stored-v1-recovery-restore"),
  });
  expect(restored.restored[0]?.entities).toEqual([
    expect.objectContaining({ entity: "clip", sourceId: "legacy-clip" }),
  ]);
  const clips = await t.run((ctx) => ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect());
  expect(clips).toEqual([
    expect.objectContaining({ trackId: track, startSec: 2, duration: 3, name: "Stored V1 clip" }),
  ]);
});

test("captures and restores oversized legacy MIDI for clip and track deletion", async () => {
  const oversizedMidi = {
    wave: "custom-legacy",
    gain: 7,
    notes: Array.from({ length: 500 }, (_, beat) => ({ beat, length: 1, pitch: 60 })),
    cc: [{ beat: 0, controller: 1, value: 0 }],
  };
  for (const deletionKind of ["clip", "track"] as const) {
    const t = await setup();
    const track = await addTrack(t, { name: `Instrument ${deletionKind}`, index: 0, kind: "instrument" });
    const clip = await t.run(async (ctx) => {
      const clipId = await ctx.db.insert("clips", {
        projectId, trackId: track, startSec: 0, duration: 1, midi: oversizedMidi,
      });
      await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
      return clipId;
    });
    const action = deletionKind === "clip"
      ? { kind: "clip.delete" as const, clip: { source: "persisted" as const, id: String(clip) } }
      : { kind: "track.delete" as const, track: { source: "persisted" as const, id: String(track) } };
    const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: await approvedRequest(t, [action], `oversized-${deletionKind}-delete`),
    });
    const descriptor = deleted.recoveries[0];
    if (!descriptor) throw new Error("Expected recovery descriptor.");
    const recovery = await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("controlRecoveries", descriptor.id);
      return id ? await ctx.db.get(id) : null;
    });
    if (!recovery) throw new Error("Recovery row is unavailable.");
    expect(parseCapturedRecoveryPayload(recovery.payload).kind).toBe(`${deletionKind}.delete`);
    const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], `oversized-${deletionKind}-restore`),
    });
    expect(restored.restored).toHaveLength(1);
    const restoredClip = await t.run(async (ctx) => (await ctx.db.query("clips")
      .withIndex("by_room", (q) => q.eq("projectId", projectId))
      .collect())[0]);
    expect(restoredClip?.midi?.notes).toHaveLength(500);
    expect(restoredClip?.midi?.cc).toHaveLength(1);
    expect(restoredClip?.midi).toMatchObject({ wave: "custom-legacy", gain: 7 });
  }
});

test("restores a deleted nested track subtree and survivor routing through recovery", async () => {
  const t = await setup();
  const group = await addTrack(t, { name: "Group", index: 0, channelRole: "group" });
  const child = await addTrack(t, { name: "Child", index: 1 });
  const survivor = await addTrack(t, { name: "Survivor", index: 2 });
  await t.run(async (ctx) => {
    const childRow = await ctx.db.get(child);
    const childChannel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", child)).unique();
    const survivorChannel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", survivor)).unique();
    if (!childRow || !childChannel || !survivorChannel) throw new Error("Track fixtures are unavailable.");
    await ctx.db.patch(childRow._id, { groupId: group });
    await ctx.db.patch(childChannel._id, { outputTargetId: group });
    await ctx.db.patch(survivorChannel._id, { outputTargetId: group, sends: [{ targetId: child, amount: 0.4 }] });
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "track.delete", track: { source: "persisted", id: String(group) } }], "track-recovery-delete"),
  });
  expect(deleted.recoveries[0]?.kind).toBe("track.delete");
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected track recovery.");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "track-recovery-restore"),
  });
  expect(restored.restored[0]?.entities.filter((entity) => entity.entity === "track")).toHaveLength(2);
  await t.run(async (ctx) => {
    const tracks = await ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    const restoredGroup = tracks.find((track) => track.name === "Group");
    const restoredChild = tracks.find((track) => track.name === "Child");
    const restoredSurvivor = tracks.find((track) => track.name === "Survivor");
    if (!restoredGroup || !restoredChild || !restoredSurvivor) throw new Error("Restored tracks are unavailable.");
    const childChannel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", restoredChild._id)).unique();
    const survivorChannel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", restoredSurvivor._id)).unique();
    expect(String(restoredChild.groupId)).toBe(String(restoredGroup._id));
    expect(String(childChannel?.outputTargetId)).toBe(String(restoredGroup._id));
    expect(String(survivorChannel?.outputTargetId)).toBe(String(restoredGroup._id));
    expect(String(survivorChannel?.sends[0]?.targetId)).toBe(String(restoredChild._id));
  });
});

test("restores an ungrouped group and its direct child transitions through recovery", async () => {
  const t = await setup();
  const group = await addTrack(t, { name: "Group", index: 0, channelRole: "group" });
  const child = await addTrack(t, { name: "Child", index: 1, groupId: group });
  await t.run(async (ctx) => {
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", child)).unique();
    if (!channel) throw new Error("Child mixer channel is unavailable.");
    await ctx.db.patch(channel._id, { outputTargetId: group });
  });
  const ungrouped = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "track.ungroup", group: { source: "persisted", id: String(group) } }], "ungroup-recovery-delete"),
  });
  expect(ungrouped.recoveries[0]?.kind).toBe("track.ungroup");
  const descriptor = ungrouped.recoveries[0];
  if (!descriptor) throw new Error("Expected ungroup recovery.");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "ungroup-recovery-restore"),
  });
  expect(restored.restored[0]?.entities.some((entity) => entity.entity === "track")).toBe(true);
  await t.run(async (ctx) => {
    const tracks = await ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    const restoredGroup = tracks.find((track) => track.name === "Group");
    const restoredChild = tracks.find((track) => track.name === "Child");
    if (!restoredGroup || !restoredChild) throw new Error("Restored group fixtures are unavailable.");
    const childChannel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", restoredChild._id)).unique();
    expect(String(restoredChild.groupId)).toBe(String(restoredGroup._id));
    expect(String(childChannel?.outputTargetId)).toBe(String(restoredGroup._id));
  });
});

test("lists only active recovery descriptors without private payload data", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Recovery list", index: 0 });
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", { projectId, trackId: track, startSec: 0, duration: 1 });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "clip.delete", clip: { source: "persisted", id: String(clip) } }], "recovery-list-delete"),
  });
  const listed = await t.withIdentity({ subject: owner }).query(api.control.recoveriesV1, { projectId });
  expect(listed.entries).toEqual([deleted.recoveries[0]]);
  expect(JSON.stringify(listed)).not.toContain("payload");
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected recovery.");
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "recovery-list-restore"),
  });
  expect((await t.withIdentity({ subject: owner }).query(api.control.recoveriesV1, { projectId })).entries).toEqual([]);
});

test("project deletion removes recoveries before a project ID is recreated", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Delete project", index: 0 });
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", { projectId, trackId: track, startSec: 0, duration: 1 });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "clip.delete", clip: { source: "persisted", id: String(clip) } }], "project-delete-recovery"),
  });
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected recovery.");
  await t.run(async (ctx) => {
    await ctx.db.insert("sharedOperationResults", {
      projectId, userId: owner, operationId: "stale-operation-receipt", result: { stale: true }, createdAt: Date.now(),
    });
    await ctx.db.insert("clipDeletionRecoveryReceipts", {
      projectId, actorUserId: owner, recoveryId: "stale-clip-recovery", restoredClipId: "stale-clip",
      createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
  });
  await t.withIdentity({ subject: owner }).mutation(api.projects.prepareCloudRoomDeleteAsOwner, { projectId });
  await t.withIdentity({ subject: owner }).mutation(api.projects.finalizeCloudRoomDeleteAsOwner, { projectId });
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  expect(await t.run(async (ctx) => await ctx.db.query("sharedOperationResults").collect())).toEqual([]);
  expect(await t.run(async (ctx) => await ctx.db.query("clipDeletionRecoveryReceipts").collect())).toEqual([]);
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "recreated-project-recovery"),
  })).rejects.toThrow("Recovery is unavailable.");
});

test("project deletion preserves R2 jobs for prior storage lifecycles", async () => {
  const t = await setup();
  const first = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!first) throw new Error("Expected first project lifecycle.");
  const firstExactKey = `asset-namespaces/${first.storageNamespace}/samples/first`;
  await t.run(async (ctx) => {
    await enqueueR2DeleteRows(ctx, {
      projectId,
      storageNamespace: first.storageNamespace,
      keys: [firstExactKey],
      kind: "sample",
    });
  });
  await t.withIdentity({ subject: owner }).mutation(api.projects.prepareCloudRoomDeleteAsOwner, { projectId });
  await t.withIdentity({ subject: owner }).mutation(api.projects.finalizeCloudRoomDeleteAsOwner, { projectId });
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  const second = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!second) throw new Error("Expected second project lifecycle.");
  expect(second.storageNamespace).not.toBe(first.storageNamespace);
  const secondExactKey = `asset-namespaces/${second.storageNamespace}/samples/second`;
  await t.run(async (ctx) => {
    await enqueueR2DeleteRows(ctx, {
      projectId,
      storageNamespace: second.storageNamespace,
      keys: [secondExactKey],
      kind: "sample",
    });
  });
  await t.withIdentity({ subject: owner }).mutation(api.projects.prepareCloudRoomDeleteAsOwner, { projectId });
  await t.withIdentity({ subject: owner }).mutation(api.projects.finalizeCloudRoomDeleteAsOwner, { projectId });

  const rows = await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue").collect());
  const firstPrefixKey = `asset-namespaces/${first.storageNamespace}/`;
  const secondPrefixKey = `asset-namespaces/${second.storageNamespace}/`;
  expect(rows.map((row) => row.r2Key).sort()).toEqual([
    firstExactKey,
    firstPrefixKey,
    secondExactKey,
    secondPrefixKey,
  ].sort());
  const oldRows = rows.filter((row) => row.r2Key.startsWith(firstPrefixKey));
  const newRows = rows.filter((row) => row.r2Key.startsWith(secondPrefixKey));
  expect(oldRows).toHaveLength(2);
  expect(newRows).toHaveLength(2);
  expect(oldRows.every((row) => !row.r2Key.startsWith(secondPrefixKey))).toBe(true);

  const worker = { subject: "worker", tokenIdentifier: "worker-token", dawWorker: true };
  const claimed = await t.withIdentity(worker).mutation(api.r2Deletes.claimRows, {
    projectId,
    ids: oldRows.map((row) => row._id),
    now: Date.now(),
  });
  await t.withIdentity(worker).mutation(api.r2Deletes.markDeleted, {
    projectId,
    claims: claimed.flatMap((row) => row.claimToken === undefined ? [] : [{ id: row._id, claimToken: row.claimToken }]),
  });
  const drained = await t.run(async (ctx) => await ctx.db.query("r2DeleteQueue").collect());
  expect(drained.filter((row) => row.r2Key.startsWith(firstPrefixKey)).every((row) => row.status === "deleted")).toBe(true);
  expect(drained.filter((row) => row.r2Key.startsWith(secondPrefixKey)).every((row) => row.status === "pending")).toBe(true);
});

test("recovery descriptors are single-use per request and available to project writers", async () => {
  const t = await setup();
  const editor = "recovery-editor";
  await t.run(async (ctx) => {
    await ctx.db.insert("ownerships", { projectId, ownerUserId: editor, role: "editor" });
  });
  const track = await addTrack(t, { name: "Recovery", index: 0 });
  const clip = await t.run(async (ctx) => {
    const clipId = await ctx.db.insert("clips", { projectId, trackId: track, startSec: 0, duration: 1, name: "Cross writer" });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, clipId });
    return clipId;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "clip.delete", clip: { source: "persisted", id: String(clip) } }], "cross-writer-delete"),
  });
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected a recovery descriptor.");
  await expect(t.withIdentity({ subject: editor }).query(api.control.previewV1, {
    request: {
      version: "v1",
      projectId,
      actions: [
        { kind: "recovery.restore", recovery: { id: descriptor.id } },
        { kind: "recovery.restore", recovery: { id: descriptor.id } },
      ],
    },
  })).rejects.toThrow('"code":"validation"');
  const restored = await t.withIdentity({ subject: editor }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "cross-writer-restore"),
  });
  expect(restored.restored[0]?.recoveryId).toBe(descriptor.id);
  const history = await t.withIdentity({ subject: editor }).query(api.control.historyV1, { projectId, limit: 10 });
  expect(history.entries.some((entry) => entry.recoveries.some((recovery) => recovery.id === descriptor.id))).toBe(true);
  expect(JSON.stringify(history)).not.toContain("payloadHash");
  expect(JSON.stringify(history)).not.toContain("r2Key");
  await expect(t.withIdentity({ subject: "outsider" }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [{ kind: "recovery.restore", recovery: { id: descriptor.id } }] },
  })).rejects.toThrow("access to this project");
});

test("restores effect, instrument, arpeggiator, automation, and sidechain payloads with replay-safe mappings", async () => {
  const t = await setup();
  const source = await addTrack(t, { name: "Source", index: 0 });
  const target = await addTrack(t, { name: "Target", index: 1, kind: "instrument" });
  const ids = await t.run(async (ctx) => {
    const utility = await ctx.db.insert("effects", {
      projectId, targetType: "track", trackId: target, index: 0, type: "utility",
      instanceId: "recover-utility", params: normalizeOwnedProcessorParams("utility", {}), createdAt: 1,
    });
    const compressor = await ctx.db.insert("effects", {
      projectId, targetType: "track", trackId: target, index: 1, type: "compressor",
      instanceId: "recover-compressor", params: normalizeAudioEffectParamsForUpdate("compressor", {}), createdAt: 2,
    });
    const instrument = await ctx.db.insert("effects", {
      projectId, targetType: "track", trackId: target, index: 2, type: "instrument",
      instanceId: "recover-instrument", params: { kind: "synth", instanceId: "recover-instrument", params: createDefaultSynthParams() }, createdAt: 3,
    });
    const arpeggiator = await ctx.db.insert("effects", {
      projectId, targetType: "track", trackId: target, index: 3, type: "arpeggiator",
      params: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false }, createdAt: 4,
    });
    await ctx.db.insert("automationEnvelopes", {
      projectId, targetKind: "master", targetKey: 'automation:v2:["master",null,null,"volume"]', parameterId: "volume", enabled: true,
      points: [{ id: "recover-point", timeSec: 0, value: 0.5, interpolation: "linear" }], updatedAt: 5,
    });
    await ctx.db.insert("sidechainRoutes", {
      projectId, sourceTrackId: source, targetTrackId: target, effectInstanceId: "recover-compressor",
    });
    return { utility, compressor, instrument, arpeggiator };
  });
  const ref = (id: Id<"tracks"> | Id<"effects">) => ({ source: "persisted" satisfies "persisted", id: String(id) });
  const destructive = [
    { kind: "effect.remove", target: { kind: "track", track: ref(target) }, effect: ref(ids.utility), effectKind: "utility" },
    { kind: "instrument.remove", target: { kind: "track", track: ref(target) } },
    { kind: "arpeggiator.remove", target: { kind: "track", track: ref(target) } },
    { kind: "automation.delete", target: { kind: "master" }, parameterId: "volume" },
    { kind: "sidechain.remove", target: ref(target), effect: ref(ids.compressor) },
  ];
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, destructive, "bundle-recovery-delete"),
  });
  expect(deleted.recoveries.map((recovery) => recovery.kind).sort()).toEqual([
    "arpeggiator.remove", "automation.delete", "effect.remove", "instrument.remove", "sidechain.remove",
  ]);
  for (const [index, descriptor] of deleted.recoveries.entries()) {
    const recovery = await t.run(async (ctx) => {
      const recoveryId = ctx.db.normalizeId("controlRecoveries", descriptor.id);
      return recoveryId === null ? null : await ctx.db.get(recoveryId);
    });
    if (!recovery) throw new Error("Recovery record missing.");
    expect(JSON.parse(recovery.payload).version).toBe(2);
    parseRecoveryPayload(recovery.payload);
    let preview;
    try {
      preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
        request: { version: "v1", projectId, actions: [{ kind: "recovery.restore", recovery: { id: descriptor.id } }] },
      });
    } catch {
      throw new Error(`Recovery preview failed for ${descriptor.kind}.`);
    }
    expect(preview.applied).toBe(true);
    const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], `bundle-recovery-${index}`),
    });
    const replay = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], `bundle-recovery-${index}`),
    });
    expect(restored.restored[0]?.entities.length).toBeGreaterThan(0);
    expect(replay.idempotencyReplay).toBe(true);
  }
});

test("restores legacy synth instruments and their automation with canonical parameters", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Legacy synth", index: 0, kind: "instrument" });
  const instanceId = "legacy-synth";
  const parameterId = synthAutomationKey(String(track), instanceId, "filter.frequency");
  const targetKey = automationTargetKey({ kind: "track", trackId: String(track) }, parameterId);
  const legacySynth = await t.run(async (ctx) => {
    const effectId = await ctx.db.insert("effects", {
      projectId,
      targetType: "track",
      trackId: track,
      index: 0,
      type: "synth",
      instanceId,
      params: createDefaultSynthParams(),
      createdAt: 1,
    });
    await ctx.db.insert("automationEnvelopes", {
      projectId,
      targetKind: "track",
      trackId: track,
      targetKey,
      parameterId,
      enabled: true,
      points: [{ id: "legacy-point", timeSec: 0, value: 440, interpolation: "linear" }],
      updatedAt: 1,
    });
    return effectId;
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{
      kind: "instrument.remove",
      target: { kind: "track", track: { source: "persisted", id: String(track) } },
    }], "legacy-synth-delete"),
  });
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected legacy synth recovery.");
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: {
      version: "v1",
      projectId,
      actions: [{ kind: "recovery.restore", recovery: { id: descriptor.id } }],
    },
  });
  expect(preview.applied).toBe(true);
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "legacy-synth-restore"),
  });
  const restored = await t.run(async (ctx) => {
    const effect = await ctx.db.query("effects").withIndex("by_track", (query) => query.eq("trackId", track)).unique();
    const automation = await ctx.db.query("automationEnvelopes")
      .withIndex("by_project_target_key", (query) => query.eq("projectId", projectId).eq("targetKey", targetKey))
      .unique();
    return { effect, automation };
  });
  expect(restored.effect?._id).not.toBe(legacySynth);
  expect(restored.effect).toMatchObject({
    type: "instrument",
    instanceId,
    params: { kind: "synth", instanceId, params: createDefaultSynthParams() },
  });
  expect(restored.automation).toMatchObject({
    parameterId,
    points: [{ id: "legacy-point", timeSec: 0, value: 440, interpolation: "linear" }],
  });
});

test("restores an asset before its pending deletion claim and replays the restore", async () => {
  const t = await setup();
  const project = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!project) throw new Error("Project missing.");
  await t.run(async (ctx) => {
    await ctx.db.insert("samples", {
      projectId,
      assetKey: "recover-asset",
      sourceKind: "upload",
      name: "Recover.wav",
      mimeType: "audio/wav",
      sizeBytes: 1,
      contentSha256: "a".repeat(64),
      r2Key: `asset-namespaces/${project.storageNamespace}/recover-asset`,
      ownerUserId: owner,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const deleted = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [
      { kind: "asset.delete", asset: { source: "persisted", id: "recover-asset" } },
    ], "asset-recovery-delete"),
  });
  const descriptor = deleted.recoveries[0];
  if (!descriptor) throw new Error("Expected an asset recovery descriptor.");
  const restored = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "asset-recovery-restore"),
  });
  const replay = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "recovery.restore", recovery: { id: descriptor.id } }], "asset-recovery-restore"),
  });
  expect(restored.restored[0]?.entities[0]?.entity).toBe("asset");
  expect(replay.idempotencyReplay).toBe(true);
});

test("previews, approves, and commits restore-then-delete asset recovery with a canonical recapture", async () => {
  const t = await setup();
  const project = await t.run(async (ctx) => await ctx.db.query("projects")
    .withIndex("by_room", (query) => query.eq("projectId", projectId)).unique());
  if (!project) throw new Error("Project missing.");
  await t.run(async (ctx) => {
    await ctx.db.insert("samples", {
      projectId,
      assetKey: "restore-then-delete",
      sourceKind: "upload",
      name: "Recovered.wav",
      mimeType: "audio/wav",
      sizeBytes: 1,
      contentSha256: "a".repeat(64),
      r2Key: `asset-namespaces/${project.storageNamespace}/restore-then-delete`,
      duration: 1,
      sampleRate: 48_000,
      channelCount: 2,
      ownerUserId: owner,
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const initial = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [
      { kind: "asset.delete", asset: { source: "persisted", id: "restore-then-delete" } },
    ], "restore-then-delete-initial"),
  });
  const recovery = initial.recoveries[0];
  if (!recovery) throw new Error("Expected asset recovery.");

  const actions = [
    { kind: "recovery.restore" as const, recovery: { id: recovery.id } },
    { kind: "asset.delete" as const, asset: { source: "persisted" as const, id: "restore-then-delete" } },
  ];
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions },
  });
  expect(preview.applied).toBe(true);
  const committed = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, actions, "restore-then-delete-commit"),
  });
  const recaptured = committed.recoveries[0];
  if (!recaptured) throw new Error("Expected recaptured asset recovery.");
  const row = await t.run(async (ctx) => {
    const id = ctx.db.normalizeId("controlRecoveries", recaptured.id);
    return id ? await ctx.db.get(id) : null;
  });
  if (!row) throw new Error("Expected recaptured recovery row.");
  expect(hashRecoveryPayloadSyncV1(row.payload)).toBe(row.payloadHash);
  expect(parseCapturedRecoveryPayload(row.payload)).toMatchObject({
    kind: "asset.delete",
    data: {
      assetId: "restore-then-delete",
      asset: {
        r2Key: `asset-namespaces/${project.storageNamespace}/restore-then-delete`,
        duration: 1,
        sampleRate: 48_000,
        channelCount: 2,
      },
    },
  });
  expect(await t.run((ctx) => ctx.db.query("samples")
    .withIndex("by_room_assetKey", (query) => query.eq("projectId", projectId).eq("assetKey", "restore-then-delete"))
    .unique())).toBeNull();
});

test("locked affected tracks reject preview and commit with an action index", async () => {
  const t = await setup();
  const trackId = await addTrack(t, { name: "Locked", index: 0, lockedBy: "other-user" });
  const action = { kind: "track.rename", track: { source: "persisted", id: String(trackId) }, name: "Blocked" };
  await expect(t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [action] },
  })).rejects.toThrow("Affected track is locked");
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([action]),
  })).rejects.toThrow('"actionIndex":0');
});

test("deleting a group recursively removes nested tracks and dependent rows", async () => {
  const t = await setup();
  const group = await addTrack(t, { name: "Group", index: 0, channelRole: "group" });
  const child = await addTrack(t, { name: "Child", index: 1, groupId: group });
  const grandchild = await addTrack(t, { name: "Grandchild", index: 2, groupId: child });
  await t.run(async (ctx) => {
    await ctx.db.insert("effects", {
      projectId,
      targetType: "track",
      trackId: grandchild,
      index: 0,
      type: "utility",
      instanceId: "effect-1",
      params: normalizeOwnedProcessorParams("utility", {}),
      createdAt: Date.now(),
    });
    await ctx.db.insert("clips", { projectId, trackId: grandchild, startSec: 0, duration: 1 });
  });
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "track.delete", track: { source: "persisted", id: String(group) } }], "group-delete"),
  });
  expect(await t.run((ctx) => ctx.db.query("tracks").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("effects").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("clips").collect())).toHaveLength(0);
});

test("destructive commits require an actor-bound one-time approval", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Delete", index: 0 });
  const actions = [{ kind: "track.delete", track: { source: "persisted" as const, id: String(track) } }];
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request(actions, "approval-required"),
  })).rejects.toThrow("approval-required");
  const approval = await t.withIdentity({ subject: owner }).mutation(api.control.requestApprovalV1, {
    request: { version: "v1", projectId, actions },
  });
  expect((await t.run((ctx) => ctx.db.query("controlApprovals").unique()))?.tokenHash).not.toBe(approval.approvalToken);
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: { ...request(actions, "approval-once"), approvalToken: approval.approvalToken },
  });
  expect((await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: { ...request(actions, "approval-once"), approvalToken: approval.approvalToken },
  })).idempotencyReplay).toBe(true);
});

test("project approval capacity rejects the sixty-fifth active approval", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Capacity", index: 0 });
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let index = 0; index < 64; index += 1) {
      await ctx.db.insert("controlApprovals", {
        projectId,
        actorSubject: `departed-${index}`,
        requestDigest: `${index}`.padStart(64, "0"),
        baseRevision: 0,
        actionIndexes: [0],
        tokenHash: `hash-${index}`,
        createdAt: now + index,
        expiresAt: now + 60_000,
      });
    }
  });
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.requestApprovalV1, {
    request: {
      version: "v1",
      projectId,
      actions: [{ kind: "track.delete", track: { source: "persisted", id: String(track) } }],
    },
  })).rejects.toThrow("retention is full");
  expect(await t.run((ctx) => ctx.db.query("controlApprovals").collect())).toHaveLength(64);
});

test("existing effect omitted params and unchanged instrument do not advance revision", async () => {
  const t = await setup();
  const trackId = await addTrack(t, { name: "Instrument", index: 0, kind: "instrument" });
  const effectId = await t.run(async (ctx) => await ctx.db.insert("effects", {
    projectId,
    targetType: "track",
    trackId,
    index: 0,
    type: "utility",
    instanceId: "eq-1",
    params: normalizeOwnedProcessorParams("utility", {}),
    createdAt: Date.now(),
  }));
  const before = await t.run(async (ctx) => (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision);
  const result = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{
      kind: "effect.upsert",
      target: { kind: "track", track: { source: "persisted", id: String(trackId) } },
      effect: { source: "persisted", id: String(effectId) },
      effectKind: "utility",
    }]),
  });
  expect(result.applied).toBe(false);
  expect(await t.run(async (ctx) => (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision)).toBe(before);
});

test("commit retention keeps at most one thousand ledger rows", async () => {
  const t = await setup();
  const createdAt = Date.now();
  await t.run(async (ctx) => {
    for (let index = 0; index < 1_500; index += 1) {
      await ctx.db.insert("controlCommits", {
        projectId,
        apiVersion: "v1",
        actorSubject: owner,
        actorRole: "owner",
        idempotencyKey: `seed-${index}`,
        requestDigest: `seed-${index}`,
        semanticRequest: "{}",
        priorRevision: 0,
        finalRevision: 0,
        applied: false,
        result: {},
        createdAt: createdAt + index,
        status: "completed",
      });
    }
  });
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "project.rename", name: "Retained" }], "retention-key"),
  });
  expect(await t.run(async (ctx) => (await ctx.db
    .query("controlCommits")
    .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
    .collect()).length)).toBeLessThanOrEqual(1_000);
});

test("created refs removed in the same commit are not reported as persisted", async () => {
  const t = await setup();
  const result = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([
      { kind: "track.create", clientRef: "temporary-track", trackKind: "audio" },
      { kind: "track.delete", track: { source: "client", clientRef: "temporary-track" } },
    ], "created-then-deleted"),
  });
  expect(result.resolvedRefs).toEqual([]);
  expect(await t.run((ctx) => ctx.db.query("tracks").collect())).toEqual([]);
});

test("expired idempotency records execute as a new request", async () => {
  const t = await setup();
  await t.run(async (ctx) => {
    await ctx.db.insert("controlCommits", {
      projectId,
      apiVersion: "v1",
      actorSubject: owner,
      actorRole: "owner",
      idempotencyKey: "expired-key",
      requestDigest: "old",
      semanticRequest: "{}",
      priorRevision: 0,
      finalRevision: 0,
      applied: false,
      result: {},
      createdAt: Date.now() - 91 * 24 * 60 * 60 * 1000,
      status: "completed",
    });
  });
  const result = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "project.rename", name: "Fresh" }], "expired-key"),
  });
  expect(result.idempotencyReplay).toBe(false);
  expect(result.applied).toBe(true);
});

test("track reorder preserves existing output routing", async () => {
  const t = await setup();
  const first = await addTrack(t, { name: "First", index: 0 });
  const second = await addTrack(t, { name: "Second", index: 1, channelRole: "group" });
  await t.run(async (ctx) => {
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", first)).unique();
    if (!channel) throw new Error("Missing mixer channel.");
    await ctx.db.patch(channel._id, { outputTargetId: second });
  });
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{
      kind: "track.reorder",
      tracks: [
        { track: { source: "persisted", id: String(first) }, index: 1, group: null },
        { track: { source: "persisted", id: String(second) }, index: 0, group: null },
      ],
    }], "preserve-routing"),
  });
  const channel = await t.run((ctx) => ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", first)).unique());
  expect(String(channel?.outputTargetId)).toBe(String(second));
});

test("deletion rejects a locked surviving routing dependent", async () => {
  const t = await setup();
  const deleted = await addTrack(t, { name: "Deleted", index: 0 });
  const dependent = await addTrack(t, { name: "Dependent", index: 1, lockedBy: "other-user" });
  await t.run(async (ctx) => {
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", dependent)).unique();
    if (!channel) throw new Error("Missing mixer channel.");
    await ctx.db.patch(channel._id, { outputTargetId: deleted });
  });
  const action = { kind: "track.delete", track: { source: "persisted", id: String(deleted) } };
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([action], "locked-routing-delete"),
  })).rejects.toThrow("Affected track is locked");
});

test("deletion rejects a locked index-only survivor without writes", async () => {
  const t = await setup();
  const deleted = await addTrack(t, { name: "Deleted", index: 0 });
  const survivor = await addTrack(t, { name: "Locked survivor", index: 1, lockedBy: "other-user" });
  const action = { kind: "track.delete", track: { source: "persisted", id: String(deleted) } };
  const before = await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    revision: (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision,
    commits: await ctx.db.query("controlCommits").collect(),
  }));
  for (const invoke of [
    () => t.withIdentity({ subject: owner }).query(api.control.previewV1, {
      request: { version: "v1", projectId, actions: [action] },
    }),
    () => t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([action], "locked-index-delete"),
    }),
  ]) {
    await expect(invoke()).rejects.toThrow("Affected track is locked");
  }
  expect(await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    revision: (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision,
    commits: await ctx.db.query("controlCommits").collect(),
  }))).toEqual(before);
  expect(String(survivor)).toBeTruthy();
});

test("deletion rejects a locked surviving sidechain dependent without writes", async () => {
  const t = await setup();
  const deleted = await addTrack(t, { name: "Deleted source", index: 0 });
  const target = await addTrack(t, { name: "Locked target", index: 1, lockedBy: "other-user" });
  await t.run(async (ctx) => {
    await ctx.db.insert("effects", {
      projectId,
      targetType: "track",
      trackId: target,
      index: 0,
      type: "compressor",
      instanceId: "compressor-1",
      params: normalizeAudioEffectParamsForUpdate("compressor", {}),
      createdAt: Date.now(),
    });
    await ctx.db.insert("sidechainRoutes", {
      projectId,
      sourceTrackId: deleted,
      targetTrackId: target,
      effectInstanceId: "compressor-1",
    });
  });
  const action = { kind: "track.delete", track: { source: "persisted", id: String(deleted) } };
  const before = await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    sidechains: await ctx.db.query("sidechainRoutes").collect(),
    revision: (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision,
    commits: await ctx.db.query("controlCommits").collect(),
  }));
  for (const invoke of [
    () => t.withIdentity({ subject: owner }).query(api.control.previewV1, {
      request: { version: "v1", projectId, actions: [action] },
    }),
    () => t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([action], "locked-sidechain-delete"),
    }),
  ]) {
    await expect(invoke()).rejects.toThrow("Affected track is locked");
  }
  expect(await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    sidechains: await ctx.db.query("sidechainRoutes").collect(),
    revision: (await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique())?.revision,
    commits: await ctx.db.query("controlCommits").collect(),
  }))).toEqual(before);
});

test("track recovery transition limits accept sixty-four survivors and reject sixty-five before approval creation", async () => {
  const allowed = await setup();
  const root = await addTrack(allowed, { name: "Deleted", index: 0 });
  for (let index = 0; index < 64; index += 1) {
    await addTrack(allowed, { name: `Survivor ${index}`, index: index + 1 });
  }
  const allowedAction = { kind: "track.delete", track: { source: "persisted" as const, id: String(root) } };
  expect((await allowed.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [allowedAction] },
  })).approval?.required).toBe(true);
  expect((await allowed.withIdentity({ subject: owner }).mutation(api.control.requestApprovalV1, {
    request: { version: "v1", projectId, actions: [allowedAction] },
  }).then((approval) => approval.approvalToken)).length).toBeGreaterThan(0);

  const rejected = await setup();
  const rejectedRoot = await addTrack(rejected, { name: "Deleted", index: 0 });
  for (let index = 0; index < 65; index += 1) {
    await addTrack(rejected, { name: `Survivor ${index}`, index: index + 1 });
  }
  const rejectedAction = { kind: "track.delete", track: { source: "persisted" as const, id: String(rejectedRoot) } };
  await expect(rejected.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [rejectedAction] },
  })).rejects.toThrow('"code":"limit-exceeded"');
  await expect(rejected.withIdentity({ subject: owner }).mutation(api.control.requestApprovalV1, {
    request: { version: "v1", projectId, actions: [rejectedAction] },
  })).rejects.toThrow('"code":"limit-exceeded"');
  expect(await rejected.run((ctx) => ctx.db.query("controlApprovals").collect())).toEqual([]);
});

test("recovery locks appended tracks whose indices would shift before writes", async () => {
  const t = await setup();
  const deleted = await addTrack(t, { name: "Deleted", index: 0 });
  const survivor = await addTrack(t, { name: "Survivor", index: 1 });
  const deletion = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{ kind: "track.delete", track: { source: "persisted", id: String(deleted) } }], "recovery-lock-delete"),
  });
  const descriptor = deletion.recoveries[0];
  if (!descriptor) throw new Error("Expected recovery descriptor.");
  const appended = await addTrack(t, { name: "Appended", index: 1, lockedBy: "other-user" });
  const action = {
    kind: "recovery.restore",
    recovery: { id: descriptor.id },
  } satisfies ControlActionV1;
  const before = await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    approvals: await ctx.db.query("controlApprovals").collect(),
    commits: await ctx.db.query("controlCommits").collect(),
  }));
  for (const invoke of [
    () => t.withIdentity({ subject: owner }).query(api.control.previewV1, {
      request: { version: "v1", projectId, actions: [action] },
    }),
    () => t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
      request: request([action], "recovery-lock-restore"),
    }),
  ]) {
    await expect(invoke()).rejects.toThrow("Affected track is locked");
  }
  expect(await t.run(async (ctx) => ({
    tracks: await ctx.db.query("tracks").collect(),
    approvals: await ctx.db.query("controlApprovals").collect(),
    commits: await ctx.db.query("controlCommits").collect(),
  }))).toEqual(before);
  expect(String(survivor)).toBeTruthy();
  expect(String(appended)).toBeTruthy();
});

test("track recovery restores canonical contiguous order matching its preview", async () => {
  const t = await setup();
  const leading = await addTrack(t, { name: "Leading", index: 0 });
  const group = await addTrack(t, { name: "Group", index: 1, channelRole: "group" });
  const child = await addTrack(t, { name: "Child", index: 2, groupId: group });
  const grandchild = await addTrack(t, { name: "Grandchild", index: 3, groupId: child });
  const trailing = await addTrack(t, { name: "Trailing", index: 4 });
  const deletion = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [{
      kind: "track.delete",
      track: { source: "persisted", id: String(group) },
    }], "canonical-order-delete"),
  });
  const descriptor = deletion.recoveries[0];
  if (!descriptor) throw new Error("Expected recovery descriptor.");
  await addTrack(t, { name: "Appended one", index: 2 });
  await addTrack(t, { name: "Appended two", index: 3 });
  const action = {
    kind: "recovery.restore",
    recovery: { id: descriptor.id },
  } satisfies ControlActionV1;
  await t.withIdentity({ subject: owner }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [action] },
  });
  const expected = await t.run(async (ctx) => {
    const recoveryId = ctx.db.normalizeId("controlRecoveries", descriptor.id);
    const recovery = recoveryId ? await ctx.db.get(recoveryId) : null;
    if (!recovery) throw new Error("Recovery record is unavailable.");
    return planControlRequestV1(
      await readProjectControlSnapshotV1(ctx, projectId),
      { projectId, actions: [action] },
      new Map([[descriptor.id, { payload: parseRecoveryPayload(recovery.payload) }]]),
    ).snapshot.tracks.map((track) => ({ name: track.name, index: track.index }));
  });
  await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([action], "canonical-order-restore"),
  });
  const actual = await t.run(async (ctx) => (await ctx.db.query("tracks")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .collect())
    .sort((left, right) => left.index - right.index || String(left._id).localeCompare(String(right._id)))
    .map((track) => ({ name: track.name, index: track.index })));
  expect(actual.map((track) => track.index)).toEqual(Array.from({ length: actual.length }, (_, index) => index));
  expect(actual).toEqual(expected);
  expect(String(leading)).toBeTruthy();
  expect(String(child)).toBeTruthy();
  expect(String(grandchild)).toBeTruthy();
  expect(String(trailing)).toBeTruthy();
});

test("replay requires current write access without rerunning control preflight", async () => {
  const t = await setup();
  const editor = "editor-1";
  await t.run(async (ctx) => {
    await ctx.db.insert("ownerships", { projectId, ownerUserId: editor, role: "editor" });
  });
  const commitRequest = request([
    { kind: "track.create", clientRef: "editor-track", trackKind: "audio", name: "Editor track" },
  ], "editor-replay-key");
  const first = await t.withIdentity({ subject: editor }).mutation(api.control.commitV1, { request: commitRequest });
  await t.run(async (ctx) => {
    const memberships = await ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", editor))
      .collect();
    const membership = memberships.find((entry) => !entry.trackId && !entry.clipId);
    if (!membership) throw new Error("Editor membership was not found.");
    await ctx.db.delete(membership._id);
  });
  await expect(t.withIdentity({ subject: editor }).mutation(api.control.commitV1, {
    request: commitRequest,
  })).rejects.toThrow("write access");
  expect(await t.run((ctx) => ctx.db.query("controlCommits").collect())).toHaveLength(1);
  expect(first.idempotencyReplay).toBe(false);
});

test("endpoint enforces roles, revision conflicts, and idempotency key scopes", async () => {
  const t = await setup();
  const viewer = "viewer-1";
  const editor = "editor-1";
  await t.run(async (ctx) => {
    await ctx.db.insert("ownerships", { projectId, ownerUserId: viewer, role: "viewer" });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: editor, role: "editor" });
  });
  const action = { kind: "track.create", clientRef: "scoped-track", trackKind: "audio", name: "Scoped" };
  await expect(t.withIdentity({ subject: viewer }).query(api.control.previewV1, {
    request: { version: "v1", projectId, actions: [action] },
  })).rejects.toThrow("Viewers cannot execute");
  await expect(t.withIdentity({ subject: viewer }).mutation(api.control.commitV1, {
    request: request([action], "viewer-key"),
  })).rejects.toThrow("Viewers cannot execute");
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: { ...request([action], "revision-key"), expectedRevision: 99 },
  })).rejects.toThrow("revision");

  const ownerCommit = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([action], "shared-key"),
  });
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request([{ kind: "track.create", clientRef: "different-track", trackKind: "audio", name: "Different" }], "shared-key"),
  })).rejects.toThrow("Idempotency key");
  const editorCommit = await t.withIdentity({ subject: editor }).mutation(api.control.commitV1, {
    request: request([{ kind: "track.create", clientRef: "editor-track", trackKind: "audio", name: "Editor" }], "shared-key"),
  });
  expect(ownerCommit.idempotencyReplay).toBe(false);
  expect(editorCommit.idempotencyReplay).toBe(false);
});

test("late execution failures roll back earlier actions, revisions, and idempotency rows", async () => {
  const t = await setup();
  const track = await addTrack(t, { name: "Before", index: 0 });
  const clip = await t.run(async (ctx) => await ctx.db.insert("clips", {
    projectId,
    trackId: track,
    startSec: 0,
    duration: 1,
    name: "Unowned",
  }));
  const before = await t.run(async (ctx) => ({
    project: await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique(),
    track: await ctx.db.get(track),
    commits: await ctx.db.query("controlCommits").collect(),
  }));
  await expect(t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, [
      { kind: "track.rename", track: { source: "persisted", id: String(track) }, name: "Changed" },
      { kind: "clip.delete", clip: { source: "persisted", id: String(clip) } },
    ], "late-failure"),
  })).rejects.toThrow("Control execution failed");
  expect(await t.run(async (ctx) => ({
    project: await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique(),
    track: await ctx.db.get(track),
    commits: await ctx.db.query("controlCommits").collect(),
  }))).toEqual(before);
});

test("every advertised action has an authenticated preview and commit endpoint fixture", async () => {
  const t = await setup();
  const group = await addTrack(t, { name: "Group", index: 0, channelRole: "group" });
  const audio = await addTrack(t, { name: "Audio", index: 1 });
  const instrument = await addTrack(t, { name: "Instrument", index: 2, kind: "instrument" });
  const source = await addTrack(t, { name: "Source", index: 3 });
  const returnTrack = await addTrack(t, { name: "Return", index: 4, channelRole: "return" });
  await t.run(async (ctx) => await ctx.db.insert("samples", {
    projectId,
    assetKey: "asset-1",
    sourceKind: "upload",
    name: "Fixture Audio",
    mimeType: "audio/wav",
    sizeBytes: 1,
    contentSha256: "a".repeat(64),
    r2Key: "fixture-audio",
    duration: 2,
    sampleRate: 48_000,
    channelCount: 2,
    ownerUserId: owner,
    createdAt: 0,
    updatedAt: 0,
  }));
  const removable = await t.run(async (ctx) => await ctx.db.insert("effects", {
    projectId,
    targetType: "track",
    trackId: instrument,
    index: 0,
    type: "utility",
    instanceId: "removable-utility",
    params: normalizeOwnedProcessorParams("utility", {}),
    createdAt: Date.now(),
  }));
  const ref = (id: Id<"tracks">) => ({ source: "persisted" as const, id: String(id) });
  const temp = { source: "client" as const, clientRef: "temporary" };
  const actions = [
    { kind: "project.rename", name: "Endpoint Matrix" },
    { kind: "project.settings.set", tempoBpm: 128, loopEnabled: true, loopStartSec: 1, loopEndSec: 9 },
    { kind: "track.create", clientRef: "temporary", trackKind: "audio", name: "Temporary" },
    { kind: "track.rename", track: ref(audio), name: "Renamed audio" },
    { kind: "track.mix.set", track: ref(audio), volume: 0.6, muted: true, soloed: false },
    {
      kind: "track.routing.set",
      track: ref(audio),
      output: ref(group),
      sends: [{ target: ref(returnTrack), amount: 0.5, tap: "post-fader" }],
    },
    { kind: "track.group.set", track: ref(audio), group: ref(group) },
    {
      kind: "track.reorder",
      tracks: [
        { track: ref(group), index: 0, group: null },
        { track: ref(audio), index: 1, group: ref(group) },
        { track: ref(instrument), index: 2, group: null },
        { track: ref(source), index: 3, group: null },
        { track: temp, index: 4, group: null },
        { track: ref(returnTrack), index: 5, group: null },
      ],
    },
    {
      kind: "clip.midi.create",
      clientRef: "midi",
      track: ref(instrument),
      name: "MIDI",
      startSec: 0,
      duration: 2,
      wave: "sine",
      notes: [{ beat: 0, length: 1, pitch: 60 }],
    },
    {
      kind: "clip.audio.create",
      clientRef: "audio-clip",
      track: ref(audio),
      asset: { source: "persisted" as const, id: "asset-1" },
      color: "#22C55E",
      audioWarp: {
        enabled: true,
        sourceBpm: 120.004,
        sourceBeatOffset: 0.0004,
        mode: "stretch",
      },
    },
    {
      kind: "clip.source.set",
      clip: { source: "client" as const, clientRef: "audio-clip" },
      asset: { source: "persisted" as const, id: "asset-1" },
    },
    {
      kind: "clip.fades.set",
      clip: { source: "client" as const, clientRef: "audio-clip" },
      fades: { fadeInSec: 0.1, fadeOutSec: 0.1, fadeInCurve: 0, fadeOutCurve: 0 },
    },
    {
      kind: "clip.audioWarp.set",
      clip: { source: "client" as const, clientRef: "audio-clip" },
      audioWarp: {
        enabled: true,
        sourceBpm: 120.0041,
        sourceBeatOffset: 0.00049,
        mode: "stretch",
      },
    },
    { kind: "clip.color.set", clip: { source: "client" as const, clientRef: "audio-clip" }, color: "#22c55e" },
    { kind: "clip.move", clip: { source: "client" as const, clientRef: "midi" }, track: ref(instrument), startSec: 1 },
    { kind: "clip.midi.set", clip: { source: "client" as const, clientRef: "midi" }, wave: "sine", notes: [{ beat: 0, length: 1, pitch: 62 }] },
    { kind: "clip.timing.set", clip: { source: "client" as const, clientRef: "midi" }, duration: 3, gain: 0.7 },
    { kind: "clip.rename", clip: { source: "client" as const, clientRef: "midi" }, name: "Renamed MIDI" },
    { kind: "master.volume.set", volume: 0.7 },
    { kind: "effect.upsert", target: { kind: "track" as const, track: ref(instrument) }, clientRef: "compressor", effectKind: "compressor" },
    {
      kind: "effect.reorder",
      target: { kind: "track" as const, track: ref(instrument) },
      order: [
        { effect: { source: "persisted" as const, id: String(removable) }, kind: "utility" },
        { effect: { source: "client" as const, clientRef: "compressor" }, kind: "compressor" },
      ],
    },
    {
      kind: "effect.remove",
      target: { kind: "track" as const, track: ref(instrument) },
      effect: { source: "persisted" as const, id: String(removable) },
      effectKind: "utility",
    },
    { kind: "instrument.set", target: { kind: "track" as const, track: ref(instrument) }, instrumentKind: "synth" },
    {
      kind: "arpeggiator.set",
      target: { kind: "track" as const, track: ref(instrument) },
      params: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false },
    },
    { kind: "track.collapsed.set", track: ref(source), collapsed: true },
    { kind: "track.color.set", track: ref(source), color: "#22c55e" },
    { kind: "track.color.cascade", root: ref(group), color: "#22c55e", cascadeClipColors: true },
    { kind: "track.ungroup", group: ref(group) },
    { kind: "automation.set", target: { kind: "master" as const }, parameterId: "volume", enabled: true, points: [{ id: "point", timeSec: 0, value: 0.7, interpolation: "linear" }] },
    { kind: "automation.delete", target: { kind: "master" as const }, parameterId: "volume" },
    { kind: "sidechain.set", source: ref(source), target: ref(instrument), effect: { source: "client" as const, clientRef: "compressor" } },
    { kind: "sidechain.remove", target: ref(instrument), effect: { source: "client" as const, clientRef: "compressor" } },
    { kind: "instrument.remove", target: { kind: "track" as const, track: ref(instrument) } },
    { kind: "arpeggiator.remove", target: { kind: "track" as const, track: ref(instrument) } },
    { kind: "timeline.range.delete", tracks: [ref(instrument)], startSec: 100, endSec: 101 },
    { kind: "clip.delete", clip: { source: "client" as const, clientRef: "midi" } },
    { kind: "track.delete", track: temp },
    { kind: "asset.delete", asset: { source: "persisted" as const, id: "missing-asset" } },
  ];
  expect(actions).toHaveLength(38);
  expect(actions.map((action) => action.kind).sort()).toEqual(
    controlCapabilitiesV1.actionKinds.filter((kind) => kind !== "recovery.restore").sort(),
  );
  const previewRequest = { version: "v1" as const, projectId, actions };
  expect(() => parseControlPreviewRequestV1(previewRequest)).not.toThrow();
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, { request: previewRequest });
  expect(preview.applied).toBe(true);
  const result = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: await approvedRequest(t, actions, "endpoint-action-matrix"),
  });
  expect(result.applied).toBe(true);
  expect(result.revision).toBe(result.priorRevision + 1);

  await t.run(async (ctx) => {
    const project = await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique();
    const channel = await ctx.db.query("mixerChannels").withIndex("by_track", (q) => q.eq("trackId", audio)).unique();
    const tracks = await ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    const clips = await ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    const effects = await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", instrument)).collect();
    const automation = await ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect();
    const sidechains = await ctx.db.query("sidechainRoutes").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect();
    const master = await ctx.db.query("projectMixerSettings").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique();
    expect(project?.name).toBe("Endpoint Matrix");
    expect(project?.revision).toBe(result.revision);
    expect(project?.tempoBpm).toBe(128);
    expect(channel?.volume).toBe(0.6);
    expect(channel?.muted).toBe(true);
    expect(channel?.outputTargetId).toBeUndefined();
    expect(channel?.sends).toHaveLength(1);
    expect(tracks.some((track) => track.name === "Temporary")).toBe(false);
    expect(clips).toHaveLength(1);
    expect(effects.map((effect) => effect.type).sort()).toEqual(["compressor"]);
    expect(automation).toEqual([]);
    expect(sidechains).toEqual([]);
    expect(master?.masterVolume).toBe(0.7);
  });
});
