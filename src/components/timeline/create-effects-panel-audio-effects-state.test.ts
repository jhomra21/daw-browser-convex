import { describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { createComponent, createRenderEffect, createRoot, createSignal, Show, type Accessor, type JSX } from "solid-js";
import { AudioEngine, type AudioEffectRuntimeInstance, type EngineDisposition } from "@daw-browser/audio-engine/audio-engine";
import { AUDIO_EFFECT_CONTRACTS, type AudioEffectInstance, type AudioEffectKind, type JsonValue } from "@daw-browser/shared";
import type { ExternalSidechainRoute } from "@daw-browser/timeline-core/types";
import type { DeliveryRegistration, LiveProcessorEditIdentity, ProcessorDeliveryOutcome } from "~/lib/live-processor-control";
import type { EffectParamsCommitPayload } from "~/lib/undo/types";
import type { SharedTimelineOperation } from "~/lib/shared-timeline-operations-api";
import {
  createEffectsPanelAudioDevice,
  indexFirstAudioEffectRowsByKind,
  publishEffectOperation,
  registerAudioEffectCardInteractionCleanup,
} from "./create-effects-panel-audio-effects-state";
import { createAudioEffectInstanceIdentityCache } from "./create-effects-panel-instance-identity-cache";
import { publishEffects } from "./create-effects-panel-state";
import { deleteLocalEffectInstance, listLocalEffects, setLocalEffect, setLocalEffectInstance, type LocalEffectRow } from "~/lib/local-effects";
import * as localChanges from "~/lib/local-project-changes";
import { ParameterGestureHolder } from "./parameter-gesture-owner";
import { createProcessorEditRegistry } from "./create-processor-edit-registry";
import { createLocalEffectsView } from "./create-local-effects-view";
import { z } from "zod";

type PersistOrder = (targetId: string, order: AudioEffectInstance[]) => void | Promise<void>;
type EffectsPanelContext = Parameters<typeof createEffectsPanelAudioDevice>[0];

class SpyAudioEngine extends AudioEngine {
  readonly trackFxCalls: Array<{ trackId: string; instances: AudioEffectRuntimeInstance[] }> = [];
  readonly masterFxCalls: AudioEffectRuntimeInstance[][] = [];
  deferMasterFx = false;
  private resolveMasterFx?: () => void;

  override async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> {
    this.trackFxCalls.push({ trackId, instances });
    return "applied";
  }

  override async setMasterFxInstances(instances: AudioEffectRuntimeInstance[]) {
    this.masterFxCalls.push(instances);
    await this.waitForMasterFxRelease();
    return super.setMasterFxInstances(instances);
  }

  override async setMasterFxInstance(instance: AudioEffectRuntimeInstance) {
    this.masterFxCalls.push([instance]);
    await this.waitForMasterFxRelease();
    return super.setMasterFxInstance(instance);
  }

  override async setTrackFxInstance(trackId: string, instance: AudioEffectRuntimeInstance) {
    this.trackFxCalls.push({ trackId, instances: [instance] });
    return super.setTrackFxInstance(trackId, instance);
  }

  private async waitForMasterFxRelease() {
    if (!this.deferMasterFx) return;
    await new Promise<void>((resolve) => {
      this.resolveMasterFx = resolve;
    });
  }

  releaseMasterFx() {
    this.resolveMasterFx?.();
    this.resolveMasterFx = undefined;
  }
}

const createDevice = (
  engine: SpyAudioEngine,
  options: {
    canWrite?: boolean;
    projectId?: string;
    projectGeneration?: number;
    targetId?: string;
    usesLegacyAudioEngine?: boolean;
    localEffectsView?: EffectsPanelContext["localEffectsView"];
    deliverProcessor?: EffectsPanelContext["deliverProcessor"];
    persistAudioEffectOrder?: PersistOrder;
    persistSidechainRoute?: (targetTrackId: string, effectInstanceId: string, sourceTrackId?: string) => Promise<void>;
    sidechainRoutes?: ExternalSidechainRoute[];
    allocateProcessorEdit?: EffectsPanelContext["allocateProcessorEdit"];
    onEffectParamsCommitted?: EffectsPanelContext["onEffectParamsCommitted"];
  } = {},
) => {
  const [currentTargetId, setCurrentTargetId] = createSignal(options.targetId ?? "track-1");
  const [projectId, setProjectId] = createSignal(options.projectId);
  const [projectGeneration, setProjectGeneration] = createSignal(options.projectGeneration ?? 0);
  const [canWriteCurrentTargetEffects, setCanWriteCurrentTargetEffects] = createSignal(options.canWrite ?? true);
  const [sidechainRoutes, setSidechainRoutes] = createSignal(options.sidechainRoutes ?? []);
  const device = createEffectsPanelAudioDevice(
    {
      audioEngine: () => engine,
      projectId,
      userId: () => projectId() ? "user-1" : undefined,
      roomEffects: () => [],
      sidechainRoutes,
      canWriteCurrentTargetEffects,
      projectGeneration,
      usesLegacyAudioEngine: () => options.usesLegacyAudioEngine ?? true,
      localEffectsView: options.localEffectsView,
      allocateProcessorEdit: options.allocateProcessorEdit ?? createProcessorEditRegistry(() => 120).allocate,
      deliverProcessor: options.deliverProcessor,
      onEffectParamsCommitted: options.onEffectParamsCommitted,
      persistAudioEffectOrder: options.persistAudioEffectOrder,
      persistSidechainRoute: options.persistSidechainRoute,
    },
    currentTargetId,
    () => undefined,
  );
  return {
    device,
    setCanWriteCurrentTargetEffects,
    setCurrentTargetId,
    setProjectGeneration,
    setProjectId,
    setSidechainRoutes,
  };
};

type NonKeyedEffectShowProps = {
  when: { id: string } | undefined;
  keyed?: false;
  children: (effect: Accessor<{ id: string }>) => JSX.Element;
};
const renderNonKeyedEffectShow = (props: NonKeyedEffectShowProps) => (
  createComponent<NonKeyedEffectShowProps>(Show, props)
);

describe("effects panel instance engine synchronization", () => {
  test("W24 structural edit persists and records history before its native receipt ends", async () => {
    const projectId = `project:step6-w24-${crypto.randomUUID()}`;
    const instanceId = "spectral:step6-w24";
    const initial = AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams();
    await setLocalEffectInstance(projectId, "track-1", "spectral", initial, { instanceId });
    const terminal = Promise.withResolvers<ProcessorDeliveryOutcome>();
    const registered = Promise.withResolvers<void>();
    const history: EffectParamsCommitPayload[] = [];
    const registrations: { key: string; serial: number }[] = [];
    let answered = false;
    let dispose = () => {};
    const fixture = createRoot(end => {
      dispose = end;
      const view = createLocalEffectsView({ projectId: () => projectId });
      return { view, ...createDevice(new SpyAudioEngine(), { projectId, usesLegacyAudioEngine: false,
        localEffectsView: view,
        deliverProcessor: () => {
          registered.resolve();
          const receipt = { key: instanceId, serial: registrations.length + 1 };
          registrations.push(receipt);
          return { receipt, settled: terminal.promise };
        },
        onEffectParamsCommitted: payload => { history.push(payload); },
      }) };
    });
    void terminal.promise.then(() => { answered = true; });
    try {
      await fixture.view.reload();
      fixture.device.spectral.changeInstance(instanceId, params => ({
        ...params, state: { ...params.state, fftSize: 4096 },
      }));
      await registered.promise;
      const before: unknown = await fixture.device.flushPending();
      expect(answered).toBe(false);
      expect(history).toHaveLength(1);
      const rows = await listLocalEffects(projectId);
      expect(rows.find(row => row.instanceId === instanceId)?.params).toMatchObject({ state: { fftSize: 4096 } });
      terminal.resolve({ state: "refused", reason: "apply-failed" });
      await terminal.promise;
      const after: unknown = await fixture.device.flushPending();
      expect(answered).toBe(true);
      expect(history).toHaveLength(1);
      expect(await listLocalEffects(projectId)).toEqual(rows);
      console.log("STEP6-W24", JSON.stringify({ savedBeforeNative: true, historyBeforeNative: 1,
        historyAfterNative: history.length, answered, drainBefore: before ?? "void", drainAfter: after ?? "void" }));
      expect(registrations).toHaveLength(2);
      expect(before).toEqual({ unanswered: registrations.map(receipt => expect.objectContaining({ receipt })), admitted: [] });
      expect(after).toEqual({ unanswered: [], admitted: [] });
    } finally { terminal.resolve({ state: "unavailable" }); dispose(); }
  });

  test("3B1 a real audio adapter records history without waiting for native settlement", async () => {
    const projectId = `project:3b0-native-${crypto.randomUUID()}`;
    const instanceId = "audio-effect:3b0-native";
    const initial = AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams();
    await setLocalEffectInstance(projectId, "track-1", "compressor", initial, { instanceId });
    let finish = (_result: ProcessorDeliveryOutcome) => {};
    const held = new Promise<ProcessorDeliveryOutcome>((resolve) => { finish = resolve; });
    let entered = () => {};
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const history: number[] = [];
    let dispose = () => {};
    const fixture = createRoot((end) => {
      dispose = end;
      const view = createLocalEffectsView({ projectId: () => projectId });
      const device = createDevice(new SpyAudioEngine(), {
        projectId, usesLegacyAudioEngine: false,
        localEffectsView: view,
        deliverProcessor: () => { entered(); return { receipt: { key: instanceId, serial: 1 }, settled: held }; },
        onEffectParamsCommitted: () => { history.push(1); },
      });
      return { ...device, view };
    });
    // Join the shared local reader's publication instead of waiting on elapsed time.
    await fixture.view.reload();
    fixture.device.compressor.changeInstance(instanceId, (params) => ({ ...params, thresholdDb: -33 }));
    await started;
    await fixture.device.flushPending();
    expect(history).toEqual([1]);
    finish({ state: "refused", reason: "native-refused" });
    await fixture.device.flushPending();
    expect(history).toEqual([1]);
    dispose();
  });

  const terminalGestureBrowserChild = process.env.EFFECT_TERMINAL_GESTURE_BROWSER_CHILD === "1";
  test.skipIf(terminalGestureBrowserChild)(
    "runs the terminal knob gesture regression with Solid's browser runtime",
    async () => {
      const child = Bun.spawn([
        "perl", "-e", "alarm shift; exec @ARGV", "120",
        "bun",
        "--conditions=browser",
        "test",
        "--timeout", "30000",
        import.meta.path,
        "-t",
        "flushes the latest knob gesture stamp without rolling back its committed value",
      ], {
        env: { ...process.env, EFFECT_TERMINAL_GESTURE_BROWSER_CHILD: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
      expect(code).toBe(0);
    },
  );

  test.skipIf(process.env.EFFECT_CARD_CLEANUP_BROWSER_CHILD === "1")(
    "runs card cleanup regressions with Solid's browser runtime",
    () => {
      const result = Bun.spawnSync([
        "perl", "-e", "alarm shift; exec @ARGV", "120",
        "bun",
        "--conditions=browser",
        "test",
        "--timeout", "30000",
        import.meta.path,
        "--test-name-pattern",
        "cancels captured IDs when non-keyed Show content is invalidated|cancels a replaced effect interaction with its previous effect ID",
      ], {
        env: { ...process.env, EFFECT_CARD_CLEANUP_BROWSER_CHILD: "1" },
      });
      expect(result.exitCode).toBe(0);
    },
  );

  test.skipIf(process.env.EFFECT_CARD_CLEANUP_BROWSER_CHILD !== "1")(
    "cancels captured IDs when non-keyed Show content is invalidated",
    () => {
      const canceled: Array<{ effectId: string; targetId: string | undefined }> = [];
      let activeEffectId: string | undefined;
      const audioEffects = {
        beginInteraction: (effectId: string, _targetId?: string) => {
          activeEffectId = effectId;
        },
        interruptGesture: (effectId: string, targetId?: string) => {
          canceled.push({ effectId, targetId });
        },
      };
      const [effect, setEffect] = createSignal<{ id: string } | undefined>({ id: "effect-show" });
      let dispose = () => {};
      createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return renderNonKeyedEffectShow({
          get when() {
            return effect();
          },
          get children() {
            return (shownEffect: Accessor<{ id: string }>) => {
              registerAudioEffectCardInteractionCleanup({
                audioEffects: () => audioEffects,
                effectId: () => shownEffect().id,
                targetId: () => "track-show",
                ownerKey: () => `project:1:${shownEffect().id}`,
              });
              createRenderEffect(() => audioEffects.beginInteraction(shownEffect().id, "track-show"));
              return "";
            };
          },
        });
      });

      expect(activeEffectId).toBe("effect-show");
      expect(() => setEffect(undefined)).not.toThrow();
      expect(canceled).toEqual([{ effectId: "effect-show", targetId: "track-show" }]);
      dispose();
    },
  );

  test.skipIf(process.env.EFFECT_CARD_CLEANUP_BROWSER_CHILD !== "1")(
    "cancels a replaced effect interaction with its previous effect ID",
    () => {
      const events: string[] = [];
      let activeEffectId: string | undefined;
      const audioEffects = {
        beginInteraction: (effectId: string) => {
          activeEffectId = effectId;
          events.push(`begin:${effectId}`);
        },
        interruptGesture: (effectId: string, targetId?: string) => {
          events.push(`cancel:${effectId}:${targetId}`);
        },
      };
      const [effect, setEffect] = createSignal<{ id: string } | undefined>({ id: "effect-old" });
      let dispose = () => {};
      createRoot((disposeRoot) => {
        dispose = disposeRoot;
        return renderNonKeyedEffectShow({
          get when() {
            return effect();
          },
          get children() {
            return (shownEffect: Accessor<{ id: string }>) => {
              registerAudioEffectCardInteractionCleanup({
                audioEffects: () => audioEffects,
                effectId: () => shownEffect().id,
                targetId: () => "track-current",
                ownerKey: () => `project:1:${shownEffect().id}`,
              });
              createRenderEffect(() => audioEffects.beginInteraction(shownEffect().id));
              return "";
            };
          },
        });
      });

      setEffect({ id: "effect-new" });
      expect(events).toEqual([
        "begin:effect-old",
        "begin:effect-new",
        "cancel:effect-old:track-current",
      ]);
      expect(activeEffectId).toBe("effect-new");
      dispose();
      expect(events.at(-1)).toBe("cancel:effect-new:track-current");
    },
  );

  test("commits a real reverb edit with the persisted row instance ID", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const commits: EffectParamsCommitPayload[] = [];
      const { device } = createDevice(engine, {
        projectId: `project:reverb-${crypto.randomUUID()}`,
        onEffectParamsCommitted: (payload) => {
          commits.push(payload);
        },
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

  test("does not commit an async edit after the project generation changes", async () => {
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      const commits: EffectParamsCommitPayload[] = [];
      const { device, setProjectGeneration, setProjectId } = createDevice(engine, {
        projectId: "project:stale-effect-commit",
        targetId: "master",
        onEffectParamsCommitted: (payload) => {
          commits.push(payload);
        },
      });
      await device.addByKindToTarget("master", "delay");
      const inserted = engine.masterFxCalls.at(-1)?.[0];
      if (!inserted) throw new Error("Expected an inserted delay instance.");
      await device.flushPending();
      commits.length = 0;

      engine.deferMasterFx = true;
      device.delay.changeInstance(inserted.id, (params) => ({ ...params, feedback: 0.8 }));
      const pending = device.flushPending();
      await Promise.resolve();
      setProjectId("project:other");
      setProjectGeneration(1);
      engine.releaseMasterFx();
      await pending;
      await Promise.resolve();
      expect(engine.masterFxCalls.at(-1)?.[0]?.params).toMatchObject({ feedback: 0.8 });
      expect(commits).toHaveLength(0);
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
      const hasUpdatedFeedback = (params: AudioEffectRuntimeInstance["params"]) => (
        "feedback" in params && params.feedback === 0.8
      );
      const updated = engine.trackFxCalls
        .flatMap((call) => call.instances)
        .find((instance) => instance.kind === "delay" && hasUpdatedFeedback(instance.params));
      if (!updated) throw new Error("Expected the updated delay parameters.");
      expect(updated.params).toMatchObject({ feedback: 0.8 });
      dispose();
    });
  });

  test.skipIf(!terminalGestureBrowserChild)(
    "flushes the latest knob gesture stamp without rolling back its committed value",
    async () => {
    const projectId = `project:terminal-gesture-${crypto.randomUUID()}`;
    const instance = { id: "utility:terminal", kind: "utility" } satisfies AudioEffectInstance;
    await setLocalEffectInstance(projectId, "track-1", "utility", AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(), {
      instanceId: instance.id, index: 0,
    });
    await createRoot(async (dispose) => {
      const engine = new SpyAudioEngine();
      let latest: { signature: string; edit: LiveProcessorEditIdentity } | undefined;
      const previews: Array<{ sequence: number | undefined; gainDb: number }> = [];
      const flushes: Array<{ sequence: number | undefined; gainDb: number }> = [];
      const commits: EffectParamsCommitPayload[] = [];
      const events: string[] = [];
      const { device } = createDevice(engine, {
        projectId,
        usesLegacyAudioEngine: false,
        // The registry's rule: equal content on the member is the same write and keeps its identity.
        allocateProcessorEdit: (payload) => {
          const signature = JSON.stringify(payload.to);
          if (latest?.signature === signature) return latest.edit;
          const order = (latest?.edit.order ?? 0) + 1;
          latest = {
            signature,
            edit: {
              id: `test-edit-${order}`,
              order,
              target: { nodeId: payload.targetId, instanceId: payload.instanceId ?? "", kindId: 1, incarnation: 1 },
              content: { params: payload.to },
            },
          };
          return latest.edit;
        },
        deliverProcessor: (edit, gesture): DeliveryRegistration => {
          const params = z.object({ state: z.object({ gainDb: z.number() }) }).parse(edit.content.params);
          if (gesture?.holds) {
            events.push(`preview:${edit.order}`);
            previews.push({ sequence: edit.order, gainDb: params.state.gainDb });
          } else {
            events.push(`flush:${edit.order}`);
            flushes.push({ sequence: edit.order, gainDb: params.state.gainDb });
          }
          return { receipt: { key: edit.target.instanceId, serial: edit.order }, settled: Promise.resolve({ state: "applied" }) };
        },
        onEffectParamsCommitted: (payload) => {
          events.push("commit");
          commits.push(payload);
        },
      });
      // Wait for the real persisted row, not an optimistic insertion with an empty query.
      await new Promise<void>((resolve) => {
        createRenderEffect(() => {
          if (device.snapshotExportRows(["track-1"]).some((row) => row.instanceId === instance.id)) resolve();
        });
      });

      const gesture = device.gestureOwner(instance.id, "utility");
      const holder = new ParameterGestureHolder();
      gesture.open(holder);
      gesture.tick(holder, () => device.utility.changeInstance(instance.id, (params) => ({
        ...params,
        state: { ...params.state, gainDb: -3 },
      })));
      gesture.tick(holder, () => device.utility.changeInstance(instance.id, (params) => ({
        ...params,
        state: { ...params.state, gainDb: -6 },
      })));
      gesture.end(holder);
      await device.flushPending();

      // Previews are one per frame and the gesture ended inside one, so only the release reaches the engine. Each tick took
      // an order when it was written (1, 2); the release is the equal content of the second and keeps its identity.
      expect(previews).toEqual([]);
      expect(flushes).toEqual([{ sequence: 2, gainDb: -6 }]);
      expect(commits.at(-1)).toMatchObject({ to: { state: { gainDb: -6 } } });
      expect(device.paramsForInstance(instance)).toMatchObject({ state: { gainDb: -6 } });
      expect(events).toEqual(["flush:2", "commit"]);
      dispose();
    });
    },
  );

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

      expect(engine.trackFxCalls.slice(before).every(call => call.instances.every(instance => instance.kind !== "delay" || instance.params.feedback !== 0.8))).toBe(true);
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
      let sequence = 0;
      const commits: Array<{ feedback: number }> = [];
      const { device } = createDevice(engine, {
        projectId: `project:effects-export-projection-${crypto.randomUUID()}`,
        allocateProcessorEdit: (payload) => {
          const order = ++sequence;
          return {
            id: `test-edit-${order}`,
            order,
            target: { nodeId: payload.targetId, instanceId: payload.instanceId ?? "", kindId: 1, incarnation: 1 },
            content: { params: payload.to },
          };
        },
        onEffectParamsCommitted: (payload) => {
          if (payload.effect === "delay" && "feedback" in payload.to)
            commits.push({ feedback: payload.to.feedback });
        },
      });

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
      const firstSequence = sequence;
      expect(device.snapshotExportRows(["track-1"])
        .find((row) => row.effect === "delay")?.params).toMatchObject({ feedback: 0.8 });
      device.delay.changeInstance(delay.instanceId, (params) => ({ ...params, feedback: 0.9 }));
      const secondSequence = sequence;
      expect(secondSequence).toBeGreaterThan(firstSequence);
      await device.flushPending();
      expect(commits.slice(-2)).toEqual([
        { feedback: 0.8 },
        { feedback: 0.9 },
      ]);

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
    cache.retain([{ targetId: "track-1", id: "delay-1", kind: "delay" }]);
    const initial = cache.instance("track-1", "delay-1", "delay");
    cache.retain([{ targetId: "track-1", id: "delay-1", kind: "delay" }]);

    expect(cache.instance("track-1", "delay-1", "delay")).toBe(initial);
    expect(cache.instance("track-1", "delay-1", "reverb")).not.toBe(initial);
    cache.retain([]);
    expect(cache.instance("track-1", "delay-1", "delay")).not.toBe(initial);
  });

  test("looks up the first duplicate instance row matching each effect kind", () => {
    const utilityParams = AUDIO_EFFECT_CONTRACTS.utility.normalizeParams({ version: 1, state: { gainDb: -7 } });
    const utilityKind: AudioEffectKind = "utility";
    const delayKind: AudioEffectKind = "delay";
    const firstRow = {
      targetId: "track-1",
      instanceId: "duplicate",
      kind: utilityKind,
      params: utilityParams,
    };
    const laterRow = {
      ...firstRow,
      params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams(),
    };
    const differentKindRow = {
      ...firstRow,
      kind: delayKind,
      params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(),
    };
    const index = indexFirstAudioEffectRowsByKind([firstRow, laterRow, differentKindRow]);

    expect(index.get("track-1:duplicate:utility")).toBe(firstRow);
    expect(index.get("track-1:duplicate:delay")).toBe(differentKindRow);
  });
});

const loadViewModule = () => import("./create-local-effects-view");
const utilityRow = (id: string, value = 0): LocalEffectRow<JsonValue> => ({
  id: `track-1:effect:${id}`, targetId: "track-1", effect: "utility", instanceId: id, params: { value }, index: 0, updatedAt: 1,
});
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: Error) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const createViewHarness = async (list: (projectId: string) => Promise<LocalEffectRow<JsonValue>[]>, initialProject: string | undefined) => {
  const { createLocalEffectsViewOwner } = await loadViewModule();
  let project = initialProject;
  const publications: Array<{ through: number; ids: string[] } | undefined> = [];
  const errors: Array<string | undefined> = [];
  const owner = createLocalEffectsViewOwner({
    currentProjectId: () => project,
    list,
    publish: (view) => publications.push(view && { through: view.through, ids: view.rows.map((row) => row.id) }),
    fail: (error) => errors.push(error?.message),
  });
  return {
    owner, publications, errors,
    switchProject: (next: string | undefined) => { project = next; owner.sync(); },
  };
};

describe("local effects row sequence and lifetime-fenced view", () => {
  test("setLocalEffect and setLocalEffectInstance return the row with the change sequence their write produced", async () => {
    const projectId = `project:local-sequence-${crypto.randomUUID()}`;
    const before = localChanges.localProjectChangeSequence(projectId);
    const first = await setLocalEffectInstance(projectId, "track-1", "utility", { value: 1 }, { instanceId: "utility:1", index: 0 });
    expect(first.row).toMatchObject({ instanceId: "utility:1", params: { value: 1 } });
    expect(first.sequence).toBe(before + 1);
    const second = await setLocalEffect(projectId, "track-1", "arp", { value: 2 });
    expect(second.row).toMatchObject({ effect: "arp" });
    expect(second.sequence).toBe(before + 2);
    expect(localChanges.localProjectChangeSequence(projectId)).toBe(before + 2);
    // The sequence is per project.
    expect(localChanges.localProjectChangeSequence(`project:other-${crypto.randomUUID()}`)).toBe(0);
  });

  test("overlapping reloads publish the newest read and drop an older one that finishes late", async () => {
    const projectId = `project:view-overlap-${crypto.randomUUID()}`;
    const first = deferred<LocalEffectRow<JsonValue>[]>();
    const second = deferred<LocalEffectRow<JsonValue>[]>();
    const reads = [first, second];
    const harness = await createViewHarness(() => reads.shift()?.promise ?? Promise.resolve([]), projectId);
    harness.switchProject(projectId);
    localChanges.notifyLocalProjectChanged(projectId);
    second.resolve([utilityRow("newer")]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    first.resolve([utilityRow("older")]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.publications.map((view) => view?.ids)).toEqual([["track-1:effect:newer"]]);
    harness.owner.dispose();
  });

  test("an older reload that finishes first is superseded by the newer one in order", async () => {
    const projectId = `project:view-order-${crypto.randomUUID()}`;
    const first = deferred<LocalEffectRow<JsonValue>[]>();
    const second = deferred<LocalEffectRow<JsonValue>[]>();
    const reads = [first, second];
    const harness = await createViewHarness(() => reads.shift()?.promise ?? Promise.resolve([]), projectId);
    harness.switchProject(projectId);
    localChanges.notifyLocalProjectChanged(projectId);
    first.resolve([utilityRow("older")]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    second.resolve([utilityRow("newer")]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const published = harness.publications.flatMap((view) => view ? [view] : []);
    expect(published.map((view) => view.ids)).toEqual([["track-1:effect:older"], ["track-1:effect:newer"]]);
    expect(published[1]!.through).toBeGreaterThan(published[0]!.through);
    harness.owner.dispose();
  });

  test("a result from an ended lifetime is dropped, whether the project changed or the view was disposed", async () => {
    const projectA = `project:view-a-${crypto.randomUUID()}`;
    const projectB = `project:view-b-${crypto.randomUUID()}`;
    const pendingA = deferred<LocalEffectRow<JsonValue>[]>();
    const harness = await createViewHarness(
      (projectId) => projectId === projectA ? pendingA.promise : Promise.resolve([utilityRow("from-b")]),
      projectA,
    );
    harness.switchProject(projectA);
    harness.switchProject(projectB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pendingA.resolve([utilityRow("from-a")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.publications.flatMap((view) => view?.ids ?? [])).toEqual(["track-1:effect:from-b"]);

    const pendingB = deferred<LocalEffectRow<JsonValue>[]>();
    const later = await createViewHarness(() => pendingB.promise, projectB);
    later.switchProject(projectB);
    later.owner.dispose();
    pendingB.resolve([utilityRow("late")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(later.publications).toEqual([]);
    harness.owner.dispose();
  });

  test("a failed query keeps the last good view and reports the error instead of removing rows", async () => {
    const projectId = `project:view-error-${crypto.randomUUID()}`;
    let attempt = 0;
    const harness = await createViewHarness(async () => {
      attempt += 1;
      if (attempt === 2) throw new Error("local read failed");
      return [utilityRow(`read-${attempt}`)];
    }, projectId);
    harness.switchProject(projectId);
    await harness.owner.reload();
    await expect(harness.owner.reload()).rejects.toThrow("local read failed");
    expect(harness.publications.map((view) => view?.ids)).toEqual([["track-1:effect:read-1"]]);
    expect(harness.errors.at(-1)).toBe("local read failed");
    localChanges.notifyLocalProjectChanged(projectId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.publications.at(-1)?.ids).toEqual(["track-1:effect:read-3"]);
    expect(harness.errors.at(-1)).toBeUndefined();
    harness.owner.dispose();
  });

  test("leaving a local project resets the view", async () => {
    const projectId = `project:view-reset-${crypto.randomUUID()}`;
    const harness = await createViewHarness(async () => [utilityRow("kept")], projectId);
    harness.switchProject(projectId);
    await harness.owner.reload();
    harness.switchProject(undefined);
    expect(harness.publications.map((view) => view?.ids)).toEqual([["track-1:effect:kept"], undefined]);
    harness.owner.dispose();
  });

  test("one view serves both consumers: one read per change, and removal and load both reach them", async () => {
    const { listLocalEffects } = await import("~/lib/local-effects");
    const projectId = `project:view-shared-${crypto.randomUUID()}`;
    let reads = 0;
    const harness = await createViewHarness(async (id) => { reads += 1; return await listLocalEffects(id); }, projectId);
    const device: Promise<unknown>[] = [];
    const sync: Promise<unknown>[] = [];
    harness.owner.watchReloads((load) => device.push(load));
    harness.owner.watchReloads((load) => sync.push(load));
    harness.switchProject(projectId);
    await harness.owner.reload();
    const written = await setLocalEffectInstance(projectId, "track-1", "utility", { value: 1 }, { instanceId: "utility:1", index: 0 });
    await harness.owner.reload();
    await Promise.all([...device, ...sync]);
    expect(device).toHaveLength(sync.length);
    expect(device.length).toBeGreaterThan(0);
    expect(harness.publications.at(-1)?.ids).toEqual(["track-1:effect:utility:1"]);
    expect(harness.publications.at(-1)!.through).toBeGreaterThanOrEqual(written.sequence);
    const readsAfterLoad = reads;
    await deleteLocalEffectInstance(projectId, "track-1", "utility", "utility:1");
    await harness.owner.reload();
    expect(harness.publications.at(-1)?.ids).toEqual([]);
    expect(reads).toBeGreaterThan(readsAfterLoad);
    // Each change cost one read for both consumers, not one per consumer.
    expect(reads).toBeLessThanOrEqual(readsAfterLoad + 2);
    harness.owner.dispose();
  });

  test("N1 data plane (local): a foreign write that lands before our acknowledgement is ordered after it by sequence", async () => {
    const { listLocalEffects } = await import("~/lib/local-effects");
    const projectId = `project:view-n1-${crypto.randomUUID()}`;
    const harness = await createViewHarness(listLocalEffects, projectId);
    harness.switchProject(projectId);
    const ours = setLocalEffectInstance(projectId, "track-1", "utility", { value: 1 }, { instanceId: "utility:1", index: 0 });
    const foreign = await setLocalEffectInstance(projectId, "track-1", "utility", { value: 7 }, { instanceId: "utility:1", index: 0 });
    await harness.owner.reload();
    // Our acknowledgement is delivered only now, after the view already read the foreign row.
    const acknowledged = await ours;
    const view = harness.publications.at(-1);
    expect(acknowledged.sequence).toBeLessThan(foreign.sequence);
    expect(view!.through).toBeGreaterThanOrEqual(foreign.sequence);
    expect(view!.through).toBeGreaterThan(acknowledged.sequence);
    const row = (await listLocalEffects(projectId)).find((entry) => entry.instanceId === "utility:1");
    expect(row?.params).toEqual({ value: 7 });
    harness.owner.dispose();
  });
});

test("effects publication preserves applied, admitted, and rejected outcomes", async () => {
  const originalFetch = globalThis.fetch;
  const publication = (status: number, result: JsonValue) => {
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify(result), { status }),
      { preconnect: originalFetch.preconnect },
    );
  };
  const operation: SharedTimelineOperation = {
    kind: "effects.setDelayParams",
    payload: {
      trackId: "track-1",
      instanceId: "delay-1",
      params: AUDIO_EFFECT_CONTRACTS.delay.createDefaultParams(),
    },
  };
  try {
    publication(200, { status: "applied", effectId: "effect-1", revision: 3 });
    for (const publish of [
      (projectId: string) => publishEffectOperation(projectId, "user-1", operation),
      (projectId: string) => publishEffects(projectId, "user-1", operation),
    ]) {
      publication(200, { status: "applied", effectId: "effect-1", revision: 3 });
      expect(await publish(`publisher-applied-${crypto.randomUUID()}`))
        .toMatchObject({
          kind: "applied",
          result: { status: "applied", effectId: "effect-1", revision: { kind: "ordered", revision: 3 } },
        });

      publication(503, { status: "unavailable" });
      expect(await publish(`publisher-admitted-${crypto.randomUUID()}`)).toMatchObject({ kind: "admitted" });

      publication(403, { status: "forbidden" });
      expect(await publish(`publisher-rejected-${crypto.randomUUID()}`)).toMatchObject({ kind: "rejected" });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("effect edits the engine did not install", () => {
  class RefusingEngine extends SpyAudioEngine {
    readonly outcome: EngineDisposition;

    constructor(outcome: EngineDisposition) {
      super();
      this.outcome = outcome;
    }

    override async setTrackFxInstances(trackId: string, instances: AudioEffectRuntimeInstance[]): Promise<EngineDisposition> {
      this.trackFxCalls.push({ trackId, instances });
      return this.outcome;
    }

    override async setTrackFxInstance(trackId: string, instance: AudioEffectRuntimeInstance): Promise<EngineDisposition | "not-held"> {
      this.trackFxCalls.push({ trackId, instances: [instance] });
      return this.outcome;
    }
  }

  for (const [outcome, committed] of [["dropped", 0], ["superseded", 0], ["applied", 1], ["joined", 1]] as const) {
    test(`a released edit the engine answered ${outcome} is entered in history ${committed} times`, async () => {
      await createRoot(async (dispose) => {
        const engine = new RefusingEngine(outcome);
        const commits: EffectParamsCommitPayload[] = [];
        const { device } = createDevice(engine, { projectId: `project:portable-outcome-${crypto.randomUUID()}`, onEffectParamsCommitted: (payload) => { commits.push(payload); } });
        expect(await device.addByKindToTarget("track-1", "delay")).toBe(true);
        const delay = engine.trackFxCalls[0]?.instances[0];
        if (!delay) throw new Error("Expected delay");
        await device.flushPending();
        engine.trackFxCalls.length = 0;
        commits.length = 0;
        device.delay.changeInstance(delay.id, (params) => ({ ...params, feedback: 0.8 }));
        await device.flushPending();

        expect(engine.trackFxCalls).toHaveLength(1);
        expect(commits).toHaveLength(committed);
        dispose();
      });
    });
  }
});
