import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_CONTRACTS, AUDIO_EFFECT_KINDS, AUDIO_EFFECT_PARAMS_VERSION, isJsonObject, type AudioEffectParamsVersioning } from "@daw-browser/shared";

import { api } from "./_generated/api";
import { currentEffectRow, currentEffectRows } from "./effectRowParams";
import { upsertMasterEffectRow, upsertTrackEffectRow } from "./effects";
import { withProjectEdit } from "./projectRows";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./automation.ts": () => import("./automation"),
  "./effects.ts": () => import("./effects"),
  "./projects.ts": () => import("./projects"),
};

const owner = "effect-params-owner";
const projectId = "effect-params-project";

// Test-only chain: eq is pretended to be at version 3 with a rename step then an added field.
const exampleVersioning: AudioEffectParamsVersioning = {
  parameterValues: {},
  current: { ...AUDIO_EFFECT_PARAMS_VERSION, eq: 3 },
  migrations: {
    eq: {
      1: (params) => isJsonObject(params) ? { renamed: params.oldName } : params,
      2: (params) => isJsonObject(params) ? { ...params, current: true } : params,
    },
  },
};

const seed = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });

  const trackId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tracks", { projectId, name: "Track", index: 0 });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, trackId: id });

    return id;
  });

  return { t, trackId };
};

type StoredParams = Record<string, boolean | number | string>;

const eqRow = (trackId: Awaited<ReturnType<typeof seed>>["trackId"], params: StoredParams, paramsVersion?: number) => ({
  projectId,
  targetType: "track" as const,
  trackId,
  index: 0,
  type: "eq",
  instanceId: "eq-1",
  params,
  createdAt: 1,
  paramsVersion,
});

test("runs a stored row through the migration chain and drops the storage field", async () => {
  const { t, trackId } = await seed();

  const rows = await t.run(async (ctx) => {
    await ctx.db.insert("effects", eqRow(trackId, { oldName: 0.5 }, 1));
    await ctx.db.insert("effects", eqRow(trackId, { oldName: 0.25 }));

    return await ctx.db.query("effects").collect();
  });

  const current = currentEffectRows(rows, exampleVersioning);

  expect(current.map((row) => row.params)).toEqual([{ renamed: 0.5, current: true }, { renamed: 0.25, current: true }]);
  expect(current.every((row) => !("paramsVersion" in row))).toBe(true);
});

test("returns a newer stored version unchanged and lists it through the query", async () => {
  const { t, trackId } = await seed();
  const params = { fromTheFuture: true };
  await t.run(async (ctx) => { await ctx.db.insert("effects", eqRow(trackId, params, 99)); });

  const listed = await t.withIdentity({ subject: owner }).query(api.effects.listByRoom, { projectId });

  expect(listed).toHaveLength(1);
  expect(listed[0]?.params).toEqual(params);
  expect(listed[0]).not.toHaveProperty("paramsVersion");
});

test("leaves non-catalog rows such as instruments untouched", async () => {
  const { t, trackId } = await seed();

  const row = await t.run(async (ctx) => {
    const id = await ctx.db.insert("effects", { ...eqRow(trackId, { kind: "synth" }), type: "instrument" });

    return await ctx.db.get(id);
  });

  expect(row && currentEffectRow(row, exampleVersioning).params).toEqual({ kind: "synth" });
});

test("stamps every catalog kind on write and reads the same params back", async () => {
  const { t, trackId } = await seed();

  await t.run(async (ctx) => {
    for (const kind of AUDIO_EFFECT_KINDS) {
      const params = AUDIO_EFFECT_CONTRACTS[kind].createDefaultParams();
      await withProjectEdit(ctx, projectId, (edit) => upsertTrackEffectRow(ctx, edit, { projectId, trackId, type: kind, instanceId: `track-${kind}`, params }));
      await withProjectEdit(ctx, projectId, (edit) => upsertMasterEffectRow(ctx, edit, { projectId, type: kind, instanceId: `master-${kind}`, params }));
    }
  });

  const raw = await t.run(async (ctx) => await ctx.db.query("effects").collect());
  const listed = await t.withIdentity({ subject: owner }).query(api.effects.listByRoom, { projectId });
  const byTrack = await t.withIdentity({ subject: owner }).query(api.effects.listByTrack, { projectId, trackId });

  expect(raw).toHaveLength(AUDIO_EFFECT_KINDS.length * 2);
  expect(listed).toHaveLength(AUDIO_EFFECT_KINDS.length * 2);
  expect(byTrack).toHaveLength(AUDIO_EFFECT_KINDS.length);

  for (const row of raw) {
    expect(row.paramsVersion).toBe(AUDIO_EFFECT_PARAMS_VERSION[AUDIO_EFFECT_KINDS.find((kind) => kind === row.type) ?? "eq"]);
    expect(listed.find((entry) => entry._id === row._id)?.params).toEqual(row.params);
  }

  expect(listed.every((row) => !("paramsVersion" in row))).toBe(true);
});
