import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_CONTRACTS, createDefaultSynthParams } from "@daw-browser/shared";
import type { FunctionArgs } from "convex/server";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
  const input: FunctionArgs<typeof api.tracks.serverRestoreUngroup> = {
    projectId: "project-1",
    group: { index: 0, volume: 0.8, sends: [] },
    children: [{ trackId: childId, outputToGroup: false }],
    effects: [{
      type: "utility",
      instanceId: "restore-ungroup-utility",
      index: 0,
      params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
    }],
    automation: [],
    operationId: "restore-ungroup-1",
  };
  const first = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverRestoreUngroup, input);
  const replay = await t.withIdentity({ subject: owner }).mutation(api.tracks.serverRestoreUngroup, input);
  expect(first).toEqual(replay);
  expect(await projectRevision(t, "project-1")).toBe(1);
  const restoredEffect = await t.run(async (ctx) => (await ctx.db.query("effects")
    .withIndex("by_room", (query) => query.eq("projectId", "project-1"))
    .collect()).find((effect) => effect.instanceId === "restore-ungroup-utility"));
  expect(restoredEffect?.revision).toBe(1);
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

test("replays durable MIDI and device removals without re-advancing revision", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0, kind: "instrument" });
  const clipId = await seedMidiClip(t, { projectId: "project-1", trackId });
  const user = t.withIdentity({ subject: owner });

  const midi = {
    projectId: "project-1",
    clipId: String(clipId),
    operationId: "midi-1",
    midi: { wave: "sine", notes: [{ beat: 0, length: 1, pitch: 60 }] },
  };
  expect(await user.mutation(api.clips.serverSetMidi, midi)).toEqual({ status: "applied" });
  expect(await user.mutation(api.clips.serverSetMidi, midi)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);

  await user.mutation(api.effects.serverSetTrackInstrument, {
    projectId: "project-1",
    trackId,
    instrument: { kind: "synth", instanceId: "instrument-1", params: createDefaultSynthParams() },
  });
  await user.mutation(api.effects.serverSetArpeggiatorParams, {
    projectId: "project-1",
    trackId,
    params: { enabled: true, pattern: "up", rate: "1/4", octaves: 1, gate: 0.8, hold: false },
  });
  expect(await projectRevision(t, "project-1")).toBe(3);

  const instrument = { projectId: "project-1", trackId: String(trackId), operationId: "instrument-remove-1" };
  expect(await user.mutation(api.effects.serverRemoveTrackInstrument, instrument)).toEqual({ status: "applied" });
  expect(await user.mutation(api.effects.serverRemoveTrackInstrument, instrument)).toEqual({ status: "applied" });
  const arpeggiator = { projectId: "project-1", trackId: String(trackId), operationId: "arp-remove-1" };
  expect(await user.mutation(api.effects.serverRemoveArpeggiator, arpeggiator)).toEqual({ status: "applied" });
  expect(await user.mutation(api.effects.serverRemoveArpeggiator, arpeggiator)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(5);
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

  const automation = {
    projectId: "project-1", targetKind: "track" satisfies "track", trackId: targetTrackId,
    effectInstanceId: "gate-1", parameterId: "gate.thresholdDb", enabled: true,
    points: [{ id: "point-1", timeSec: 0, value: -30, interpolation: "linear" satisfies "linear" }],
    updatedAt: 0,
  } satisfies FunctionArgs<typeof api.automation.serverSetEnvelope>;
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
  const input = {
    projectId: "project-1", trackId,
    audioEffects: [{ id: "utility-1", kind: "utility" satisfies "utility", params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() }],
    operationId: "restore-1",
  } satisfies FunctionArgs<typeof api.effects.serverRestoreChain>;
  const user = t.withIdentity({ subject: owner });
  expect(await user.mutation(api.effects.serverRestoreChain, input)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await user.mutation(api.effects.serverRestoreChain, input)).toEqual({ status: "applied" });
  expect(await projectRevision(t, "project-1")).toBe(1);
  expect(await user.mutation(api.effects.serverRestoreChain, { ...input, operationId: "restore-2" })).toEqual({ status: "noop" });
  expect(await projectRevision(t, "project-1")).toBe(1);
});
const effectRowsOf = async (t: TestConvex, trackId: Id<"tracks">) => await t.run(async (ctx) => (
  await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect()
));
const effectRowByInstance = async (t: TestConvex, trackId: Id<"tracks">, instanceId: string) => {
  const row = (await effectRowsOf(t, trackId)).find((entry) => entry.instanceId === instanceId);
  if (!row) throw new Error(`Missing effect row ${instanceId}.`);
  return row;
};

test("stamps a row with the project revision its own transaction produced and returns it", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const user = t.withIdentity({ subject: owner });
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const utilityParams = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();
  const setGate = (thresholdDb: number) => user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "gate", instanceId: "gate-1",
    params: { ...gateParams, state: { ...gateParams.state, thresholdDb } },
  });

  const first = await setGate(-20);
  const gate = await effectRowByInstance(t, trackId, "gate-1");
  expect(first).toEqual({ status: "applied", effectId: gate._id, revision: 1 });
  expect(gate.revision).toBe(1);
  expect(await projectRevision(t, "project-1")).toBe(1);

  // A no-op returns the row's own stamp and does not advance the project.
  expect(await setGate(-20)).toEqual({ status: "applied", effectId: gate._id, revision: 1 });
  expect(await projectRevision(t, "project-1")).toBe(1);

  const utility = await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "utility", instanceId: "utility-1", params: utilityParams,
  });
  expect(utility).toMatchObject({ status: "applied", revision: 2 });
  expect(await projectRevision(t, "project-1")).toBe(2);
  // The unrelated edit leaves the first row's stamp alone.
  expect((await effectRowByInstance(t, trackId, "gate-1")).revision).toBe(1);

  // Two rows in one query carry their own stamps, not the query-wide maximum.
  const listed = await user.query(api.effects.listByRoom, { projectId: "project-1" });
  expect(listed.map((row) => [row.instanceId, row.revision]).sort()).toEqual([["gate-1", 1], ["utility-1", 2]]);

  expect(await setGate(-10)).toMatchObject({ status: "applied", effectId: gate._id, revision: 3 });
  expect((await effectRowByInstance(t, trackId, "gate-1")).revision).toBe(3);
  expect((await effectRowByInstance(t, trackId, "utility-1")).revision).toBe(2);
  expect(await projectRevision(t, "project-1")).toBe(3);
});

test("a legacy row without a revision stays unstamped on a no-op and is stamped by its next material write", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const user = t.withIdentity({ subject: owner });
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const legacyId = await t.run(async (ctx) => await ctx.db.insert("effects", {
    projectId: "project-1", targetType: "track", trackId, index: 0, type: "gate", instanceId: "gate-1",
    params: gateParams, createdAt: 1,
  }));
  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "utility", instanceId: "utility-1",
    params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
  });
  expect(await projectRevision(t, "project-1")).toBe(1);

  // The no-op reports revision 0 (committed, unordered) and does not invent a stamp or advance the project.
  expect(await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "gate", instanceId: "gate-1", params: gateParams,
  })).toEqual({ status: "applied", effectId: legacyId, revision: 0 });
  expect((await effectRowByInstance(t, trackId, "gate-1")).revision).toBeUndefined();
  expect(await projectRevision(t, "project-1")).toBe(1);

  // A query mixes the missing and the present stamp.
  const listed = await user.query(api.effects.listByRoom, { projectId: "project-1" });
  expect(listed.map((row) => [row.instanceId, row.revision]).sort()).toEqual([["gate-1", undefined], ["utility-1", 1]]);

  expect(await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "gate", instanceId: "gate-1",
    params: { ...gateParams, state: { ...gateParams.state, thresholdDb: -12 } },
  })).toEqual({ status: "applied", effectId: legacyId, revision: 2 });
  expect((await effectRowByInstance(t, trackId, "gate-1")).revision).toBe(2);
});

test("param setters answer invalid for a missing or foreign target and write nothing", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  await createProject(t, "project-2");
  const foreignTrack = await seedTrack(t, { projectId: "project-2", index: 0 });
  const user = t.withIdentity({ subject: owner });
  const params = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();

  expect(await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId: "not-a-track-id", effect: "utility", instanceId: "utility-1", params,
  })).toEqual({ status: "invalid" });
  expect(await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId: foreignTrack, effect: "utility", instanceId: "utility-1", params,
  })).toEqual({ status: "invalid" });
  expect(await user.mutation(api.effects.serverSetTrackInstrument, {
    projectId: "project-1", trackId: "not-a-track-id",
    instrument: { kind: "synth", instanceId: "instrument-1", params: createDefaultSynthParams() },
  })).toEqual({ status: "invalid" });
  expect(await projectRevision(t, "project-1")).toBe(0);
  expect(await effectRowsOf(t, foreignTrack)).toHaveLength(0);
});

test("direct setters keep their legacy ID result while server setters return revision provenance", async () => {
  const t = newTest();
  await createProject(t, "project-direct-contract");
  await createProject(t, "project-direct-foreign");
  const trackId = await seedTrack(t, { projectId: "project-direct-contract", index: 0 });
  const foreignTrackId = await seedTrack(t, { projectId: "project-direct-foreign", index: 0 });
  const user = t.withIdentity({ subject: owner });

  const directResult = await user.mutation(api.effects.setReverbParams, {
    projectId: "project-direct-contract",
    trackId,
    instanceId: "direct-reverb",
    params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(),
  });
  const directRow = (await effectRowsOf(t, trackId)).find((row) => row.instanceId === "direct-reverb");
  expect(directResult).toBe(directRow?._id ?? null);
  expect(await user.mutation(api.effects.setReverbParams, {
    projectId: "project-direct-contract",
    trackId: foreignTrackId,
    instanceId: "foreign-reverb",
    params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(),
  })).toBeNull();

  const serverResult = await user.mutation(api.effects.serverSetReverbParams, {
    projectId: "project-direct-contract",
    trackId,
    instanceId: "server-reverb",
    params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams(),
  });
  expect(serverResult).toMatchObject({ status: "applied", revision: 2 });
});

test("a master effect and a track instrument return their own stamped revisions", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0, kind: "instrument" });
  const user = t.withIdentity({ subject: owner });
  const master = await user.mutation(api.effects.serverSetMasterProcessorParams, {
    projectId: "project-1", effect: "utility", instanceId: "master-utility-1",
    params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
  });
  expect(master).toMatchObject({ status: "applied", revision: 1 });
  const instrument = await user.mutation(api.effects.serverSetTrackInstrument, {
    projectId: "project-1", trackId,
    instrument: { kind: "synth", instanceId: "instrument-1", params: createDefaultSynthParams() },
  });
  expect(instrument).toMatchObject({ status: "applied", revision: 2 });
  const masterRow = (await user.query(api.effects.listByRoom, { projectId: "project-1" }))
    .find((row) => row.targetType === "master");
  expect(masterRow?.revision).toBe(1);
  expect((await effectRowsOf(t, trackId))[0]?.revision).toBe(2);
  expect(await projectRevision(t, "project-1")).toBe(2);
});

test("a restored chain stamps every row it writes with the one revision its transaction produced", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0, kind: "instrument" });
  const user = t.withIdentity({ subject: owner });
  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "utility", instanceId: "old-utility",
    params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
  });
  await user.mutation(api.effects.serverRestoreChain, {
    projectId: "project-1", trackId, operationId: "restore-stamps-1",
    audioEffects: [
      { id: "restored-utility", kind: "utility", params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() },
      { id: "restored-gate", kind: "gate", params: AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams() },
    ],
    instrument: { kind: "synth", instanceId: "restored-instrument", params: createDefaultSynthParams() },
    arpeggiator: { enabled: true, pattern: "up", rate: "1/8", octaves: 1, gate: 0.8, hold: false },
  });
  expect(await projectRevision(t, "project-1")).toBe(2);
  const rows = await effectRowsOf(t, trackId);
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.revision)).toEqual([2, 2, 2, 2]);
});

test("reorder and audio-effect removal stamp only rows their writers change", async () => {
  const t = newTest();
  await createProject(t, "project-effect-owner-writers");
  const trackId = await seedTrack(t, { projectId: "project-effect-owner-writers", index: 0 });
  const user = t.withIdentity({ subject: owner });
  const params = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();
  for (const instanceId of ["effect-a", "effect-b", "effect-c"]) {
    await user.mutation(api.effects.serverSetProcessorParams, {
      projectId: "project-effect-owner-writers", trackId, effect: "utility", instanceId, params,
    });
  }

  await user.mutation(api.effects.serverReorderAudioEffects, {
    projectId: "project-effect-owner-writers",
    targetType: "track",
    trackId,
    order: [{ id: "effect-c", kind: "utility" }, { id: "effect-b", kind: "utility" }, { id: "effect-a", kind: "utility" }],
  });
  const reorderRevision = await projectRevision(t, "project-effect-owner-writers");
  const reordered = await effectRowsOf(t, trackId);
  expect(reordered.filter((row) => row.instanceId !== "effect-b").map((row) => row.revision))
    .toEqual([reorderRevision, reorderRevision]);

  await user.mutation(api.effects.serverRemoveAudioEffect, {
    projectId: "project-effect-owner-writers", targetType: "track", trackId, effect: "utility", instanceId: "effect-c",
  });
  const removalRevision = await projectRevision(t, "project-effect-owner-writers");
  const survivors = await effectRowsOf(t, trackId);
  expect(survivors.find((row) => row.instanceId === "effect-a")?.revision).toBe(removalRevision);
  expect(survivors.find((row) => row.instanceId === "effect-b")?.revision).toBe(removalRevision);
});

test("instrument removal compaction returns owner-stamped processor rows", async () => {
  const t = newTest();
  await createProject(t, "project-device-owner-writer");
  const trackId = await seedTrack(t, { projectId: "project-device-owner-writer", index: 0, kind: "instrument" });
  const user = t.withIdentity({ subject: owner });
  await user.mutation(api.effects.serverSetTrackInstrument, {
    projectId: "project-device-owner-writer", trackId,
    instrument: { kind: "synth", instanceId: "remove-me", params: createDefaultSynthParams() },
  });
  await user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-device-owner-writer", trackId, effect: "utility", instanceId: "survivor",
    params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
  });
  await user.mutation(api.effects.serverRemoveTrackInstrument, {
    projectId: "project-device-owner-writer", trackId,
  });
  const revision = await projectRevision(t, "project-device-owner-writer");
  expect((await effectRowsOf(t, trackId)).find((row) => row.instanceId === "survivor")?.revision).toBe(revision);
});

test("instrument track creation stamps its default row with the single owner advance", async () => {
  const t = newTest();
  await createProject(t, "project-create-owner-writer");
  const trackId = await t.withIdentity({ subject: owner }).mutation(api.tracks.create, {
    projectId: "project-create-owner-writer",
    kind: "instrument",
  });
  const project = await projectRevision(t, "project-create-owner-writer");
  const rows = await t.run(async (ctx) => {
    const normalizedTrackId = ctx.db.normalizeId("tracks", trackId);
    if (!normalizedTrackId) throw new Error("Created track ID was invalid.");
    return await ctx.db.query("effects").withIndex("by_track", (query) => query.eq("trackId", normalizedTrackId)).collect();
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.revision).toBe(project);
});

test("N1 data plane (cloud): a later foreign commit is ordered after our acknowledged write by revision", async () => {
  const t = newTest();
  await createProject(t, "project-1");
  const trackId = await seedTrack(t, { projectId: "project-1", index: 0 });
  const user = t.withIdentity({ subject: owner });
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const setGate = (thresholdDb: number) => user.mutation(api.effects.serverSetProcessorParams, {
    projectId: "project-1", trackId, effect: "gate", instanceId: "gate-1",
    params: { ...gateParams, state: { ...gateParams.state, thresholdDb } },
  });
  const ours = await setGate(-1);
  const foreign = await setGate(-7);
  const row = await effectRowByInstance(t, trackId, "gate-1");
  if (ours.status !== "applied" || foreign.status !== "applied") throw new Error("Both writes must apply.");
  // The panel holds our acknowledgement (revision ours.revision) while the room already shows the foreign write.
  // The row's stamp is newer than the acknowledgement, so the row is authority and our echo must not be kept over it.
  expect(row.params.state.thresholdDb).toBe(-7);
  expect(row.revision).toBe(foreign.revision);
  expect(foreign.revision).toBeGreaterThan(ours.revision);
  expect(row.revision !== undefined && row.revision > ours.revision).toBe(true);
});
