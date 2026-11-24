import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_PARAMS_VERSION, AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q, automationTargetKey } from "@daw-browser/shared";

import { api } from "./_generated/api";
import { setAutomationEnvelopeRow } from "./automation";
import { currentAutomationRow, currentAutomationRows } from "./automationRowValues";
import { withProjectEdit } from "./projectRows";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./automation.ts": () => import("./automation"),
  "./effects.ts": () => import("./effects"),
  "./projects.ts": () => import("./projects"),
  "./timeline.ts": () => import("./timeline"),
};

const owner = "automation-values-owner";
const projectId = "automation-values-project";
const effectInstanceId = "autofilter-1";

const qOf = (resonance: number) => AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** resonance;
const point = (value: number) => ({ id: "p0", timeSec: 0, value, interpolation: "linear" as const });

const seed = async () => {
  const t = convexTest(schema, modules);
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });

  const trackId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tracks", { projectId, name: "Track", index: 0 });
    await ctx.db.insert("ownerships", { projectId, ownerUserId: owner, trackId: id });
    await ctx.db.insert("mixerChannels", { projectId, trackId: id, volume: 1, channelRole: "track", sends: [] });

    return id;
  });

  return { t, trackId };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

const rawRow = (trackId: Seeded["trackId"], parameterId: string, value: number, valuesVersion?: number, withEffect = true) => ({
  projectId,
  targetKind: "track" as const,
  trackId,
  effectInstanceId: withEffect ? effectInstanceId : undefined,
  targetKey: automationTargetKey({ kind: "track", trackId: String(trackId), effectInstanceId: withEffect ? effectInstanceId : undefined }, parameterId),
  parameterId,
  enabled: true,
  points: [point(value)],
  updatedAt: 1,
  valuesVersion,
});

test("an unversioned resonance lane reads back migrated and without the storage field", async () => {
  const { t, trackId } = await seed();

  const rows = await t.run(async (ctx) => {
    await ctx.db.insert("automationEnvelopes", rawRow(trackId, "autofilter.resonance", 0.25));

    return await ctx.db.query("automationEnvelopes").collect();
  });

  const [current] = currentAutomationRows(rows);

  expect(qOf(current?.points[0]?.value ?? -1)).toBeCloseTo(0.5 + 19.5 * 0.25, 6);
  expect(current).not.toHaveProperty("valuesVersion");
});

test("current, mixer and future-version lanes read unchanged", async () => {
  const { t, trackId } = await seed();

  const rows = await t.run(async (ctx) => {
    await ctx.db.insert("automationEnvelopes", rawRow(trackId, "autofilter.resonance", 0.25, AUDIO_EFFECT_PARAMS_VERSION.autofilter));
    await ctx.db.insert("automationEnvelopes", rawRow(trackId, "volume", 0.25, undefined, false));
    await ctx.db.insert("automationEnvelopes", rawRow(trackId, "autofilter.driveDb", 0.25, 99));

    return await ctx.db.query("automationEnvelopes").collect();
  });

  expect(rows.map((row) => currentAutomationRow(row).points[0]?.value)).toEqual([0.25, 0.25, 0.25]);
});

test("a write stamps effect lanes only, and the timeline view reads the lane back as written", async () => {
  const { t, trackId } = await seed();

  await t.run(async (ctx) => {
    await ctx.db.insert("effects", { projectId, targetType: "track", trackId, index: 0, type: "autofilter", instanceId: effectInstanceId, params: {}, createdAt: 1 });
    await withProjectEdit(ctx, projectId, () => setAutomationEnvelopeRow(ctx, { projectId, targetKind: "track", trackId, effectInstanceId, parameterId: "autofilter.resonance", enabled: true, points: [point(0.6)] }));
    await withProjectEdit(ctx, projectId, () => setAutomationEnvelopeRow(ctx, { projectId, targetKind: "track", trackId, parameterId: "volume", enabled: true, points: [point(0.6)] }));
  });

  const raw = await t.run(async (ctx) => await ctx.db.query("automationEnvelopes").collect());
  const view = await t.withIdentity({ subject: owner }).query(api.timeline.fullViewAuthed, { projectId });

  expect(raw.find((row) => row.parameterId === "autofilter.resonance")?.valuesVersion).toBe(AUDIO_EFFECT_PARAMS_VERSION.autofilter);
  expect(raw.find((row) => row.parameterId === "volume")?.valuesVersion).toBeUndefined();
  expect(view.automationEnvelopes.map((row) => row.points[0]?.value)).toEqual([0.6, 0.6]);
  expect(view.automationEnvelopes.every((row) => !("valuesVersion" in row))).toBe(true);
});
