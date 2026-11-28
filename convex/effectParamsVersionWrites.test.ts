import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_PARAMS_VERSION, createDefaultCompressorParams, isJsonObject, type JsonValue } from "@daw-browser/shared";
import type { FunctionArgs } from "convex/server";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./automation.ts": () => import("./automation"),
  "./effects.ts": () => import("./effects"),
  "./projects.ts": () => import("./projects"),
  "./tracks.ts": () => import("./tracks"),
};

const owner = "effect-versions-owner";
const projectId = "effect-versions-project";

const seed = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });

  const trackId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tracks", { projectId, name: "Track", index: 0 });
    await ctx.db.insert("mixerChannels", { projectId, trackId: id, volume: 0.8, channelRole: "track", sends: [] });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, trackId: id });

    return id;
  });

  return { t, user: t.withIdentity({ subject: owner }), trackId };
};

const storedEffects = async (t: Awaited<ReturnType<typeof seed>>["t"]) => await t.run(async (ctx) => await ctx.db.query("effects").collect());

const stateOf = (params: JsonValue | undefined) => (isJsonObject(params) && isJsonObject(params.state) ? params.state : null);

// What a version 1 Compressor client sent: no Auto Makeup, a continuous lookahead.
const { autoMakeup: _autoMakeup, ...compressorV1 } = { ...createDefaultCompressorParams(), lookaheadMs: 7, makeupDb: 3 };

test("migrates Compressor params written by a version 1 client and stamps the current version", async () => {
  const { t, user, trackId } = await seed();

  expect(await user.mutation(api.effects.serverSetCompressorParams, { projectId, trackId, instanceId: "comp-1", params: compressorV1, paramsVersion: 1 }))
    .toMatchObject({ status: "applied" });

  const [row] = await storedEffects(t);
  expect(row?.params).toMatchObject({ lookaheadMs: 10, makeupDb: 3, autoMakeup: false });
  expect(row?.paramsVersion).toBe(AUDIO_EFFECT_PARAMS_VERSION.compressor);
});

test("reads a write with no paramsVersion as version 1", async () => {
  const { t, user, trackId } = await seed();
  const gate = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const flipped = { ...gate, state: { ...gate.state, flip: true } };

  await user.mutation(api.effects.serverSetProcessorParams, { projectId, trackId, effect: "gate", instanceId: "gate-track", params: flipped });
  await user.mutation(api.effects.serverSetMasterProcessorParams, { projectId, effect: "gate", instanceId: "gate-master", params: flipped });

  const rows = await storedEffects(t);
  expect(rows).toHaveLength(2);

  for (const row of rows) {
    expect(stateOf(row.params)?.flip).toBe(false);
    expect(row.paramsVersion).toBe(AUDIO_EFFECT_PARAMS_VERSION.gate);
  }
});

test("keeps the params of a client that writes the current version", async () => {
  const { t, user, trackId } = await seed();
  const params = { ...createDefaultCompressorParams(), lookaheadMs: 1, autoMakeup: true };

  await user.mutation(api.effects.serverSetCompressorParams, { projectId, trackId, instanceId: "comp-1", params, paramsVersion: AUDIO_EFFECT_PARAMS_VERSION.compressor });
  await user.mutation(api.effects.serverSetMasterCompressorParams, { projectId, instanceId: "comp-master", params, paramsVersion: AUDIO_EFFECT_PARAMS_VERSION.compressor });

  const rows = await storedEffects(t);
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.params)).toEqual([params, params]);
});

test("migrates a processor envelope from the version the client wrote it with", async () => {
  const { t, user, trackId } = await seed();
  const gate = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();
  const flipped = { ...gate, state: { ...gate.state, flip: true } };

  await user.mutation(api.effects.serverSetProcessorParams, { projectId, trackId, effect: "gate", instanceId: "gate-old", params: flipped, paramsVersion: 1 });
  await user.mutation(api.effects.serverSetMasterProcessorParams, { projectId, effect: "gate", instanceId: "gate-current", params: flipped, paramsVersion: AUDIO_EFFECT_PARAMS_VERSION.gate });

  const rows = await storedEffects(t);
  expect(stateOf(rows.find((row) => row.instanceId === "gate-old")?.params)?.flip).toBe(false);
  expect(stateOf(rows.find((row) => row.instanceId === "gate-current")?.params)?.flip).toBe(true);
});

test("rejects a version newer than the server's and a malformed one without writing", async () => {
  const { t, user, trackId } = await seed();
  const params = createDefaultCompressorParams();
  const newer = AUDIO_EFFECT_PARAMS_VERSION.compressor + 1;

  for (const paramsVersion of [newer, 0, 1.5, Number.NaN]) {
    expect(await user.mutation(api.effects.serverSetCompressorParams, { projectId, trackId, instanceId: "comp-1", params, paramsVersion })).toEqual({ status: "invalid" });
    expect(await user.mutation(api.effects.serverSetMasterCompressorParams, { projectId, instanceId: "comp-master", params, paramsVersion })).toEqual({ status: "invalid" });
  }

  expect(await storedEffects(t)).toHaveLength(0);
});

test("restores a chain from the version each effect was captured at", async () => {
  const { t, user, trackId } = await seed();
  const current = { ...createDefaultCompressorParams(), autoMakeup: true };

  const input = {
    projectId,
    trackId,
    audioEffects: [
      { id: "comp-old", kind: "compressor" as const, params: current, paramsVersion: 1 },
      { id: "comp-new", kind: "compressor" as const, params: current, paramsVersion: AUDIO_EFFECT_PARAMS_VERSION.compressor },
    ],
    operationId: "restore-1",
  } satisfies FunctionArgs<typeof api.effects.serverRestoreChain>;

  expect(await user.mutation(api.effects.serverRestoreChain, input)).toEqual({ status: "applied" });

  const rows = await storedEffects(t);
  expect(rows.find((row) => row.instanceId === "comp-old")?.params.autoMakeup).toBe(false);
  expect(rows.find((row) => row.instanceId === "comp-new")?.params.autoMakeup).toBe(true);
  expect(rows.every((row) => row.paramsVersion === AUDIO_EFFECT_PARAMS_VERSION.compressor)).toBe(true);

  const newer = { ...input, operationId: "restore-2", audioEffects: [{ ...input.audioEffects[0], paramsVersion: 99 }] };
  expect(await user.mutation(api.effects.serverRestoreChain, newer)).toEqual({ status: "invalid" });
  expect(await storedEffects(t)).toHaveLength(2);
});

test("restores an ungrouped chain from the version each effect was captured at", async () => {
  const { t, user, trackId } = await seed();
  const current = { ...createDefaultCompressorParams(), autoMakeup: true };

  const input = {
    projectId,
    group: { index: 0, volume: 0.8, sends: [] },
    children: [{ trackId, outputToGroup: false }],
    effects: [
      { type: "compressor" as const, instanceId: "comp-old", index: 0, params: current, paramsVersion: 1 },
      { type: "compressor" as const, instanceId: "comp-new", index: 1, params: current, paramsVersion: AUDIO_EFFECT_PARAMS_VERSION.compressor },
    ],
    automation: [],
    operationId: "restore-ungroup-1",
  } satisfies FunctionArgs<typeof api.tracks.serverRestoreUngroup>;

  expect(await user.mutation(api.tracks.serverRestoreUngroup, input)).toMatchObject({ status: "applied" });

  const rows = await storedEffects(t);
  expect(rows.find((row) => row.instanceId === "comp-old")?.params.autoMakeup).toBe(false);
  expect(rows.find((row) => row.instanceId === "comp-new")?.params.autoMakeup).toBe(true);

  const newer = { ...input, operationId: "restore-ungroup-2", effects: [{ ...input.effects[0], instanceId: "comp-future", paramsVersion: 99 }] };
  expect(await user.mutation(api.tracks.serverRestoreUngroup, newer)).toEqual({ status: "rejected" });
  expect(await storedEffects(t)).toHaveLength(2);
});
