import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { AUDIO_EFFECT_CONTRACTS } from "@daw-browser/shared";

import { api } from "./_generated/api";
import {
  removeAudioEffectRow,
  reorderAudioEffectRows,
  setArpeggiatorRow,
  setTrackInstrumentRow,
  upsertTrackEffectRow,
} from "./effects";
import {
  deleteAutomationEnvelopeRow,
  setAutomationEnvelopeRow,
} from "./automation";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./automation.ts": () => import("./automation"),
  "./effects.ts": () => import("./effects"),
  "./projects.ts": () => import("./projects"),
};

const owner = "phase-3b1-owner";
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

const createProject = async (t: TestConvex, projectId: string) => {
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
};

const seedTrack = async (t: TestConvex, projectId: string) => await t.run(async (ctx) => {
  const trackId = await ctx.db.insert("tracks", {
    projectId,
    name: "Device row track",
    index: 0,
  });
  await ctx.db.insert("ownerships", {
    projectId,
    ownerUserId: owner,
    trackId,
  });
  return trackId;
});

const projectRevision = async (t: TestConvex, projectId: string) => await t.run(async (ctx) => (
  await ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).unique()
)?.revision);

test("phase 3B-1 device row helpers preserve rows without advancing revision", async () => {
  const t = newTest();
  const projectId = "phase-3b1-device-project";
  await createProject(t, projectId);
  const trackId = await seedTrack(t, projectId);
  const utilityParams = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams();
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();

  const utility = await t.run(async (ctx) => await upsertTrackEffectRow(ctx, {
    projectId,
    trackId,
    type: "utility",
    instanceId: "utility-1",
    params: utilityParams,
  }));
  expect(utility).toMatchObject({ changed: true, status: "created" });
  expect(utility.effectId).toBeDefined();

  const gate = await t.run(async (ctx) => await upsertTrackEffectRow(ctx, {
    projectId,
    trackId,
    type: "gate",
    instanceId: "gate-1",
    params: gateParams,
  }));
  expect(gate).toMatchObject({ changed: true, status: "created" });

  expect(await t.run(async (ctx) => await reorderAudioEffectRows(ctx, {
    projectId,
    targetType: "track",
    trackId,
    order: [{ id: "gate-1", kind: "gate" }, { id: "utility-1", kind: "utility" }],
  }))).toEqual({ changed: true, status: "applied" });

  expect(await t.run(async (ctx) => await setTrackInstrumentRow(ctx, {
    projectId,
    trackId,
    instrument: {
      kind: "synth",
      instanceId: "synth-1",
      params: { gain: 0.6 },
    },
  }))).toMatchObject({ changed: true, status: "created" });

  expect(await t.run(async (ctx) => await setArpeggiatorRow(ctx, {
    projectId,
    trackId,
    params: {
      enabled: true,
      pattern: "up",
      rate: "1/16",
      octaves: 10,
      gate: 2,
      hold: false,
    },
  }))).toMatchObject({ changed: true, status: "created" });

  await t.run(async (ctx) => {
    await setAutomationEnvelopeRow(ctx, {
      projectId,
      targetKind: "track",
      trackId,
      effectInstanceId: "utility-1",
      parameterId: "utility.gainDb",
      enabled: true,
      points: [{ id: "utility-point", timeSec: 0, value: 3, interpolation: "linear" }],
    });
    await ctx.db.insert("sidechainRoutes", {
      projectId,
      sourceTrackId: trackId,
      targetTrackId: trackId,
      effectInstanceId: "utility-1",
    });
  });

  expect(await t.run(async (ctx) => await removeAudioEffectRow(ctx, {
    projectId,
    targetType: "track",
    trackId,
    effect: "utility",
    instanceId: "utility-1",
  }))).toMatchObject({ changed: true, status: "deleted", effectId: utility.effectId });
  expect(await projectRevision(t, projectId)).toBe(0);
  expect(await t.run(async (ctx) => {
    const rows = await ctx.db.query("effects").withIndex("by_track", (q) => q.eq("trackId", trackId)).collect();
    const arpeggiator = rows.find((row) => row.type === "arpeggiator");
    const gateRow = rows.find((row) => row.instanceId === "gate-1");
    const automation = await ctx.db.query("automationEnvelopes")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const sidechains = await ctx.db.query("sidechainRoutes")
      .withIndex("by_target", (q) => q.eq("targetTrackId", trackId))
      .collect();
    return {
      arpeggiatorParams: arpeggiator?.params,
      gateIndex: gateRow?.index,
      automationCount: automation.length,
      sidechainCount: sidechains.length,
    };
  })).toEqual({
    arpeggiatorParams: {
      enabled: true,
      pattern: "up",
      rate: "1/16",
      octaves: 4,
      gate: 1,
      hold: false,
    },
    gateIndex: 0,
    automationCount: 0,
    sidechainCount: 0,
  });

  await t.withIdentity({ subject: owner }).mutation(api.effects.serverSetProcessorParams, {
    projectId,
    trackId,
    effect: "gate",
    instanceId: "gate-1",
    params: {
      ...gateParams,
      state: { ...gateParams.state, thresholdDb: -20 },
    },
  });
  expect(await projectRevision(t, projectId)).toBe(1);
});

test("phase 3B-1 automation row helpers stay revision-free while wrappers version writes", async () => {
  const t = newTest();
  const projectId = "phase-3b1-automation-project";
  await createProject(t, projectId);
  const trackId = await seedTrack(t, projectId);
  const gateParams = AUDIO_EFFECT_CONTRACTS.gate.createDefaultParams();

  await t.run(async (ctx) => await upsertTrackEffectRow(ctx, {
    projectId,
    trackId,
    type: "gate",
    instanceId: "gate-1",
    params: gateParams,
  }));
  const input: {
    projectId: string;
    targetKind: "track";
    trackId: typeof trackId;
    effectInstanceId: string;
    parameterId: string;
    enabled: boolean;
    points: Array<{
      id: string;
      timeSec: number;
      value: number;
      interpolation: "linear";
    }>;
  } = {
    projectId,
    targetKind: "track",
    trackId,
    effectInstanceId: "gate-1",
    parameterId: "gate.thresholdDb",
    enabled: true,
    points: [{ id: "point-1", timeSec: 0, value: -30, interpolation: "linear" }],
  };

  const created = await t.run(async (ctx) => await setAutomationEnvelopeRow(ctx, input));
  expect(created).toMatchObject({ changed: true, status: "created" });
  expect(created.envelopeId).toBeDefined();
  expect(await projectRevision(t, projectId)).toBe(0);

  const noop = await t.run(async (ctx) => await setAutomationEnvelopeRow(ctx, input));
  expect(noop).toEqual({ changed: false, status: "noop", envelopeId: created.envelopeId });
  expect(await projectRevision(t, projectId)).toBe(0);

  await t.withIdentity({ subject: owner }).mutation(api.automation.serverSetEnvelope, {
    ...input,
    trackId: String(trackId),
    points: [{ id: "point-1", timeSec: 0, value: -20, interpolation: "linear" }],
    updatedAt: 1,
  });
  expect(await projectRevision(t, projectId)).toBe(1);

  expect(await t.run(async (ctx) => await deleteAutomationEnvelopeRow(ctx, {
    projectId,
    targetKind: "track",
    trackId,
    effectInstanceId: "gate-1",
    parameterId: "gate.thresholdDb",
  }))).toEqual({ changed: true, status: "deleted", envelopeId: created.envelopeId });
  expect(await projectRevision(t, projectId)).toBe(1);
});
