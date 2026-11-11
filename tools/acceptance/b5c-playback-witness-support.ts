import { expect, mock } from "bun:test";
import { createComputed, createMemo, createRoot, untrack } from "solid-js";
import type { ExportFx } from "@daw-browser/audio-engine/export-mixdown";
import type { Track } from "@daw-browser/timeline-core/types";
import type { NativeHostTransport, NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire";
import type { NativeRevisionReply, NativeRevisionSession } from "@daw-browser/desktop-protocol/native-revision";
import type { NativeProcessorPatchReply } from "~/types/desktop-bridge";
import { compileDesiredNativeProcessorState, compileLivePlaybackSnapshot, type LivePlaybackSnapshotInput } from "~/lib/live-playback-snapshot";
import { nativePlaybackFaultText, type NativePlaybackFault } from "~/lib/desktop/native-playback-controller";
import type { ExportAutomationPatch, ExportRenderStateSnapshot } from "~/lib/export/run-export-job";
import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { observeCalls } from "./device-control-cost-spy";
import { createSampledInstrumentRegionBudget } from "~/lib/sampled-instrument-region-budget";
import { pickNativePlaybackInputs } from "~/components/timeline/native-playback-inputs";
import { replaceEqualDeep } from "@tanstack/solid-query";

// Fixtures run serially because they replace the same window/host boundary.
// The wrapper forwards to the real controller and only records disposal calls.
let observeDisposal: ((reason: string) => void) | undefined;
let disposalSpyInstalled = false;
const installDisposalSpy = async () => {
  if (disposalSpyInstalled) return;
  disposalSpyInstalled = true;
  const path = `${import.meta.dir}/../../src/lib/desktop/native-playback-controller.ts`;
  const actual = { ...(await import(path)) };
  mock.module(path, () => ({
    ...actual,
    createNativePlaybackController: (...args: Parameters<typeof actual.createNativePlaybackController>) =>
      observeCalls(actual.createNativePlaybackController(...args), {
        call: ({ property, reason }) => {
          if (property === "dispose" && reason !== undefined) observeDisposal?.(reason);
        },
        result: () => undefined,
      }),
  }));
};

const nativeTransactionToken = "native-playback-transaction-token-000000000";
const createStep5NativeHost = () => {
  const calls: string[] = [];
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>();
  const acceptedFrames = new Map<number, bigint>();
  let runtimeRevision = 1;
  let progressSequence = 0n;
  let appliedProcessorSequence = 0n;
  let appliedUrgentSequence = 0n;
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
        appliedTransportTransitionId: transport.transitionId, appliedUrgentSequence, appliedProcessorSequence,
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
    queueInstrumentEvents: async (bytes: Uint8Array) => {
      calls.push("instrument");
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < view.getUint32(0, true); index++) {
        const offset = 4 + index * 48;
        expect(view.getUint32(offset + 24, true)).toBe(transport.epoch);
        appliedUrgentSequence = view.getBigUint64(offset + 16, true);
        appliedParameters.set(`${view.getBigUint64(offset, true)}:${view.getUint32(offset + 40, true)}`,
          view.getFloat32(offset + 44, true));
      }
      queueMicrotask(emitProgress);
      return accepted;
    },
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
            appliedTransportTransitionId: next.transitionId ?? progressSequence, appliedUrgentSequence, appliedProcessorSequence,
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
    instrumentBudgetPolicy: { deviceDecodedBytes: 8 * 1024 * 1024, aggregateBytes: 8 * 1024 * 1024 },
    resolveOutputDevice: async () => ({
      ...accepted,
      device: { deviceId: defaultDeviceId, name: "Default", nominalSampleRateHz: 48_000, outputChannelCount: 2, maximumFramesPerBlock: 512, available: true },
    }),
    resolveInputDevice: async () => ({ ...accepted, device: null }),
    session,
  };
  return { calls, audioHost, appliedParameters, epoch: () => transport.epoch };
};

// Drain the same bounded microtask budget as the existing Part-B fixture.
// Frames are explicit test inputs, never scheduled by a timer or polling job.
export const settleStep5Playback = async () => {
  for (let turn = 0; turn < 800; turn++) await Promise.resolve();
};

export const mountStep5Playback = async <Inputs extends {
  masterVolume: number;
  automation: readonly ExportAutomationPatch[];
  sidechains: NonNullable<LivePlaybackSnapshotInput["sidechainRoutes"]>;
  canonical?: { automationEnvelopes?: readonly unknown[] };
}>(input: {
  projectId: string;
  tracks: () => Track<AudioBuffer>[];
  playbackInputs: () => Inputs;
  desiredFx: (captured: Inputs) => ExportFx;
  renderState: (captured: Inputs) => Promise<ExportRenderStateSnapshot>;
  compileInputs?: (captured: Inputs) => Pick<LivePlaybackSnapshotInput, "timeSignature" | "sidechainRoutes">;
  // Timeline's nativePlaybackRevision, which its rebuild requests bump; 1 for a witness that never rebuilds.
  revision?: () => number;
}) => {
  await installDisposalSpy();
  const { useTimelinePlayback } = await import("~/hooks/useTimelinePlayback");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const host = createStep5NativeHost();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: host.audioHost } } });
  const faults: string[] = [];
  const typedFaults: NativePlaybackFault[] = [];
  const compilations: { mode: string; renderState: ExportRenderStateSnapshot }[] = [];
  const disposals: string[] = [];
  observeDisposal = reason => { disposals.push(reason); };
  const processorEdits = createProcessorEditRegistry(() => 120);
  const instrumentBudget = createSampledInstrumentRegionBudget(8 * 1024 * 1024);
  let dispose = () => {};
  const engine = {
    currentTimelineSec: 0, ensureAudio: () => undefined,
    applyAutomationAtTimelineSec: () => undefined, cancelAutomationSchedules: () => undefined,
    onTransportPause: () => undefined, onTransportSeek: () => undefined,
    onTransportStart: () => undefined, onTransportStop: () => undefined,
    resume: async () => undefined, rescheduleClipsAtPlayhead: () => ({ deferredStretchWindows: [] }),
    scheduleAllClipsFromPlayhead: () => ({ deferredStretchWindows: [] }),
    scheduleAutomationFromPlayhead: () => undefined, stopAllSources: () => undefined,
    subscribeStretchRenderState: () => () => true,
  } satisfies Parameters<typeof useTimelinePlayback>[0];
  const playback = createRoot(cleanup => {
    dispose = cleanup;
    const capturedInputs = createMemo(input.playbackInputs);
    createComputed(() => {
      const fx = input.desiredFx(capturedInputs());
      untrack(() => processorEdits.observe(fx));
    });
    const playbackInputs = createMemo(() => {
      const captured = capturedInputs();
      return pickNativePlaybackInputs({
        timeSignature: input.compileInputs?.(captured)?.timeSignature ?? { numerator: 4, denominator: 4 },
        automationEnvelopes: captured.canonical?.automationEnvelopes,
        masterVolume: captured.masterVolume, automation: captured.automation, sidechains: captured.sidechains,
        processorStructure: processorEdits.structure(),
      });
    }, undefined, { equals: (previous, next) => replaceEqualDeep(previous, next) === previous });
    return useTimelinePlayback(engine, { getTracks: input.tracks, bpm: () => 120 }, {
      requiresNativeAudio: true, enabled: () => true, projectId: () => input.projectId,
      instrumentBudget,
      playbackInputs,
      getProcessorTarget: processorEdits.target,
      getDesiredProcessorState: (snapshot, sampleRate) => compileDesiredNativeProcessorState(
        { ...snapshot, mixer: { ...snapshot.mixer, fx: input.desiredFx(input.playbackInputs()) } },
        sampleRate, processorEdits.sequence()),
      reportFault: fault => { typedFaults.push(fault); faults.push(nativePlaybackFaultText(fault)); },
      compileSnapshot: async transport => {
        const captured = input.playbackInputs();
        const renderState = await input.renderState(captured);
        compilations.push({ mode: transport.state, renderState });
        const result = compileLivePlaybackSnapshot({
          revision: input.revision?.() ?? 1, processorStateSequence: processorEdits.sequence(), bpm: 120, transport, tracks: input.tracks(),
          renderState, sidechainRoutes: [], ...input.compileInputs?.(captured),
        });
        if (!result.supported) throw new Error(`Step 5 fixture compile: ${JSON.stringify(result)}`);
        return result;
      },
    });
  });
  const frame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
    await settleStep5Playback();
  };
  const mark = () => ({ calls: host.calls.length, compilations: compilations.length, disposals: disposals.length });
  const counts = (before: ReturnType<typeof mark>) => {
    const calls = host.calls.slice(before.calls);
    const compiled = compilations.slice(before.compilations);
    return {
      scheduleCompiles: compiled.filter(row => row.mode === "playing").length,
      previewCompiles: compiled.filter(row => row.mode !== "playing").length,
      publishes: calls.filter(name => name === "revision.publish").length,
      teardowns: calls.filter(name => name === "teardown").length,
      liveSends: calls.filter(name => name === "queueParameterEvents" || name === "instrument").length,
      previewDisposals: disposals.slice(before.disposals).filter(reason => reason === "paused-preview-structural-change").length,
    };
  };
  const close = async () => {
    dispose();
    await settleStep5Playback();
    instrumentBudget.dispose();
    observeDisposal = undefined;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
  };
  try {
    await settleStep5Playback();
    await playback.awaitPlaybackPreparation();
    expect(faults).toEqual([]);
    expect(playback.isNativePlaybackPrepared()).toBe(true);
  } catch (cause) {
    await close();
    throw cause;
  }
  return { playback, host, faults, typedFaults, compilations, processorEdits, mark, counts, frame, close };
};
