import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { createRoot, createSignal } from "solid-js";
import { AudioEngine, type AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine";
import { AUDIO_EFFECT_CONTRACTS, type AudioEffectInstance } from "@daw-browser/shared";
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types";
import type { EffectParamsCommitPayload, EffectType } from "~/lib/undo/types";
import {
  createAudioEffectInstanceIdentityCache,
  createEffectsPanelAudioDevice,
} from "./create-effects-panel-audio-effects-state";

type PersistOrder = (targetId: string, order: AudioEffectInstance[]) => void | Promise<unknown>;

class SpyAudioEngine extends AudioEngine {
  readonly trackFxCalls: Array<{ trackId: string; instances: AudioEffectRuntimeInstance[] }> = [];

  override async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]) {
    this.trackFxCalls.push({ trackId, instances });
  }
}

const createDevice = (
  engine: SpyAudioEngine,
  options: {
    canWrite?: boolean;
    projectId?: string;
    persistAudioEffectOrder?: PersistOrder;
    persistSidechainRoute?: (targetTrackId: string, effectInstanceId: string, sourceTrackId?: string) => Promise<unknown>;
    sidechainRoutes?: ExternalSidechainRoute[];
    onEffectParamsCommitted?: <Effect extends EffectType>(payload: EffectParamsCommitPayload<Effect>, projectId?: string) => void;
  } = {},
) => {
  const [currentTargetId, setCurrentTargetId] = createSignal("track-1");
  const [canWriteCurrentTargetEffects, setCanWriteCurrentTargetEffects] = createSignal(options.canWrite ?? true);
  const [sidechainRoutes, setSidechainRoutes] = createSignal(options.sidechainRoutes ?? []);
  const device = createEffectsPanelAudioDevice(
    {
      audioEngine: () => engine,
      projectId: () => options.projectId,
      userId: () => options.projectId ? "user-1" : undefined,
      roomEffects: () => [],
      sidechainRoutes,
      canWriteCurrentTargetEffects,
      persistAudioEffectOrder: options.persistAudioEffectOrder,
      persistSidechainRoute: options.persistSidechainRoute,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
    },
    currentTargetId,
    () => undefined,
  );
  return { device, setCanWriteCurrentTargetEffects, setCurrentTargetId, setSidechainRoutes };
};

describe("effects panel instance engine synchronization", () => {
  test("commits a real reverb edit with the persisted row instance ID", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const commits: EffectParamsCommitPayload[] = [];
      const { device } = createDevice(engine, {
        onEffectParamsCommitted: (payload) => commits.push(payload),
      });
      await device.addByKindToTarget("track-1", "reverb");
      const inserted = engine.trackFxCalls.at(-1)?.instances[0];
      if (!inserted || inserted.kind !== "reverb") throw new Error("Expected an inserted reverb instance.");

      device.reverb.changeInstance(inserted.id, (params) => ({ ...params, wet: 0.35 }));
      await device.flushPending();
      await Promise.resolve();

      expect(commits.at(-1)).toMatchObject({
        targetId: "track-1",
        effect: "reverb",
        instanceId: inserted.id,
        to: { wet: 0.35 },
      });
      dispose();
    });
  });

  test("applies an optimistic parameter edit to the engine before persistence", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine);
      const addPromise = device.addByKindToTarget("track-1", "delay");
      const inserted = engine.trackFxCalls.find((call) => call.instances.length === 1);
      const instanceId = inserted?.instances[0]?.id;
      if (!instanceId) throw new Error("Expected an inserted delay instance.");
      const before = engine.trackFxCalls.length;

      device.delay.changeInstance(instanceId, (params) => ({ ...params, feedback: 0.8 }));
      await addPromise;

      expect(engine.trackFxCalls.length).toBeGreaterThan(before);
      const hasUpdatedFeedback = (params: unknown) => (
        typeof params === "object" &&
        params !== null &&
        "feedback" in params &&
        params.feedback === 0.8
      );
      const updated = engine.trackFxCalls
        .flatMap((call) => call.instances)
        .find((instance) => instance.kind === "delay" && hasUpdatedFeedback(instance.params));
      if (!updated) throw new Error("Expected the updated delay parameters.");
      expect(updated.params).toMatchObject({ feedback: 0.8 });
      dispose();
    });
  });

  test("applies an optimistic reorder without waiting for persisted rows", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine);
      const firstAdd = device.addByKindToTarget("track-1", "delay");
      const secondAdd = device.addByKindToTarget("track-1", "chorus");
      await Promise.all([firstAdd, secondAdd]);
      const inserted = engine.trackFxCalls.find((call) => call.instances.length === 2);
      const delay = inserted?.instances.find((instance) => instance.kind === "delay");
      if (!delay) throw new Error("Expected an inserted delay instance.");
      device.reorder({ id: delay.id, kind: "delay" } satisfies AudioEffectInstance, 1);

      const reordered = engine.trackFxCalls.find((call) => call.instances.map((instance) => instance.kind).join(",") === "chorus,delay");
      expect(reordered?.instances.map((instance) => instance.kind)).toEqual(["chorus", "delay"]);
      dispose();
    });
  });

  test("blocks parameter edits for read-only users", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device, setCanWriteCurrentTargetEffects } = createDevice(engine, { canWrite: true });
      const addPromise = device.addByKindToTarget("track-1", "delay");
      const inserted = engine.trackFxCalls.find((call) => call.instances.length === 1);
      const instanceId = inserted?.instances[0]?.id;
      if (!instanceId) throw new Error("Expected an inserted delay instance.");
      setCanWriteCurrentTargetEffects(false);
      const before = engine.trackFxCalls.length;
      device.delay.changeInstance(instanceId, (params) => ({ ...params, feedback: 0.8 }));
      await addPromise;

      expect(engine.trackFxCalls.length).toBe(before);
      dispose();
    });
  });

  test("rolls back only the rejected target and reapplies its persisted engine order", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const persistAudioEffectOrder: PersistOrder = (targetId, order) => {
        if (targetId === "track-a" && order[0]?.kind === "chorus") {
          return Promise.reject(new Error("track-a persistence rejected"));
        }
        return Promise.resolve();
      };
      const { device, setCurrentTargetId } = createDevice(engine, { persistAudioEffectOrder });
      await Promise.all([
        device.addChainToTarget("track-a", [
          { kind: "delay", params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() },
          { kind: "chorus", params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}) },
        ]),
        device.addChainToTarget("track-b", [
          { kind: "eq", params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams() },
          { kind: "reverb", params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams() },
        ]),
      ]);
      const trackACurrent = engine.trackFxCalls.find((call) => call.trackId === "track-a" && call.instances.length === 2);
      const trackBCurrent = engine.trackFxCalls.find((call) => call.trackId === "track-b" && call.instances.length === 2);
      if (!trackACurrent || !trackBCurrent) throw new Error("Expected both target chains.");
      const delay = trackACurrent.instances.find((instance) => instance.kind === "delay");
      const eq = trackBCurrent.instances.find((instance) => instance.kind === "eq");
      if (!delay || !eq) throw new Error("Expected target instances.");

      setCurrentTargetId("track-a");
      device.reorder({ id: delay.id, kind: "delay" } satisfies AudioEffectInstance, 1);
      setCurrentTargetId("track-b");
      device.reorder({ id: eq.id, kind: "eq" } satisfies AudioEffectInstance, 1);
      await Promise.resolve();
      await Promise.resolve();

      expect(engine.trackFxCalls.at(-1)?.trackId).toBe("track-a");
      expect(engine.trackFxCalls.at(-1)?.instances).toEqual([]);
      expect(engine.trackFxCalls.filter((call) => call.trackId === "track-b").at(-1)?.instances.map((instance) => instance.kind)).toEqual(["reverb", "eq"]);
      dispose();
    });
  });

  test("keeps successful concurrent reorders for independent targets", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device, setCurrentTargetId } = createDevice(engine, {
        persistAudioEffectOrder: () => Promise.resolve(),
      });
      await Promise.all([
        device.addChainToTarget("track-a", [
          { kind: "delay", params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() },
          { kind: "chorus", params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}) },
        ]),
        device.addChainToTarget("track-b", [
          { kind: "eq", params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams() },
          { kind: "reverb", params: AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams() },
        ]),
      ]);
      const trackACurrent = engine.trackFxCalls.find((call) => call.trackId === "track-a" && call.instances.length === 2);
      const trackBCurrent = engine.trackFxCalls.find((call) => call.trackId === "track-b" && call.instances.length === 2);
      if (!trackACurrent || !trackBCurrent) throw new Error("Expected both target chains.");
      const delay = trackACurrent.instances.find((instance) => instance.kind === "delay");
      const eq = trackBCurrent.instances.find((instance) => instance.kind === "eq");
      if (!delay || !eq) throw new Error("Expected target instances.");

      setCurrentTargetId("track-a");
      device.reorder({ id: delay.id, kind: "delay" } satisfies AudioEffectInstance, 1);
      setCurrentTargetId("track-b");
      device.reorder({ id: eq.id, kind: "eq" } satisfies AudioEffectInstance, 1);

      expect(engine.trackFxCalls.filter((call) => call.trackId === "track-a").at(-1)?.instances.map((instance) => instance.kind)).toEqual(["chorus", "delay"]);
      expect(engine.trackFxCalls.filter((call) => call.trackId === "track-b").at(-1)?.instances.map((instance) => instance.kind)).toEqual(["reverb", "eq"]);
      dispose();
    });
  });

  test("allows chains longer than the former per-chain limit", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine);
      const results = await Promise.all(Array.from({ length: 17 }, () => (
        device.addByKindToTarget("track-1", "delay")
      )));

      expect(results.filter(Boolean)).toHaveLength(17);
      expect(engine.trackFxCalls.at(-1)?.instances).toHaveLength(17);
      dispose();
    });
  });

  test("creates canonical reverb defaults for a reverb insertion", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine);

      await device.addByKindToTarget("track-1", "reverb");

      const reverb = engine.trackFxCalls.at(-1)?.instances[0];
      expect(reverb?.kind).toBe("reverb");
      expect(reverb?.params).toEqual(AUDIO_EFFECT_CONTRACTS.reverb.createDefaultParams());
      dispose();
    });
  });

  test("rolls back drafts, order, and engine state when an inserted chain reorder fails", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine, {
        persistAudioEffectOrder: () => Promise.reject(new Error("reorder failed")),
      });

      const added = await device.addChainToTarget("track-1", [
        { kind: "delay", params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams() },
        { kind: "chorus", params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({}) },
      ], 0);

      expect(added).toBe(false);
      expect(device.orderedEffects()).toEqual([]);
      expect(engine.trackFxCalls.at(-1)?.instances).toEqual([]);
      dispose();
    });
  });

  test("projects draft edits, all-target insertions, reorders, and removals into export rows", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const { device } = createDevice(engine, { projectId: "project:effects-export-projection" });

      const delayAdd = device.addByKindToTarget("track-1", "delay");
      expect(device.snapshotExportRows(["track-1"])).toEqual([
        expect.objectContaining({ targetId: "track-1", effect: "delay", index: 0 }),
      ]);
      await delayAdd;
      await device.addByKindToTarget("track-1", "chorus");
      await device.addByKindToTarget("master", "utility");

      const delay = device.snapshotExportRows(["track-1"])
        .find((row) => row.effect === "delay");
      if (!delay?.instanceId) throw new Error("Expected a projected delay.");
      device.delay.changeInstance(delay.instanceId, (params) => ({ ...params, feedback: 0.8 }));
      expect(device.snapshotExportRows(["track-1"])
        .find((row) => row.effect === "delay")?.params).toMatchObject({ feedback: 0.8 });

      device.reorder({ id: delay.instanceId, kind: "delay" }, 1);
      expect(device.snapshotExportRows(["track-1"]).map((row) => row.effect)).toEqual(["chorus", "delay"]);
      expect(device.snapshotExportRows(["master", "track-1"]).map((row) => row.targetId)).toEqual([
        "master",
        "track-1",
        "track-1",
      ]);

      const removal = device.removeByInstanceFromTarget("track-1", { id: delay.instanceId, kind: "delay" });
      expect(device.snapshotExportRows(["track-1"]).map((row) => row.effect)).toEqual(["chorus"]);
      await removal;

      const removeMaster = device.removeAllFromTarget("master");
      expect(device.snapshotExportRows(["master"])).toEqual([]);
      await removeMaster;
      dispose();
    });
  });

  test("restores projected removal order when persistence fails", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      let rejectReorder = false;
      const { device } = createDevice(engine, {
        projectId: "project:effects-export-removal-rollback",
        persistAudioEffectOrder: () => rejectReorder
          ? Promise.reject(new Error("reorder failed"))
          : Promise.resolve(),
      });
      await device.addByKindToTarget("track-1", "delay");
      await device.addByKindToTarget("track-1", "chorus");
      const delay = device.snapshotExportRows(["track-1"])
        .find((row) => row.effect === "delay");
      if (!delay?.instanceId) throw new Error("Expected a projected delay.");

      rejectReorder = true;
      const removal = device.removeByInstanceFromTarget("track-1", { id: delay.instanceId, kind: "delay" });
      expect(device.snapshotExportRows(["track-1"]).map((row) => row.effect)).toEqual(["chorus"]);
      await expect(removal).rejects.toThrow("reorder failed");
      expect(device.snapshotExportRows(["track-1"]).map((row) => row.effect)).toEqual(["delay", "chorus"]);
      dispose();
    });
  });

  test("projects pending sidechain changes, flushes them, and rolls back failures", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      let resolvePersist: (() => void) | undefined;
      let rejectNext = false;
      const { device, setSidechainRoutes } = createDevice(engine, {
        projectId: "project:sidechain-export",
        sidechainRoutes: [{
          sourceTrackId: "track-source-a",
          targetTrackId: "track-1",
          effectInstanceId: "gate-1",
        }],
        persistSidechainRoute: async () => {
          if (rejectNext) throw new Error("sidechain persistence failed");
          await new Promise<void>((resolve) => {
            resolvePersist = resolve;
          });
        },
      });

      const pending = device.gate.setSidechainSource("gate-1", "track-source-b");
      expect(device.snapshotSidechainRoutes()).toEqual([{
        sourceTrackId: "track-source-b",
        targetTrackId: "track-1",
        effectInstanceId: "gate-1",
      }]);
      let flushed = false;
      const flush = device.flushPending().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBeFalse();
      resolvePersist?.();
      await Promise.all([pending, flush]);
      setSidechainRoutes([{
        sourceTrackId: "track-source-b",
        targetTrackId: "track-1",
        effectInstanceId: "gate-1",
      }]);
      expect(device.snapshotSidechainRoutes()[0]?.sourceTrackId).toBe("track-source-b");

      rejectNext = true;
      const failed = device.gate.setSidechainSource("gate-1", "track-source-c");
      expect(device.snapshotSidechainRoutes()[0]?.sourceTrackId).toBe("track-source-c");
      await expect(failed).rejects.toThrow("sidechain persistence failed");
      expect(device.snapshotSidechainRoutes()[0]?.sourceTrackId).toBe("track-source-b");
      dispose();
    });
  });

  test("keeps persisted effect instance identity stable across row refreshes", () => {
    const cache = createAudioEffectInstanceIdentityCache();
    const initial = cache.get("track-1", "delay-1", "delay");
    const refreshed = cache.get("track-1", "delay-1", "delay");
    const changedKind = cache.get("track-1", "delay-1", "reverb");

    expect(refreshed).toBe(initial);
    expect(changedKind).not.toBe(initial);
    cache.prune(new Set(["track-1:delay-1"]));
    expect(cache.get("track-1", "delay-1", "delay")).not.toBe(initial);
  });
});
