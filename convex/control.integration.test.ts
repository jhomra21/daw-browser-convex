import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { controlCapabilitiesV1, parseControlPreviewRequestV1 } from "@daw-browser/control";
import { normalizeAudioEffectParamsForUpdate, normalizeOwnedProcessorParams } from "@daw-browser/shared";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./control.ts": () => import("./control"),
  "./projects.ts": () => import("./projects"),
};

const owner = "owner-1";
const projectId = "project-1";

const request = (actions: unknown[], idempotencyKey = "commit-key-1") => ({
  version: "v1",
  projectId,
  idempotencyKey,
  actions,
});

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
    request: request([{ kind: "track.delete", track: { source: "persisted", id: String(group) } }]),
  });
  expect(await t.run((ctx) => ctx.db.query("tracks").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("effects").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("clips").collect())).toHaveLength(0);
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
    request: request([
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
    { kind: "clip.move", clip: { source: "client" as const, clientRef: "midi" }, track: ref(instrument), startSec: 1 },
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
    { kind: "automation.set", target: { kind: "master" as const }, parameterId: "volume", enabled: true, points: [{ id: "point", timeSec: 0, value: 0.7, interpolation: "linear" }] },
    { kind: "automation.delete", target: { kind: "master" as const }, parameterId: "volume" },
    { kind: "sidechain.set", source: ref(source), target: ref(instrument), effect: { source: "client" as const, clientRef: "compressor" } },
    { kind: "sidechain.remove", target: ref(instrument), effect: { source: "client" as const, clientRef: "compressor" } },
    { kind: "clip.delete", clip: { source: "client" as const, clientRef: "midi" } },
    { kind: "track.delete", track: temp },
  ];
  expect(actions.map((action) => action.kind).sort()).toEqual([...controlCapabilitiesV1.actionKinds].sort());
  const previewRequest = { version: "v1" as const, projectId, actions };
  expect(() => parseControlPreviewRequestV1(previewRequest)).not.toThrow();
  const preview = await t.withIdentity({ subject: owner }).query(api.control.previewV1, { request: previewRequest });
  expect(preview.applied).toBe(true);
  const result = await t.withIdentity({ subject: owner }).mutation(api.control.commitV1, {
    request: request(actions, "endpoint-action-matrix"),
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
    expect(String(channel?.outputTargetId)).toBe(String(group));
    expect(channel?.sends).toHaveLength(1);
    expect(tracks.some((track) => track.name === "Temporary")).toBe(false);
    expect(clips).toEqual([]);
    expect(effects.map((effect) => effect.type).sort()).toEqual(["arpeggiator", "compressor", "instrument"]);
    expect(automation).toEqual([]);
    expect(sidechains).toEqual([]);
    expect(master?.masterVolume).toBe(0.7);
  });
});
