import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { AudioEngine, type AudioEffectRuntimeInstance } from "@daw-browser/audio-engine/audio-engine";
import { AUDIO_EFFECT_CONTRACTS, type AudioEffectInstance } from "@daw-browser/shared";
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
    persistAudioEffectOrder?: PersistOrder;
  } = {},
) => {
  const [currentTargetId, setCurrentTargetId] = createSignal("track-1");
  const [canWriteCurrentTargetEffects, setCanWriteCurrentTargetEffects] = createSignal(options.canWrite ?? true);
  const device = createEffectsPanelAudioDevice(
    {
      audioEngine: () => engine,
      projectId: () => undefined,
      userId: () => undefined,
      roomEffects: () => [],
      canWriteCurrentTargetEffects,
      persistAudioEffectOrder: options.persistAudioEffectOrder,
    },
    currentTargetId,
    () => undefined,
  );
  return { device, setCanWriteCurrentTargetEffects, setCurrentTargetId };
};

describe("effects panel instance engine synchronization", () => {
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
