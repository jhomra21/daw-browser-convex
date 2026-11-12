// Measures what one built-in device control edit costs. Part A mounts the real EffectsPanel in Chromium and
// drives real DOM events. Part B mounts the real useTimelinePlayback hook over a fake native host in bun.
// Run through tools/acceptance/device-control-cost.ts, which sets DEVICE_COST_RAW_DIR and collects the output.
import { expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { createComputed, createMemo, createRoot, createSignal, untrack } from "solid-js";
import { isServer } from "solid-js/web";
import { z } from "zod";
import { automationTargetKey, createDefaultDelayParams, createDefaultEqParams, createDefaultGateParams, createDefaultSpectralParams, createDefaultSynthParams, createDefaultDrumRackParams, createDefaultSamplerParams, createDefaultGranularParams, createDefaultCompressorParams, type AutomationEnvelope, type DelayParams, type TrackInstrumentParams } from "@daw-browser/shared";
import type { NativeBuiltInParameterPayload } from "~/lib/desktop/native-built-in-parameter-mapper";
import { getEffectTiming } from "@daw-browser/audio-engine/effects/timing";
import { replaceEqualDeep } from "@tanstack/solid-query";
import type { LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot";
import type { Track } from "@daw-browser/timeline-core/types";
import type { NativeHostTransport, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire";
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision";
import { compileLivePlaybackSnapshot } from "~/lib/live-playback-snapshot";
import { nativePlaybackFaultText } from "~/lib/desktop/native-playback-controller";
import type { ExportEffectsProjection } from "~/lib/export/export-effect-rows";
import { observeCalls } from "./device-control-cost-spy";
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { pickNativePlaybackInputs } from "~/components/timeline/native-playback-inputs";
import type { NativeProcessorPatchReply } from "~/types/desktop-bridge";
import { mountStep5Playback, settleStep5Playback } from "./b5c-playback-witness-support";
import { resolveDesiredPlaybackFx } from "~/lib/export/run-export-job";
import { createParameterGestureOwner } from "~/components/timeline/parameter-gesture-owner";

const root = resolve(import.meta.dir, "../..");
// Runs only through tools/acceptance/device-control-cost.ts, which sets the raw directory; plain `bun test` skips it.
const measuring = process.env.DEVICE_COST_RAW_DIR !== undefined;
const rawDir = process.env.DEVICE_COST_RAW_DIR ?? "/tmp/device-control-cost-raw";

const recordSchema = z.looseObject({
  device: z.string(),
  engine: z.enum(["legacy", "native"]),
  gesture: z.string(),
  cadence: z.string(),
  applicable: z.boolean(),
  layer: z.literal("dom"),
});

// ───────────────────────── Part A: Chromium ─────────────────────────

const fixtureHtml = async (fixture: "cost" | "engine" = "cost") => {
  const runtime = `${root}/tools/acceptance/${fixture === "cost"
    ? "device-control-cost.browser-runtime.tsx" : "dv01-engine-witnesses.browser-runtime.ts"}`;
  const result = await build({
    root,
    logLevel: "error",
    configFile: false,
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.VITE_CONVEX_URL": '"https://fixture.convex.cloud"',
      "import.meta.env.BASE_URL": JSON.stringify(`file://${root}/public/`),
    },
    plugins: [solidPlugin(), tailwindcss(), {
      name: "device-cost-cloud-stubs",
      enforce: "pre",
      resolveId: (id, importer) => fixture === "engine" && importer?.endsWith("/live-mixer-runtime.ts") && id === "./effects/compressor-chain-state"
        ? "\0dv01-observed-compressor" : undefined,
      load(id) {
        if (id === "\0dv01-observed-compressor") return `export { observeCompressorChainState as createCompressorChainState } from ${JSON.stringify(`${root}/tools/acceptance/dv01-engine-witnesses.browser-runtime.ts`)}`;
        if (id === `${root}/src/lib/auth-client.ts`) {
          return "export const authClient = { getSession: async () => ({ data: null }), signOut: async () => undefined };";
        }
        // Local project only: keep cloud I/O disconnected.
        if (id === `${root}/src/lib/convex.ts`) {
          return `
            export { api as convexApi } from ${JSON.stringify(`${root}/convex/_generated/api.js`)};
            export const convexClient = { mutation: async () => { throw new Error("Cloud mutation in local fixture") }, query: async () => undefined };
            export const useConvexQuery = () => ({ data: undefined, status: "success", isPending: false, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) });
          `;
        }
        return undefined;
      },
    }],
    resolve: { alias: { "~": `${root}/src` } },
    build: {
      write: false,
      minify: false,
      rollupOptions: { output: { inlineDynamicImports: true } },
      lib: { entry: runtime, formats: ["iife"], name: "deviceCostFixture" },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Expected fixture bundle.");
  const chunk = output.output.find((value) => value.type === "chunk");
  if (!chunk) throw new Error("Fixture JavaScript missing.");
  const css = output.output.flatMap((value) => value.type === "asset" && value.fileName.endsWith(".css")
    ? [z.union([z.string(), z.instanceof(Uint8Array).transform((bytes) => new TextDecoder().decode(bytes))]).parse(value.source)]
    : []).join("\n");
  return `<!doctype html><meta charset="utf-8"><style>${css}\nhtml,body{height:100%;margin:0}</style><body><script>window.bootErrors=[];window.addEventListener("error",e=>window.bootErrors.push(e.message+" "+(e.error&&e.error.stack)));window.addEventListener("unhandledrejection",e=>window.bootErrors.push(String(e.reason&&e.reason.stack||e.reason)))</script><script>${chunk.code.replaceAll("</script", "<\\/script")}</script>`;
};

test.skipIf(!measuring)("device-control-cost part A: real EffectsPanel in Chromium", async () => {
  const directory = `${process.env.DEVICE_COST_SCRATCH_DIR ?? "/tmp"}/device-control-cost-${crypto.randomUUID()}`;
  await mkdir(directory);
  await mkdir(rawDir, { recursive: true });
  await Bun.write(`${directory}/index.html`, await fixtureHtml());
  const session = `device-control-cost-${crypto.randomUUID()}`;
  const { AGENT_BROWSER_CDP: _cdp, AGENT_BROWSER_SESSION: _session, ...inherited } = process.env;
  const env = { ...inherited, AGENT_BROWSER_ALLOW_FILE_ACCESS: "1" };
  const browser = async (...args: string[]) => {
    const child = Bun.spawn(["perl", "-e", "alarm shift; exec @ARGV", "240", "agent-browser", "--session", session, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(`agent-browser ${args.join(" ")}: ${error || out}`);
    return out.trim();
  };
  const evalJson = async (expression: string) => JSON.parse(JSON.parse(
    await browser("eval", `Promise.resolve(${expression}).then(value => JSON.stringify(value ?? null))`),
  ));
  const records: unknown[] = [];
  try {
    await browser("open", `file://${directory}/index.html`);
    if (!(await evalJson("!!window.costFixture"))) throw new Error(`Fixture did not load: ${JSON.stringify(await evalJson("window.bootErrors"))}`);
    const engines: readonly ("legacy" | "native")[] = ["legacy", "native"];
    const only = (process.env.DEVICE_COST_DEVICES ?? "").split(",").filter(Boolean);
    const devices = z.array(z.string()).parse(await evalJson("costFixture.devices")).filter((device) => only.length === 0 || only.includes(device));
    for (const engine of process.env.DEVICE_COST_A8_ONLY === "1" ? [] : engines) {
      for (const device of devices) {
        // Await the page's work promise, not a wall-clock poll. One device bounds the command and result size.
        await evalJson(`costFixture.${process.env.DEVICE_COST_LIFECYCLE === "1" ? "runLifecycle" : "runMatrix"}(${JSON.stringify(engine)}, [${JSON.stringify(device)}])`);
        records.push(...z.array(z.unknown()).parse(await evalJson("costFixture.takeRecords()")));
      }
      // Typed multi-character number entry: Chromium's real keyboard, then Tab to commit the field.
      for (const device of ["drum-rack", "sampler", "granular"]) {
        const measure = { device, engine, gesture: "typed-number-64", cadence: "single" };
        const prepared = await evalJson(`costFixture.prepareTyped(${JSON.stringify(measure)})`);
        if (!z.looseObject({ prepared: z.literal(true) }).safeParse(prepared).success) {
          records.push(prepared);
          continue;
        }
        await browser("keyboard", "type", "64");
        await browser("press", "Tab");
        records.push(await evalJson("costFixture.finishTyped()"));
      }
    }
    await Bun.write(`${rawDir}/a8.json`, JSON.stringify(await evalJson("costFixture.runA8()"), null, 2));
    const callbacks = z.array(z.object({ device: z.string(), applicable: z.literal(true),
      nativeSubmitted: z.number().positive(), outcomes: z.object({ unavailable: z.number().positive(), pending: z.literal(0) }),
      consumerReads: z.array(z.number().positive()).nonempty(), synthCallbacks: z.literal(0), registryAllocations: z.literal(0),
    })).length(3).parse(await evalJson("costFixture.runPublicationCallbacks()"));
    for (const row of callbacks) if (row.consumerReads.length !== row.nativeSubmitted || row.outcomes.unavailable !== row.nativeSubmitted)
      throw new Error(`The real sampled callbacks lost a registration: ${JSON.stringify(row)}`);
    await Bun.write(`${rawDir}/publication-callbacks.json`, JSON.stringify(callbacks, null, 2));
    // The accepted E controls verify that a successful promise is not silently counted as a new application.
    // Reuse the existing real-AudioContext runtime on a separate page so its node recorders never affect DP.
    await Bun.write(`${directory}/engine.html`, await fixtureHtml("engine"));
    await browser("open", `file://${directory}/engine.html`);
    const names = z.array(z.string()).parse(await evalJson("engineRows.names"));
    const engineRows = [];
    const engineRow = z.looseObject({
      row: z.string(),
      checks: z.array(z.object({ name: z.string(), pass: z.boolean(), expected: z.string(), actual: z.string() })),
    });
    for (const name of names) {
      const row = engineRow.parse(await evalJson(`engineRows.run(${JSON.stringify(name)})`));
      const failures = row.checks.filter(check => !check.pass);
      if (failures.length > 0) throw new Error(`Engine control ${name}: ${JSON.stringify(failures)}`);
      engineRows.push(row);
    }
    await Bun.write(`${rawDir}/engine-controls.json`, JSON.stringify(engineRows, null, 2));
    await Bun.write(`${rawDir}/part-a.json`, JSON.stringify(records.map((record) => recordSchema.parse(record)), null, 2));
  } finally {
    await Bun.write(`${rawDir}/part-a-partial.json`, JSON.stringify(records, null, 1));
    await browser("close").catch(() => undefined);
  }
}, 3_600_000);
// ───────────────────────── Part B: useTimelinePlayback over a fake native host ─────────────────────────

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 4 / 48_000;
  readonly length = 4;
  readonly numberOfChannels = 1;
  readonly sampleRate = 48_000;
  private readonly channel = new Float32Array(4);
  copyFromChannel(destination: Float32Array) { destination.set(this.channel.subarray(0, destination.length)); }
  copyToChannel(source: Float32Array) { this.channel.set(source.subarray(0, this.channel.length)); }
  getChannelData() { return this.channel; }
}

// The capture carries the final live value into later structural work, a cold
// rebuild and the export read. No independent param() compiler shortcut.
for (const scenario of ["B15-lookahead", "B26a-cutoff", "B27b-automated-live", "B29a-clip", "B29b-cold", "B29c-export"]) {
  for (const transport of scenario.startsWith("B29") ? ["playing"] : ["playing", "paused"]) {
    test(`STEP5 ${scenario} ${transport} captured live boundary`, async () => {
      const synth: TrackInstrumentParams = { kind: "synth", instanceId: "synth-live", params: createDefaultSynthParams() };
      const compressor = createDefaultCompressorParams();
      const payload: NativeBuiltInParameterPayload = scenario === "B15-lookahead"
        ? { targetId: "track-audio", instanceId: "fx-compressor", effect: "compressor", from: compressor, to: { ...compressor, lookaheadMs: 5 } }
        : scenario === "B26a-cutoff"
          ? { targetId: "track-audio", effect: "instrument", from: synth,
            to: { ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: 1000 } } } }
          : { targetId: "track-audio", instanceId: "fx-delay", effect: "delay", from: delayAt(0), to: delayAt(20) };
      const projection = (next: boolean): ExportEffectsProjection => payload.effect === "instrument"
        ? instrumentProjection(next ? payload.to : payload.from)
        : payload.effect === "compressor" ? { replaceAudioEffectTargets: [{ targetId: "track-audio",
          rows: [{ targetId: "track-audio", effect: "compressor", instanceId: "fx-compressor", index: 0,
            params: next ? payload.to : payload.from }] }], upsertDeviceRows: [] } : projectionFor(next ? 20 : 0);
      const [edited, setEdited] = createSignal(false);
      const [clipStart, setClipStart] = createSignal(0);
      const buffer = new TestAudioBuffer();
      const tracks = (): Track<AudioBuffer>[] => [{ id: "track-audio", name: "Track", volume: 1,
        clips: [{ id: "clip-audio", name: "Clip", startSec: clipStart(), duration: 1, color: "#fff",
          sourceAssetKey: "asset-audio", buffer }] }];
      const target: AutomationEnvelope["target"] = { kind: "track", trackId: "track-audio", effectInstanceId: "fx-delay" };
      const automation: AutomationEnvelope[] = scenario === "B27b-automated-live" ? [{
        id: "lane", projectId: "step5", target, targetKey: automationTargetKey(target, "delay.dryWet"),
        parameterId: "delay.dryWet", enabled: true, updatedAt: 1,
        points: [{ id: "p", timeSec: 0, value: 0.2, interpolation: "hold" }],
      }] : [];
      const inputs = () => ({ canonical: { automationEnvelopes: automation }, masterVolume: 1,
        effects: projection(edited()), automation: [], sidechains: [] });
      const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
        { masterVolume: 1, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
      const renderState = async (captured: ReturnType<typeof inputs>) => ({ fx: fx(captured), automationEnvelopes: captured.canonical.automationEnvelopes });
      const f = await mountStep5Playback({ projectId: `step5-${scenario}-${transport}`, tracks,
        playbackInputs: inputs, desiredFx: fx, renderState });
      try {
        if (transport === "playing") await f.playback.handlePlay(untrack(tracks));
        await settleStep5Playback();
        const before = f.mark();
        const edit = f.processorEdits.allocate(payload);
        if (!edit) throw new Error("Missing live identity");
        if (payload.effect === "compressor") {
          expect(getEffectTiming({ kind: "compressor", params: payload.to }, 48_000).latencyFrames)
            .toBe(getEffectTiming({ kind: "compressor", params: payload.from }, 48_000).latencyFrames);
        }
        const result = await f.playback.deliverProcessor(edit).settled;
        setEdited(true);
        await f.frame();
        const liveCounts = f.counts(before);
        expect(result).toEqual({ state: "applied" });
        expect(f.host.appliedParameters.size).toBeGreaterThan(0);
        if (scenario.startsWith("B29")) {
          const beforeStructural = f.mark();
          if (scenario === "B29a-clip") { setClipStart(0.25); await f.frame(); }
          if (scenario === "B29b-cold") await f.playback.restartTimelineSchedule(untrack(tracks), { rebuildBackend: true, resumePlayback: false });
          const fresh = await renderState(untrack(inputs));
          expect(fresh.fx.trackFx?.["track-audio"]?.instances[0]?.params).toEqual(delayAt(20));
          if (scenario !== "B29c-export") expect(f.compilations.at(-1)?.renderState.fx).toEqual(fresh.fx);
          console.log("STEP5 retained live", JSON.stringify({ scenario, liveCounts, structuralCounts: f.counts(beforeStructural) }));
          if (scenario !== "B29c-export") {
            const structural = f.counts(beforeStructural);
            expect(structural.scheduleCompiles).toBe(1);
            expect(structural.previewCompiles).toBe(scenario === "B29b-cold" ? 1 : 0);
            expect(f.counts(beforeStructural).publishes).toBe(scenario === "B29a-clip" ? 1 : 0);
          }
        } else console.log("STEP5 captured live", JSON.stringify({ scenario, transport, counts: liveCounts, result }));
        expect(f.faults).toEqual([]);
        expect(liveCounts).toEqual({ scheduleCompiles: 0, previewCompiles: 0, publishes: 0,
          teardowns: 0, liveSends: 1, previewDisposals: 0 });
      } finally { await f.close(); }
    });
  }
}

const nativeTransactionToken = "native-playback-transaction-token-000000000";
const flushMicrotasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const settle = async () => { for (let index = 0; index < 40; index += 1) await flushMicrotasks(); };

// Every call that reaches the fake host is named in `calls`, so work is counted at the host boundary.
const createFakeHost = () => {
  const calls: string[] = [];
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>();
  const acceptedFrames = new Map<number, bigint>();
  let runtimeRevision = 1;
  let progressSequence = 0n;
  let appliedProcessorSequence = 0n;
  const appliedParameters = new Map<string, number>();
  let transport = { epoch: 1, frame: 0, running: false, transitionId: 0n };
  type Accepted = { ok: true };
  const accepted: Accepted = { ok: true };
  const ok = (name: string) => async () => {
    calls.push(name);
    if (name === "begin") return { ...accepted, transactionToken: nativeTransactionToken };
    return accepted;
  };
  const emitProgress = () => {
    progressSequence++;
    for (const listener of progressListeners) {
      listener({
        revision: runtimeRevision, epoch: transport.epoch, progressSequence, renderedThroughFrame: BigInt(transport.frame),
        acceptedThroughFrame: acceptedFrames.get(transport.epoch) ?? BigInt(transport.frame + 1), lastAcceptedWindowId: 1n,
        appliedTransportTransitionId: transport.transitionId, appliedUrgentSequence: 0n, appliedProcessorSequence,
        running: transport.running, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
      });
    }
  };
  let revision = 1;
  let activeRevision = 1;
  let seam = 0n;
  let status: "prepared" | "published" = "prepared";
  const reply = async (): Promise<NativeRevisionReply> => ({
    ok: true, hostPid: 123, hostGeneration: 7,
    revision: {
      status, continuity: "accepted", requestedRevision: revision, activeRevision,
      preparedRevision: status === "prepared" ? revision : 0, retiredRevision: 0, renderEpoch: 1n,
      transportEpoch: transport.epoch, publicationFrame: status === "published" ? seam : 0n, progressFrame: 0n,
    },
  });
  const revisions: NativeRevisionSession = {
    prepare: async (request) => { calls.push("revision.prepare"); revision++; seam = request.requestedPublicationFrame ?? 0n; status = "prepared"; return reply(); },
    publish: async () => { calls.push("revision.publish"); status = "published"; activeRevision = revision; runtimeRevision = revision; return reply(); },
    inspect: async () => { calls.push("revision.inspect"); return reply(); },
    rollback: async () => { calls.push("revision.rollback"); return reply(); },
    retire: async () => { calls.push("revision.retire"); return reply(); },
  };
  const session = {
    configure: async () => { calls.push("configure"); return { ...accepted, hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } }; },
    beginTransaction: ok("begin"),
    commitTransaction: ok("commit"),
    rollbackTransaction: ok("rollback"),
    installAsset: ok("install"),
    releaseAsset: ok("release"),
    publishGraph: (bytes: Uint8Array) => {
      runtimeRevision = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, false));
      return ok("graph")();
    },
    createMappedAsset: ok("install"),
    writeMappedAssetPage: ok("write-page"),
    prepareMappedAssetRange: ok("prepare-range"),
    coordinateVstAttachments: ok("coordinate"),
    queueParameterEvents: async (bytes: Uint8Array) => {
      calls.push("queueParameterEvents");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getUint32(4, true)).toBe(runtimeRevision);
      expect(view.getUint32(8, true)).toBe(transport.epoch);
      for (let index = 0; index < view.getUint32(0, true); index++) {
        const offset = 20 + index * 20;
        appliedParameters.set(`${view.getUint32(offset, true)}:${view.getUint32(offset + 8, true)}`, view.getFloat32(offset + 16, true));
      }
      appliedProcessorSequence = view.getBigUint64(12, true);
      queueMicrotask(emitProgress);
      return accepted;
    },
    queueInstrumentEvents: ok("instrument"),
    queueSourceEvents: ok("source"),
    queueProcessorStatePatch: async () => {
      calls.push("queueProcessorStatePatch");
      return { ok: true, outcome: "applied" } satisfies NativeProcessorPatchReply;
    },
    queueScheduleWindow: (bytes: Uint8Array) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      acceptedFrames.set(view.getUint32(4, true), view.getBigUint64(24, true));
      queueMicrotask(emitProgress);
      return ok("schedule")();
    },
    setTransport: async (next: NativeHostTransport) => {
      transport = { ...next, transitionId: next.transitionId ?? 0n };
      calls.push("transport");
      progressSequence += 1n;
      queueMicrotask(() => {
        for (const listener of progressListeners) {
          listener({
            revision: runtimeRevision, epoch: next.epoch, progressSequence, renderedThroughFrame: BigInt(next.frame),
            acceptedThroughFrame: acceptedFrames.get(next.epoch) ?? BigInt(next.frame + 1), lastAcceptedWindowId: 1n,
            appliedTransportTransitionId: next.transitionId ?? progressSequence, appliedUrgentSequence: 0n, appliedProcessorSequence,
            running: next.running, scheduleComplete: false, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256,
          });
        }
      });
      return accepted;
    },
    configureRecording: ok("recording-configure"),
    startRecording: ok("recording-start"),
    stopRecording: ok("recording-stop"),
    cancelRecording: ok("recording-cancel"),
    start: ok("start"),
    stop: ok("stop"),
    teardown: ok("teardown"),
    configureInstrumentStates: async () => { calls.push("configureInstrumentStates"); return accepted; },
    revisions,
    onLoss: () => () => undefined,
    onRecordingBlock: () => () => undefined,
    onRecordingStatus: () => () => undefined,
    onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
      progressListeners.add(listener);
      return () => { progressListeners.delete(listener); };
    },
  };
  type DefaultDeviceId = "coreaudio:default";
  const defaultDeviceId: DefaultDeviceId = "coreaudio:default";
  const audioHost = {
    resolveOutputDevice: async () => ({
      ...accepted,
      device: { deviceId: defaultDeviceId, name: "Default", nominalSampleRateHz: 48_000, outputChannelCount: 2, maximumFramesPerBlock: 512, available: true },
    }),
    resolveInputDevice: async () => ({ ...accepted, device: null }),
    session,
  };
  return { calls, audioHost, appliedParameters, epoch: () => transport.epoch };
};

type ControllerLog = { counts: Map<string, number>; disposeReasons: string[]; previewResults: string[] };
const observeController = <Target extends object>(target: Target, log: ControllerLog): Target => observeCalls(target, {
  call: ({ name, property, reason }) => {
    if (!/^(is|has|read|get)[A-Z]/u.test(property)) log.counts.set(name, (log.counts.get(name) ?? 0) + 1);
    if (property === "dispose" && reason !== undefined) log.disposeReasons.push(reason);
  },
  result: (property, outcome) => {
    if (property === "ensureLivePreview") outcome.then((value) => { log.previewResults.push(String(value)); }, () => undefined);
  },
});

type PartBSpec = {
  id: string;
  transport: "playing" | "paused";
  edits: number;
  kind: "param-change" | "new-identity-same-content" | "state-patch-api";
  pacing: "one-edit-per-frame" | "single-edit";
};

// useTimelinePlayback imports createNativePlaybackController statically, so the observing wrapper is installed
// once and writes into whichever log the running scenario owns. The real controller still runs underneath.
let activeLog: ControllerLog = { counts: new Map(), disposeReasons: [], previewResults: [] };
let controllerSpyInstalled = false;
const installControllerSpy = async () => {
  if (controllerSpyInstalled) return;
  controllerSpyInstalled = true;
  const controllerPath = `${root}/src/lib/desktop/native-playback-controller.ts`;
  const actual = { ...(await import(controllerPath)) };
  const forward: ControllerLog = {
    get counts() { return activeLog.counts; },
    get disposeReasons() { return activeLog.disposeReasons; },
    get previewResults() { return activeLog.previewResults; },
  };
  mock.module(controllerPath, () => ({
    ...actual,
    createNativePlaybackController: (...args: unknown[]) => observeController(actual.createNativePlaybackController(...args), forward),
  }));
};

const delayAt = (step: number): DelayParams => ({ ...createDefaultDelayParams(), dryWet: 0.2 + step * 0.01 });
const projectionFor = (step: number): ExportEffectsProjection => ({
  replaceAudioEffectTargets: [{
    targetId: "track-audio",
    rows: [{ targetId: "track-audio", instanceId: "fx-delay", index: 0, effect: "delay", params: delayAt(step) }],
  }],
  upsertDeviceRows: [],
  clearInstrumentTargets: [],
});

const runPartBScenario = async (spec: PartBSpec) => {
  const { mapNativeBuiltInParameterCommit } = await import("~/lib/desktop/native-built-in-parameter-mapper");
  await installControllerSpy();
  const log: ControllerLog = { counts: new Map(), disposeReasons: [], previewResults: [] };
  activeLog = log;
  const { useTimelinePlayback } = await import("~/hooks/useTimelinePlayback");

  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer");
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: TestAudioBuffer });
  const rafQueue: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = (callback) => { rafQueue.push(callback); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => undefined;
  const stepRaf = () => { const callback = rafQueue.shift(); if (callback) callback(0); };

  const host = createFakeHost();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: host.audioHost } } });
  const track: Track<AudioBuffer> = {
    id: "track-audio", name: "Audio", volume: 1,
    clips: [{ id: "clip-audio", name: "Audio clip", startSec: 0, duration: 1, color: "#fff", sourceAssetKey: "asset-audio", buffer: new TestAudioBuffer() }],
  };
  const [param, setParam] = createSignal(0);
  const [identityBump, setIdentityBump] = createSignal(0);
  let compiles = 0;
  let supported = true;
  const faults: string[] = [];
  let dispose: () => void = () => undefined;
  try {
    const engine = {
      currentTimelineSec: 0, ensureAudio: () => undefined, applyAutomationAtTimelineSec: () => undefined, cancelAutomationSchedules: () => undefined,
      onTransportPause: () => undefined, onTransportSeek: () => undefined, onTransportStart: () => undefined, onTransportStop: () => undefined,
      resume: async () => undefined, rescheduleClipsAtPlayhead: () => ({ deferredStretchWindows: [] }),
      scheduleAllClipsFromPlayhead: () => ({ deferredStretchWindows: [] }), scheduleAutomationFromPlayhead: () => undefined,
      stopAllSources: () => undefined, subscribeStretchRenderState: () => () => true,
    } satisfies Parameters<typeof useTimelinePlayback>[0];
    const playback = createRoot((cleanup) => {
      dispose = cleanup;
      const processorEdits = createProcessorEditRegistry(() => 120);
      const capturedInputs = createMemo(() => {
        identityBump();
        return { masterVolume: 1, effects: projectionFor(param()), automation: [], sidechains: [] };
      });
      createComputed(() => {
        const captured = capturedInputs();
        const fx = resolveDesiredPlaybackFx({ masterVolume: 1, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
        untrack(() => processorEdits.observe(fx));
      });
      const playbackInputs = createMemo(() => {
        const captured = capturedInputs();
        return pickNativePlaybackInputs({ timeSignature: { numerator: 4, denominator: 4 }, automationEnvelopes: [],
          masterVolume: captured.masterVolume, automation: captured.automation, sidechains: captured.sidechains,
          processorStructure: processorEdits.structure() });
      }, undefined, { equals: (previous, next) => replaceEqualDeep(previous, next) === previous });
      return useTimelinePlayback(engine, { getTracks: () => [track] }, {
        requiresNativeAudio: true, enabled: () => true, projectId: () => "project", playbackInputs,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        compileSnapshot: async (transport) => {
          compiles++;
          const captured = capturedInputs();
          const compiled = compileLivePlaybackSnapshot({
            revision: 1, bpm: 120, transport, tracks: [track],
            renderState: {
              fx: resolveDesiredPlaybackFx({ masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined),
              automationEnvelopes: [],
            },
            sidechainRoutes: [],
          });
          supported = compiled.supported;
          return compiled;
        },
      });
    });
    await settle();
    if (spec.transport === "playing") {
      await playback.handlePlay([track]);
      await settle();
    } else {
      for (let index = 0; index < 4; index++) { stepRaf(); await settle(); }
    }
    const preparedBeforeEdits = playback.isPlaying() ? "playing" : "paused";
    const hostBefore = host.calls.length;
    const compilesBefore = compiles;
    log.counts.clear();
    log.disposeReasons.length = 0;
    log.previewResults.length = 0;
    const patchResults: string[] = [];
    let mappedValueCount = 0;
    for (let step = 1; step <= spec.edits; step++) {
      if (spec.kind === "param-change") setParam(step);
      else if (spec.kind === "new-identity-same-content") setIdentityBump((value) => value + 1);
      else {
        // Allocate the whole edit, register delivery, and check its applied proof.
        const mapped = mapNativeBuiltInParameterCommit({ targetId: "track-audio", effect: "delay", instanceId: "fx-delay", from: delayAt(step - 1), to: delayAt(step) }, 120);
        mappedValueCount = mapped?.values.length ?? 0;
        const edit = createProcessorEditRegistry(() => 120).allocate({ targetId: "track-audio", effect: "delay", instanceId: "fx-delay", from: delayAt(step - 1), to: delayAt(step) });
        if (mapped && edit) {
          patchResults.push(JSON.stringify(await playback.deliverProcessor({ ...edit, order: step, id: `delay-${step}` }).settled));
          expect([...host.appliedParameters.values()]).toEqual([Math.fround(delayAt(step).dryWet)]);
        }
        else patchResults.push("unmapped");
      }
      await settle();
      if (spec.pacing === "one-edit-per-frame") { stepRaf(); await settle(); }
    }
    await settle();
    const hostDelta = host.calls.slice(hostBefore);
    const tally = (names: readonly string[]) => Object.fromEntries(names.map((name) => [name, hostDelta.filter((call) => call === name).length]));
    return {
      id: spec.id, transport: spec.transport, edits: spec.edits, kind: spec.kind, pacing: spec.pacing,
      stateBeforeEdits: preparedBeforeEdits, compileSupported: supported,
      compileSnapshotCalls: compiles - compilesBefore,
      scheduleWork: tally(["revision.prepare", "revision.publish", "graph", "schedule", "begin", "commit", "install", "transport", "start", "stop", "teardown"]),
      hostCallsDuringEdits: hostDelta.length,
      previewDisposals: log.disposeReasons.length,
      previewDisposalReasons: [...log.disposeReasons],
      previewEnsureResults: [...log.previewResults],
      controllerCalls: Object.fromEntries([...log.counts].sort(([left], [right]) => left.localeCompare(right))),
      faults,
      mappedValueCount,
      livePreviewResults: [...new Set(patchResults)].sort(),
    };
  } finally {
    dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousBuffer) Object.defineProperty(globalThis, "AudioBuffer", previousBuffer); else Reflect.deleteProperty(globalThis, "AudioBuffer");
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  }
};

const partBSpecs: PartBSpec[] = [
  { id: "playing-1-edit", transport: "playing", edits: 1, kind: "param-change", pacing: "single-edit" },
  { id: "playing-20-edits-one-per-frame", transport: "playing", edits: 20, kind: "param-change", pacing: "one-edit-per-frame" },
  { id: "paused-preview-1-edit", transport: "paused", edits: 1, kind: "param-change", pacing: "single-edit" },
  { id: "paused-preview-20-edits-one-per-frame", transport: "paused", edits: 20, kind: "param-change", pacing: "one-edit-per-frame" },
  { id: "control-playing-identity-only", transport: "playing", edits: 1, kind: "new-identity-same-content", pacing: "single-edit" },
  { id: "playing-20-live-processor-previews", transport: "playing", edits: 20, kind: "state-patch-api", pacing: "one-edit-per-frame" },
];

// Failures: membership, order, enabled and unsupported fields may lose their
// schedule carrier. Resolve captured projections, never synthetic counters.
const step5StructuralSpecs: { id: string; from: ExportEffectsProjection; to: ExportEffectsProjection }[] = [
  { id: "B16a-add", from: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [] }], upsertDeviceRows: [] }, to: projectionFor(0) },
  { id: "B16b-remove-last", from: projectionFor(0), to: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [] }], upsertDeviceRows: [] } },
  { id: "B17-reorder",
    from: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-delay", index: 0, effect: "delay", params: delayAt(0) },
      { targetId: "track-audio", instanceId: "fx-delay-2", index: 1, effect: "delay", params: delayAt(2) },
    ] }], upsertDeviceRows: [] },
    to: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-delay-2", index: 0, effect: "delay", params: delayAt(2) },
      { targetId: "track-audio", instanceId: "fx-delay", index: 1, effect: "delay", params: delayAt(0) },
    ] }], upsertDeviceRows: [] } },
  { id: "B18-enabled", from: projectionFor(0), to: {
    replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-delay", index: 0, effect: "delay", params: { ...delayAt(0), enabled: false } },
    ] }], upsertDeviceRows: [] } },
  { id: "B20a-pingPong", from: projectionFor(0), to: {
    replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-delay", index: 0, effect: "delay", params: { ...delayAt(0), pingPong: !delayAt(0).pingPong } },
    ] }], upsertDeviceRows: [] } },
  { id: "B20b-fftSize",
    from: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-spectral", index: 0, effect: "spectral", params: { version: 1, state: createDefaultSpectralParams() } },
    ] }], upsertDeviceRows: [] },
    to: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-spectral", index: 0, effect: "spectral", params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize: 4096 } } },
    ] }], upsertDeviceRows: [] } },
  { id: "B21-eq-band-type",
    from: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-eq", index: 0, effect: "eq", params: createDefaultEqParams() },
    ] }], upsertDeviceRows: [] },
    to: { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [
      { targetId: "track-audio", instanceId: "fx-eq", index: 0, effect: "eq", params: {
        ...createDefaultEqParams(), bands: createDefaultEqParams().bands.map((band, index) => index === 0 ? { ...band, type: "highpass" } : band),
      } },
    ] }], upsertDeviceRows: [] } },
];
const instrumentProjection = (instrument: TrackInstrumentParams): ExportEffectsProjection => ({
  replaceAudioEffectTargets: [], upsertDeviceRows: [{ targetId: "track-audio", effect: "instrument", params: instrument }],
});
const step5Synth: TrackInstrumentParams = { kind: "synth", instanceId: "synth-step5", params: createDefaultSynthParams() };
const step5Drum = createDefaultDrumRackParams();
const step5Sampler = createDefaultSamplerParams();
const step5Granular = createDefaultGranularParams();
step5StructuralSpecs.push(
  { id: "B22-drum-pad",
    from: instrumentProjection({ kind: "drum-rack", instanceId: "drum-step5", params: step5Drum }),
    to: instrumentProjection({ kind: "drum-rack", instanceId: "drum-step5",
      params: { ...step5Drum, pads: step5Drum.pads.map((pad, index) => index === 0 ? { ...pad, transpose: 12 } : pad) } }) },
  { id: "B23-sampler-polyphony",
    from: instrumentProjection({ kind: "sampler", instanceId: "sampler-step5", params: step5Sampler }),
    to: instrumentProjection({ kind: "sampler", instanceId: "sampler-step5", params: { ...step5Sampler, polyphony: 8 } }) },
  { id: "B24-granular",
    from: instrumentProjection({ kind: "granular", instanceId: "granular-step5", params: step5Granular }),
    to: instrumentProjection({ kind: "granular", instanceId: "granular-step5", params: { ...step5Granular, position: 0.25 } }) },
  { id: "B26b-waveform", from: instrumentProjection(step5Synth),
    to: instrumentProjection({ ...step5Synth, params: { ...step5Synth.params,
      oscillators: [{ ...step5Synth.params.oscillators[0], wave: "square" }, step5Synth.params.oscillators[1]] } }) },
  { id: "B26-polyphony", from: instrumentProjection(step5Synth),
    to: instrumentProjection({ ...step5Synth, params: { ...step5Synth.params, polyphony: 8 } }) },
  { id: "B26-retrigger", from: instrumentProjection(step5Synth),
    to: instrumentProjection({ ...step5Synth, params: { ...step5Synth.params, retrigger: !step5Synth.params.retrigger } }) },
  { id: "B26-instrument-replacement", from: instrumentProjection(step5Synth),
    to: instrumentProjection({ ...step5Synth, instanceId: "synth-replacement" }) },
);
for (const spec of step5StructuralSpecs) {
  for (const transport of ["playing", "paused"]) {
    test(`STEP5 ${spec.id} ${transport} structural guard`, async () => {
      const track: Track<AudioBuffer> = { id: "track-audio", name: "Audio", volume: 1, clips: [] };
      const [projection, setProjection] = createSignal(spec.from);
      const inputs = () => ({ canonical: undefined, local: undefined, masterVolume: 1, effects: projection(), automation: [], sidechains: [] });
      const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
        { masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined,
      );
      const f = await mountStep5Playback({ projectId: `step5-${spec.id}-${transport}`, tracks: () => [track],
        playbackInputs: inputs, desiredFx: fx, renderState: async captured => ({ fx: fx(captured), automationEnvelopes: [] }) });
      try {
        if (transport === "playing") await f.playback.handlePlay([track]);
        await settleStep5Playback();
        const before = f.mark();
        setProjection(spec.to);
        await f.frame();
        await f.playback.awaitPlaybackPreparation();
        await settleStep5Playback();
        const counts = f.counts(before);
        console.log("STEP5 structural guard", JSON.stringify({ id: spec.id, transport, counts, faults: f.faults }));
        expect(f.faults).toEqual([]);
        // A paused structural edit is adopted in place exactly like a playing one (D7): one schedule compile and one
        // publication on the kept session, no preview compile, dispose, teardown, or host restart.
        expect(counts.scheduleCompiles).toBe(1);
        expect(counts.publishes).toBe(1);
        expect(counts.previewCompiles).toBe(0);
        expect(counts.previewDisposals).toBe(0);
        expect(counts.teardowns).toBe(0);
        expect(counts.liveSends).toBe(0);
        expect(f.host.calls.slice(before.calls).filter(call => ["begin", "configure", "start", "stop", "teardown"].includes(call))).toEqual([]);
        expect(f.playback.isNativePlaybackPrepared()).toBe(true);
        expect(f.compilations.at(-1)?.renderState.fx).toEqual(untrack(() => fx(inputs())));
      } finally { await f.close(); }
    });
  }
}

test.skipIf(isServer || !measuring)("device-control-cost part B: processor-only edit through useTimelinePlayback", async () => {
  await mkdir(rawDir, { recursive: true });
  const cases = [];
  for (const spec of partBSpecs) {
    const row = await runPartBScenario(spec);
    if (spec.kind === "state-patch-api" && (row.livePreviewResults.join() !== '{"state":"applied"}'
      || row.faults.length || row.hostCallsDuringEdits !== spec.edits))
      throw new Error(`Actual Part-B parameter application/proof failed: ${JSON.stringify(row)}`);
    cases.push(row);
  }
  await Bun.write(`${rawDir}/part-b.json`, JSON.stringify(cases, null, 2));
}, 120_000);

// STEP5 failure inventory: broad raw metadata and mapper-live projection
// echoes request schedule work; paused echoes dispose a valid preview.
// These rows deliberately do not change the six durable DP measurements.
const step5LiveSpecs = [
  { id: "B1", transport: "playing", edits: 1, metadata: false },
  { id: "B2", transport: "playing", edits: 20, metadata: false },
  { id: "B3", transport: "paused", edits: 1, metadata: false },
  { id: "B4-B31", transport: "paused", edits: 20, metadata: false },
  { id: "B6", transport: "playing", edits: 20, metadata: false },
  { id: "B7-live", transport: "playing", edits: 20, metadata: true },
];
for (const spec of step5LiveSpecs) {
  test(`STEP5 ${spec.id} ${spec.transport} owner delivery and projection echo`, async () => {
    const track: Track<AudioBuffer> = {
      id: "track-audio", name: "Audio", volume: 1,
      clips: [{ id: "clip-audio", name: "Audio", startSec: 0, duration: 1, color: "#fff", sourceAssetKey: "asset-audio", buffer: new TestAudioBuffer() }],
    };
    const [projection, setProjection] = createSignal(projectionFor(0));
    const [revision, setRevision] = createSignal(1);
    const inputs = () => ({
      canonical: { project: { revision: revision(), updatedAt: revision(), name: `Project ${revision()}` } },
      local: undefined, masterVolume: 1, effects: projection(), automation: [], sidechains: [],
    });
    const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
      { masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined,
    );
    const f = await mountStep5Playback({
      projectId: `step5-${spec.id}`, tracks: () => [track], playbackInputs: inputs, desiredFx: fx,
      renderState: async captured => ({ fx: fx(captured), automationEnvelopes: [] }),
    });
    let disposeOwner = () => {};
    const registrations: ReturnType<typeof f.playback.deliverProcessor>[] = [];
    const errors: unknown[] = [];
    let persisted = delayAt(0);
    const owner = createRoot(dispose => {
      disposeOwner = dispose;
      return createParameterGestureOwner<string, DelayParams>({
        key: target => target, scope: () => ({ projectId: `step5-${spec.id}`, generation: 0 }),
        exists: () => true, canWrite: () => true,
        equal: (_target, a, b) => JSON.stringify(a) === JSON.stringify(b),
        initial: () => delayAt(0), committed: () => persisted,
        apply: (_target, params) => {
          setProjection({ replaceAudioEffectTargets: [{ targetId: track.id,
            rows: [{ targetId: track.id, instanceId: "fx-delay", index: 0, effect: "delay", params }] }],
          upsertDeviceRows: [], clearInstrumentTargets: [] });
          return "skipped";
        },
        allocateEdit: (targetId, from, to) => f.processorEdits.allocate({
          targetId, effect: "delay", instanceId: "fx-delay", from: from ?? persisted, to,
        }),
        registerDelivery: (_target, _params, edit, gesture) => {
          if (!edit) throw new Error("Missing real owner edit");
          const registration = f.playback.deliverProcessor(edit, gesture);
          registrations.push(registration);
          return registration;
        },
        persist: async record => { persisted = record.latest; return { kind: "committed-unordered" }; },
        history: () => undefined, onError: (_stage, cause) => { errors.push(cause); },
      });
    });
    try {
      if (spec.transport === "playing") await f.playback.handlePlay([track]);
      await settleStep5Playback();
      const before = f.mark();
      for (let step = 1; step <= spec.edits; step++) {
        owner.set(track.id, delayAt(step));
        await owner.flushPending();
        await settleStep5Playback();
        if (spec.metadata) setRevision(step + 1);
        // Advance one explicit frame per input, including preview maintenance.
        await f.frame();
        await f.playback.awaitPlaybackPreparation();
      }
      const outcomes = await Promise.all(registrations.map(row => row.settled));
      const counts = f.counts(before);
      console.log("STEP5 live witness", JSON.stringify({ id: spec.id, transport: spec.transport, counts,
        outcomes, epoch: f.host.epoch(), applied: [...f.host.appliedParameters.values()], playing: f.playback.isPlaying(), errors }));
      expect(errors).toEqual([]);
      expect(f.faults).toEqual([]);
      expect(persisted).toEqual(delayAt(spec.edits));
      expect(owner.effective(track.id)).toEqual(delayAt(spec.edits));
      expect(outcomes).toEqual(Array.from({ length: spec.edits }, () => ({ state: "applied" })));
      expect([...f.host.appliedParameters.values()]).toEqual([Math.fround(delayAt(spec.edits).dryWet)]);
      expect(f.playback.isPlaying()).toBe(spec.transport === "playing");
      expect(counts).toEqual({
        scheduleCompiles: 0, previewCompiles: 0, publishes: 0, teardowns: 0,
        liveSends: spec.edits, previewDisposals: 0,
      });
    } finally { disposeOwner(); await f.close(); }
  });
}

for (const kind of ["identical", "metadata"]) {
  test(`STEP5 ${kind === "identical" ? "B5" : "B7-bookkeeping"} captured input control`, async () => {
    const track: Track<AudioBuffer> = { id: "track-audio", name: "Audio", volume: 1, clips: [] };
    const [revision, setRevision] = createSignal(1);
    const inputs = () => ({
      canonical: { project: { revision: kind === "metadata" ? revision() : (revision(), 1), updatedAt: kind === "metadata" ? revision() : 1, name: "Fixture" } },
      local: undefined, masterVolume: 1, effects: projectionFor(0), automation: [], sidechains: [],
    });
    const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
      { masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined,
    );
    const f = await mountStep5Playback({ projectId: `step5-${kind}`, tracks: () => [track],
      playbackInputs: inputs, desiredFx: fx, renderState: async captured => ({ fx: fx(captured), automationEnvelopes: [] }) });
    try {
      await f.playback.handlePlay([track]);
      await settleStep5Playback();
      const before = f.mark();
      setRevision(2);
      await f.frame();
      await f.playback.awaitPlaybackPreparation();
      const counts = f.counts(before);
      console.log("STEP5 input control", JSON.stringify({ id: kind, counts }));
      expect(f.faults).toEqual([]);
      expect(counts).toEqual({ scheduleCompiles: 0, previewCompiles: 0, publishes: 0, teardowns: 0, liveSends: 0, previewDisposals: 0 });
    } finally { await f.close(); }
  });
}

// Non-FX compiler fields must keep their own identity carrier after narrowing.
for (const field of ["meter", "masterVolume", "automation", "sidechain"]) {
  for (const transport of ["playing", "paused"]) {
    test(`STEP5 ${field === "sidechain" ? "B19" : field === "automation" ? "B27a" : field} ${transport} structural guard`, async () => {
      const tracks: Track<AudioBuffer>[] = [
        { id: "track-audio", name: "Audio", volume: 1, clips: [] },
        { id: "source", name: "Source", volume: 1, clips: [] },
      ];
      const [step, setStep] = createSignal(0);
      const target: AutomationEnvelope["target"] = { kind: "track", trackId: "track-audio", effectInstanceId: "fx-delay" };
      const envelopes = (): AutomationEnvelope[] => field === "automation" ? [{
        id: "lane", projectId: "step5", target, targetKey: automationTargetKey(target, "delay.dryWet"),
        parameterId: "delay.dryWet", enabled: true, updatedAt: step(),
        points: [{ id: "point", timeSec: 0, value: 0.2 + step() * 0.1, interpolation: "hold" }],
      }] : [];
      const routes = (): LivePlaybackSnapshotInput["sidechainRoutes"] => field === "sidechain" && step() > 0
        ? [{ sourceTrackId: "source", targetTrackId: "track-audio", effectInstanceId: "fx-gate" }] : [];
      const inputs = () => ({
        canonical: { project: { timeSignatureNumerator: field === "meter" && step() > 0 ? 7 : 4, timeSignatureDenominator: 4 },
          automationEnvelopes: envelopes() },
        local: undefined, masterVolume: field === "masterVolume" ? 1 - step() * 0.1 : 1,
        effects: field === "sidechain" ? { replaceAudioEffectTargets: [{ targetId: "track-audio", rows: [{
          targetId: "track-audio", effect: "gate", instanceId: "fx-gate", index: 0,
          params: { version: 1, state: { ...createDefaultGateParams(),
            sidechain: { ...createDefaultGateParams().sidechain, enabled: true } } },
        }] }], upsertDeviceRows: [] } satisfies ExportEffectsProjection : projectionFor(0),
        automation: [], sidechains: routes(),
      });
      const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
        { masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
      const f = await mountStep5Playback({ projectId: `step5-${field}-${transport}`, tracks: () => tracks,
        playbackInputs: inputs, desiredFx: fx,
        renderState: async captured => ({ fx: fx(captured), automationEnvelopes: captured.canonical.automationEnvelopes }),
        compileInputs: captured => ({ sidechainRoutes: captured.sidechains, timeSignature: {
          numerator: captured.canonical.project.timeSignatureNumerator, denominator: captured.canonical.project.timeSignatureDenominator,
        } }),
      });
      try {
        if (transport === "playing") await f.playback.handlePlay(tracks);
        await settleStep5Playback();
        const before = f.mark();
        setStep(1);
        await f.frame();
        await f.playback.awaitPlaybackPreparation();
        const counts = f.counts(before);
        console.log("STEP5 compiler field guard", JSON.stringify({ field, transport, counts, faults: f.faults }));
        // Playing and paused edits are adopted on the kept session alike (D7). A sidechain edit is an accepted native
        // limitation (E6/D8): no fault, nothing prepared or retried, the graph and host stay as they were.
        expect(f.faults).toEqual([]);
        expect(f.typedFaults).toEqual([]);
        expect(counts.scheduleCompiles).toBe(1);
        expect(counts.publishes).toBe(field === "sidechain" ? 0 : 1);
        if (field === "sidechain") expect(f.host.calls.slice(before.calls)).not.toContain("revision.prepare");
        expect(counts.previewCompiles).toBe(0);
        expect(counts.previewDisposals).toBe(0);
        expect(counts.teardowns).toBe(0);
        expect(counts.liveSends).toBe(0);
        expect(f.host.calls.slice(before.calls).filter(call => ["begin", "configure", "start", "stop", "teardown"].includes(call))).toEqual([]);
        expect(f.playback.isNativePlaybackPrepared()).toBe(true);
      } finally { await f.close(); }
    });
  }
}
