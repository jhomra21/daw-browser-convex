import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_CONTRACTS } from "@daw-browser/shared";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./clips.ts": () => import("./clips"),
  "./projectMixerSettings.ts": () => import("./projectMixerSettings"),
  "./projects.ts": () => import("./projects"),
  "./tracks.ts": () => import("./tracks"),
  "./effects.ts": () => import("./effects"),
  "./automation.ts": () => import("./automation"),
};
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

const owner = "owner-1";

const createProject = async (
  t: TestConvex,
  projectId: string,
) => await t.withIdentity({ subject: owner }).mutation(
    api.projects.createOwnedRoom,
    { projectId },
  );

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

const seedTrack = async (
  t: TestConvex,
  input: { projectId: string; index: number; kind?: string; channelRole?: string; groupId?: string },
) => await t.run(async (ctx) => {
  const normalizedGroupId = input.groupId ? ctx.db.normalizeId("tracks", input.groupId) : undefined;
  const groupId = normalizedGroupId ?? undefined;
  const trackId = await ctx.db.insert("tracks", {
    projectId: input.projectId,
    name: `Track ${input.index + 1}`,
    index: input.index,
    kind: input.kind,
    groupId,
  });
  await ctx.db.insert("mixerChannels", {
    projectId: input.projectId,
    trackId,
    volume: 0.8,
    channelRole: input.channelRole ?? "track",
    sends: [],
  });
  await ctx.db.insert("ownerships", {
    projectId: input.projectId,
    ownerUserId: owner,
    trackId,
  });
  return trackId;
});

const seedMidiClip = async (
  t: TestConvex,
  input: { projectId: string; trackId: string; startSec?: number },
) => await t.run(async (ctx) => {
  const trackId = ctx.db.normalizeId("tracks", input.trackId);
  if (!trackId) throw new Error("Track not found.");
  const clipId = await ctx.db.insert("clips", {
    projectId: input.projectId,
    trackId,
    startSec: input.startSec ?? 0,
    duration: 1,
    midi: { wave: "sine", notes: [] },
  });
  await ctx.db.insert("ownerships", {
    projectId: input.projectId,
    ownerUserId: owner,
    clipId,
  });
  return clipId;
});

test("uses snapshot defaults as no-op mutation comparisons", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const clipId = await seedMidiClip(t, { projectId: "project-1", trackId });

  expect(await t.withIdentity({ subject: owner }).mutation(
    api.projectMixerSettings.setMasterVolume,
    { projectId: "project-1", volume: 1 },
  )).toEqual({ status: "noop" });
  expect(await t.withIdentity({ subject: owner }).mutation(
    api.tracks.setMix,
    { trackId, muted: false, soloed: false },
  )).toEqual({ status: "noop" });
  expect(await t.withIdentity({ subject: owner }).mutation(
    api.clips.setName,
    { clipId, name: "Clip" },
  )).toBeNull();
  expect(await t.withIdentity({ subject: owner }).mutation(
    api.clips.setTiming,
    { clipId, startSec: 0, duration: 1, leftPadSec: 0, bufferOffsetSec: 0, midiOffsetBeats: 0 },
  )).toEqual({ status: "noop" });
  expect(await projectRevision(t, "project-1")).toBe(0);
  expect(await t.run(async (ctx) => await ctx.db
    .query("projectMixerSettings")
    .withIndex("by_room", (q) => q.eq("projectId", "project-1"))
    .collect())).toHaveLength(0);
});

test("advances revision once for ungroup and replays its result", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const groupId = await seedTrack(t, { projectId: "project-1", index: 0, channelRole: "group" });
  await seedTrack(t, { projectId: "project-1", index: 1, groupId });

  const input = { projectId: "project-1", groupId, operationId: "ungroup-1" };
  const first = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverUngroup, input);
  const replay = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverUngroup, input);
  expect(first).toEqual(replay);
  expect(await projectRevision(t, "project-1")).toBe(1);
});

test("advances revision once for restore-ungroup and replays its result", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const childId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const input = {
    projectId: "project-1",
    group: { index: 0, volume: 0.8, sends: [] },
    children: [{ trackId: childId, outputToGroup: false }],
    effects: [],
    automation: [],
    operationId: "restore-ungroup-1",
  };
  const first = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverRestoreUngroup, input);
  const replay = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverRestoreUngroup, input);
  expect(first).toEqual(replay);
  expect(await projectRevision(t, "project-1")).toBe(1);
});

test("rejects mixed-project create and move batches without writes or revisions", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  await createProject(t, "project-2");
  const trackOne = await seedTrack(t, { projectId: "project-1", index: 0 });
  const trackTwo = await seedTrack(t, { projectId: "project-2", index: 0 });
  const clipOne = await seedMidiClip(t, { projectId: "project-1", trackId: trackOne });
  const clipTwo = await seedMidiClip(t, { projectId: "project-2", trackId: trackTwo });

  await expect(t.withIdentity({ subject: owner }).mutation(api.clips.createMany, {
    items: [
      { projectId: "project-1", trackId: trackOne, startSec: 1, duration: 1, midi: { wave: "sine", notes: [] } },
      { projectId: "project-2", trackId: trackTwo, startSec: 1, duration: 1, midi: { wave: "sine", notes: [] } },
    ],
  })).rejects.toThrow("Batch clip writes must target one project.");
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.moveMany, {
    moves: [
      { clipId: clipOne, startSec: 2 },
      { clipId: clipTwo, startSec: 2 },
    ],
  })).toEqual({ status: "rejected" });
  expect(await projectRevision(t, "project-1")).toBe(0);
  expect(await projectRevision(t, "project-2")).toBe(0);
  expect(await t.run(async (ctx) => await ctx.db.get(clipOne))).toMatchObject({ startSec: 0 });
  expect(await t.run(async (ctx) => await ctx.db.get(clipTwo))).toMatchObject({ startSec: 0 });
});

test("treats reordered MIDI notes as a no-op but versions material note changes", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0, kind: "instrument" });
  expect(await projectRevision(t, "project-1")).toBe(0);
  const clipId = await seedMidiClip(t, { projectId: "project-1", trackId });
  const first = [
    { beat: 0, length: 1, pitch: 60, velocity: 0.8 },
    { beat: 1, length: 1, pitch: 64, velocity: 0.7 },
  ];

  await t.withIdentity({ subject: owner }).mutation(api.clips.setMidi, {
    clipId,
    midi: { wave: "sine", notes: first },
  });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.setMidi, {
    clipId,
    midi: { wave: "sine", notes: [...first].reverse() },
  })).toBeNull();
  expect(await projectRevision(t, "project-1")).toBe(1);
  await t.withIdentity({ subject: owner }).mutation(api.clips.setMidi, {
    clipId,
    midi: {
      wave: "sine",
      notes: [
        first[0]!,
        { beat: 1, length: 1, pitch: 64, velocity: 0.6 },
      ],
    },
  });
  expect(await projectRevision(t, "project-1")).toBe(2);
});

test("versions projected effect, automation, and sidechain state only for material writes", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const sourceTrackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const targetTrackId = await seedTrack(t, { projectId: "project-1", index: 1 });
  const user = t.withIdentity({ subject: owner });
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const utilityParams = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();

  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId: targetTrackId, effect: "gate", instanceId: "gate-1", params: gateParams,
  });
  const storedGateParams = await t.run(async (ctx) => {
    const rows = await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", targetTrackId)).collect();
    return rows.find((row) => row.instanceId === "gate-1")?.params;
  });
  expect(storedGateParams).toEqual(gateParams);
  expect(await projectRevision(t, "project-1")).toBe(1);
  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId: targetTrackId, effect: "gate", instanceId: "gate-1", params: gateParams,
  });
  expect(await projectRevision(t, "project-1")).toBe(1);
  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId: targetTrackId, effect: "utility", instanceId: "utility-1", params: utilityParams,
  });
  expect(await projectRevision(t, "project-1")).toBe(2);
  expect(await user.mutation(api.automation.serverDeleteEnvelope, {
    projectId: "project-1", targetKind: "track", trackId: targetTrackId, effectInstanceId: "gate-1", parameterId: "gate.thresholdDb",
  })).toBeNull();
  expect(await projectRevision(t, "project-1")).toBe(2);
  await user.mutation(api.effects.serverReorderAudioEffects, {
    projectId: "project-1", targetType: "track", trackId: targetTrackId,
    order: [{ id: "gate-1", kind: "gate" }, { id: "utility-1", kind: "utility" }],
  });
  expect(await projectRevision(t, "project-1")).toBe(2);
  await user.mutation(api.effects.serverReorderAudioEffects, {
    projectId: "project-1", targetType: "track", trackId: targetTrackId,
    order: [{ id: "utility-1", kind: "utility" }, { id: "gate-1", kind: "gate" }],
  });
  expect(await projectRevision(t, "project-1")).toBe(3);

  const automation: {
    projectId: string; targetKind: "track"; trackId: string; effectInstanceId: string; parameterId: string; enabled: boolean;
    points: Array<{ id: string; timeSec: number; value: number; interpolation: "linear" }>;
  } = {
    projectId: "project-1", targetKind: "track", trackId: targetTrackId,
    effectInstanceId: "gate-1", parameterId: "gate.thresholdDb", enabled: true,
    points: [{ id: "point-1", timeSec: 0, value: -30, interpolation: "linear" }],
  };
  await user.mutation(api.automation.serverSetEnvelope, { ...automation, updatedAt: 1 });
  expect(await projectRevision(t, "project-1")).toBe(4);
  await user.mutation(api.automation.serverSetEnvelope, { ...automation, updatedAt: 2 });
  expect(await projectRevision(t, "project-1")).toBe(4);
  await user.mutation(api.automation.serverSetEnvelope, {
    ...automation, updatedAt: 3, points: [{ id: "point-1", timeSec: 0, value: -20, interpolation: "linear" }],
  });
  expect(await projectRevision(t, "project-1")).toBe(5);
  await user.mutation(api.tracks.serverSetSidechainRoute, {
    projectId: "project-1", sourceTrackId, targetTrackId, effectInstanceId: "gate-1",
  });
  expect(await projectRevision(t, "project-1")).toBe(6);
  await user.mutation(api.tracks.serverSetSidechainRoute, {
    projectId: "project-1", sourceTrackId, targetTrackId, effectInstanceId: "gate-1",
  });
  expect(await projectRevision(t, "project-1")).toBe(6);
  await expect(user.mutation(api.tracks.serverRemoveSidechainRoute, {
    projectId: "project-1", targetTrackId, effectInstanceId: "missing",
  })).rejects.toThrow();
  expect(await projectRevision(t, "project-1")).toBe(6);

  expect(await user.mutation(api.effects.serverRemoveAudioEffect, {
    projectId: "project-1", targetType: "track", trackId: targetTrackId, effect: "gate", instanceId: "gate-1",
  })).toEqual({ status: "deleted" });
  expect(await projectRevision(t, "project-1")).toBe(7);
  expect(await user.mutation(api.effects.serverRemoveAudioEffect, {
    projectId: "project-1", targetType: "track", trackId: targetTrackId, effect: "gate", instanceId: "gate-1",
  })).toEqual({ status: "not-found" });
  expect(await projectRevision(t, "project-1")).toBe(7);
});

test("restores an effect chain once and no-ops across operation identities", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const input: {
    projectId: string; trackId: string; operationId: string;
    audioEffects: Array<{ id: string; kind: "utility"; params: ReturnType<typeof AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams> }>;
  } = {
    projectId: "project-1", trackId,
    audioEffects: [{ id: "utility-1", kind: "utility", params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() }],
    operationId: "restore-1",
  };
  const user = t.withIdentity({ subject: owner });
  expect(await user.mutation(api.effects.serverRestoreChain, input)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await user.mutation(api.effects.serverRestoreChain, input)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await user.mutation(api.effects.serverRestoreChain, { ...input, operationId: "restore-2" })).toEqual({ status: "noop" });
  expect(await projectRevision(t, "project-1")).toBe(1);
});