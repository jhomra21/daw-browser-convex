import { createProcessorEditRegistry } from "~/components/timeline/create-processor-edit-registry";
import { mountStep5Playback, settleStep5Playback } from "../../tools/acceptance/b5c-playback-witness-support";
import { resolveDesiredPlaybackFx } from "~/lib/export/run-export-job";
import type { ExportEffectsProjection } from "~/lib/export/export-effect-rows";
import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createComputed, createMemo, createRoot, createSignal, untrack } from 'solid-js'
import { isServer } from 'solid-js/web'

import { useTimelinePlayback } from './useTimelinePlayback'
import { createParameterGestureOwner } from '../components/timeline/parameter-gesture-owner'
import { createPendingWorkOwner } from './useEffectsPanelAudioSync'
import { createSamplerBufferSync } from '~/lib/sampler-buffer-sync'
import { extractTimelineBindings } from '~/lib/timeline-source-test-support'
import { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { SYNTH_KIND_ID, type LiveProcessorEditIdentity } from '~/lib/live-processor-control'
import { nativePlaybackFaultText, type NativePlaybackFault } from '~/lib/desktop/native-playback-controller'
import type { AudioEffectRuntimeInstance, DeferredStretchWindow, EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { createDefaultDelayParams, createDefaultDrumRackParams, createDefaultSynthParams, createDefaultSamplerParams, createDefaultUtilityParams, mergeSynthParams } from '@daw-browser/shared'
import type { AutomationEnvelope, TrackInstrumentParams, UtilityParamsEnvelope } from '@daw-browser/shared'
import type { AudioCoreGraphSnapshot } from '@daw-browser/audio-core-contract'
import { externalProcessorSchema, type ExternalProcessor } from '@daw-browser/external-plugins'
import { compileLivePlaybackSnapshot, type LivePlaybackCompileContext, type LivePlaybackSnapshotInput } from '~/lib/live-playback-snapshot'
import { compilePreparedPortableLiveSession } from '~/lib/portable-live-session'
import { planSetTrackColor } from '~/lib/track-group-ops'
import { compileNativeExternalAttachmentPlan } from '~/lib/desktop/native-external-attachment-plan'
import { resolveNativeLivePlaybackProcessors } from '~/lib/desktop/native-live-playback-processors'
import type { NativeHostTransport, NativeScheduleProgress } from '@daw-browser/audio-engine/native-host-wire'
import type { NativeRevisionSession, NativeRevisionReply } from '@daw-browser/desktop-protocol/native-revision'
import type { DesktopAudioLifecycle } from '~/lib/desktop-audio-lifecycle'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import {
  portableWasmProtocolVersion,
  type PortableWasmControlMessage,
  type PortableWasmStatusMessage,
} from '@daw-browser/audio-engine/portable-wasm-protocol'
import { compileLiveNativeProjection } from '@daw-browser/audio-engine/live-native-projection'

// B6a3 failure-first caller routing: an unprepared update is silent;
// unsupported latency is actionable, and other typed failures stop the session.
for (const kind of ["unprepared", "refused", "unconfirmed", "unavailable", "latency-unsupported"]) {
  test(`B6a3 terminal-routing hook ${kind}`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const fixture = createNativeHookBridge()
    const faults: NativePlaybackFault[] = []
    const [keep, setKeep] = createSignal(new Set<string>())
    const reply = (status: "prepared" | "published" | "retired"): NativeRevisionReply => ({
      ok: true, hostPid: 123, hostGeneration: 7,
      revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: 2,
        preparedRevision: 2, retiredRevision: 0, publicationFrame: 1024n, renderEpoch: 10n },
    })
    const revisions: NativeRevisionSession = {
      prepare: async () => {
        if (kind === "latency-unsupported") {
          const prepared = reply("prepared")
          return prepared.ok ? { ...prepared, revision: { ...prepared.revision,
            status: "prepare-failed", continuity: "rejected", preparedRevision: 0, diagnosticCode: 3 } } : prepared
        }
        return kind === "refused" || kind === "unconfirmed" || kind === "unavailable"
          ? { ok: false, kind, error: "same diagnostic" } : reply("prepared")
      },
      publish: async () => reply("published"), inspect: async () => reply("published"),
      rollback: async () => reply("prepared"), retire: async () => reply("retired"),
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
      ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
        configureInstrumentStates: async () => ({ ok: true }) },
    } } } })
    try {
      await withFakeRaf(async () => {
        let dispose = () => {}
        const playback = createRoot(cleanup => {
          dispose = cleanup
          return useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
            undefined, { requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
              keepLatencyNodeIds: keep, compileSnapshot: nativeRequiredSnapshot,
              reportFault: fault => faults.push(fault) })
        })
        try {
          if (kind !== "unprepared") await playback.handlePlay([track])
          setKeep(new Set([track.id]))
          await settleStep5Playback()
          expect(faults).toEqual(kind === "unprepared" ? [] : kind === "latency-unsupported"
            ? [{ kind: "latency-unsupported",
              message: "Keep Latency can't be used here: this bus mixes monitored and other tracks, then splits to outputs with different latency. Route them through separate buses." }]
            : [{ kind: "session-stopped", message: "same diagnostic" }])
        } finally { dispose(); await settleStep5Playback() }
      })
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
}

test("B6a3 terminal-routing hook host loss during latency publication preserves the loss fault once", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const fixture = createNativeHookBridge()
  const faults: NativePlaybackFault[] = []
  let visibleFault: NativePlaybackFault | undefined
  const [keep, setKeep] = createSignal(new Set<string>())
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const reply = (status: "prepared" | "published" | "retired"): NativeRevisionReply => ({
    ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: 2,
      preparedRevision: 2, retiredRevision: 0, publicationFrame: 1024n, renderEpoch: 10n },
  })
  const revisions: NativeRevisionSession = {
    prepare: async () => {
      entered.resolve()
      await released.promise
      return reply("prepared")
    },
    publish: async () => reply("published"), inspect: async () => reply("published"),
    rollback: async () => reply("prepared"), retire: async () => reply("retired"),
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
    ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
      configureInstrumentStates: async () => ({ ok: true }) },
  } } } })
  try {
    await withFakeRaf(async () => {
      let dispose = () => {}
      const playback = createRoot(cleanup => {
        dispose = cleanup
        return useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined, { requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
            keepLatencyNodeIds: keep, compileSnapshot: nativeRequiredSnapshot,
            reportFault: fault => { visibleFault = fault; faults.push(fault) } })
      })
      try {
        await playback.handlePlay([track])
        setKeep(new Set([track.id]))
        await entered.promise
        fixture.emitLoss()
        released.resolve()
        await settleStep5Playback()
        const lossFault: NativePlaybackFault = { kind: "session-stopped", message: "Native playback host connection was lost." }
        expect(visibleFault).toEqual(lossFault)
        expect(faults).toEqual([lossFault])
        expect(playback.isPlaying()).toBe(false)
      } finally { released.resolve(); dispose(); await settleStep5Playback() }
    })
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

type ScheduleCall = {
  playheadSec: number
  opts: Parameters<Parameters<typeof useTimelinePlayback>[0]['scheduleAllClipsFromPlayhead']>[2]
}

type LifecycleEmitter = { emit: (value: DesktopAudioLifecycle) => void }
type NativeTransactionReply = { ok: true; transactionToken: string } | { ok: false; error: string }

const nativeTransactionToken = 'native-playback-transaction-token-000000000'

// D2 failure inventory: identifying a never-written history reservation must
// not replace latest desired content, invalidate preview, or compile a schedule.
for (const transport of ["playing", "paused"]) {
  test(`STEP5 D2 ${transport} cancelled reservation guard`, async () => {
    const params = createDefaultDelayParams();
    const effects: ExportEffectsProjection = { replaceAudioEffectTargets: [{ targetId: "track-1", rows: [
      { targetId: "track-1", effect: "delay", instanceId: "delay-d2", index: 0, params },
    ] }], upsertDeviceRows: [] };
    const inputs = () => ({ canonical: undefined, local: undefined, masterVolume: 1, effects, automation: [], sidechains: [] });
    const fx = (captured: ReturnType<typeof inputs>) => resolveDesiredPlaybackFx(
      { masterVolume: captured.masterVolume, masterFxInstances: [], trackFx: {} }, captured.effects, undefined);
    const f = await mountStep5Playback({ projectId: `step5-d2-${transport}`, tracks: () => [track], playbackInputs: inputs,
      desiredFx: fx, renderState: async captured => ({ fx: fx(captured), automationEnvelopes: [] }) });
    try {
      if (transport === "playing") await f.playback.handlePlay([track]);
      await settleStep5Playback();
      const before = f.mark();
      const latest = f.processorEdits.target("track-1", "delay-d2")?.latest;
      const reservation = f.processorEdits.reserve({ targetId: "track-1", effect: "delay", instanceId: "delay-d2",
        from: params, to: { ...params, pingPong: !params.pingPong } });
      if (!reservation) throw new Error("Reservation missing");
      await f.frame();
      expect(f.processorEdits.target("track-1", "delay-d2")?.latest).toBe(latest);
      f.processorEdits.release(reservation);
      await f.frame();
      const counts = f.counts(before);
      console.log("STEP5 D2 guard", JSON.stringify({ transport, counts }));
      expect(f.processorEdits.target("track-1", "delay-d2")?.latest).toBe(latest);
      expect(counts).toEqual({ scheduleCompiles: 0, previewCompiles: 0, publishes: 0, teardowns: 0, liveSends: 0, previewDisposals: 0 });
      expect(f.faults).toEqual([]);
    } finally { await f.close(); }
  });
}

test.each(["announce", "unsupported", "announce+sample"])("3B1 r2 actual playback preparation does not drain its %s owner", async (path) => {
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8")
  const { compilePrefix: prefix, structural, portable } = extractTimelineBindings(source)
  const transpiler = new Bun.Transpiler({ loader: "ts" })
  const compile: (effects: () => { flushPending: () => Promise<void>; awaitInstrumentReadiness: () => Promise<void>; snapshotEffectsProjection: () => number },
    context?: LivePlaybackCompileContext) => Promise<number> = new Function(
    transpiler.transformSync(`return async (effectsExportSnapshot, context) => { ${prefix} return effectsProjection; }`))()
  const makeCallbacks = new Function("deps", transpiler.transformSync(`
    const { mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
      isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
      rebuildPlaybackBackend, renderTracks, captureStructuralPlaybackIntent, notify, liveProcessorControl, SYNTH_KIND_ID } = deps;
    let instrumentPlaybackChangeTail = Promise.resolve();
    return ({ ${structural} ${portable} });
  `))
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      await createRoot(async dispose => {
        let compiled = 0, saved = false, announcing = false
        const sampledWork = createPendingWorkOwner()
        let releaseDecode = () => {}, enterDecode = () => {}
        const heldDecode = new Promise<void>(resolve => { releaseDecode = resolve })
        const enteredDecode = new Promise<void>(resolve => { enterDecode = resolve })
        const buffer = new TestAudioBuffer()
        const sampler = createSamplerBufferSync({
          projectId: () => "project:sampled",
          readLocalAsset: async () => ({ status: "ready", file: new File([], "held.wav") }),
          decodePages: async function* () {
            enterDecode()
            await heldDecode
            yield { startFrame: 0, frameCount: buffer.length, sampleRate: buffer.sampleRate,
              channelCount: 1, planes: [new Float32Array(buffer.length)] }
          },
          createBuffer: () => buffer,
        })
        if (path === "announce+sample") {
          sampledWork.track("project", sampler.syncTrack(new AudioEngine(), "sampled", {
            ...createDefaultSamplerParams(),
            zones: [{ id: "held-zone", sample: { assetKey: "held", url: "local-asset:held", sourceKind: "upload",
              source: { durationSec: buffer.duration, sampleRate: buffer.sampleRate, channelCount: 1 } },
              keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 60,
              tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
              playbackMode: "one-shot", startSec: 0, crossfadeSec: 0, chokeGroup: 0 }],
          }, "held"))
          await enteredDecode
        }
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
            requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
            compileSnapshot: async (transport, context) => {
              await compile(() => ({ flushPending: async () => { await owner.flushPending() },
                awaitInstrumentReadiness: () => sampledWork.flushPending("project"),
                snapshotEffectsProjection: () => owner.effective("track-1") ?? 0 }), context)
              compiled++
              return nativeRequiredSnapshot(transport)
            },
          },
        )
        const callbacks: {
          onStructuralPlaybackChange: (targetId: string, instrument: undefined) => Promise<void>
          applyPortableProcessor: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined>
        } = makeCallbacks({
          mountedProjectGeneration: () => 0, awaitPlaybackPreparation: playback.awaitPlaybackPreparation,
          preparedInstrument: playback.preparedInstrument, isStructuralRebuildInProgress: playback.isStructuralRebuildInProgress,
          isPreparingPlayback: playback.isPreparingPlayback, isPlaying: playback.isPlaying,
          isNativePlaybackPrepared: playback.isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared: () => false,
          rebuildPlaybackBackend: () => playback.restartTimelineSchedule([track], { rebuildBackend: true }),
          renderTracks: () => [track], captureStructuralPlaybackIntent: () => ({}),
          notify: (_title: string, message: string) => { throw new Error(message) },
          liveProcessorControl: () => ({ flush: async () => ({ accepted: false, reason: "unsupported" }) }),
        })
        const edit = createProcessorEditRegistry(() => 120).allocate({
          targetId: "track-1", instanceId: "utility", effect: "utility",
          from: { version: 1, state: createDefaultUtilityParams() },
          to: { version: 1, state: { ...createDefaultUtilityParams(), swap: true } },
        })
        if (!edit) throw new Error("Missing structural edit")
        const owner = createParameterGestureOwner<string, number>({
          key: value => value, scope: () => ({ projectId: "project", generation: 0 }),
          exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
          initial: () => 0, committed: () => 0,
          apply: () => path === "unsupported" ? callbacks.applyPortableProcessor(edit) : "applied",
          persist: async () => ({ kind: "committed-unordered" }), history: () => { saved = true },
          announce: async record => {
            announcing = true
            if (path !== "unsupported") await callbacks.onStructuralPlaybackChange(record.target, undefined)
          },
          allocateEdit: () => undefined, onError: (_stage, cause) => { throw cause },
        })
        let play = Promise.resolve()
        try {
          if (path === "unsupported") await playback.handlePlay([track])
          owner.set("track-1", 1)
          if (path !== "unsupported") play = playback.handlePlay([track])
          if (path === "announce+sample") {
            for (let turn = 0; turn < 80; turn++) await Promise.resolve()
            const beforeDecode = { compiled, announcing, pending: playback.isPlayPending() }
            releaseDecode()
            expect(beforeDecode).toEqual({ compiled: 0, announcing: true, pending: true })
          }
          // Bounded microtask observation, not a timeout or product polling.
          for (let turn = 0; turn < 300; turn++) await Promise.resolve()
          expect({ compiled: compiled > (path === "unsupported" ? 1 : 0), saved, announcing, pending: playback.isPlayPending() })
            .toEqual({ compiled: true, saved: true, announcing: true, pending: false })
          await owner.flushPending()
          expect(owner.effective("track-1")).toBe(1)
          await play
        } finally {
          releaseDecode()
          dispose()
          sampler.dispose()
          sampledWork.dispose()
        }
      })
    })
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

const isFailureResolver = (
  failure: string | (() => string | undefined) | undefined,
): failure is () => string | undefined => typeof failure === 'function'

const portableResponseFor = (
  message: PortableWasmControlMessage,
): PortableWasmStatusMessage | undefined => {
  if (message.type === 'initialize') {
    return { version: portableWasmProtocolVersion, type: 'ready', revision: 1 }
  }
  if (message.type === 'prepare-graph') {
    return { version: portableWasmProtocolVersion, type: 'graph-prepared', requestId: message.requestId, revision: message.snapshot.revision, result: 'prepared' }
  }
  if (message.type === 'publish-graph') {
    return { version: portableWasmProtocolVersion, type: 'graph-published', requestId: message.requestId, revision: message.revision, result: 'published' }
  }
  if (message.type === 'transport') {
    return { version: portableWasmProtocolVersion, type: 'transport-applied', requestId: message.requestId, epoch: message.epoch, result: 'applied' }
  }
  if (message.type === 'install-schedule') {
    return { version: portableWasmProtocolVersion, type: 'schedule-installed', requestId: message.requestId, revision: message.schedule.revision, epoch: message.schedule.transportEpoch, result: 'installed' }
  }
  if (message.type === 'schedule-sources') {
    return { version: portableWasmProtocolVersion, type: 'sources-scheduled', requestId: message.requestId, revision: message.revision, epoch: message.epoch, result: 'scheduled' }
  }
  if (message.type === 'replace-sources') {
    return { version: portableWasmProtocolVersion, type: 'sources-replaced', requestId: message.requestId, revision: message.revision, epoch: message.epoch, result: 'replaced' }
  }
  if (message.type === 'register-asset') {
    return { version: portableWasmProtocolVersion, type: 'asset-registered', requestId: message.requestId, generation: message.generation, assetId: message.asset.assetId, result: 'registered', handle: { slot: 0, generation: message.generation } }
  }
  return undefined
}

const track: Track = {
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips: [],
}

const insertedExternalProcessor = (): ExternalProcessor => externalProcessorSchema.parse({
  instanceId: '33333333-3333-4333-8333-333333333333',
  targetId: 'track-2',
  index: 0,
  manifest: {
    identity: {
      format: 'vst3',
      classId: 'example',
      vendor: 'Example',
      name: 'Example',
      version: '1',
      architecture: 'arm64',
      binaryFingerprint: 'a'.repeat(64),
    },
    role: 'effect',
    audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
    audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
    sidechainInputs: [],
    parameters: [],
    latencyFrames: 0,
    tailFrames: 0,
    supportsBypass: false,
    supportsEditor: false,
    supportsState: false,
  },
  parameterOverrides: {},
  latencyFrames: 0,
  tailFrames: 0,
  bypassed: false,
  launchReference: {
    version: 1,
    classId: 'example',
    vendorId: 'Example',
    architecture: 'arm64',
    bundleFingerprint: 'b'.repeat(64),
    binaryFingerprint: 'a'.repeat(64),
    scannerCatalogVersion: 2,
  },
  health: { state: 'ready', updatedAt: 1 },
  updatedAt: 1,
})

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 4 / 48_000
  readonly length = 4
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  private readonly channel = new Float32Array(4)
  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.set(this.channel.subarray(0, destination.length))
  }
  copyToChannel(source: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    this.channel.set(source.subarray(0, this.channel.length))
  }
  getChannelData(_channel: number) {
    return this.channel
  }
}

const audioTrack = (buffer: AudioBuffer | null): Track<AudioBuffer> => ({
  id: "track-audio",
  name: "Audio",
  volume: 1,
  clips: [{
    id: "clip-audio",
    name: "Audio clip",
    startSec: 0,
    duration: 1,
    color: "#fff",
    sourceAssetKey: "asset-audio",
    buffer,
  }],
})

const withFakeRaf = async (run: (flushRaf: () => void) => Promise<void>) => {
  const callbacks: FrameRequestCallback[] = []
  const previousRequest = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (callback) => {
    callbacks.push(callback)
    return callbacks.length
  }
  globalThis.cancelAnimationFrame = () => {}
  try {
    await run(() => {
      const callback = callbacks.shift()
      if (callback) callback(0)
    })
  } finally {
    globalThis.requestAnimationFrame = previousRequest
    globalThis.cancelAnimationFrame = previousCancel
  }
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

const withPortableAudioWorklet = async (run: () => Promise<void>) => {
  const previousAudioContext = globalThis.AudioContext
  const previousAudioWorkletNode = globalThis.AudioWorkletNode
  const previousFetch = globalThis.fetch
  const hadAudioContext = "AudioContext" in globalThis
  const hadAudioWorkletNode = "AudioWorkletNode" in globalThis
  class FakeAudioContext {
    readonly sampleRate = 48_000
    readonly destination = {}
    readonly audioWorklet = { addModule: async () => undefined }
  }
  type FakePort = {
    onmessage: ((event: { data: PortableWasmStatusMessage }) => void) | null
    postMessage: (message: PortableWasmControlMessage) => void
    close: () => void
  }
  class FakeAudioWorkletNode {
    readonly port: FakePort
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          const response = portableResponseFor(message)
          if (response) queueMicrotask(() => this.port.onmessage?.({ data: response }))
        },
        close: () => {},
      }
    }
    onprocessorerror: (() => {}) | null = null
    connect = () => {}
    disconnect = () => {}
  }
  const manifest = await readFile(new URL("../../public/audio-core/daw-audio-core.manifest.json", import.meta.url), "utf8")
  const wasm = await readFile(new URL("../../public/audio-core/daw-audio-core.wasm", import.meta.url))
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: FakeAudioWorkletNode })
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string | URL) => (
      String(input).endsWith(".manifest.json")
        ? new Response(manifest, { status: 200 })
        : new Response(wasm, { status: 200 })
    ),
  })
  try {
    await run()
  } finally {
    if (hadAudioContext) Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: previousAudioContext })
    else Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: undefined })
    if (hadAudioWorkletNode) Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: previousAudioWorkletNode })
    else Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: undefined })
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: previousFetch })
  }
}

test('keeps browser startup portable-first and runtime faults stop without fallback', async () => {
  const source = await readFile(new URL('./useTimelinePlayback.ts', import.meta.url), 'utf8')
  const timelineSource = await readFile(new URL('../components/Timeline.tsx', import.meta.url), 'utf8')
  expect(source).toContain("version: 2")
  expect(source).toContain("browserDefaultBackend: 'portable-browser'")
  expect(source).toContain("runtimeFailure: 'stop-and-mute'")
  expect(source).toContain("portableBrowserConfigured: portableBrowserOptions !== undefined")
  const portableStartup = source.indexOf('if (portableBrowserOptions) {')
  const nativeFallback = source.indexOf('if (nativeLifecycleReady && nativeOptions?.enabled?.())', portableStartup)
  const legacyStartup = source.indexOf("setActiveBackend('legacy')", nativeFallback)
  expect(portableStartup).toBeGreaterThan(-1)
  expect(nativeFallback).toBeGreaterThan(portableStartup)
  expect(legacyStartup).toBeGreaterThan(nativeFallback)
  expect(source).toContain('portableBrowserOptions?.reportFault?.(message)')
  expect(source).toContain('isPreparingPlayback: () => (playAttempt !== undefined && !isPlaying())')
  expect(source).toContain('portableBrowserPlayback.isPreparing()')
  expect(timelineSource).toContain('&& !isPreparingPlayback()) return;')
})

const createNativeHookBridge = (
  failure?: string | (() => string | undefined),
  lifecycle?: {
    initial: { state: "suspended" | "recovering" | "ready" | "failed"; powerGeneration: number }
    completeRecovery: (generation: number, result: "ready" | "failed") => Promise<{ accepted: boolean }>
    retryRecovery: () => Promise<{ accepted: boolean }>
  },
  initialBeginGate?: Promise<NativeTransactionReply>,
  transportGate?: Promise<{ ok: true } | { ok: false; error: string }>,
  failureMessage = 'failed',
  mappedAssets = false,
) => {
  const calls: string[] = []
  const transportStates: boolean[] = []
  const transportPayloads: NativeHostTransport[] = []
  const transportFrames: number[] = []
  let beginGate = initialBeginGate
  const reply = (name: string) => async () => {
    calls.push(name)
    const failureName = isFailureResolver(failure) ? failure() : failure
    if (name === failureName) return { ok: false as const, error: failureMessage }
    if (name === "begin" && beginGate) return beginGate
    if (name === "begin") return { ok: true as const, transactionToken: nativeTransactionToken }
    return { ok: true as const }
  }
  const progressListeners = new Set<(progress: NativeScheduleProgress) => void>()
  let runtimeRevision = 1
  let currentEpoch = 1
  let scheduleComplete = true
  let realisticProgress = false
  const acceptedFrames = new Map<number, bigint>()
  const lossListeners = new Set<() => void>()
  let progressSequence = 0n
  let currentTransport = { epoch: 1, frame: 0, running: false, transitionId: 0n }
  let admissionCapacityGeneration: bigint | undefined
  const emitScheduleProgress = (capacityGeneration?: bigint) => {
    if (capacityGeneration !== undefined) admissionCapacityGeneration = capacityGeneration
    progressSequence++
    for (const listener of progressListeners) listener({ revision: runtimeRevision, epoch: currentTransport.epoch,
      progressSequence, admissionCapacityGeneration, renderedThroughFrame: BigInt(currentTransport.frame),
      acceptedThroughFrame: acceptedFrames.get(currentTransport.epoch) ?? BigInt(currentTransport.frame + 1),
      lastAcceptedWindowId: 1n, appliedTransportTransitionId: currentTransport.transitionId,
      appliedUrgentSequence: 0n, appliedProcessorSequence: 0n, running: currentTransport.running,
      scheduleComplete, instrumentCredits: 256, sourceCredits: 256, automationCredits: 256 })
  }
  let lifecycleListener: ((value: DesktopAudioLifecycle) => void) | undefined
  let transportGateArmed = false
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  return {
    calls,
    transportStates,
    transportPayloads,
    transportFrames,
    epoch: () => currentEpoch,
    emitScheduleProgress,
    setRuntimeRevision: (revision: number) => { runtimeRevision = revision },
    setScheduleComplete: (value: boolean) => { scheduleComplete = value; realisticProgress = true },
    emitLoss: () => { for (const listener of lossListeners) listener() },
    armTransportGate: () => { transportGateArmed = true },
    setBeginGate: (gate: Promise<NativeTransactionReply> | undefined) => {
      beginGate = gate
    },
    emitLifecycle: (value: DesktopAudioLifecycle) => lifecycleListener?.(value),
    audioHost: {
      resolveOutputDevice: async () => ({
        ok: true as const,
        device: {
          deviceId,
          name: 'Default',
          nominalSampleRateHz: 48_000,
          outputChannelCount: 2,
          maximumFramesPerBlock: 512,
          available: true,
        },
      }),
      resolveInputDevice: async () => ({ ok: true as const, device: null }),
      session: {
        configure: async (): Promise<({ ok: true; hostIdentity: { pid: number; generation: number; configurationGeneration: number } } | { ok: false; error: string })> => {
          const result = await reply('configure')()
          return result.ok ? { ok: true, hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } } : result
        },
        beginTransaction: reply('begin'),
        commitTransaction: reply('commit'),
        rollbackTransaction: reply('rollback'),
        installAsset: reply('install'),
        releaseAsset: reply('release'),
        publishGraph: (bytes: Uint8Array) => {
          runtimeRevision = Number(new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, false))
          return reply('graph')()
        },
        createMappedAsset: mappedAssets ? reply('install') : undefined,
        writeMappedAssetPage: mappedAssets ? reply('write-page') : undefined,
        prepareMappedAssetRange: mappedAssets ? reply('prepare-range') : undefined,
        coordinateVstAttachments: reply('coordinate'),
        queueParameterEvents: reply('parameter'),
        queueInstrumentEvents: reply('instrument'),
        queueSourceEvents: reply('source'),
        queueScheduleWindow: (bytes: Uint8Array) => {
          const view = new DataView(bytes.buffer, bytes.byteOffset)
          acceptedFrames.set(view.getUint32(4, true), view.getBigUint64(24, true))
          if (realisticProgress) queueMicrotask(emitScheduleProgress)
          return reply('schedule')()
        },
        setTransport: async (transport: NativeHostTransport) => {
          currentEpoch = transport.epoch
          currentTransport = { ...transport, transitionId: transport.transitionId ?? 0n }
          calls.push('transport')
          transportStates.push(transport.running)
          transportPayloads.push(transport)
          transportFrames.push(transport.frame)
          if (
            !transport.running
            && transportGate
            && transportGateArmed
          ) await transportGate
          progressSequence += 1n
          queueMicrotask(() => { for (const progressListener of progressListeners) progressListener({
            revision: realisticProgress ? runtimeRevision : 1,
            epoch: transport.epoch,
            progressSequence,
            renderedThroughFrame: BigInt(transport.frame),
            acceptedThroughFrame: realisticProgress ? acceptedFrames.get(transport.epoch) ?? BigInt(transport.frame + 1)
              : BigInt(transport.frame + 1),
            lastAcceptedWindowId: 1n,
            appliedTransportTransitionId: transport.transitionId ?? progressSequence,
            appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
            running: transport.running,
            scheduleComplete,
            instrumentCredits: 256,
            sourceCredits: 256,
            automationCredits: 256,
          }) })
          return { ok: true as const }
        },
        configureRecording: reply('recording-configure'),
        startRecording: reply('recording-start'),
        stopRecording: reply('recording-stop'),
        cancelRecording: reply('recording-cancel'),
        start: reply('start'),
        stop: reply('stop'),
        teardown: reply('teardown'),
        onLoss: (listener: () => void) => {
          lossListeners.add(listener)
          return () => { lossListeners.delete(listener) }
        },
        onRecordingBlock: () => () => {},
        onRecordingStatus: () => () => {},
        onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
          if (!realisticProgress) progressListeners.clear()
          progressListeners.add(listener)
          return () => { progressListeners.delete(listener) }
        },
      },
      getLifecycle: lifecycle ? async () => lifecycle.initial : undefined,
      completeRecovery: lifecycle?.completeRecovery,
      retryRecovery: lifecycle?.retryRecovery,
      onLifecycle: lifecycle === undefined ? undefined : (listener: (value: DesktopAudioLifecycle) => void) => {
        lifecycleListener = listener
        return () => { lifecycleListener = undefined }
      },
    },
  }
}

const createFakeEngine = (deferredWindow: DeferredStretchWindow) => {
  let currentTimelineSec = 0
  let stretchListener = () => {}
  const scheduleCalls: ScheduleCall[] = []
  const transportEvents: string[] = []
  const engine = {
    get currentTimelineSec() {
      return currentTimelineSec
    },
    ensureAudio: () => {},
    applyAutomationAtTimelineSec: () => {},
    cancelAutomationSchedules: () => {
      transportEvents.push('cancelAutomationSchedules')
    },
    onTransportPause: () => {
      transportEvents.push('onTransportPause')
    },
    onTransportSeek: () => {
      transportEvents.push('onTransportSeek')
    },
    onTransportStart: () => {},
    onTransportStop: () => {},
    resume: async () => {},
    rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
      scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
      return { deferredStretchWindows: [deferredWindow] }
    },
    scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
      scheduleCalls.push({ playheadSec, opts })
      return scheduleCalls.length === 1
        ? { deferredStretchWindows: [deferredWindow] }
        : { deferredStretchWindows: [] }
    },
    scheduleAutomationFromPlayhead: () => {},
    stopAllSources: () => {},
    subscribeStretchRenderState: (listener) => {
      stretchListener = listener
      return () => true
    },
  } satisfies Parameters<typeof useTimelinePlayback>[0]

  return {
    engine,
    scheduleCalls,
    transportEvents,
    setCurrentTimelineSec: (sec: number) => {
      currentTimelineSec = sec
    },
    notifyStretchReady: () => stretchListener(),
  }
}

const nativeRequiredSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => {
  const result = compileLivePlaybackSnapshot({
    revision: 1,
    bpm: 120,
    transport,
    tracks: [track],
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
    sidechainRoutes: [],
  })
  if (!result.supported) return result
  return {
    supported: true as const,
    snapshot: {
      ...result.snapshot,
      nativeExternalAttachmentPlan: { version: 1 as const, attachments: [] },
      requiresNativePlayback: true,
    },
  }
}

const adoptionChildren = new Set<ReturnType<typeof Bun.spawn>>()
afterEach(() => {
  for (const child of adoptionChildren) child.kill()
  adoptionChildren.clear()
})
test.skipIf(!isServer)('adopted snapshots exercise real Solid reactive effects', async () => {
  const child = Bun.spawn(["bun", "test", "--conditions=browser", "--timeout", "30000",
    import.meta.path, "-t", "adopted snapshot"], { stdout: "pipe", stderr: "pipe" })
  adoptionChildren.add(child)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  adoptionChildren.delete(child)
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(code).toBe(0)
})

for (const scenario of ["delete", "move-trim", "add", "tempo", "burst", "rejection", "failure", "publish-error", "compile-error", "automation-only", "mixer-only",
  "progress-retry", "capacity-release", "pending-exhaustion", "rebase-exhaustion", "loop-ui", "loop-adopted", "loop-clip", "loop-inflight", "unsupported", "time-signature", "duplicate", "stale-compile", "burst-during-compile", "inputs-during-compile", "explicit", "effect-only", "stop", "seek", "project"]) {
  test.skipIf(isServer)(`adopted snapshot ${scenario} preserves the latest live intent`, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const previousBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer")
    Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: TestAudioBuffer })
    const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
    fixture.setScheduleComplete(false)
    const initial = audioTrack(new TestAudioBuffer())
    const [tracks, setTracks] = createSignal<Track[]>([initial])
    const [bpm, setBpm] = createSignal(120)
    const [mixRevision, setMixRevision] = createSignal(0)
    const [loopEnabled, setLoopEnabled] = createSignal(scenario === "loop-inflight")
    const [loopEndSec, setLoopEndSec] = createSignal(1)
    const [projectId, setProjectId] = createSignal("project")
    const gate = Promise.withResolvers<void>()
    const publishing = Promise.withResolvers<void>()
    const publicationGate = Promise.withResolvers<void>()
    const releaseAck = Promise.withResolvers<void>()
    const releaseAsset = fixture.audioHost.session.releaseAsset
    fixture.audioHost.session.releaseAsset = async (...args) => {
      if (scenario === "capacity-release") await releaseAck.promise
      return releaseAsset(...args)
    }
    const compiling = Promise.withResolvers<void>()
    let holdCompile = false
    let changed = false
    let failed = ["failure", "rejection", "publish-error", "compile-error", "progress-retry",
      "pending-exhaustion", "rebase-exhaustion"].includes(scenario)
    let publishAttempts = 0
    let compilations = 0
    let revision = 1
    let activeRevision = 1
    let seam = 0n
    let status: "prepared" | "published" | "invalid-revision" | "publish-pending" | "rebase-required" | "rolled-back" | "stale-revision" = "prepared"
    const preparedTracks: Track[][] = []
    const published: number[] = []
    const compilationsAtPublication: number[] = []
    const stagedWindows: Uint8Array[] = []
    const queue = fixture.audioHost.session.queueScheduleWindow
    fixture.audioHost.session.queueScheduleWindow = (bytes) => {
      if (new DataView(bytes.buffer, bytes.byteOffset).getUint8(60) !== 0) stagedWindows.push(bytes)
      return queue(bytes)
    }
    const reply = async (): Promise<NativeRevisionReply> => ({ ok: true, hostPid: 123, hostGeneration: 7,
      revision: { status, continuity: "accepted", requestedRevision: revision, activeRevision,
        preparedRevision: status === "prepared" ? revision : 0, retiredRevision: 0,
        renderEpoch: 1n, transportEpoch: fixture.epoch(), publicationFrame: status === "published" ? seam : 0n,
        progressFrame: 0n } })
    const revisions: NativeRevisionSession = {
      prepare: async (request) => {
        expect(request.projectId).toBe("project")
        preparedTracks.push(tracks())
        revision++
        seam = request.requestedPublicationFrame ?? 0n
        if (failed && scenario === "failure") throw new Error("temporary staging failure")
        if (failed && ["progress-retry", "capacity-release"].includes(scenario)) return { ok: false, error: "asset-capacity-exceeded", kind: "refused" }
        status = failed && scenario === "pending-exhaustion" ? "publish-pending"
          : failed && !["publish-error", "rebase-exhaustion"].includes(scenario) ? "invalid-revision" : "prepared"
        return reply()
      },
      publish: async (request) => {
        publishAttempts++
        if (scenario === "loop-inflight" && publishAttempts === 1) {
          publishing.resolve()
          await publicationGate.promise
        }
        if (failed && scenario === "publish-error") throw new Error("permanent publication bridge failure")
        if (failed && scenario === "rebase-exhaustion") {
          status = status === "rebase-required" ? "prepared" : "rebase-required"
          return reply()
        }
        expect(request.hostGeneration).toBe(7)
        expect(request.projectId).toBe("project")
        status = "published"
        activeRevision = revision
        fixture.setRuntimeRevision(revision)
        published.push(revision)
        compilationsAtPublication.push(compilations)
        return reply()
      },
      inspect: async () => {
        // Lost bridge replies are not native proof of a prepared or failed bank.
        if (failed && scenario === "publish-error") throw new Error("Inspection reply lost")
        return reply()
      },
      rollback: async () => {
        if (failed && scenario === "publish-error") throw new Error("Rollback reply lost")
        // audio-host.cpp:3123–3162 releases an unclaimed prepared bank.
        status = activeRevision === revision ? "stale-revision" : "rolled-back"
        return reply()
      },
      retire: reply,
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
      ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
        configureInstrumentStates: async () => ({ ok: true }) },
    } } } })
    try {
      await withFakeRaf(async () => {
        let dispose = () => {}
        const playback = createRoot((cleanup) => {
          dispose = cleanup
          const playbackInputs = createMemo(() => ({ revision: mixRevision() }))
          return useTimelinePlayback(createFakeEngine({ clipId: "x", startSec: 0, endSec: 1 }).engine,
            { getTracks: tracks, bpm, loopEnabled, loopStartSec: () => 0, loopEndSec }, {
              requiresNativeAudio: true, enabled: () => true, projectId,
              playbackInputs,
              compileSnapshot: async (transport) => {
                compilations++
                if (changed && failed && scenario === "compile-error") throw new Error("persistent compiler failure")
                const capturedTracks = tracks()
                const capturedBpm = bpm()
                const hold = holdCompile
                holdCompile = false
                if (hold) { compiling.resolve(); await gate.promise }
                const result = compileLivePlaybackSnapshot({ revision: 1, bpm: capturedBpm, transport,
                  tracks: capturedTracks, renderState: {
                    fx: { masterVolume: changed && ["effect-only", "mixer-only"].includes(scenario) ? 0.5 : 1, masterFxInstances: [], trackFx: {} },
                    automationEnvelopes: changed && scenario === "automation-only" ? [{
                      id: "master-volume", projectId: "project", target: { kind: "master" },
                      targetKey: "master", parameterId: "volume", enabled: true, updatedAt: 1,
                      points: [{ id: "point", timeSec: 0, value: 0.5, interpolation: "linear" }],
                    }] : [],
                  }, sidechainRoutes: [] })
                if (result.supported && changed && scenario === "unsupported")
                  return { ...result, snapshot: { ...result.snapshot, nativeExternalAttachmentPlan: { version: 1, attachments: [] } } }
                if (result.supported && changed && scenario === "time-signature")
                  return { ...result, snapshot: { ...result.snapshot, timeSignature: { numerator: 3, denominator: 4 } } }
                return result
              },
            })
        })
        const settle = async () => { for (let i = 0; i < 30; i++) await flushMicrotasks() }
        try {
          await settle()
          await playback.handlePlay(untrack(tracks))
          if (scenario === "capacity-release") {
            setTracks([{ ...initial, clips: [] }])
            await settle()
            expect(published).toHaveLength(1)
            published.length = 0
            preparedTracks.length = 0
            failed = true
          }
          const epoch = fixture.epoch()
          const before = fixture.calls.length
          const compilationsBeforeEdit = compilations
          changed = true
          const desired = { ...initial, clips: scenario === "delete" || scenario === "burst" ? []
            : initial.clips.map((clip) => ({ ...clip, startSec: 0.25, duration: 0.5, bufferOffsetSec: 0.125 })) }
          if (scenario === "loop-inflight") {
            expect(fixture.transportPayloads.at(-1)).toMatchObject({ cycleActive: true, cycleStartSec: 0, cycleEndSec: 1 })
            setTracks([desired])
            await publishing.promise
            setLoopEnabled(false)
            const loop = playback.updateNativeLoop()
            await settle()
            expect(fixture.calls.slice(before).filter((call) => call === "transport")).toHaveLength(0)
            publicationGate.resolve()
            await loop
            expect(fixture.transportPayloads.slice(-2)).toMatchObject([
              { running: false, cycleActive: false },
              { running: true, cycleActive: false },
            ])
            expect(fixture.transportPayloads.at(-1)?.cycleStartSec).toBeUndefined()
            expect(fixture.transportPayloads.at(-1)?.cycleEndSec).toBeUndefined()
          } else if (scenario.startsWith("loop-")) {
            setLoopEnabled(true)
            setLoopEndSec(0.75)
            if (scenario === "loop-ui") void playback.updateNativeLoop()
            if (scenario === "loop-clip") setTracks([desired])
          } else if (scenario === "automation-only" || scenario === "mixer-only") setMixRevision(1)
          else if (scenario === "effect-only") await playback.restartTimelineSchedule(untrack(tracks), { rebuildBackend: true })
          else if (scenario === "tempo") setBpm(137)
          else if (scenario === "burst") {
            for (let i = 1; i <= 5; i++) setTracks([desired, ...Array.from({ length: i }, (_, index) => ({
              ...track, id: `added-${index}`,
            }))])
          } else {
            if (["stale-compile", "burst-during-compile", "inputs-during-compile", "stop", "seek", "project"].includes(scenario)) holdCompile = true
            setTracks(scenario === "add" ? [initial, { ...track, id: "added" }] : [desired])
          }
          if (scenario === "explicit") await playback.restartTimelineSchedule(untrack(tracks), { rebuildBackend: true })
          if (["stale-compile", "burst-during-compile", "inputs-during-compile", "stop", "seek", "project"].includes(scenario)) {
            await compiling.promise
            if (scenario === "inputs-during-compile") {
              for (let index = 1; index <= 10; index++) { setMixRevision(index); await settle() }
            }
            if (scenario === "stale-compile") setTracks([{ ...desired, clips: [] }])
            if (scenario === "burst-during-compile") {
              for (let i = 1; i <= 5; i++) setTracks([{ ...desired, clips: [] },
                ...Array.from({ length: i }, (_, index) => ({ ...track, id: `added-${index}` }))])
            }
            if (scenario === "stop") await playback.handleStop()
            if (scenario === "seek") playback.setPlayhead(1, untrack(tracks))
            if (scenario === "project") setProjectId("next-project")
            expect(preparedTracks).toHaveLength(0)
            gate.resolve()
          }
          await settle()
          if (scenario.endsWith("exhaustion")) {
            for (let event = 0; event < 12; event++) { fixture.emitScheduleProgress(); await settle() }
          }
          if (scenario.startsWith("loop-")) {
            expect(fixture.calls.slice(before).filter((call) => call === "graph")).toHaveLength(0)
            expect(fixture.calls.slice(before).filter((call) => call === "transport")).toHaveLength(2)
            expect(published).toHaveLength(scenario === "loop-clip" || scenario === "loop-inflight" ? 1 : 0)
            expect(playback.isPlaying()).toBe(true)
            return
          }
          if (scenario === "stop" || scenario === "project" || scenario === "seek") {
            expect(published).toHaveLength(scenario === "seek" ? 1 : 0)
            expect(playback.isPlaying()).toBe(scenario === "seek")
            if (scenario === "seek") expect(fixture.calls.slice(before).filter((call) =>
              ["configure", "begin", "graph"].includes(call))).toEqual([])
            return
          }
          if (["failure", "rejection", "publish-error", "compile-error", "progress-retry",
            "capacity-release", "pending-exhaustion", "rebase-exhaustion"].includes(scenario)) {
            if (scenario === "pending-exhaustion") expect(preparedTracks).toHaveLength(9)
            if (scenario === "rebase-exhaustion") expect(publishAttempts).toBe(9)
            expect(published).toHaveLength(0)
            expect(playback.isPlaying()).toBe(true)
            expect(fixture.calls.slice(before)).not.toContain("graph")
            {
              const attempts = preparedTracks.length
              const compiled = compilations
              const publishCount = publishAttempts
              for (let event = 0; event < 25; event++) {
                fixture.emitScheduleProgress()
                await settle()
              }
              expect(preparedTracks).toHaveLength(attempts)
              expect(compilations).toBe(compiled)
              expect(publishAttempts).toBe(publishCount)
            }
            failed = false
            if (scenario === "capacity-release") {
              const attempts = preparedTracks.length
              const compiled = compilations
              releaseAck.resolve()
              await settle()
              expect(preparedTracks).toHaveLength(attempts)
              fixture.emitScheduleProgress(1n)
              await settle()
              expect(preparedTracks).toHaveLength(attempts + 1)
              expect(compilations).toBe(compiled)
            }
            if (scenario === "pending-exhaustion") {
              const attempts = preparedTracks.length
              fixture.emitScheduleProgress(1n)
              await settle()
              expect(preparedTracks).toHaveLength(attempts + 1)
              expect(published).toHaveLength(1)
              for (let event = 0; event < 5; event++) { fixture.emitScheduleProgress(1n); await settle() }
              expect(preparedTracks).toHaveLength(attempts + 1)
              return
            }
            if (scenario === "progress-retry") {
              const compiled = compilations
              await playback.restartTimelineSchedule(untrack(tracks))
              expect(compilations).toBe(compiled)
            }
            if (!["progress-retry", "capacity-release"].includes(scenario)) setTracks([{ ...desired, clips: [] }, { ...track, id: "latest" }])
            fixture.emitScheduleProgress()
            await settle()
          }
          if (scenario === "unsupported") {
            expect(fixture.calls.slice(before).filter((call) => call === "graph")).toHaveLength(1)
            expect(published).toHaveLength(0)
          } else {
            expect(published).toHaveLength(1)
            if (scenario === "inputs-during-compile") expect(compilationsAtPublication[0]).toBe(compilationsBeforeEdit + 1)
            expect(stagedWindows.length).toBeGreaterThan(0)
            expect(stagedWindows.every((bytes) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true) === epoch)).toBe(true)
            expect(preparedTracks.at(-1)).toEqual(untrack(tracks))
            if (scenario === "duplicate" || scenario === "explicit") {
              setTracks(untrack(tracks).map((entry) => ({ ...entry })))
              await playback.restartTimelineSchedule(untrack(tracks))
              await settle()
              expect(published).toHaveLength(1)
            }
            expect(fixture.epoch()).toBe(epoch)
            expect(fixture.calls.slice(before).filter((call) =>
              ["stop", "teardown", "configure", "begin", "graph"].includes(call))).toEqual([])
            expect(fixture.calls.slice(before).filter((call) => call === "transport"))
              .toHaveLength(["tempo", "time-signature"].includes(scenario) ? 1 : 0)
          }
          expect(playback.isPlaying()).toBe(true)
        } finally { gate.resolve(); releaseAck.resolve(); dispose(); await settle() }
      })
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
      else Reflect.deleteProperty(globalThis, "window")
      if (previousBuffer) Object.defineProperty(globalThis, "AudioBuffer", previousBuffer)
      else Reflect.deleteProperty(globalThis, "AudioBuffer")
    }
  })
}

test.skipIf(isServer)('recording save hydration cannot retire active playback before Stop, Pause, or record-only Finish', async () => {
  const previousWindow = globalThis.window
  const previousAudioBuffer = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer')
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
  try {
    for (const intent of ['stop', 'pause', 'record-only']) {
      const fixture = createNativeHookBridge()
      const faults: string[] = []
      const [tracks, setTracks] = createSignal<Track[]>([track])
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { dawDesktop: { audioHost: fixture.audioHost } },
      })
      await withFakeRaf(async (flushRaf) => {
        let dispose = () => {}
        const playback = createRoot((cleanup) => {
          dispose = cleanup
          return useTimelinePlayback(
            createFakeEngine({ clipId: 'recorded', startSec: 0, endSec: 1 }).engine,
            { getTracks: tracks },
            {
              requiresNativeAudio: true,
              enabled: () => true,
              projectId: () => 'project',
              compileSnapshot: nativeRequiredSnapshot,
              reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
            },
          )
        })
        const sourceRelease = Promise.withResolvers<void>()
        try {
          await flushMicrotasks()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          playback.setPlayhead(1, untrack(tracks))
          await flushMicrotasks()
          await playback.handlePlay(untrack(tracks))
          expect(playback.isNativePlayback()).toBeTrue()

          // Timeline awaits recording Stop/save before its transport Stop/Pause.
          // Clip creation projects a source-backed clip without a decoded buffer;
          // source release (or normal asset hydration) may settle much later.
          const save = Promise.resolve().then(async () => {
            setTracks([audioTrack(null)])
            await sourceRelease.promise
          })
          const transport = save.then(() => {
            if (intent === 'stop') return playback.handleStop()
            if (intent === 'pause') return playback.handlePause()
          })
          await flushMicrotasks()
          flushRaf()
          expect(faults).toEqual([])
          expect(playback.isPlaying()).toBeTrue()
          expect(playback.isNativePlayback()).toBeTrue()
          expect(fixture.calls).not.toContain('stop')
          expect(fixture.calls).not.toContain('teardown')

          // Playback stays owned throughout the hydration/release wait, not just
          // for a grace period. This also covers hydration before source release.
          setTracks([audioTrack(new TestAudioBuffer())])
          await flushMicrotasks()
          flushRaf()
          expect(faults).toEqual([])
          expect(playback.isNativePlayback()).toBeTrue()
          sourceRelease.resolve()
          await transport
          flushRaf()
          expect(faults).toEqual([])
          expect(playback.isPlaying()).toBe(intent === 'record-only')
          if (intent === 'stop') {
            expect(playback.playheadSec()).toBe(0)
            expect(fixture.calls).toContain('teardown')
          } else {
            expect(playback.playheadSec()).toBe(1)
            expect(fixture.calls).not.toContain('teardown')
          }
          if (intent === 'record-only') await playback.handlePause()
          await playback.handlePlay(untrack(tracks))
          expect(playback.isPlaying()).toBeTrue()
          expect(playback.isNativePlayback()).toBeTrue()
          await playback.handleStop()
          expect(faults).toEqual([])
        } finally {
          sourceRelease.resolve()
          dispose()
          await flushMicrotasks()
        }
      })
    }
  } finally {
    if (previousAudioBuffer) Object.defineProperty(globalThis, 'AudioBuffer', previousAudioBuffer)
    else Reflect.deleteProperty(globalThis, 'AudioBuffer')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test.skipIf(isServer)('pending save hydration still reports real host loss and honors project retirement', async () => {
  const previousWindow = globalThis.window
  const previousAudioBuffer = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer')
  Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
  try {
    for (const transition of ['loss', 'graph-retired', 'project', 'generation']) {
      const fixture = createNativeHookBridge()
      const faults: string[] = []
      const [tracks, setTracks] = createSignal<Track[]>([track])
      const [projectId, setProjectId] = createSignal('project')
      const [generation, setGeneration] = createSignal(0)
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { dawDesktop: { audioHost: fixture.audioHost } },
      })
      await withFakeRaf(async (flushRaf) => {
        let dispose = () => {}
        const playback = createRoot((cleanup) => {
          dispose = cleanup
          return useTimelinePlayback(
            createFakeEngine({ clipId: 'recorded', startSec: 0, endSec: 1 }).engine,
            { getTracks: tracks },
            {
              requiresNativeAudio: true,
              enabled: () => true,
              projectId,
              projectGeneration: generation,
              compileSnapshot: nativeRequiredSnapshot,
              reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
            },
          )
        })
        try {
          await flushMicrotasks()
          await playback.handlePlay(untrack(tracks))
          setTracks([audioTrack(null)])
          await flushMicrotasks()
          if (transition === 'loss') fixture.emitLoss()
          else if (transition === 'graph-retired') await playback.disposePreparedBackends(undefined, "test-graph-retired")
          else if (transition === 'project') setProjectId('another-project')
          else setGeneration(1)
          await flushMicrotasks()
          flushRaf()
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.isNativePlayback()).toBeFalse()
          if (transition === 'loss') {
            expect(faults).toEqual(['Native playback host connection was lost.'])
          } else if (transition === 'graph-retired') {
            expect(faults).toEqual(['Native audio playback stopped because the native graph is no longer active.'])
          } else {
            expect(faults).toEqual([])
            expect(fixture.calls).toContain('teardown')
            setTracks([track])
            await flushMicrotasks()
            await playback.handlePlay(untrack(tracks))
            expect(playback.isPlaying()).toBeTrue()
            await playback.handleStop()
          }
        } finally {
          dispose()
          await flushMicrotasks()
        }
      })
    }
  } finally {
    if (previousAudioBuffer) Object.defineProperty(globalThis, 'AudioBuffer', previousAudioBuffer)
    else Reflect.deleteProperty(globalThis, 'AudioBuffer')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('keeps lifecycle state reactive while limiting it to native backend selection', async () => {
  const source = await readFile(new URL("./useTimelinePlayback.ts", import.meta.url), "utf8")
  expect(source).toContain("const [audioLifecycleState, setAudioLifecycleState] = createSignal")
  expect(source).toContain("audioLifecycleState() === \"ready\"")
  expect(source).toContain("if (lifecycleState === \"suspended\") return")
  expect(source).not.toContain("if (audioLifecycleState === \"failed\")")
})

test('fingerprints all playback-relevant audio clip compiler fields for paused preview', async () => {
  const source = await readFile(new URL("./useTimelinePlayback.ts", import.meta.url), "utf8")
  const fingerprint = source.slice(
    source.indexOf("const readNativePreviewTrackFingerprint"),
    source.indexOf("  const disposeNativePreview", source.indexOf("const readNativePreviewTrackFingerprint")),
  )
  // B6f5 step 5b: the track fields are the union of those the native and portable compiles read; a name or colour is not.
  const trackFields = fingerprint.match(/tracks\.map\(\(\{ ([^}]+) \}\) => \(\{/)?.[1]?.split(", ")
  expect(trackFields).toEqual(["id", "kind", "channelRole", "groupId", "volume", "muted", "soloed", "sends", "outputTargetId", "clips"])
  expect(trackFields?.filter((field) => field === "name" || field === "color")).toEqual([])
  expect(fingerprint).toContain("clips.map((clip)")
  expect(fingerprint).toContain("buffer: readBufferFingerprint(buffer)")
  expect(fingerprint).not.toContain("clip.id")
})

test('waits for audio clip hydration before native paused preview and retries after hydration', async () => {
  const previousWindow = globalThis.window
  const [tracks, setTracks] = createSignal([audioTrack(null)])
  const hydratedTrack = audioTrack(new TestAudioBuffer())
  const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
  const faults: string[] = []
  const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]["transport"]) => (
    compileLivePlaybackSnapshot({
      revision: 1,
      bpm: 120,
      transport,
      tracks: tracks(),
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
      sidechainRoutes: [],
    })
  )
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    let dispose = () => {}
    const playback = createRoot((cleanup) => {
      dispose = cleanup
      return useTimelinePlayback(
        createFakeEngine({ clipId: "clip-audio", startSec: 0, endSec: 1 }).engine,
        { getTracks: () => tracks() },
        {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot,
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        },
      )
    })
    await flushMicrotasks()
    expect(fixture.calls).not.toContain("begin")
    expect(faults).toEqual([])
    expect(playback.isNativePlaybackPrepared()).toBeFalse()

    if (!isServer) {
      setTracks(() => [hydratedTrack])
      await flushMicrotasks()
      expect(untrack(tracks)).toEqual([hydratedTrack])
      expect(fixture.calls).toContain("begin")
      expect(faults).toEqual([])
      expect(playback.isNativePlaybackPrepared()).toBeTrue()
    }
    dispose()
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('reports unhydrated native audio when playback is explicitly requested', async () => {
  const previousWindow = globalThis.window
  const unhydratedTracks = [audioTrack(null)]
  const fixture = createNativeHookBridge()
  const faults: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(
        createFakeEngine({ clipId: "clip-audio", startSec: 0, endSec: 1 }).engine,
        { getTracks: () => unhydratedTracks },
        {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: unhydratedTracks,
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        },
      )
      await flushMicrotasks()
      expect(faults).toEqual([])

      await playback.handlePlay(unhydratedTracks)
      expect(fixture.calls).not.toContain("begin")
      expect(faults).toEqual(['Audio clip "clip-audio" is not hydrated.'])
      expect(playback.isPlaying()).toBeFalse()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})


test("STEP7B3 real host paused edit during claimed latency", async () => {
  // Run the standalone acceptance fixture in its own browser-conditioned
  // process: it owns IDB, virtual time and the mounted hook's global host.
  const fixturePath = new URL("../../tools/acceptance/ae-08-processor-state-fuzz-hook.ts", import.meta.url).pathname
  const child = Bun.spawn(["perl", "-e", "alarm shift; exec @ARGV", "20", process.execPath,
    "--conditions=browser", "-e", `
      import assert from "node:assert/strict"
      import createFixture from ${JSON.stringify(fixturePath)}
      const f = await createFixture(() => {}, 994)
      let turn = 0
      const step = async () => {
        const enabled = f.enabled()
        const frame = turn++ % 2 ? "deliver-progress" : "render-block"
        const action = enabled.find(action => ["control-wake", "deliver-reply", "resolve-compile", "idb-task", "publication-acknowledge"].includes(action.kind))
          ?? enabled.find(action => action.kind === frame)
          ?? enabled.find(action => action.kind === "render-block")
        if (!action) return false
        await f.act(action)
        return true
      }
      const drain = async done => {
        for (let index = 0; index < 800 && !done(); index++) if (!await step()) break
        assert(done(), "real host reaches requested premise")
      }
      try {
        await f.act({ kind: "lifecycle-ready" })
        await drain(() => f.state().prepared && !f.state().preparing)
        await f.act({ kind: "start" })
        await drain(() => f.state().running && f.state().playing && !f.state().preparing)
        await f.act({ kind: "latency", value: 2048 })
        await drain(() => f.enabled().some(action => action.kind === "publication-acknowledge"))
        await f.act({ kind: "pause" })
        const before = f.state().metrics.compileCount
        await f.act({ kind: "clip-timing", value: 0.75 })
        assert.equal(f.state().counts.stop ?? 0, 0, "held publication is not stopped by the fresh edit")
        await drain(() => !f.state().waiters.some(waiter => waiter.name === "pause" && !waiter.settled))
        for (let index = 0; index < 120; index++) await step()
        const final = f.state()
        console.log("STEP7B3-REAL-HOST-FINAL", JSON.stringify({
          before, after: final.metrics.compileCount, prepared: final.prepared,
          counts: final.counts, bankSources: final.bankSources,
        }))
        assert(!final.prepared || (final.metrics.compileCount > before && final.bankSources.length > 0),
          "latest paused structure is installed or the stale preview is invalidated")
      } finally { await f.cleanup() }
      process.exit(0)
    `], { stdout: "pipe", stderr: "pipe" })
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    console.log(stdout)
    expect(code, stderr).toBe(0)
  } finally {
    child.kill()
    await child.exited
  }
}, 30000)

for (const resume of [false, true]) test(`STEP7B3 real paused structural edit during held publication${resume ? " then queued start" : ""}`, async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer")
  Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: TestAudioBuffer })
  const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
  fixture.setScheduleComplete(false)
  const initial = audioTrack(new TestAudioBuffer())
  const [tracks, setTracks] = createSignal<Track[]>([initial])
  const publishGate = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  const transportGate = Promise.withResolvers<void>()
  let holdTransport = false
  let revision = 1, activeRevision = 1, seam = 0n
  let status: "prepared" | "published" | "rolled-back" = "prepared"
  const captures: { state: string; starts: number[] }[] = []
  const reply = async (): Promise<NativeRevisionReply> => ({ ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status, continuity: "accepted", requestedRevision: revision, activeRevision,
      preparedRevision: status === "prepared" ? revision : 0, retiredRevision: 0, renderEpoch: 1n,
      transportEpoch: fixture.epoch(), publicationFrame: status === "published" ? seam : 0n, progressFrame: 0n } })
  const revisions: NativeRevisionSession = {
    prepare: async request => { revision++; seam = request.requestedPublicationFrame ?? 0n; status = "prepared"; return reply() },
    publish: async () => {
      publishing.resolve()
      await publishGate.promise
      status = "published"; activeRevision = revision; fixture.setRuntimeRevision(revision)
      return reply()
    },
    inspect: reply,
    rollback: async () => { status = "rolled-back"; return reply() },
    retire: reply,
  }
  const setTransport = fixture.audioHost.session.setTransport
  fixture.audioHost.session.setTransport = async transport => {
    if (holdTransport && !transport.running) await transportGate.promise
    return setTransport(transport)
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
    ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
      configureInstrumentStates: async () => ({ ok: true }) },
  } } } })
  let dispose = () => {}
  const settle = async () => { for (let i = 0; i < 800; i++) await Promise.resolve() }
  try {
    await withFakeRaf(async () => {
      const playback = createRoot(cleanup => {
        dispose = cleanup
        return useTimelinePlayback(createFakeEngine({ clipId: "x", startSec: 0, endSec: 1 }).engine,
          { getTracks: tracks, bpm: () => 120 }, {
            requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
            compileSnapshot: async transport => {
              const captured = tracks()
              captures.push({ state: transport.state, starts: captured.flatMap(track => track.clips.map(clip => clip.startSec)) })
              return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: captured,
                renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
                sidechainRoutes: [] })
            },
          })
      })
      await settle()
      await playback.handlePlay(untrack(tracks))
      const editA = { ...initial, clips: initial.clips.map(clip => ({ ...clip, startSec: 0.25 })) }
      setTracks([editA])
      await publishing.promise
      holdTransport = true
      const pause = playback.handlePause()
      await settle()
      const before = captures.length
      const stopBefore = fixture.calls.filter(call => call === "stop").length
      const editB = { ...initial, clips: initial.clips.map(clip => ({ ...clip, startSec: 0.75 })) }
      setTracks([editB])
      const restart = resume ? playback.handlePlay(untrack(tracks)) : undefined
      await settle()
      expect(playback.isNativePlaybackPrepared()).toBe(true)
      expect(fixture.calls.filter(call => call === "stop").length).toBe(stopBefore)
      console.log("STEP7B3-PAUSED-EDIT-BEFORE-ACK", JSON.stringify({ before, captures, calls: fixture.calls.slice(-15), prepared: playback.isNativePlaybackPrepared() }))
      if (resume) expect(captures).toHaveLength(before)
      publishGate.resolve(); transportGate.resolve()
      await pause
      await restart
      await settle()
      const latestCaptured = captures.slice(before).some(capture => capture.starts.includes(0.75))
      console.log("STEP7B3-PAUSED-EDIT-FINAL", JSON.stringify({ latestCaptured, captures,
        stopBefore, stopAfter: fixture.calls.filter(call => call === "stop").length,
        prepared: playback.isNativePlaybackPrepared(), playing: playback.isPlaying() }))
      // Either install the new structure or invalidate the old preview. Leaving
      // the old graph advertised as prepared is the regression under review.
      try {
        expect(latestCaptured || !playback.isNativePlaybackPrepared()).toBe(true)
        if (resume) {
          expect(playback.isPlaying()).toBe(true)
          expect(captures.slice(before).filter(capture => capture.state === "playing" && capture.starts.includes(0.75))).toHaveLength(1)
        }
      } finally {
        dispose()
        dispose = () => {}
      }
    })
  } finally {
    publishGate.resolve(); transportGate.resolve()
    dispose()
    await settle()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousBuffer) Object.defineProperty(globalThis, "AudioBuffer", previousBuffer)
    else Reflect.deleteProperty(globalThis, "AudioBuffer")
  }
})

test("B6d2 a paused structural change requested while the pause is pending is not dropped", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const previousBuffer = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer")
  Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: TestAudioBuffer })
  const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
  fixture.setScheduleComplete(false)
  const initial = audioTrack(new TestAudioBuffer())
  const [tracks, setTracks] = createSignal<Track[]>([initial])
  const publishGate = Promise.withResolvers<void>()
  const publishing = Promise.withResolvers<void>()
  let revision = 1
  let status: "prepared" | "rolled-back" = "prepared"
  const captures: number[][] = []
  const reply = async (): Promise<NativeRevisionReply> => ({ ok: true, hostPid: 123, hostGeneration: 7,
    revision: { status, continuity: "accepted", requestedRevision: revision, activeRevision: 1,
      preparedRevision: status === "prepared" ? revision : 0, retiredRevision: 0, renderEpoch: 1n,
      transportEpoch: fixture.epoch(), publicationFrame: 0n, progressFrame: 0n } })
  const revisions: NativeRevisionSession = {
    prepare: async () => { revision++; status = "prepared"; return reply() },
    // The pause wins: native never publishes the adopted edit.
    publish: async () => { publishing.resolve(); await publishGate.promise; status = "rolled-back"; return reply() },
    inspect: reply,
    rollback: async () => { status = "rolled-back"; return reply() },
    retire: reply,
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
    ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
      configureInstrumentStates: async () => ({ ok: true }) },
  } } } })
  let dispose = () => {}
  const settle = async () => { for (let i = 0; i < 800; i++) await Promise.resolve() }
  const begins = () => fixture.calls.filter(call => call === "begin").length
  try {
    await withFakeRaf(async () => {
      const playback = createRoot(cleanup => {
        dispose = cleanup
        return useTimelinePlayback(createFakeEngine({ clipId: "x", startSec: 0, endSec: 1 }).engine,
          { getTracks: tracks, bpm: () => 120 }, {
            requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
            compileSnapshot: async transport => {
              const captured = tracks()
              captures.push(captured.flatMap(track => track.clips.map(clip => clip.startSec)))
              return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: captured,
                renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
                sidechainRoutes: [] })
            },
          })
      })
      await settle()
      await playback.handlePlay(untrack(tracks))
      const before = begins()
      // Adopted while playing; the pause arrives while its publication is in flight.
      setTracks([{ ...initial, clips: initial.clips.map(clip => ({ ...clip, startSec: 0.25 })) }])
      await publishing.promise
      const pause = playback.handlePause()
      await settle()
      publishGate.resolve()
      await pause
      await settle()
      const paused = { begins: begins(), calls: [...fixture.calls], prepared: playback.isNativePlaybackPrepared() }
      try {
        // The paused preview is replaced while paused (a live graph compiled from the edited project), and the next play
        // resumes that replacement instead of preparing again.
        expect(paused).toMatchObject({ prepared: true, begins: before + 1 })
        expect(captures.at(-1)).toEqual([0.25])
        await playback.handlePlay(untrack(tracks))
        await settle()
        console.log("B6D2-PAUSED-STRUCTURE", JSON.stringify({ before, paused, begins: begins(), captures, playing: playback.isPlaying() }))
        expect(begins()).toBe(before + 1)
        expect(captures.at(-1)).toEqual([0.25])
        expect(playback.isPlaying()).toBe(true)
      } finally {
        dispose()
        dispose = () => {}
      }
    })
  } finally {
    publishGate.resolve()
    dispose()
    await settle()
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (previousBuffer) Object.defineProperty(globalThis, "AudioBuffer", previousBuffer)
    else Reflect.deleteProperty(globalThis, "AudioBuffer")
  }
})


describe('useTimelinePlayback deferred stretch retries', () => {
  test('playing seek cancels automation before updating transport seek', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
        await playback.handlePlay([track])

        fake.transportEvents.length = 0
        playback.setPlayhead(4, [track])

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        dispose()
      })
    })
  })

  test('paused seek updates the transport epoch before applying destination automation', async () => {
    const transportEvents: string[] = []
    const engine = {
      ...createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 }).engine,
      onTransportSeek: () => transportEvents.push('onTransportSeek'),
      applyAutomationAtTimelineSec: () => transportEvents.push('applyAutomationAtTimelineSec'),
    }
    await createRoot((dispose) => {
      const playback = useTimelinePlayback(engine)
      playback.setPlayhead(4, [track])
      expect(transportEvents).toEqual(['onTransportSeek', 'applyAutomationAtTimelineSec'])
      dispose()
    })
  })

  test('loop wrap cancels automation before updating transport seek', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, {
          loopEnabled: () => true,
          loopStartSec: () => 2,
          loopEndSec: () => 6,
          getTracks: () => [track],
        })
        await flushMicrotasks()
        await playback.handlePlay([track])

        fake.transportEvents.length = 0
        fake.setCurrentTimelineSec(6.1)
        flushRaf()

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        dispose()
      })
    })
  })

  test('RAF does not retry deferred stretch windows before they become imminent', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        flushRaf()

        expect(fake.scheduleCalls).toHaveLength(1)
        dispose()
      })
    })
  })

  test('stretch readiness retries non-imminent deferred stretch windows', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        fake.notifyStretchReady()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]).toEqual({
          playheadSec: 10,
          opts: {
            preserveExisting: true,
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('RAF retries deferred stretch windows once they become imminent', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(11)
        flushRaf()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]?.opts?.startLimitSec).toBe(12)
        dispose()
      })
    })
  })

  test('live reschedule tracks deferred stretch windows for readiness retry', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(10)
        playback.rescheduleChangedClips([track], 10, ['clip-1'], { endLimitSec: 16 })
        fake.notifyStretchReady()

        expect(fake.scheduleCalls.at(-1)).toEqual({
          playheadSec: 10,
          opts: {
            preserveExisting: true,
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('restarts active playback from the current transport position', async () => {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 12, endSec: 16 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])
        fake.setCurrentTimelineSec(4)
        fake.transportEvents.length = 0

        playback.restartTimelineSchedule([track])

        expect(fake.transportEvents).toEqual(['cancelAutomationSchedules', 'onTransportSeek'])
        expect(fake.scheduleCalls.at(-1)?.playheadSec).toBe(4)
        dispose()
      })
    })
  })

  test('live reschedule clears stale deferred stretch windows when a clip no longer needs stretching', async () => {
    await withFakeRaf(async () => {
      let currentTimelineSec = 0
      let stretchListener = () => {}
      const scheduleCalls: ScheduleCall[] = []
      const engine = {
        get currentTimelineSec() {
          return currentTimelineSec
        },
        ensureAudio: () => {},
        applyAutomationAtTimelineSec: () => {},
        cancelAutomationSchedules: () => {},
        onTransportPause: () => {},
        onTransportSeek: () => {},
        onTransportStart: () => {},
        onTransportStop: () => {},
        resume: async () => {},
        rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
          scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
          return { deferredStretchWindows: [] }
        },
        scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
          scheduleCalls.push({ playheadSec, opts })
          return scheduleCalls.length === 1
            ? { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16 }] }
            : { deferredStretchWindows: [] }
        },
        scheduleAutomationFromPlayhead: () => {},
        stopAllSources: () => {},
        subscribeStretchRenderState: (listener) => {
          stretchListener = listener
          return () => true
        },
      } satisfies Parameters<typeof useTimelinePlayback>[0]

      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine)
        await playback.handlePlay([track])

        currentTimelineSec = 10
        playback.rescheduleChangedClips([track], 10, ['clip-1'], { endLimitSec: 16 })
        stretchListener()

        expect(scheduleCalls).toHaveLength(2)
        dispose()
      })
    })
  })

  test('RAF keeps fallback stretch windows queued for render readiness replacement', async () => {
    await withFakeRaf(async (flushRaf) => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 11, endSec: 15, replaceExistingSource: true })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await playback.handlePlay([track])

        fake.setCurrentTimelineSec(11)
        flushRaf()
        fake.notifyStretchReady()

        expect(fake.scheduleCalls).toHaveLength(2)
        expect(fake.scheduleCalls[1]).toEqual({
          playheadSec: 11,
          opts: {
            startLimitSec: 11,
            endLimitSec: 15,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })

  test('deferred queue upgrades matching windows to replace existing fallback sources', async () => {
    await withFakeRaf(async () => {
      let currentTimelineSec = 0
      let stretchListener = () => {}
      const scheduleCalls: ScheduleCall[] = []
      const engine = {
        get currentTimelineSec() {
          return currentTimelineSec
        },
        ensureAudio: () => {},
        applyAutomationAtTimelineSec: () => {},
        cancelAutomationSchedules: () => {},
        onTransportPause: () => {},
        onTransportSeek: () => {},
        onTransportStart: () => {},
        onTransportStop: () => {},
        resume: async () => {},
        rescheduleClipsAtPlayhead: (_tracks, playheadSec, clipIds, opts) => {
          scheduleCalls.push({ playheadSec, opts: { ...opts, clipIds } })
          return scheduleCalls.length === 2
            ? { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16, replaceExistingSource: true }] }
            : { deferredStretchWindows: [] }
        },
        scheduleAllClipsFromPlayhead: (_tracks, playheadSec, opts) => {
          scheduleCalls.push({ playheadSec, opts })
          return { deferredStretchWindows: [{ clipId: 'clip-1', startSec: 12, endSec: 16 }] }
        },
        scheduleAutomationFromPlayhead: () => {},
        stopAllSources: () => {},
        subscribeStretchRenderState: (listener) => {
          stretchListener = listener
          return () => true
        },
      } satisfies Parameters<typeof useTimelinePlayback>[0]

      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine)
        await playback.handlePlay([track])

        currentTimelineSec = 11
        playback.rescheduleChangedClips([track], 11, ['clip-1'], { endLimitSec: 16 })
        stretchListener()

        expect(scheduleCalls.at(-1)).toEqual({
          playheadSec: 11,
          opts: {
            startLimitSec: 12,
            endLimitSec: 16,
            clipIds: ['clip-1'],
          },
        })
        dispose()
      })
    })
  })
})

test('does not acknowledge stale recovery after suspend or unmount', async () => {
  const previousWindow = globalThis.window
  const gate = Promise.withResolvers<NativeTransactionReply>()
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => ({ accepted: false }),
  }, gate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
      })
      fixture.emitLifecycle({ state: "recovering", powerGeneration: 1 })
      await flushMicrotasks()
      fixture.emitLifecycle({ state: "suspended", powerGeneration: 2 })
      dispose()
      gate.resolve({ ok: true, transactionToken: nativeTransactionToken })
      await flushMicrotasks()
      expect(acknowledgements).toEqual([])
      expect(playback.isPlaying()).toBeFalse()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps legacy recovery inert until explicit play', async () => {
  const previousWindow = globalThis.window
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => ({ accepted: false }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(fake.engine)
      fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
      await flushMicrotasks()
      expect(acknowledgements).toEqual([{ generation: 2, result: "ready" }])
      expect(fake.scheduleCalls).toEqual([])
      expect(playback.isPlaying()).toBeFalse()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('plays through legacy Web Audio while lifecycle is recovering', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "recovering", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fixture.calls).not.toContain("begin")
        expect(fake.scheduleCalls.length).toBeGreaterThan(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('plays through legacy Web Audio and retries native recovery while lifecycle is failed', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return { accepted: true }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        fixture.emitLifecycle({ state: "failed", powerGeneration: 1 })
        await flushMicrotasks()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(retries).toBe(1)
        expect(fixture.calls).not.toContain("begin")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native-required play retries failed recovery and stays stopped while recovery runs', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const lifecycleEmitter: LifecycleEmitter = {
    emit: () => {},
  }
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => {
      retries += 1
      lifecycleEmitter.emit({ state: "recovering", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  lifecycleEmitter.emit = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      await flushMicrotasks()
      expect(retries).toBe(1)
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toEqual([])
      expect(acknowledgements).toEqual([])
      expect(playback.isNativePlaybackPrepared()).toBeTrue()
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native-required play reports rejected recovery and retries it on a later play', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return { accepted: false }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      await playback.handlePlay([track])
      expect(retries).toBe(2)
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toHaveLength(2)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('coalesces concurrent native-required recovery retries', async () => {
  const previousWindow = globalThis.window
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return retryGate.promise
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
      await flushMicrotasks()
      const first = playback.handlePlay([track])
      const second = playback.handlePlay([track])
      await flushMicrotasks()
      expect(retries).toBe(1)
      retryGate.resolve({ accepted: false })
      await Promise.all([first, second])
      expect(playback.isPlaying()).toBeFalse()
      expect(faults).toHaveLength(1)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('allows a rejected recovery retry to be attempted again in the same generation', async () => {
  const previousWindow = globalThis.window
  let retries = 0
  let rejectRetry = true
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      if (rejectRetry) {
        rejectRetry = false
        throw new Error("retry failed")
      }
      return { accepted: true }
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
        await playback.handlePlay([track])
        await flushMicrotasks()
        await playback.handlePause()
        await playback.handlePlay([track])
        await flushMicrotasks()
        expect(retries).toBe(2)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('coalesces concurrent recovery retries', async () => {
  const previousWindow = globalThis.window
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  let retries = 0
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      retries += 1
      return retryGate.promise
    },
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine)
        await flushMicrotasks()
        const first = playback.handlePlay([track])
        const second = playback.handlePlay([track])
        await flushMicrotasks()
        expect(retries).toBe(1)
        retryGate.resolve({ accepted: false })
        await Promise.all([first, second])
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes three rapid play calls into one legacy startup', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    let resumeCalls = 0
    let stopAllSourcesCalls = 0
    const engine = {
      ...fake.engine,
      resume: () => {
        resumeCalls += 1
        return resumeGate.promise
      },
      stopAllSources: () => {
        stopAllSourcesCalls += 1
      },
    }
    await createRoot(async (dispose) => {
      const first = useTimelinePlayback(engine)
      const second = first.handlePlay([track])
      const third = first.handlePlay([track])
      await flushMicrotasks()
      expect(resumeCalls).toBe(1)
      resumeGate.resolve()
      await Promise.all([second, third])
      expect(resumeCalls).toBe(1)
      expect(fake.scheduleCalls).toHaveLength(1)
      expect(stopAllSourcesCalls).toBe(0)
      expect(first.isPlaying()).toBeTrue()
      expect(first.backendDiagnostics().activeBackend).toBe("legacy")
      dispose()
    })
  })
})

test('cancels delayed legacy resume before it schedules playback', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => resumeGate.promise,
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine)
      const play = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      resumeGate.resolve()
      await play
      expect(playback.isPlaying()).toBeFalse()
      expect(fake.scheduleCalls).toEqual([])
      dispose()
    })
  })
})

test('waits for a cancelled play attempt before starting a fresh play', async () => {
  await withFakeRaf(async () => {
    const resumeGates = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ]
    let resumeCalls = 0
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => {
        const gate = resumeGates[resumeCalls]
        resumeCalls += 1
        if (!gate) throw new Error("Unexpected extra resume.")
        return gate.promise
      },
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine)
      const first = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      const second = playback.handlePlay([track])
      const third = playback.handlePlay([track])
      await flushMicrotasks()

      expect(resumeCalls).toBe(1)
      resumeGates[0]?.resolve()
      await flushMicrotasks()
      expect(resumeCalls).toBe(2)
      resumeGates[1]?.resolve()
      await Promise.all([first, second, third])

      expect(fake.scheduleCalls).toHaveLength(1)
      expect(playback.isPlaying()).toBeTrue()
      dispose()
    })
  })
})

test('cancels delayed portable resume before it can start the portable backend', async () => {
  await withFakeRaf(async () => {
    const resumeGate = Promise.withResolvers<void>()
    const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
    const engine = {
      ...fake.engine,
      resume: () => resumeGate.promise,
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(
        engine,
        undefined,
        undefined,
        {
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        },
      )
      const play = playback.handlePlay([track])
      await flushMicrotasks()
      await playback.handlePause()
      resumeGate.resolve()
      await play
      expect(playback.isPlaying()).toBeFalse()
      expect(playback.backendDiagnostics().activeBackend).toBe("idle")
      expect(fake.scheduleCalls).toEqual([])
      dispose()
    })
  })
})

test('cancels delayed native startup and disposes the late backend', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const nativeEnabled = true
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => nativeEnabled,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        await playback.handlePause()
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fake.scheduleCalls).toEqual([])
        expect(fixture.calls).toContain("teardown")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('settles a cancelled native start before replacement playback can rebuild', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [nativeEnabled, setNativeEnabled] = createSignal(false)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: nativeEnabled,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        setNativeEnabled(true)
        const firstPlay = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        await playback.handleStop()
        const replacementPlay = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await firstPlay
        await replacementPlay

        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('cancels an in-flight native preview before selecting portable playback', async () => {
  await withPortableAudioWorklet(async () => {
    const previousWindow = globalThis.window
    const beginGate = Promise.withResolvers<NativeTransactionReply>()
    const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { dawDesktop: { audioHost: fixture.audioHost } },
    })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
        const engine = {
          ...fake.engine,
          getAudioContext: () => new AudioContext(),
        }
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(
            engine,
            undefined,
            {
              enabled: () => true,
              projectId: () => "project",
              compileSnapshot: compileSnapshot,
            },
            { compileSnapshot },
          )
          const note = playback.nativeLiveMidi.start({ trackId: track.id, pitch: 60, velocity: 0.5 })
          await flushMicrotasks()
          expect(fixture.calls).toContain("begin")

          const play = playback.handlePlay([track])
          await flushMicrotasks()
          expect(fixture.calls).toContain("stop")
          expect(fixture.calls).toContain("teardown")

          beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          await play

          expect(playback.isPlaying()).toBeTrue()
          expect(playback.isPortableBrowserPlayback()).toBeTrue()
          expect(playback.isPortableBrowserPlaybackPrepared()).toBeTrue()
          expect(playback.isNativePlaybackPrepared()).toBeFalse()
          expect(playback.backendDiagnostics().activeBackend).toBe("portable-browser")
          if (note) playback.nativeLiveMidi.stop(note)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    }
  })
})

test('an acceptance-owned native session is never acquired or retired by the renderer', async () => {
  const previousWindow = globalThis.window
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "ready", powerGeneration: 1 },
    completeRecovery: async (generation, result) => {
      acknowledgements.push({ generation, result })
      return { accepted: true }
    },
    retryRecovery: async () => ({ accepted: true }),
  })
  const [projectGeneration, setProjectGeneration] = createSignal(1)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { acceptanceExternalNativeSession: true, audioHost: fixture.audioHost } },
  })
  try {
    const faults: string[] = []
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        projectGeneration,
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
      await flushMicrotasks()
      // The mount's paused-preview request.
      expect(fixture.calls).toEqual([])
      await playback.handlePlay([track])
      await flushMicrotasks()
      expect(fixture.calls).toEqual([])
      setProjectGeneration(2)
      await flushMicrotasks()
      expect(fixture.calls).toEqual([])
      const faultsBeforeRecovery = faults.length
      fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
      await flushMicrotasks()
      expect(fixture.calls).toEqual([])
      expect(acknowledgements).toEqual([{ generation: 2, result: "ready" }])
      expect(faults).toHaveLength(faultsBeforeRecovery)
      dispose()
      await flushMicrotasks()
      expect(fixture.calls).toEqual([])
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('rebuilds from the persisted generation when native insertion races delayed startup', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [nativeEnabled, setNativeEnabled] = createSignal(false)
  let projectGeneration = 1
  let insertionOrder = ['old']
  const compiled: Array<{ generation: number; order: string[] }> = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: nativeEnabled,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: async (transport) => {
            compiled.push({ generation: projectGeneration, order: [...insertionOrder] })
            return compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: [track],
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            })
          },
        })
        setNativeEnabled(true)
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        insertionOrder = ["new"]
        projectGeneration = 2
        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeFalse()

        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()
        await play

        expect(compiled.at(-1)).toEqual({ generation: 2, order: ["new"] })
        expect(compiled.some((entry) => entry.generation === 1)).toBeTrue()
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps a paused portable session compatible when enabling a loop', async () => {
  await withPortableAudioWorklet(async () => {
    const [loopEnabled, setLoopEnabled] = createSignal(false)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          {
            loopEnabled,
            loopStartSec: () => 0,
            loopEndSec: () => 2,
            getTracks: () => [track],
          },
          undefined,
          { compileSnapshot },
        )
        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeTrue()

        setLoopEnabled(true)
        await expect(playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          playheadSec: 0,
        })).resolves.toBeUndefined()

        expect(loopEnabled()).toBeTrue()
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("portable-browser")

        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.usesLegacyAudioEngine()).toBeFalse()
        expect(playback.isPortableBrowserPlayback()).toBeTrue()
        expect(loopEnabled()).toBeTrue()
        dispose()
      })
    })
  })
})

test('rebuilds active portable playback into compatibility playback for a loop', async () => {
  await withPortableAudioWorklet(async () => {
    const [loopEnabled, setLoopEnabled] = createSignal(false)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          {
            loopEnabled,
            loopStartSec: () => 0,
            loopEndSec: () => 2,
            getTracks: () => [track],
          },
          undefined,
          { compileSnapshot },
        )
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        setLoopEnabled(true)
        await expect(playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 0,
          owner: "portable-browser",
        })).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeTrue()
        expect(playback.usesLegacyAudioEngine()).toBeFalse()
        expect(playback.isPortableBrowserPlayback()).toBeTrue()
        expect(loopEnabled()).toBeTrue()
        dispose()
      })
    })
  })
})

test('preserves an explicitly captured native owner across queued generation rebuilds', async () => {
  await withPortableAudioWorklet(async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [projectGeneration, setProjectGeneration] = createSignal(1)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { dawDesktop: { audioHost: fixture.audioHost } },
    })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
        const engine = {
          ...fake.engine,
          getAudioContext: () => new AudioContext(),
        }
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(
            engine,
            undefined,
            {
              enabled: () => true,
              projectId: () => "project",
              projectGeneration,
              compileSnapshot,
            },
            {
              projectGeneration,
              compileSnapshot,
            },
          )
          await flushMicrotasks()
          await playback.handlePlay([track])
          expect(playback.backendDiagnostics().activeBackend).toBe("portable-browser")

          setProjectGeneration(2)
          await flushMicrotasks()
          const first = playback.restartTimelineSchedule([track], {
            rebuildBackend: true,
            resumePlayback: true,
            playheadSec: 1,
            owner: "native",
            projectId: "project",
            projectGeneration: 2,
          })
          const second = playback.restartTimelineSchedule([track], {
            rebuildBackend: true,
            resumePlayback: true,
            playheadSec: 2,
            owner: "native",
            projectId: "project",
            projectGeneration: 2,
          })
          await Promise.all([first, second])

          expect(playback.isPlaying()).toBeTrue()
          expect(playback.backendDiagnostics().activeBackend).toBe("native")
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.isPortableBrowserPlaybackPrepared()).toBeFalse()
          expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
          expect(fixture.transportFrames.at(-1)).toBe(96_000)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    }
  })
})

test('pauses Web Audio transport before disposing portable playback on project generation change', async () => {
  await withPortableAudioWorklet(async () => {
    const [projectGeneration, setProjectGeneration] = createSignal(1)
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, undefined, {
          projectGeneration,
          compileSnapshot,
        })
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        fake.transportEvents.length = 0
        setProjectGeneration(2)
        await flushMicrotasks()
        await playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "portable-browser",
          projectGeneration: 2,
        })

        expect(fake.transportEvents).toContain("onTransportPause")
        dispose()
      })
    })
  })
})

test('pauses Web Audio transport before disposing active portable playback on cleanup', async () => {
  await withPortableAudioWorklet(async () => {
    const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => (
      compileLivePlaybackSnapshot({
        revision: 1,
        bpm: 120,
        transport,
        tracks: [track],
        renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
        sidechainRoutes: [],
      })
    )
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        getAudioContext: () => new AudioContext(),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, undefined, { compileSnapshot })
        await playback.handlePlay([track])
        expect(playback.isPortableBrowserPlayback()).toBeTrue()

        fake.transportEvents.length = 0
        dispose()

        expect(fake.transportEvents).toContain("onTransportPause")
        expect(playback.isPortableBrowserPlaybackPrepared()).toBeFalse()
      })
    })
  })
})

test('waits for lifecycle recovery before restarting an active native graph', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "ready", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => false,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(2)
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resolves a pending rebuild when intentional teardown cancels lifecycle readiness', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "suspended", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: false }),
  })
  const faults: string[] = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    let dispose = () => {}
    const playback = createRoot((cleanup) => {
      dispose = cleanup
      return useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        projectId: () => "project",
        compileSnapshot: nativeRequiredSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
    })
    await flushMicrotasks()

    const rebuild = playback.restartTimelineSchedule([track], {
      rebuildBackend: true,
      resumePlayback: true,
      playheadSec: 0,
      owner: "native",
      projectId: "project",
    })
    await flushMicrotasks()
    dispose()

    await expect(rebuild).resolves.toBeUndefined()
    expect(faults).toEqual([])
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resumes an explicitly captured structural rebuild after project generation invalidation', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      let dispose = () => {}
      const playback = createRoot((cleanup) => {
        dispose = cleanup
        return useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      expect(playback.isPlaying()).toBeTrue()

      const intent = {
        resumePlayback: true,
        playheadSec: 3,
        projectId: "project",
      }
      projectGeneration = 2
      await playback.handlePause()
      expect(playback.isPlaying()).toBeFalse()

      await playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        ...intent,
      })

      expect(playback.isPlaying()).toBeTrue()
      expect(fixture.transportStates.filter((running) => running)).toHaveLength(2)
      expect(fixture.transportFrames.at(-1)).toBe(144000)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('resumes after the generation effect disposes playback before structural rebuild', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [projectGeneration, setProjectGeneration] = createSignal(1)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fake.setCurrentTimelineSec(3)
        const intent = {
          resumePlayback: playback.isPlaying(),
          playheadSec: 3,
          projectId: "project",
        }

        setProjectGeneration(2)
        // Bun resolves Solid's createEffect through its server entry point, so
        // model the generation effect's disposal explicitly in this hook test.
        await playback.handlePause()
        expect(playback.isPlaying()).toBeFalse()

        fixture.calls.length = 0
        fixture.transportStates.length = 0
        await playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          ...intent,
        })

        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
        expect(fixture.transportFrames.at(-1)).toBe(144000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('live schedule compile failure retains the active graph for a later retry', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  let compilations = 0
  const faults: string[] = []
  const unsupported = async (): Promise<NativeRevisionReply> => ({ ok: false, error: "not used", kind: "unavailable" })
  const revisions: NativeRevisionSession = { prepare: unsupported, publish: unsupported,
    inspect: unsupported, rollback: unsupported, retire: unsupported }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
    ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
      configureInstrumentStates: async () => ({ ok: true }) },
  } } } })
  try {
    await withFakeRaf(async () => createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
        undefined, { requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          compileSnapshot: async (transport) => {
            compilations++
            if (compilations === 2) return { supported: false, reasons: ["edit remains desired"] }
            return nativeRequiredSnapshot(transport)
          },
        })
      await playback.handlePlay([track])
      const before = fixture.calls.length
      await playback.restartTimelineSchedule([track])
      expect(compilations).toBe(2)
      expect(playback.isPlaying()).toBe(true)
      expect(playback.isNativePlayback()).toBe(true)
      expect(fixture.calls.slice(before)).not.toContain("graph")
      expect(faults).toEqual(["edit remains desired"])
      dispose()
    }))
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('typed-fault-forwarding: a delivery incident reaches the native reportFault option as a typed fault that retains playback', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const received: Array<{ fault: NativePlaybackFault; options: { retainPlayback: true } | undefined }> = []
  const utility = createDefaultUtilityParams()
  const unsupported = async (): Promise<NativeRevisionReply> => ({ ok: false, error: "not used", kind: "unavailable" })
  const revisions: NativeRevisionSession = { prepare: unsupported, publish: unsupported,
    inspect: unsupported, rollback: unsupported, retire: unsupported }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
    ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions,
      configureInstrumentStates: async () => ({ ok: true }),
      queueProcessorStatePatch: async () => ({ ok: true, outcome: "refused", refusal: "invalid", coreResult: 0 }) },
  } } } })
  try {
    await withFakeRaf(async () => createRoot(async (dispose) => {
      const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
        undefined, { requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
          reportFault: (fault, options) => received.push({ fault, options }),
          compileSnapshot: async (transport) => {
            const compiled = await nativeRequiredSnapshot(transport)
            if (!compiled.supported) return compiled
            return { ...compiled, snapshot: { ...compiled.snapshot, mixer: { ...compiled.snapshot.mixer,
              fx: { ...compiled.snapshot.mixer.fx, trackFx: { [track.id]: { instances: [
                { id: "utility:1", kind: "utility", params: { version: 1, state: utility } },
              ] } } } } } }
          },
        })
      await playback.handlePlay([track])
      expect(playback.isPlaying()).toBe(true)
      const edit = createProcessorEditRegistry(() => 120).allocate({
        effect: "utility", instanceId: "utility:1", targetId: track.id,
        from: { version: 1, state: utility }, to: { version: 1, state: { ...utility, gainDb: -3 } },
      });
      if (!edit) throw new Error("Missing utility edit.");
      await playback.deliverProcessor({ ...edit, content: { ...edit.content, values: {} } }).settled;
      expect(received).toEqual([{ fault: { kind: "delivery-refused", targets: 1 }, options: { retainPlayback: true } }])
      expect(playback.isPlaying()).toBe(true)
      dispose()
    }))
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

for (const edit of ["audio-add", "audio-move", "audio-resize", "audio-delete", "audio-track-remove", "audio-tempo",
  "asset-add", "asset-replace", "vst-insert", "vst-bypass", "vst-reorder", "instrument-replace", "sampled-add",
  "vst-remove", "sidechain", "midi-mappings", "supported", "publication-failure", "time-signature-move", "vst-insert-move"]) {
  test(`running native edit ${edit} installs desired state through the correct route`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
    let staged = 0
    let compiles = 0
    let desiredInstalled = false
    let changed = false
    let graphs = 0
    let installedRevision = 0n
    const faults: string[] = []
    const audioTrack: RuntimeTrack = { ...track, clips: [{ id: "audio", name: "Audio", color: "#fff",
      startSec: 0, duration: 1, sourceAssetKey: "asset", buffer: new TestAudioBuffer() }] }
    const synthTrack: Track = { ...track, kind: "instrument", clips: [{ id: "midi", name: "MIDI", color: "#fff",
      startSec: 0, duration: 3, midi: { wave: "sawtooth", notes: [{ id: "note", pitch: 60, beat: 0, length: 4, velocity: 0.8 }] } }] }
    const retainedTrack = { ...audioTrack, id: "retained", clips: audioTrack.clips.map((clip) => ({
      ...clip, id: "retained-audio", sourceAssetKey: "retained-asset",
    })) }
    const base: LivePlaybackSnapshotInput = {
      revision: 1, bpm: 120,
      transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
      tracks: edit.startsWith("audio") || edit.startsWith("asset") || edit.endsWith("-move") ? [audioTrack, retainedTrack] : [synthTrack],
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {
        [track.id]: { instances: [], instrument: { kind: "synth", instanceId: "synth", params: createDefaultSynthParams() } },
      } }, automationEnvelopes: [] }, sidechainRoutes: [],
    }
    let desired: LivePlaybackSnapshotInput = { ...base, revision: 2 }
    if (edit === "sidechain") desired = { ...desired, sidechainRoutes: [{
      sourceTrackId: track.id, targetTrackId: "master", effectInstanceId: "external",
    }] }
    if (edit === "midi-mappings") desired = { ...desired, tracks: [{ ...synthTrack,
      clips: synthTrack.clips.map((clip) => ({ ...clip, midi: clip.midi && { ...clip.midi,
        mappings: [{ id: "mapping", source: { kind: "cc", controller: 1, channel: 1 },
          target: { parameterId: "gain" }, outputMin: 0, outputMax: 1 }] } })),
    }] }
    if (edit === "supported") desired = { ...desired, tracks: [{ ...synthTrack,
      clips: synthTrack.clips.map((clip) => ({ ...clip, midi: clip.midi && { ...clip.midi,
        notes: clip.midi.notes.map((note) => ({ ...note, pitch: 62 })) } })),
    }] }
    if (edit === "audio-add" || edit === "asset-add") desired = { ...desired, tracks: [{ ...audioTrack,
      clips: [...audioTrack.clips, { ...audioTrack.clips[0]!, id: "added", startSec: 2,
        sourceAssetKey: edit === "asset-add" ? "new-asset" : "asset" }] }, retainedTrack] }
    if (edit === "audio-move" || edit === "audio-resize" || edit === "asset-replace") desired = { ...desired,
      tracks: [{ ...audioTrack, clips: audioTrack.clips.map((clip) => ({ ...clip,
        startSec: edit === "audio-move" ? 2 : 0, duration: edit === "audio-resize" ? 0.5 : 1,
        buffer: edit === "asset-replace" ? new TestAudioBuffer() : clip.buffer })) }, retainedTrack] }
    if (edit === "audio-delete") desired = { ...desired, tracks: [{ ...audioTrack, clips: [] }, retainedTrack] }
    if (edit === "audio-track-remove") desired = { ...desired, tracks: [retainedTrack, {
      ...audioTrack, id: "added-track", clips: audioTrack.clips.map((clip) => ({
        ...clip, id: "added-audio", sourceAssetKey: "added-asset",
      })),
    }],
      renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: {} } } }
    if (edit === "audio-tempo") desired = { ...desired, bpm: 130 }
    if (edit.endsWith("-move")) desired = { ...desired, tracks: [{ ...audioTrack,
      clips: audioTrack.clips.map((clip) => ({ ...clip, startSec: 1 })) }, retainedTrack] }
    if (edit === "time-signature-move") desired = { ...desired, timeSignature: { numerator: 3, denominator: 4 } }
    if (edit === "instrument-replace") desired = { ...desired,
      renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: {
        [track.id]: { instances: [], instrument: { kind: "synth", instanceId: "synth",
          params: { ...createDefaultSynthParams(), gain: 0.2 } } },
      } } } }
    if (edit === "sampled-add") desired = { ...desired,
      tracks: [...base.tracks, { ...synthTrack, id: "sampled", clips: [] }],
      renderState: { ...base.renderState, fx: { ...base.renderState.fx, trackFx: { ...base.renderState.fx.trackFx,
        sampled: { instances: [], instrument: { kind: "sampler", instanceId: "sampled", params: createDefaultSamplerParams() } },
      } } } }
    let seam = 0n
    let status: "prepared" | "published" | "invalid-revision" = "prepared"
    const reply = async (): Promise<NativeRevisionReply> => ({ ok: true, hostPid: 123, hostGeneration: 7,
      revision: { status, continuity: "accepted", requestedRevision: 2, activeRevision: status === "published" ? 2 : 1,
        preparedRevision: status === "prepared" ? 2 : 0, retiredRevision: 0, renderEpoch: 1n, transportEpoch: fixture.epoch(),
        publicationFrame: status === "published" ? seam : 0n, progressFrame: seam } })
    const revisions: NativeRevisionSession = { prepare: async (request) => {
      staged++
      seam = request.requestedPublicationFrame ?? 0n
      status = edit === "publication-failure" ? "invalid-revision" : "prepared"
      return reply()
    }, publish: async () => { status = "published"; return reply() }, inspect: reply, rollback: reply, retire: reply }
    const publishGraph = fixture.audioHost.session.publishGraph
    const installedWindows: Uint8Array[] = []
    const queueScheduleWindow = fixture.audioHost.session.queueScheduleWindow
    fixture.audioHost.session.queueScheduleWindow = (bytes) => {
      if (changed) installedWindows.push(bytes)
      return queueScheduleWindow(bytes)
    }
    fixture.audioHost.session.publishGraph = (bytes) => {
      graphs++
      installedRevision = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(0, false)
      if (changed) desiredInstalled = true
      return publishGraph(bytes)
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: {
      ...fixture.audioHost, session: { ...fixture.audioHost.session, revisions, configureInstrumentStates: async () => ({ ok: true }) },
    } } } })
    try {
      await withFakeRaf(async () => createRoot(async (dispose) => {
        const playback = useTimelinePlayback(createFakeEngine({ clipId: "x", startSec: 0, endSec: 1 }).engine,
          undefined, { requiresNativeAudio: true, enabled: () => true, projectId: () => "project",
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
            compileSnapshot: async (transport) => {
              compiles++;
              const compiled = compileLivePlaybackSnapshot({ ...(changed ? desired : base), transport })
              if (!compiled.supported) return compiled
              if (edit.startsWith("vst")) {
                const processor = { ...insertedExternalProcessor(), targetId: track.id,
                  bypassed: changed && edit === "vst-bypass", index: changed && edit === "vst-reorder" ? 1 : 0 }
                const plan = compileNativeExternalAttachmentPlan({ target: "native", graph: compiled.snapshot.mixer.graph,
                  processors: edit.startsWith("vst-insert") && !changed || edit === "vst-remove" && changed ? [] : [processor],
                  workerTransport: { slotCount: 2, maximumFrames: 8192, maximumEventsPerBlock: 128 } })
                if (!plan.supported) throw new Error(plan.reasons.join(" "))
                return { ...compiled, snapshot: { ...compiled.snapshot, nativeExternalAttachmentPlan: plan.plan, requiresNativePlayback: true } }
              }
              return compiled
            } })
        try {
          fixture.setScheduleComplete(false)
          await playback.handlePlay([track])
          expect(playback.isNativePlayback()).toBe(true)
          const beforeCompiles = compiles;
          changed = true
          const restart = playback.restartTimelineSchedule([track], { rebuildBackend: true })
          if (edit === "sidechain" || edit === "midi-mappings") {
            await restart.catch(() => undefined)
            expect(staged).toBe(0)
            expect(graphs).toBe(1)
            expect(desiredInstalled).toBe(false)
            expect(faults.length).toBeGreaterThan(0)
            expect(playback.isPlaying()).toBe(true)
            return
          }
          await restart
          if (edit.startsWith("vst") && !edit.endsWith("-move")) {
            console.log("STEP5 B28 explicit VST carrier", JSON.stringify({ edit, compiles: compiles - beforeCompiles, staged, graphs }));
            // Admission probe, cold-rebuild preflight, then fresh start capture.
            // D5 preserves this explicit external restart route, not one publication.
            expect(compiles - beforeCompiles).toBe(3);
            expect(staged).toBe(0);
            expect(graphs).toBe(2);
          }
          if (edit !== "publication-failure") expect(faults).toEqual([])
          const stagedEdit = ["supported", "audio-add", "audio-move", "audio-resize", "audio-delete", "audio-track-remove",
            "audio-tempo", "asset-replace", "asset-add", "sampled-add", "instrument-replace", "time-signature-move"].includes(edit)
          expect(desiredInstalled).toBe(!stagedEdit && edit !== "publication-failure")
          expect(graphs).toBe(stagedEdit || edit === "publication-failure" ? 1 : 2)
          expect(installedRevision).toBe(stagedEdit || edit === "publication-failure" ? 1n : 2n)
          expect(staged).toBe(stagedEdit ? 1 : edit === "publication-failure" ? 9 : 0)
          if (edit.endsWith("-move")) {
            expect(installedWindows.flatMap((bytes) => {
              const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              const offset = 72 + view.getUint32(44, true) * 48
              return Array.from({ length: view.getUint32(48, true) }, (_, index) =>
                view.getBigInt64(offset + index * 112 + 24, true))
            })).toContain(48_000n)
          }
          expect(playback.isPlaying()).toBe(true)
        } finally { dispose() }
      }))
    } finally { Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow }) }
  })
}

test('instrument readiness waits for Play preparation before comparing the prepared instrument', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const compiling = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => "project",
            compileSnapshot: async (transport) => {
              compiling.resolve()
              await ready.promise
              return nativeRequiredSnapshot(transport)
            },
          },
        )
        try {
          const play = playback.handlePlay([track])
          await compiling.promise
          let compared = false
          const instrumentReady = playback.awaitPlaybackPreparation().then(() => {
            compared = true
            expect(playback.isPlaying()).toBeTrue()
            expect(playback.isNativePlaybackPrepared()).toBeTrue()
          })
          await flushMicrotasks()
          expect(compared).toBeFalse()
          ready.resolve()
          await play
          await instrumentReady
          expect(compared).toBeTrue()
          expect(fixture.calls.filter((call) => call === "configure")).toHaveLength(1)
          expect(fixture.transportStates.at(-1)).toBeTrue()
        } finally {
          ready.resolve()
          dispose()
        }
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('instrument readiness stops waiting on disposal during an unresolved compile', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const compiling = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => "project",
            compileSnapshot: async (transport) => {
              compiling.resolve()
              await ready.promise
              return nativeRequiredSnapshot(transport)
            },
          },
        )
        try {
          const play = playback.handlePlay([track])
          await compiling.promise
          let waiting = true
          const readiness = playback.awaitPlaybackPreparation().then(() => { waiting = false })
          dispose()
          await flushMicrotasks()
          expect(waiting).toBeFalse()
          ready.resolve()
          await play
          await readiness
        } finally {
          ready.resolve()
          dispose()
        }
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps Play visible throughout a cold native rebuild and resumes at the stopped host position', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const rebuilding = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<NativeTransactionReply>()
  const begin = fixture.audioHost.session.beginTransaction
  let holdRebuild = false
  fixture.audioHost.session.beginTransaction = async () => {
    if (!holdRebuild) return begin()
    rebuilding.resolve()
    return ready.promise
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: {
      ...fixture.audioHost,
      diagnostics: async () => ({ ok: true, status: { pid: 123, generation: 7 }, configurationGeneration: 1, diagnostics: {
        transportFrame: 3072n, activeRevision: 1, transportEpoch: 1,
      } }),
    } } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => "project",
            compileSnapshot: nativeRequiredSnapshot,
          },
        )
        try {
          await playback.handlePlay([track])
          holdRebuild = true
          const rebuild = playback.restartTimelineSchedule([track], {
            rebuildBackend: true,
            resumePlayback: true,
            playheadSec: 2560 / 48000,
            owner: "native",
          })
          await rebuilding.promise
          expect(playback.isPlaying()).toBeTrue()
          ready.resolve({ ok: true, transactionToken: nativeTransactionToken })
          await rebuild
          expect(playback.isPlaying()).toBeTrue()
          expect(fixture.transportStates.at(-1)).toBeTrue()
          expect(fixture.transportFrames.at(-1)).toBe(3072)
        } finally {
          ready.resolve({ ok: true, transactionToken: nativeTransactionToken })
          dispose()
        }
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

for (const failure of ["loss", "suspended", "failed"]) {
  test(`clears cold rebuild Play intent immediately on ${failure}`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge(undefined, {
      initial: { state: "ready", powerGeneration: 0 },
      completeRecovery: async () => ({ accepted: true }),
      retryRecovery: async () => ({ accepted: true }),
    })
    const rebuilding = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<NativeTransactionReply>()
    const begin = fixture.audioHost.session.beginTransaction
    let holdRebuild = false
    fixture.audioHost.session.beginTransaction = async () => {
      if (!holdRebuild) return begin()
      rebuilding.resolve()
      return ready.promise
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { dawDesktop: { audioHost: fixture.audioHost } },
    })
    try {
      await withFakeRaf(async () => {
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(
            createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
            undefined,
            { requiresNativeAudio: true, enabled: () => true, projectId: () => "project", compileSnapshot: nativeRequiredSnapshot },
          )
          try {
            await flushMicrotasks()
            await playback.handlePlay([track])
            holdRebuild = true
            const rebuild = playback.restartTimelineSchedule([track], {
              rebuildBackend: true, resumePlayback: true, playheadSec: 0, owner: "native",
            })
            await rebuilding.promise
            expect(playback.isPlaying()).toBeTrue()
            const runningCount = fixture.transportStates.filter(Boolean).length
            if (failure === "loss") fixture.emitLoss()
            else fixture.emitLifecycle({ state: failure === "suspended" ? "suspended" : "failed", powerGeneration: 1 })
            await flushMicrotasks()
            expect(playback.isPlaying()).toBeFalse()
            ready.resolve({ ok: true, transactionToken: nativeTransactionToken })
            await rebuild.catch(() => undefined)
            expect(playback.isPlaying()).toBeFalse()
            expect(fixture.transportStates.filter(Boolean)).toHaveLength(runningCount)
          } finally {
            ready.resolve({ ok: true, transactionToken: nativeTransactionToken })
            dispose()
          }
        })
      })
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
    }
  })
}

test('coalesces queued structural rebuilds and resumes once', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      let dispose = () => {}
      const playback = createRoot((cleanup) => {
        dispose = cleanup
        return useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
      })
      await flushMicrotasks()
      await playback.handlePlay([track])
      fixture.transportStates.length = 0

      const first = playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        resumePlayback: true,
        playheadSec: 1,
        projectId: "project",
      })
      const second = playback.restartTimelineSchedule([track], {
        rebuildBackend: true,
        resumePlayback: true,
        playheadSec: 2,
        projectId: "project",
      })
      await first
      await second

      expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
      expect(fixture.transportFrames.at(-1)).toBe(96000)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('carries the latest inserted processor through coalesced paused rebuild compilation', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const inserted = insertedExternalProcessor()
  const compileContexts: Array<unknown> = []
  const longTrack: Track = {
    id: 'track-2',
    name: 'Track 2',
    volume: 1,
    clips: [],
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => 'project',
          compileSnapshot: async (transport, context) => {
            compileContexts.push(context)
            const result = compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: [longTrack],
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            })
            if (!result.supported) return result
            const processors = await resolveNativeLivePlaybackProcessors({
              projectId: 'project',
              persisted: [],
              seed: context?.externalProcessor,
              readPersisted: async () => undefined,
            })
            const plan = compileNativeExternalAttachmentPlan({
              target: 'native',
              graph: result.snapshot.mixer.graph,
              processors,
              workerTransport: { slotCount: 2, maximumFrames: 8_192, maximumEventsPerBlock: 128 },
            })
            if (!plan.supported) return {
              supported: true as const,
              snapshot: { ...result.snapshot, requiresNativePlayback: true },
            }
            return {
              supported: true as const,
              snapshot: {
                ...result.snapshot,
                nativeExternalAttachmentPlan: plan.plan,
                requiresNativePlayback: true,
              },
            }
          },
        })
        const first = playback.restartTimelineSchedule([longTrack], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          externalProcessor: { projectId: 'project', processor: inserted },
        })
        const second = playback.restartTimelineSchedule([longTrack], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          externalProcessor: { projectId: 'project', processor: inserted },
        })
        await Promise.all([first, second])
        expect(compileContexts).toContainEqual({
          externalProcessor: { projectId: 'project', processor: inserted },
        })
        expect(compileContexts.at(-1)).toEqual({
          externalProcessor: { projectId: 'project', processor: inserted },
        })
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('preserves the latest instrument override across an active structural rebuild', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  const compileContexts: Array<unknown> = []
  const instrumentA = {
    kind: 'drum-rack' as const,
    instanceId: 'instrument-a',
    params: createDefaultDrumRackParams(),
  }
  const instrumentB = {
    kind: 'drum-rack' as const,
    instanceId: 'instrument-b',
    params: createDefaultDrumRackParams(),
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport, context) => {
            compileContexts.push(context)
            return nativeRequiredSnapshot(transport)
          },
        })
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.setBeginGate(beginGate.promise)

        const first = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "native",
          projectId: "project",
          instrumentOverride: { targetId: track.id, instrument: instrumentA },
        })
        await flushMicrotasks()
        expect(playback.isStructuralRebuildInProgress()).toBeTrue()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()

        const second = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: "native",
          projectId: "project",
          instrumentOverride: { targetId: track.id, instrument: instrumentB },
        })
        await flushMicrotasks()
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await Promise.all([first, second])

        expect(compileContexts).toContainEqual({ instrumentOverride: { targetId: track.id, instrument: instrumentA } })
        expect(compileContexts.at(-1)).toEqual({
          instrumentOverride: { targetId: track.id, instrument: instrumentB },
        })
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.isPlaying()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not restart after pause wins an active native rebuild', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.setBeginGate(beginGate.promise)
        fixture.calls.length = 0
        fixture.transportStates.length = 0

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        await flushMicrotasks()
        await playback.handlePause()
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not resume a structural rebuild after stop wins', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.transportStates.length = 0
        fixture.setBeginGate(beginGate.promise)

        const rebuild = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 2,
          projectId: "project",
        })
        await flushMicrotasks()
        await playback.handleStop()
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()
        // Stop wins: nothing resumes, and the paused graph stays live at the start.
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        expect(playback.playheadSec()).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not resume a structural rebuild after switching projects', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  let projectId = "project"
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => projectId,
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        await playback.handlePlay([track])
        fixture.calls.length = 0
        fixture.transportStates.length = 0
        fixture.setBeginGate(beginGate.promise)

        const rebuild = playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: true,
          playheadSec: 2,
          projectId: "project",
        })
        await flushMicrotasks()
        projectId = "other-project"
        projectGeneration = 2
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(fixture.transportStates.filter((running) => running)).toHaveLength(0)
        expect(fixture.calls.filter((call) => call === "teardown").length).toBeGreaterThan(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('rebuilds a delayed paused native preview without committing play intent', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        const note = playback.nativeLiveMidi.start({ trackId: track.id, pitch: 60, velocity: 0.5 })
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)

        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(1)
        expect(fixture.transportStates).not.toContain(true)
        if (note) playback.nativeLiveMidi.stop(note)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('fails safely when the fresh native graph cannot start after insertion', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  let failFreshBegin = false
  const fixture = createNativeHookBridge(() => {
    return failFreshBegin ? "begin" : undefined
  }, undefined, beginGate.promise)
  const [nativeEnabled, setNativeEnabled] = createSignal(false)
  let projectGeneration = 1
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: nativeEnabled,
          projectId: () => "project",
          projectGeneration: () => projectGeneration,
          compileSnapshot: nativeRequiredSnapshot,
        })
        setNativeEnabled(true)
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        projectGeneration = 2
        const rebuild = playback.restartTimelineSchedule([track], { rebuildBackend: true })
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        failFreshBegin = true

        const rebuildError = await rebuild.then(
          () => undefined,
          (cause) => cause instanceof Error ? cause : new Error(String(cause)),
        )
        expect(rebuildError).toBeInstanceOf(Error)
        if (rebuildError instanceof Error) expect(rebuildError.message).toContain("failed")
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fixture.calls.filter((call) => call === "start")).toHaveLength(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes a delayed native pause before immediate play', async () => {
  const previousWindow = globalThis.window
  const pauseGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, pauseGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0
        fixture.transportStates.length = 0

        const pause = playback.handlePause()
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeFalse()

        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(1)

        pauseGate.resolve({ ok: true })
        await Promise.all([pause, play])

        expect(fixture.transportStates.filter((running) => running)).toHaveLength(1)
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("native")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes play behind an in-flight stop while retaining the native session', async () => {
  const previousWindow = globalThis.window
  const stopGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, stopGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0
        fake.transportEvents.length = 0

        const stop = playback.handleStop()
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()

        expect(fixture.calls.filter((call) => call === "transport")).toHaveLength(1)
        expect(fixture.calls).not.toContain("begin")
        expect(playback.isPlaying()).toBeFalse()

        stopGate.resolve({ ok: true })
        await Promise.all([stop, play])

        expect(fixture.calls).not.toContain("teardown")
        expect(fixture.calls).not.toContain("begin")
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlayback()).toBeTrue()
        expect(fake.transportEvents).not.toContain("onTransportStop")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('keeps fallback startup alive across a failed native retry', async () => {
  const previousWindow = globalThis.window
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const resumeGate = Promise.withResolvers<void>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      emitLifecycle({ state: "recovering", powerGeneration: 2 })
      emitLifecycle({ state: "failed", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        resume: () => resumeGate.promise,
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        resumeGate.resolve()
        await play
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fake.scheduleCalls).toHaveLength(1)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('preserves active legacy playback across a failed native retry', async () => {
  const previousWindow = globalThis.window
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const retryGate = Promise.withResolvers<{ accepted: boolean }>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "failed", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => {
      await retryGate.promise
      emitLifecycle({ state: "recovering", powerGeneration: 2 })
      emitLifecycle({ state: "failed", powerGeneration: 2 })
      return { accepted: true }
    },
  })
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        retryGate.resolve({ accepted: true })
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(fixture.calls).not.toContain("begin")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('suspension cancels delayed native startup before it can commit playback', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "recovering", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  }, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "ready", powerGeneration: 2 })
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        fixture.emitLifecycle({ state: "suspended", powerGeneration: 3 })
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(fake.scheduleCalls).toEqual([])
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('failed lifecycle transition cancels delayed native startup', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, {
    initial: { state: "ready", powerGeneration: 1 },
    completeRecovery: async () => ({ accepted: true }),
    retryRecovery: async () => ({ accepted: true }),
  }, beginGate.promise)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls).toContain("begin")
        fixture.emitLifecycle({ state: "failed", powerGeneration: 2 })
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe("idle")
        expect(fake.scheduleCalls).toEqual([])
        expect(fixture.calls).toContain("teardown")
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('native live MIDI availability includes a recoverable native preview', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        expect(playback.nativeLiveMidi.isActive()).toBeFalse()
        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('retries failed recovery only after explicit play and stays paused until ready', async () => {
  const previousWindow = globalThis.window
  let failed = true
  let emitLifecycle = (_lifecycle: DesktopAudioLifecycle) => {}
  const acknowledgements: Array<{ generation: number; result: "ready" | "failed" }> = []
  const fixture = createNativeHookBridge(
    () => failed ? "begin" : undefined,
    {
      initial: { state: "suspended", powerGeneration: 1 },
      completeRecovery: async (generation, result) => {
        acknowledgements.push({ generation, result })
        emitLifecycle({ state: result, powerGeneration: generation })
        return { accepted: true }
      },
      retryRecovery: async () => {
        emitLifecycle({ state: "recovering", powerGeneration: 3 })
        return { accepted: true }
      },
    },
  )
  emitLifecycle = fixture.emitLifecycle
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine, undefined, {
          enabled: () => true,
          projectId: () => "project",
          compileSnapshot: nativeRequiredSnapshot,
        })
        fixture.emitLifecycle({ state: "recovering", powerGeneration: 2 })
        for (let index = 0; index < 100; index += 1) await Promise.resolve()
        expect(acknowledgements).toContainEqual({ generation: 2, result: "failed" })
        failed = false
        await playback.handlePlay([track])
        await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.backendDiagnostics().activeBackend).toBe("legacy")
        expect(acknowledgements).toContainEqual({ generation: 3, result: "ready" })
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        await playback.handlePause()
        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('does not prepare native audio when disabled and keeps browser playback available', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      let webEnsures = 0
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        ensureAudio: () => { webEnsures += 1 },
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => false,
          projectGeneration: () => 1,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(0)
        expect(playback.nativeLiveMidi.isAvailable()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        await playback.handlePlay([track])
        expect(webEnsures).toBe(1)
        expect(playback.isPlaying()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('suppresses native faults while preparing an idle preview', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge('begin')
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine, undefined, {
        enabled: () => true,
        compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
          revision: 1,
          bpm: 120,
          transport,
          tracks: [track],
          renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
          sidechainRoutes: [],
        }),
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })

      playback.nativeLiveMidi.start({ trackId: 'track-1', pitch: 60, velocity: 0.5 })
      await flushMicrotasks()
      expect(fixture.calls).toContain('begin')
      expect(faults).toEqual([])
      expect(playback.backendDiagnostics().activeBackend).toBe('idle')
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('reports native faults and stops active playback', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })

        await playback.handlePlay([track])
        expect(playback.isPlaying()).toBeTrue()

        fixture.emitLoss()
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(faults).toEqual(['Native playback host connection was lost.'])
        expect(fixture.calls).not.toContain('stop')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('uses the committed native backend without scheduling Web Audio', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === 'begin'
      ? { ok: true as const, transactionToken: nativeTransactionToken }
      : { ok: true as const }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dawDesktop: {
        audioHost: {
          resolveOutputDevice: async () => ({
            ok: true,
            device: {
              deviceId,
              name: 'Default',
              nominalSampleRateHz: 48_000,
              outputChannelCount: 2,
              maximumFramesPerBlock: 512,
              available: true,
            },
          }),
          session: {
            configure: async () => {
              const result = await reply('configure')()
              return result.ok ? { ok: true as const, hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } } : result
            },
            beginTransaction: reply('begin'),
            commitTransaction: reply('commit'),
            rollbackTransaction: reply('rollback'),
            installAsset: reply('install'),
            releaseAsset: reply('release'),
            publishGraph: reply('graph'),
            queueParameterEvents: reply('parameter'),
            queueInstrumentEvents: reply('instrument'),
            queueSourceEvents: reply('source'),
            queueScheduleWindow: reply('schedule'),
            reenableVstScheduleAutomation: reply('automation-enable'),
            setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
              calls.push('transport')
              progressSequence += 1n
              queueMicrotask(() => progressListener({
                revision: 1,
                epoch: transport.epoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(transport.frame + 1),
                lastAcceptedWindowId: 1n,
                appliedTransportTransitionId: transport.transitionId ?? progressSequence,
                appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
                running: transport.running,
                scheduleComplete: true,
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              }))
              return { ok: true as const }
            },
            start: reply('start'),
            stop: reply('stop'),
            teardown: reply('teardown'),
            onLoss: () => () => {},
            onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
              progressListener = listener
              return () => { progressListener = () => {} }
            },
          },
        },
      },
    },
  })
  try {
    await withFakeRaf(async () => {
      let nativeEnabled = true
      let webSchedules = 0
      let webEnsures = 0
      const engine = {
        ...createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine,
        ensureAudio: () => { webEnsures += 1 },
        scheduleAllClipsFromPlayhead: () => {
          webSchedules += 1
          return { deferredStretchWindows: [] }
        },
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => nativeEnabled,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })
        await playback.handlePlay([track])
        expect(webEnsures).toBe(0)
        expect(webSchedules).toBe(0)
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        const initialCalls = [...calls]
        await playback.restartTimelineSchedule([track], { rebuildBackend: true })
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'graph')).toHaveLength(2)
        expect(calls.slice(0, initialCalls.length)).toEqual(initialCalls)
        expect(playback.backendDiagnostics()).toEqual({
          version: 2,
          browserDefaultBackend: 'portable-browser',
          browserCompatibilityBackend: 'legacy',
          selection: 'startup-only',
          preActivationFailure: 'compatibility-fallback',
          runtimeFailure: 'stop-and-mute',
          portableBrowserRequiresOptIn: false,
          nativeRequiresOptIn: true,
          activeBackend: 'native',
          requestedNative: true,
          portableBrowserConfigured: false,
        })
        await playback.handlePlay([track])
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        await playback.handlePause()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(playback.nativeLiveMidi.isActive()).toBeTrue()
        nativeEnabled = false
        expect(playback.nativeLiveMidi.isAvailable()).toBeFalse()
        await playback.handlePlay([track])
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'start')).toHaveLength(2)
        expect(calls).not.toContain('release')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('native-required playback does not fall back when native startup fails', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge('begin')
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
    let webEnsures = 0
    const engine = {
      ...fake.engine,
      ensureAudio: () => { webEnsures += 1 },
    }
    await createRoot(async (dispose) => {
      const playback = useTimelinePlayback(engine, undefined, {
        requiresNativeAudio: true,
        enabled: () => true,
        compileSnapshot: async (transport) => nativeRequiredSnapshot(transport),
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
      await playback.handlePlay([track])
      expect(playback.isPlaying()).toBeFalse()
      expect(webEnsures).toBe(0)
      expect(faults.length).toBeGreaterThan(0)
      dispose()
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('preserves a prepared native preview across a paused native seek', async () => {
  const previousWindow = globalThis.window
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, transportGate.promise)
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const transportEvents: string[] = []
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      const engine = {
        ...fake.engine,
        applyAutomationAtTimelineSec: () => transportEvents.push('applyAutomationAtTimelineSec'),
        cancelAutomationSchedules: () => transportEvents.push('cancelAutomationSchedules'),
        onTransportSeek: () => transportEvents.push('onTransportSeek'),
      }
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        const beforeCounts = {
          begin: fixture.calls.filter((call) => call === 'begin').length,
          release: fixture.calls.filter((call) => call === 'release').length,
          stop: fixture.calls.filter((call) => call === 'stop').length,
          teardown: fixture.calls.filter((call) => call === 'teardown').length,
        }

        transportEvents.length = 0
        playback.setPlayhead(4, [track])
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.nativeLiveMidi.isAvailable()).toBeTrue()
        expect(transportEvents).toEqual([])
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(beforeCounts.begin)
        expect(fixture.calls.filter((call) => call === 'release')).toHaveLength(beforeCounts.release)
        expect(fixture.calls.filter((call) => call === 'stop')).toHaveLength(beforeCounts.stop)
        expect(fixture.calls.filter((call) => call === 'teardown')).toHaveLength(beforeCounts.teardown)
        expect(fixture.transportFrames.at(-1)).toBe(192_000)
        expect(fixture.transportStates.at(-1)).toBeFalse()
        expect(faults).toEqual([])

        // A failed seek on an unchanged host must still surface the fault.
        fixture.armTransportGate()
        playback.setPlayhead(5, [track])
        await flushMicrotasks()
        transportGate.reject(new Error('stable host seek failed'))
        await flushMicrotasks()
        expect(faults).toContain('stable host seek failed')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('reconciles a paused seek superseded by native preview fingerprint disposal', async () => {
  const previousWindow = globalThis.window
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, transportGate.promise)
  const [tracks, setTracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const changedTrack: Track = {
        ...track,
        kind: 'instrument',
      }
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          fake.engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          },
        )

        await playback.handlePlay(tracks())
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()

        fixture.armTransportGate()
        playback.setPlayhead(4, tracks())
        await flushMicrotasks()

        setTracks([changedTrack])
        await flushMicrotasks()
        transportGate.resolve({ ok: true })
        await flushMicrotasks()

        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(192_000)

        // The structural edit can request its rebuild BEFORE jumpToClip seeks.
        // Its token has already advanced, but the old graph is still prepared.
        const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true })
        playback.setPlayhead(6, tracks())
        await rebuild
        await flushMicrotasks()
        expect(faults).toEqual([])
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(288_000)

        playback.setPlayhead(8, tracks())
        await playback.disposePreparedBackends(undefined, "test-prepared-backend-dispose")
        await flushMicrotasks()
        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(384_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('B6d3 a paused seek superseded by a structural replacement keeps that replacement', async () => {
  const previousWindow = globalThis.window
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, transportGate.promise)
  const [tracks, setTracks] = createSignal([track])
  const faults: string[] = []
  const compiled: { playheadSec: number; kind: string | undefined }[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => {
            compiled.push({ playheadSec: transport.playheadSec, kind: tracks()[0]?.kind })
            return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
          },
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay(tracks())
        await playback.handlePause()
        const before = fixture.calls.filter(call => call === 'begin').length
        fixture.armTransportGate()
        playback.setPlayhead(4, tracks())
        await flushMicrotasks()
        setTracks([{ ...track, kind: 'instrument' }])
        await flushMicrotasks()
        transportGate.resolve({ ok: true })
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        const begins = fixture.calls.filter(call => call === 'begin').length
        console.log('B6D3-PAUSED-SEEK', JSON.stringify({ before, begins, compiled, frame: fixture.transportFrames.at(-1), faults }))
        // The replacement already holds the edited structure at the seek's position: one prepare, not a second one.
        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(begins).toBe(before + 1)
        expect(compiled.at(-1)).toEqual({ playheadSec: 4, kind: 'instrument' })
        expect(fixture.transportFrames.at(-1)).toBe(192_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('B6d3 a paused structural replacement prepares at the playhead a Stop published while it waited', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const compiled: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => {
            compiled.push(transport.playheadSec)
            return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
          },
        })
        await playback.handlePlay(tracks())
        await playback.handlePause()
        playback.setPlayhead(4, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(fixture.transportFrames.at(-1)).toBe(192_000)
        // The edit's replacement waits for its dispose; the Stop lands in that window.
        setTracks([{ ...track, kind: 'instrument' }])
        void playback.handleStop()
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D3-PAUSED-STOP', JSON.stringify({ compiled, frames: fixture.transportFrames.slice(-2),
          prepared: playback.isNativePlaybackPrepared(), playhead: playback.playheadSec() }))
        expect(playback.playheadSec()).toBe(0)
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(compiled.at(-1)).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

for (const structural of [false, true]) {
  test(`B6d3 a seek made while Play waits on a ${structural ? 'structural replacement' : 'mount'} preview leaves the hook and native in agreement`, async () => {
    const previousWindow = globalThis.window
    const beginGate = Promise.withResolvers<NativeTransactionReply>()
    const transportGate = Promise.withResolvers<{ ok: true }>()
    const fixture = createNativeHookBridge(undefined, undefined, structural ? undefined : beginGate.promise, transportGate.promise)
    const [tracks, setTracks] = createSignal([track])
    const faults: string[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          if (structural) {
            await playback.handlePlay(tracks())
            await playback.handlePause()
            fixture.setBeginGate(beginGate.promise)
            setTracks([{ ...track, kind: 'instrument' }])
          }
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          // A paused preview start is held at its transaction, and Play waits on it.
          expect(fixture.calls.at(-1)).toBe('begin')
          expect(playback.isNativePlaybackPrepared()).toBeFalse()
          // Play from another position than the preview's, so the resume moves the prepared graph.
          playback.setPlayhead(1, tracks())
          const play = playback.handlePlay(tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(undefined)
          beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          // The preview has committed and is still starting when the seek lands; its transport is still in flight.
          const transportsBefore = fixture.transportFrames.length
          fixture.armTransportGate()
          playback.setPlayhead(2, tracks())
          // Hold the seek's transport until the resumed Play has sent its own.
          for (let turn = 0; turn < 400 && fixture.transportFrames.length < transportsBefore + 2; turn += 1) await Promise.resolve()
          transportGate.resolve({ ok: true })
          await play
          for (let index = 0; index < 40; index += 1) await flushMicrotasks()
          const running = fixture.transportStates.at(-1)
          console.log('B6D3-SEEK-PENDING-PLAY', JSON.stringify({ structural, faults, playing: playback.isPlaying(),
            native: playback.isNativePlayback(), running, frame: fixture.transportFrames.at(-1), playhead: playback.playheadSec(),
            backend: playback.backendDiagnostics().activeBackend, prepared: playback.isNativePlaybackPrepared() }))
          expect(faults.filter(fault => fault.includes('could not seek'))).toEqual([])
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.isPlaying()).toBe(running ?? false)
          expect(playback.isNativePlayback()).toBe(running ?? false)
          expect(playback.backendDiagnostics().activeBackend).toBe('native')
          expect(fixture.transportFrames.at(-1)).toBe(Math.round(playback.playheadSec() * 48_000))
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}
for (const { structural, stop } of [{ structural: false, stop: false }, { structural: true, stop: false }, { structural: false, stop: true }]) {
  test(stop
    ? 'B6d4 a Stop issued after a locate superseded a waiting Play still stops'
    : `B6d4 a Play superseded by a locate on a ${structural ? 'structural replacement' : 'mount'} preview keeps playing from the locate`, async () => {
    const previousWindow = globalThis.window
    const beginGate = Promise.withResolvers<NativeTransactionReply>()
    const transportGate = Promise.withResolvers<{ ok: true }>()
    const fixture = createNativeHookBridge(undefined, undefined, structural ? undefined : beginGate.promise, transportGate.promise)
    const [tracks, setTracks] = createSignal([track])
    const faults: string[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          if (structural) {
            await playback.handlePlay(tracks())
            await playback.handlePause()
            fixture.setBeginGate(beginGate.promise)
            setTracks([{ ...track, kind: 'instrument' }])
          }
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          expect(fixture.calls.at(-1)).toBe('begin')
          playback.setPlayhead(1, tracks())
          const play = playback.handlePlay(tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(undefined)
          beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          // The locate lands while Play waits on the committed preview, and wins over it.
          const transportsBefore = fixture.transportFrames.length
          fixture.armTransportGate()
          playback.setPlayhead(2, tracks())
          // The user stops right after the locate, before the superseded Play answers.
          const stopped = stop ? playback.handleStop() : undefined
          for (let turn = 0; turn < 400 && fixture.transportFrames.length < transportsBefore + 2; turn += 1) await Promise.resolve()
          const sentBefore = fixture.transportStates.length
          transportGate.resolve({ ok: true })
          await play
          await stopped
          for (let index = 0; index < 40; index += 1) await flushMicrotasks()
          const sent = fixture.transportStates.slice(sentBefore)
          console.log('B6D4-LOCATE-SUPERSEDES-PLAY', JSON.stringify({ structural, stop, faults, playing: playback.isPlaying(), sent,
            frame: fixture.transportFrames.at(-1), playhead: playback.playheadSec() }))
          expect(faults).toEqual([])
          if (stop) {
            expect(playback.isPlaying()).toBeFalse()
            expect(sent).not.toContain(true)
            expect(playback.playheadSec()).toBe(0)
          } else {
            expect(playback.isPlaying()).toBeTrue()
            expect(playback.isNativePlayback()).toBeTrue()
            expect(fixture.transportStates.at(-1)).toBeTrue()
            expect(fixture.transportFrames.at(-1)).toBe(96_000)
            expect(playback.playheadSec()).toBe(2)
          }
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}

test('B6d4 a locate made while Play waits on an uncommitted preview is applied once the start commits', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [tracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(fixture.calls.at(-1)).toBe('begin')
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        playback.setPlayhead(1, tracks())
        const play = playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        playback.setPlayhead(2, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D4-LOCATE-UNCOMMITTED-START', JSON.stringify({ faults, playing: playback.isPlaying(), running: fixture.transportStates.at(-1),
          frames: fixture.transportFrames, playhead: playback.playheadSec() }))
        expect(faults).toEqual([])
        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportStates.at(-1)).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(96_000)
        expect(playback.playheadSec()).toBe(2)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('B6d4 a Stop in the same tick as a paused structural edit reports no fault', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const faults: string[] = []
  const compiled: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => {
            compiled.push(transport.playheadSec)
            return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
          },
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay(tracks())
        await playback.handlePause()
        playback.setPlayhead(4, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        // The Stop's seek reaches the graph the edit's dispose is retiring.
        setTracks([{ ...track, kind: 'instrument' }])
        void playback.handleStop()
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D4-STOP-RACES-DISPOSE', JSON.stringify({ faults, compiled, prepared: playback.isNativePlaybackPrepared(),
          playhead: playback.playheadSec(), frame: fixture.transportFrames.at(-1) }))
        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(0)
        expect(compiled.at(-1)).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('B6d4 a Stop while the paused replacement is starting keeps a live graph at the start', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const faults: string[] = []
  const compiled: number[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => {
            compiled.push(transport.playheadSec)
            return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
          },
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay(tracks())
        await playback.handlePause()
        playback.setPlayhead(4, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(beginGate.promise)
        setTracks([{ ...track, kind: 'instrument' }])
        for (let turn = 0; turn < 400 && fixture.calls.at(-1) !== 'begin'; turn += 1) await Promise.resolve()
        expect(fixture.calls.at(-1)).toBe('begin')
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        const stop = playback.handleStop()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await stop
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        const begins = fixture.calls.filter(call => call === 'begin').length
        console.log('B6D4-STOP-PENDING-REPLACEMENT', JSON.stringify({ faults, compiled, prepared: playback.isNativePlaybackPrepared(),
          playhead: playback.playheadSec(), frame: fixture.transportFrames.at(-1), calls: fixture.calls.slice(-6) }))
        expect(faults).toEqual([])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        // The next Play resumes that graph instead of preparing another.
        await playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.calls.filter(call => call === 'begin').length).toBe(begins)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
test('B6d5 a Stop while a Play waits on an uncommitted preview leaves nothing running and a live paused graph at the start', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [tracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(fixture.calls.at(-1)).toBe('begin')
        playback.setPlayhead(1, tracks())
        const play = playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        const stop = playback.handleStop()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        await stop
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D5-STOP-CHAINED-PLAY', JSON.stringify({ faults, prepared: playback.isNativePlaybackPrepared(),
          native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(),
          calls: fixture.calls, frames: fixture.transportFrames, running: fixture.transportStates }))
        expect(faults).toEqual([])
        expect(fixture.transportStates).not.toContain(true)
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlayback()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

for (const route of ['stop', 'pause'] as const) {
  test(`B6d5 a ${route === 'stop' ? 'Stop' : 'Pause'} that cancels a pending Play keeps a live paused graph at the ${route === 'stop' ? 'start' : 'pause position'}`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [tracks] = createSignal([track])
    const faults: string[] = []
    const compiled: number[] = []
    let compileGate: Promise<void> | undefined
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => {
              compiled.push(transport.playheadSec)
              await compileGate
              return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
                renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
            },
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          playback.setPlayhead(1, tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          // The Play resuming the prepared graph is held at its recompile, before it sends any transport.
          const held = Promise.withResolvers<void>()
          compileGate = held.promise
          const sentBefore = fixture.transportStates.length
          const play = playback.handlePlay(tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          expect(playback.isPlayPending()).toBeTrue()
          const cancelled = route === 'stop' ? playback.handleStop() : playback.handlePause()
          compileGate = undefined
          held.resolve()
          await play
          await cancelled
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          for (let index = 0; index < 40; index += 1) await flushMicrotasks()
          const position = route === 'stop' ? 0 : 1
          console.log('B6D5-CANCELLED-PLAY-KEEPS-GRAPH', JSON.stringify({ route, faults, compiled, prepared: playback.isNativePlaybackPrepared(),
            playing: playback.isPlaying(), playhead: playback.playheadSec(), frame: fixture.transportFrames.at(-1),
            sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-8) }))
          expect(faults).toEqual([])
          expect(playback.isPlaying()).toBeFalse()
          expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.playheadSec()).toBe(position)
          expect(fixture.transportFrames.at(-1)).toBe(position * 48_000)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}

test('B6d5 a Stop during a rebuild-owned start resumes nothing and keeps a live paused graph at the start', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  const [tracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay(tracks())
        const sentBefore = fixture.transportStates.length
        fixture.setBeginGate(beginGate.promise)
        const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true, resumePlayback: true, playheadSec: 2 })
        for (let turn = 0; turn < 400 && fixture.calls.at(-1) !== 'begin'; turn += 1) await Promise.resolve()
        expect(fixture.calls.at(-1)).toBe('begin')
        const stop = playback.handleStop()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await rebuild
        await stop
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D5-STOP-REBUILD-START', JSON.stringify({ faults, prepared: playback.isNativePlaybackPrepared(),
          playing: playback.isPlaying(), playhead: playback.playheadSec(), frame: fixture.transportFrames.at(-1),
          sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-8) }))
        expect(faults).toEqual([])
        expect(playback.isPlaying()).toBeFalse()
        expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(0)
        expect(fixture.transportFrames.at(-1)).toBe(0)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

for (const stop of ['none', 'waiting', 'after'] as const) {
  test(stop === 'after'
    ? 'B6d5 a Stop after a locate during an uncommitted paused preview still returns it to the start'
    : `B6d5 a locate during an uncommitted paused preview reaches native once it commits${stop === 'waiting' ? ' while Stop waits on it' : ''}`, async () => {
    const previousWindow = globalThis.window
    const beginGate = Promise.withResolvers<NativeTransactionReply>()
    const fixture = createNativeHookBridge()
    const [tracks, setTracks] = createSignal([track])
    const faults: string[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          await playback.handlePlay(tracks())
          await playback.handlePause()
          playback.setPlayhead(4, tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(beginGate.promise)
          setTracks([{ ...track, kind: 'instrument' }])
          for (let turn = 0; turn < 400 && fixture.calls.at(-1) !== 'begin'; turn += 1) await Promise.resolve()
          expect(fixture.calls.at(-1)).toBe('begin')
          const waiting = stop === 'waiting' ? playback.handleStop() : undefined
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          playback.setPlayhead(2, tracks())
          const after = stop === 'after' ? playback.handleStop() : undefined
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(undefined)
          beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          await waiting
          await after
          for (let index = 0; index < 60; index += 1) await flushMicrotasks()
          const position = stop === 'after' ? 0 : 2
          console.log('B6D5-LOCATE-UNCOMMITTED-PREVIEW', JSON.stringify({ stop, faults, prepared: playback.isNativePlaybackPrepared(),
            playing: playback.isPlaying(), playhead: playback.playheadSec(), frames: fixture.transportFrames.slice(-4) }))
          expect(faults).toEqual([])
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.playheadSec()).toBe(position)
          expect(fixture.transportStates.at(-1)).toBeFalse()
          expect(fixture.transportFrames.at(-1)).toBe(position * 48_000)
          // A locate the later Stop superseded never reaches native.
          if (stop === 'after') expect(fixture.transportFrames).not.toContain(96_000)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}

test('B6d5 a Play replayed from a locate stays pending until it plays', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise, transportGate.promise)
  const [tracks] = createSignal([track])
  const faults: string[] = []
  const pending: boolean[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        const pendingNow = createMemo(() => {
          const value = playback.isPlayPending()
          pending.push(value)
          return value
        })
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(fixture.calls.at(-1)).toBe('begin')
        playback.setPlayhead(1, tracks())
        const play = playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        const transportsBefore = fixture.transportFrames.length
        fixture.armTransportGate()
        playback.setPlayhead(2, tracks())
        for (let turn = 0; turn < 400 && fixture.transportFrames.length < transportsBefore + 2; turn += 1) await Promise.resolve()
        transportGate.resolve({ ok: true })
        await play
        for (let index = 0; index < 40; index += 1) await flushMicrotasks()
        console.log('B6D5-REPLAY-PENDING', JSON.stringify({ faults, pending, playing: playback.isPlaying(), frame: fixture.transportFrames.at(-1) }))
        expect(faults).toEqual([])
        expect(playback.isPlaying()).toBeTrue()
        expect(fixture.transportFrames.at(-1)).toBe(96_000)
        expect(pending).toEqual([false, true, false])
        expect(untrack(pendingNow)).toBeFalse()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
for (const hold of ['teardown', 'capture'] as const) {
  test(`B6d6 a Stop while a resuming rebuild retires the playing graph at the ${hold === 'teardown' ? 'teardown' : 'VST state capture'} leaves nothing running and a live paused graph at the start`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [tracks] = createSignal([track])
    const faults: string[] = []
    const retireGate = Promise.withResolvers<void>()
    let retireHeld = false
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: hold === 'capture' ? () => 'project' : undefined,
            captureNativeVstStates: hold === 'capture' ? async () => { retireHeld = true; await retireGate.promise } : undefined,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          await playback.handlePlay(tracks())
          const realTeardown = fixture.audioHost.session.teardown
          if (hold === 'teardown') fixture.audioHost.session.teardown = async () => {
            retireHeld = true
            await retireGate.promise
            return realTeardown()
          }
          // The rebuild is held retiring the playing graph, before it requests its own start.
          const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true, resumePlayback: true, playheadSec: 2 })
          for (let turn = 0; turn < 400 && !retireHeld; turn += 1) await Promise.resolve()
          expect(retireHeld).toBeTrue()
          const sentBefore = fixture.transportStates.length
          const stop = playback.handleStop()
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          retireGate.resolve()
          await rebuild
          await stop
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          for (let index = 0; index < 40; index += 1) await flushMicrotasks()
          console.log('B6D6-STOP-REBUILD-RETIRE', JSON.stringify({ hold, faults, prepared: playback.isNativePlaybackPrepared(),
            playing: playback.isPlaying(), playhead: playback.playheadSec(), frames: fixture.transportFrames,
            sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-10) }))
          expect(faults).toEqual([])
          expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.playheadSec()).toBe(0)
          expect(fixture.transportFrames.at(-1)).toBe(0)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}
for (const release of ['begin', 'teardown'] as const) {
  test(`B6d7 a Stop that joins a held schedule-replacement dispose cancels the Play started inside it (${release} released first) and leaves nothing running and a live paused graph at the start`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [tracks] = createSignal([track])
    const faults: string[] = []
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          await playback.handlePlay(tracks())
          const realTeardown = fixture.audioHost.session.teardown
          const teardownGate = Promise.withResolvers<void>()
          const beginGate = Promise.withResolvers<NativeTransactionReply>()
          let teardownHeld = false
          fixture.audioHost.session.teardown = async () => {
            teardownHeld = true
            await teardownGate.promise
            return realTeardown()
          }
          // The replacement dispose has already cancelled the pending start, so the Play below creates one it never sees.
          const replaced = playback.restartTimelineSchedule(tracks(), { rebuildBackend: false })
          for (let turn = 0; turn < 400 && !teardownHeld; turn += 1) await Promise.resolve()
          expect(teardownHeld).toBeTrue()
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(beginGate.promise)
          const play = playback.handlePlay(tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          expect(playback.isPlayPending()).toBeTrue()
          const sentBefore = fixture.transportStates.length
          const stop = playback.handleStop()
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.audioHost.session.teardown = realTeardown
          fixture.setBeginGate(undefined)
          if (release === 'begin') beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          else teardownGate.resolve()
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          if (release === 'begin') teardownGate.resolve()
          else beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          await Promise.allSettled([replaced, play, stop])
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          for (let index = 0; index < 60; index += 1) await flushMicrotasks()
          console.log('B6D7-STOP-JOINED-DISPOSE', JSON.stringify({ release, faults, prepared: playback.isNativePlaybackPrepared(),
            native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(),
            frames: fixture.transportFrames.slice(sentBefore), sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-10) }))
          expect(faults).toEqual([])
          expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
          expect(playback.isNativePlayback()).toBeFalse()
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.playheadSec()).toBe(0)
          expect(fixture.transportFrames.at(-1)).toBe(0)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}
test('B6d7 a locate during a Pause that cancels a pending Play keeps its paused rebuild and reports no fault', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge(undefined, undefined, beginGate.promise)
  const [tracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(fixture.calls.at(-1)).toBe('begin')
        playback.setPlayhead(1, tracks())
        const play = playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        const pause = playback.handlePause()
        for (let index = 0; index < 5; index += 1) await flushMicrotasks()
        // The locate's rebuild requests its paused start while the cancelled Play's own cleanup dispose is still joining.
        playback.setPlayhead(3, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await play
        await pause
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 60; index += 1) await flushMicrotasks()
        console.log('B6D7-PAUSE-LOCATE-REBUILD', JSON.stringify({ faults, prepared: playback.isNativePlaybackPrepared(), native: playback.isNativePlayback(),
          playing: playback.isPlaying(), pending: playback.isPlayPending(), playhead: playback.playheadSec(),
          begins: fixture.calls.filter(call => call === 'begin').length, calls: fixture.calls.slice(-10), frames: fixture.transportFrames, running: fixture.transportStates }))
        expect(faults).toEqual([])
        expect(fixture.transportStates).not.toContain(true)
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(3)
        expect(fixture.transportFrames.at(-1)).toBe(144_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
test('B6d8 a Pause while a resuming rebuild retires the playing graph keeps a live paused graph at the resume position', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks] = createSignal([track])
  const faults: string[] = []
  const retireGate = Promise.withResolvers<void>()
  let retireHeld = false
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay(tracks())
        const realTeardown = fixture.audioHost.session.teardown
        fixture.audioHost.session.teardown = async () => {
          retireHeld = true
          await retireGate.promise
          return realTeardown()
        }
        // The rebuild is held retiring the playing graph while the transport still shows playing.
        const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true, resumePlayback: true, playheadSec: 2 })
        for (let turn = 0; turn < 400 && !retireHeld; turn += 1) await Promise.resolve()
        expect(retireHeld).toBeTrue()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isStructuralRebuildInProgress()).toBeTrue()
        const sentBefore = fixture.transportStates.length
        const pause = playback.handlePause()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.audioHost.session.teardown = realTeardown
        retireGate.resolve()
        await rebuild
        await pause
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 60; index += 1) await flushMicrotasks()
        console.log('B6D8-PAUSE-RESUMING-REBUILD', JSON.stringify({ faults, prepared: playback.isNativePlaybackPrepared(),
          native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(),
          begins: fixture.calls.filter(call => call === 'begin').length, frames: fixture.transportFrames.slice(sentBefore),
          sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-10) }))
        expect(faults).toEqual([])
        expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(2)
        expect(fixture.transportFrames.at(-1)).toBe(96_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
test('B6d8 a Pause while a paused rebuild is starting keeps a live paused graph at the locate', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks] = createSignal([track])
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        playback.setPlayhead(1, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        const beginGate = Promise.withResolvers<NativeTransactionReply>()
        fixture.setBeginGate(beginGate.promise)
        const beginsBefore = fixture.calls.filter(call => call === 'begin').length
        // MIDI record arming pauses the transport unconditionally, so a Pause can land while a paused rebuild starts.
        const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true })
        for (let turn = 0; turn < 800 && fixture.calls.filter(call => call === 'begin').length === beginsBefore; turn += 1) await Promise.resolve()
        expect(fixture.calls.filter(call => call === 'begin').length).toBe(beginsBefore + 1)
        expect(playback.isStructuralRebuildInProgress()).toBeTrue()
        const sentBefore = fixture.transportStates.length
        const pause = playback.handlePause()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        fixture.setBeginGate(undefined)
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await Promise.allSettled([rebuild, pause])
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 60; index += 1) await flushMicrotasks()
        console.log('B6D8-PAUSE-PAUSED-REBUILD', JSON.stringify({ faults, prepared: playback.isNativePlaybackPrepared(),
          native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(),
          begins: fixture.calls.filter(call => call === 'begin').length, frames: fixture.transportFrames.slice(sentBefore),
          sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-10) }))
        expect(faults).toEqual([])
        expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(playback.playheadSec()).toBe(1)
        expect(fixture.transportFrames.at(-1)).toBe(48_000)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
for (const hold of ['begin', 'teardown'] as const) {
  test(`B6d8 a Stop while a paused rebuild is ${hold === 'begin' ? 'starting' : 'retiring its graph'} leaves nothing running and a live paused graph at the start`, async () => {
    const previousWindow = globalThis.window
    const fixture = createNativeHookBridge()
    const [tracks] = createSignal([track])
    const faults: string[] = []
    const beginGate = Promise.withResolvers<NativeTransactionReply>()
    const retireGate = Promise.withResolvers<void>()
    let held = false
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
    try {
      await withFakeRaf(async () => {
        const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
        await createRoot(async (dispose) => {
          const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
            requiresNativeAudio: true,
            enabled: () => true,
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          })
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          playback.setPlayhead(1, tracks())
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          const realTeardown = fixture.audioHost.session.teardown
          const beginsBefore = fixture.calls.filter(call => call === 'begin').length
          if (hold === 'begin') fixture.setBeginGate(beginGate.promise)
          else fixture.audioHost.session.teardown = async () => {
            held = true
            await retireGate.promise
            return realTeardown()
          }
          // Stop's own Pause and Stop both cancel this rebuild; the graph must still come back at the start.
          const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true })
          for (let turn = 0; turn < 800 && !held && fixture.calls.filter(call => call === 'begin').length === beginsBefore; turn += 1) await Promise.resolve()
          if (hold === 'begin') expect(fixture.calls.filter(call => call === 'begin').length).toBe(beginsBefore + 1)
          else expect(held).toBeTrue()
          expect(playback.isStructuralRebuildInProgress()).toBeTrue()
          const sentBefore = fixture.transportStates.length
          const stop = playback.handleStop()
          for (let index = 0; index < 20; index += 1) await flushMicrotasks()
          fixture.setBeginGate(undefined)
          fixture.audioHost.session.teardown = realTeardown
          beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
          retireGate.resolve()
          await Promise.allSettled([rebuild, stop])
          for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
          for (let index = 0; index < 60; index += 1) await flushMicrotasks()
          console.log('B6D8-STOP-PAUSED-REBUILD', JSON.stringify({ hold, faults, prepared: playback.isNativePlaybackPrepared(),
            native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(),
            begins: fixture.calls.filter(call => call === 'begin').length, frames: fixture.transportFrames.slice(sentBefore),
            sent: fixture.transportStates.slice(sentBefore), calls: fixture.calls.slice(-10) }))
          expect(faults).toEqual([])
          expect(fixture.transportStates.slice(sentBefore)).not.toContain(true)
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.isNativePlaybackPrepared()).toBeTrue()
          expect(playback.playheadSec()).toBe(0)
          expect(fixture.transportFrames.at(-1)).toBe(0)
          dispose()
        })
      })
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  })
}
// B6e: a Pause while playing that supersedes a resuming rebuild must leave a live paused graph of the edited tracks.
// Before the rebuild retires the playing graph, the superseded rebuild returns and the paused-preview owner has skipped
// the edit; after the rebuild's own Play commits, the superseded rebuild disposes the graph that Pause has just paused.
const b6eEditedTracks: Track[] = [track, { ...track, id: 'track-b6e', name: 'B6e edit' }]
const runB6eSupersededRebuild = async (
  action: 'pause' | 'stop' | 'locate',
  at: 'before-retire' | 'after-play-commit',
  hold: boolean,
) => {
  const previousWindow = globalThis.window
  const transportGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, transportGate.promise)
  const [tracks, setTracks] = createSignal<Track[]>([track])
  const faults: string[] = []
  const compiles: { state: string; trackIds: string[] }[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    await withFakeRaf(async () => {
      const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(fake.engine, { getTracks: () => tracks() }, {
          requiresNativeAudio: true,
          enabled: () => true,
          compileSnapshot: async (transport) => {
            compiles.push({ state: transport.state, trackIds: tracks().map(entry => entry.id) })
            return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
          },
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        playback.setPlayhead(1, tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        await playback.handlePlay(tracks())
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlayback()).toBeTrue()
        const compilesBefore = compiles.length
        const callsBefore = fixture.calls.length
        const sentBefore = fixture.transportStates.length
        const retired = () => fixture.calls.slice(callsBefore).some(call => call === 'stop' || call === 'teardown')
        // A structural edit while playing, then the Timeline's resuming rebuild in the same task.
        setTracks(b6eEditedTracks)
        const rebuild = playback.restartTimelineSchedule(tracks(), { rebuildBackend: true, resumePlayback: true, playheadSec: 2 })
        // The first turn at which the rebuild has retired the old graph and its own Play has committed: the new session
        // runs and the Play attempt is no longer preparing, but the rebuild has not yet returned from it.
        const committed = () => retired() && playback.isNativePlayback() && !playback.isPreparingPlayback()
        let anchorTurn = 0
        if (at === 'after-play-commit') for (; anchorTurn < 400 && !committed(); anchorTurn += 1) await Promise.resolve()
        expect(committed()).toBe(at === 'after-play-commit')
        expect(playback.isStructuralRebuildInProgress()).toBeTrue()
        expect(playback.isPlaying()).toBeTrue()
        expect(playback.isNativePlayback()).toBeTrue()
        expect(retired()).toBe(at === 'after-play-commit')
        expect(fixture.calls.slice(callsBefore).includes('start')).toBe(at === 'after-play-commit')
        if (hold) fixture.armTransportGate()
        const callsAtAction = fixture.calls.length
        const sentAtAction = fixture.transportStates.length
        let pending: Promise<unknown> = Promise.resolve()
        if (action === 'pause') pending = playback.handlePause()
        if (action === 'stop') pending = playback.handleStop()
        if (action === 'locate') playback.setPlayhead(3, tracks())
        const playheadAtAction = playback.playheadSec()
        for (let index = 0; index < 20; index += 1) await flushMicrotasks()
        const callsWhileHeld = hold ? fixture.calls.slice(callsAtAction) : []
        transportGate.resolve({ ok: true })
        await Promise.allSettled([rebuild, pending])
        for (let turn = 0; turn < 400 && !playback.isNativePlaybackPrepared(); turn += 1) await Promise.resolve()
        for (let index = 0; index < 60; index += 1) await flushMicrotasks()
        console.log('B6E-SUPERSEDED-REBUILD', JSON.stringify({ action, at, hold, anchorTurn, faults, prepared: playback.isNativePlaybackPrepared(),
          native: playback.isNativePlayback(), playing: playback.isPlaying(), playhead: playback.playheadSec(), playheadAtAction,
          compilesAfterEdit: compiles.slice(compilesBefore), frames: fixture.transportFrames.slice(sentBefore),
          sentAfterAction: fixture.transportStates.slice(sentAtAction), callsWhileHeld, calls: fixture.calls.slice(callsBefore) }))
        if (hold) {
          expect(callsWhileHeld).toContain('transport')
          // The replacement graph is prepared only once the host has applied the Pause.
          expect(callsWhileHeld).not.toContain('begin')
        }
        expect(faults).toEqual([])
        expect(playback.isStructuralRebuildInProgress()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(compiles.length).toBeGreaterThan(compilesBefore)
        expect(compiles.at(-1)?.trackIds).toEqual(['track-1', 'track-b6e'])
        if (action === 'locate') {
          expect(playback.isPlaying()).toBeTrue()
          expect(playback.isNativePlayback()).toBeTrue()
          expect(playback.playheadSec()).toBe(3)
          expect(fixture.transportStates.at(-1)).toBeTrue()
          expect(fixture.transportFrames.at(-1)).toBe(144_000)
          expect(compiles.at(-1)?.state).toBe('playing')
        } else {
          // Pause stays where it landed: the playing position before the retire, the resume position after the commit.
          const expected = action === 'stop' ? 0 : at === 'before-retire' ? 1 : 2
          expect(playheadAtAction).toBe(expected)
          expect(fixture.transportStates.slice(sentAtAction)).not.toContain(true)
          expect(playback.isPlaying()).toBeFalse()
          expect(playback.playheadSec()).toBe(expected)
          expect(fixture.transportFrames.at(-1)).toBe(expected * 48_000)
        }
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
}
for (const hold of [false, true]) {
  test(`B6e a Pause before a resuming rebuild retires the playing graph keeps a live paused graph of the edit${hold ? ' (host pause held)' : ''}`, async () => {
    await runB6eSupersededRebuild('pause', 'before-retire', hold)
  })
  test(`B6e a Pause after a resuming rebuild's Play commits keeps a live paused graph of the edit${hold ? ' (host pause held)' : ''}`, async () => {
    await runB6eSupersededRebuild('pause', 'after-play-commit', hold)
  })
}
test("B6e a Stop after a resuming rebuild's Play commits leaves a live paused graph of the edit at the start", async () => {
  await runB6eSupersededRebuild('stop', 'after-play-commit', false)
})
test('B6e a locate before a resuming rebuild retires the playing graph plays the edit from the locate', async () => {
  await runB6eSupersededRebuild('locate', 'before-retire', false)
})
test('rebuilds a prepared native backend while paused', async () => {
  const previousWindow = globalThis.window
  const calls: string[] = []
  const reply = (name: string) => async () => {
    calls.push(name)
    return name === 'begin'
      ? { ok: true as const, transactionToken: nativeTransactionToken }
      : { ok: true as const }
  }
  let progressListener = (_progress: NativeScheduleProgress) => {}
  let progressSequence = 0n
  const deviceId: `coreaudio:${string}` = 'coreaudio:default'
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      dawDesktop: {
        audioHost: {
          resolveOutputDevice: async () => ({
            ok: true,
            device: {
              deviceId,
              name: 'Default',
              nominalSampleRateHz: 48_000,
              outputChannelCount: 2,
              maximumFramesPerBlock: 512,
              available: true,
            },
          }),
          session: {
            configure: async () => {
              const result = await reply('configure')()
              return result.ok ? { ok: true as const, hostIdentity: { pid: 123, generation: 7, configurationGeneration: 1 } } : result
            },
            beginTransaction: reply('begin'),
            commitTransaction: reply('commit'),
            rollbackTransaction: reply('rollback'),
            installAsset: reply('install'),
            releaseAsset: reply('release'),
            publishGraph: reply('graph'),
            queueParameterEvents: reply('parameter'),
            queueInstrumentEvents: reply('instrument'),
            queueSourceEvents: reply('source'),
            queueScheduleWindow: reply('schedule'),
            reenableVstScheduleAutomation: reply('automation-enable'),
            setTransport: async (transport: { epoch: number; frame: number; running: boolean; transitionId?: bigint }) => {
              calls.push('transport')
              progressSequence += 1n
              queueMicrotask(() => progressListener({
                revision: 1,
                epoch: transport.epoch,
                progressSequence,
                renderedThroughFrame: BigInt(transport.frame),
                acceptedThroughFrame: BigInt(transport.frame + 1),
                lastAcceptedWindowId: 1n,
                appliedTransportTransitionId: transport.transitionId ?? progressSequence,
                appliedUrgentSequence: 0n,
  appliedProcessorSequence: 0n,
                running: transport.running,
                scheduleComplete: true,
                instrumentCredits: 256,
                sourceCredits: 256,
                automationCredits: 256,
              }))
              return { ok: true as const }
            },
            start: reply('start'),
            stop: reply('stop'),
            teardown: reply('teardown'),
            onLoss: () => () => {},
            onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
              progressListener = listener
              return () => { progressListener = () => {} }
            },
          },
        },
      },
    },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          enabled: () => true,
          compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
            revision: 1,
            bpm: 120,
            transport,
            tracks: [track],
            renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
            sidechainRoutes: [],
          }),
        })

        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(1)

        await playback.restartTimelineSchedule([track], { rebuildBackend: true })
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls).toContain('teardown')

        await playback.handlePlay([track])
        expect(playback.backendDiagnostics().activeBackend).toBe('native')
        expect(calls.filter((call) => call === 'begin')).toHaveLength(2)
        expect(calls.filter((call) => call === 'graph')).toHaveLength(2)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('re-establishes paused native preview after structural fingerprint disposal', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const instrument: Track = { ...track, kind: 'instrument' }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => 'project',
            compileSnapshot: async (transport, context) => compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: tracks(),
              renderState: {
                fx: {
                  masterVolume: 1,
                  masterFxInstances: [],
                  trackFx: context?.instrumentOverride
                    ? {
                        [context.instrumentOverride.targetId]: {
                          instances: [],
                          instrument: context.instrumentOverride.instrument,
                        },
                      }
                    : {},
                },
                automationEnvelopes: [],
              },
              sidechainRoutes: [],
            }),
          },
        )
        await playback.handlePlay(tracks())
        await playback.handlePause()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        const beginsBefore = fixture.calls.filter((call) => call === 'begin').length

        setTracks([instrument])
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await expect(rebuild).resolves.toBeUndefined()
        await flushMicrotasks()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(fixture.calls.filter((call) => call === 'begin').length).toBeGreaterThan(beginsBefore)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('keeps optional paused structural rebuilds idle when native preview becomes unavailable', async () => {
  const source = await readFile(new URL('./useTimelinePlayback.ts', import.meta.url), 'utf8')
  expect(source).toContain('reportUnavailable: requiresNativeAudio')
  expect(source).toContain(': "The prepared native playback graph could not be rebuilt.")')

  const previousWindow = globalThis.window
  let failBegin = false
  const fixture = createNativeHookBridge(
    () => failBegin ? 'begin' : undefined,
    undefined,
    undefined,
    undefined,
    'The native audio session is unavailable.',
  )
  const faults: string[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine,
          { getTracks: () => [track] },
          {
            requiresNativeAudio: false,
            enabled: () => true,
            projectId: () => 'project',
            compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
              revision: 1,
              bpm: 120,
              transport,
              tracks: [track],
              renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
              sidechainRoutes: [],
            }),
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          },
        )

        await playback.handlePlay([track])
        await playback.handlePause()
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()

        failBegin = true
        await expect(playback.restartTimelineSchedule([track], {
          rebuildBackend: true,
          resumePlayback: false,
          playheadSec: 0,
          owner: 'native',
          projectId: 'project',
        })).rejects.toThrow(
          'The prepared native playback graph could not be rebuilt: Native playback failed during begin-transaction: The native audio session is unavailable.',
        )

        expect(faults).toEqual([])
        expect(playback.isPlaying()).toBeFalse()
        expect(playback.backendDiagnostics().activeBackend).toBe('idle')
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(playback.usesLegacyAudioEngine()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('structural rebuild owns paused preview while reactive tracks change', async () => {
  const previousWindow = globalThis.window
  const beginGate = Promise.withResolvers<NativeTransactionReply>()
  const fixture = createNativeHookBridge()
  const [tracks, setTracks] = createSignal([track])
  const instrument: Track = { ...track, kind: 'instrument' }
  const compileContexts: Array<unknown> = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          engine,
          { getTracks: () => tracks() },
          {
            requiresNativeAudio: true,
            enabled: () => true,
            projectId: () => 'project',
            compileSnapshot: async (transport, context) => {
              compileContexts.push(context)
              return nativeRequiredSnapshot(transport)
            },
          },
        )
        await playback.handlePlay(tracks())
        await playback.handlePause()
        fixture.calls.length = 0
        fixture.setBeginGate(beginGate.promise)

        setTracks([instrument])
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await flushMicrotasks()
        beginGate.resolve({ ok: true, transactionToken: nativeTransactionToken })
        await expect(rebuild).resolves.toBeUndefined()

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(compileContexts.at(-1)).toEqual({
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(1)
        expect(fixture.calls.slice(fixture.calls.lastIndexOf('begin') + 1)).not.toContain('teardown')
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('serializes stop teardown before a paused structural insertion', async () => {
  const previousWindow = globalThis.window
  const stopGate = Promise.withResolvers<{ ok: true }>()
  const fixture = createNativeHookBridge(undefined, undefined, undefined, stopGate.promise)
  const faults: string[] = []
  const instrument: Track = { ...track, kind: 'instrument' }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const engine = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 }).engine
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(engine, undefined, {
          requiresNativeAudio: true,
          enabled: () => true,
          projectId: () => 'project',
          compileSnapshot: nativeRequiredSnapshot,
          reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
        })
        await playback.handlePlay([track])
        fixture.armTransportGate()
        fixture.calls.length = 0

        const stop = playback.handleStop()
        await flushMicrotasks()
        const rebuild = playback.restartTimelineSchedule([instrument], {
          rebuildBackend: true,
          resumePlayback: false,
          owner: 'native',
          projectId: 'project',
          instrumentOverride: {
            targetId: instrument.id,
            instrument: {
              kind: 'drum-rack',
              instanceId: 'instrument-instance',
              params: createDefaultDrumRackParams(),
            },
          },
        })
        await flushMicrotasks()
        stopGate.resolve({ ok: true })
        await Promise.all([stop, rebuild])

        expect(playback.isPlaying()).toBeFalse()
        expect(playback.isNativePlaybackPrepared()).toBeTrue()
        expect(faults).toEqual([])
        expect(fixture.calls.filter((call) => call === 'begin')).toHaveLength(1)
        const teardownIndex = fixture.calls.lastIndexOf('teardown')
        const beginIndex = fixture.calls.lastIndexOf('begin')
        expect(teardownIndex).toBeGreaterThan(-1)
        expect(beginIndex).toBeGreaterThan(teardownIndex)
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('disposes the native backend even when state persistence fails', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      const faults: string[] = []
      let failCapture = false
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            enabled: () => true,
            projectId: () => "project",
            compileSnapshot: nativeRequiredSnapshot,
            captureNativeVstStates: async () => {
              if (failCapture) throw new Error("state persistence failed")
            },
            reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
          },
        )
        await playback.handlePlay([track])
        expect(playback.isNativePlaybackPrepared()).toBeTrue()

        failCapture = true
        await expect(playback.handleStop()).rejects.toThrow("state persistence failed")
        expect(fixture.calls).toContain("teardown")
        expect(playback.isNativePlaybackPrepared()).toBeFalse()
        expect(faults).toEqual([])
        failCapture = false
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('captures a prepared native graph against its original project after navigation', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const captureStarted = Promise.withResolvers<void>()
  const captureFinished = Promise.withResolvers<void>()
  let currentProject = 'project-a'
  const captured: Array<{ projectId: string; instanceIds: readonly string[] }> = []
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            enabled: () => true,
            projectId: () => currentProject,
            compileSnapshot: nativeRequiredSnapshot,
            captureNativeVstStates: async (capture) => {
              captured.push(capture)
              captureStarted.resolve()
              await captureFinished.promise
            },
          },
        )
        await playback.handlePlay([track])
        const stop = playback.handleStop()
        await captureStarted.promise
        currentProject = 'project-b'
        captureFinished.resolve()
        await stop
        expect(captured).toEqual([{ projectId: 'project-a', instanceIds: [] }])
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

test('serializes play behind capture and disposal of the previous native session', async () => {
  const previousWindow = globalThis.window
  const fixture = createNativeHookBridge()
  const captureGate = Promise.withResolvers<void>()
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { dawDesktop: { audioHost: fixture.audioHost } },
  })
  try {
    await withFakeRaf(async () => {
      await createRoot(async (dispose) => {
        const playback = useTimelinePlayback(
          createFakeEngine({ clipId: "clip-1", startSec: 1, endSec: 2 }).engine,
          undefined,
          {
            enabled: () => true,
            projectId: () => "project",
            compileSnapshot: nativeRequiredSnapshot,
            captureNativeVstStates: async () => captureGate.promise,
          },
        )
        await playback.handlePlay([track])
        const stop = playback.handleStop()
        await flushMicrotasks()
        const play = playback.handlePlay([track])
        await flushMicrotasks()
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(1)
        captureGate.resolve()
        await Promise.all([stop, play])
        expect(fixture.calls.filter((call) => call === "begin")).toHaveLength(2)
        expect(playback.isPlaying()).toBeTrue()
        dispose()
      })
    })
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

// B6f: the browser build keeps its paused portable session live on every paused or stopped route, as native keeps its
// paused preview: one prepared, paused session at the transport playhead, carrying the newest edit, and no running
// transport after a Stop or Pause. The shape is the browser build's (Timeline.tsx:167, :763-781, :855-859): no desktop
// bridge, native `enabled` (default true), portable options, and no AudioContext until a Play gesture creates one.
type B6fLiveSession = { createdSeq: number; closed: boolean; graph: string; positions: { seq: number; sec: number; running: boolean }[] }
type B6fLiveHold = { armed: boolean; held: (() => void)[]; reached: PromiseWithResolvers<void> }
type B6fLiveWorld = { seq: number; sessions: B6fLiveSession[]; transportHold: B6fLiveHold }
type B6fLiveEdit = 'none' | 'structure' | 'volume'
const b6fLiveHold = (): B6fLiveHold => ({ armed: false, held: [], reached: Promise.withResolvers<void>() })
const holdB6fLive = (hold: B6fLiveHold, resume: () => void) => {
  hold.held.push(resume)
  hold.reached.resolve()
}
const releaseB6fLive = (hold: B6fLiveHold) => {
  hold.armed = false
  for (const resume of hold.held.splice(0)) resume()
}
const b6fLiveEditedTracks: Track[] = [track, { ...track, id: 'track-b6f', name: 'B6f edit' }]

const mountB6fLive = (world: B6fLiveWorld, nativeEnabled: boolean) => {
  const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
  const audioContext = new AudioContext()
  let audioCreated = false
  const resumeHold = b6fLiveHold()
  const compileHold = b6fLiveHold()
  const [tracks, setTracks] = createSignal<Track[]>([track])
  const [projectId, setProjectId] = createSignal('project-a')
  const [generation, setGeneration] = createSignal(1)
  const faults: string[] = []
  const compiles: { seq: number; volumes: number[] }[] = []
  const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport']) => {
    if (compileHold.armed) await new Promise<void>((resolve) => holdB6fLive(compileHold, resolve))
    compiles.push({ seq: ++world.seq, volumes: tracks().map((entry) => entry.volume) })
    return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
  }
  const engine = {
    ...fake.engine,
    ensureAudio: () => { audioCreated = true },
    getAudioContext: () => audioCreated ? audioContext : null,
    resume: async () => { if (resumeHold.armed) await new Promise<void>((resolve) => holdB6fLive(resumeHold, resolve)) },
  }
  const playback = useTimelinePlayback(engine, { getTracks: () => tracks() }, {
    enabled: () => nativeEnabled,
    projectId,
    projectGeneration: generation,
    compileSnapshot,
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  }, { projectGeneration: generation, compileSnapshot, reportFault: (message) => faults.push(message) })
  const holds = { resume: resumeHold, compile: compileHold, transport: world.transportHold }
  const summary = (mark: number) => {
    const open = world.sessions.filter((session) => !session.closed)
    const session = open.at(-1)
    const newest = compiles.at(-1)
    const position = session?.positions.at(-1)
    return {
      faults: [...faults],
      playing: playback.isPlaying(),
      portableActive: playback.isPortableBrowserPlayback(),
      prepared: playback.isPortableBrowserPlaybackPrepared(),
      playhead: playback.playheadSec(),
      openSessions: open.length,
      position: position && { sec: position.sec, running: position.running },
      edit: session?.graph.includes('"track-b6f"') ? 'structure'
        : newest?.volumes.includes(0.5) && session && session.createdSeq > newest.seq ? 'volume' : 'none',
      runningAfterMark: world.sessions.flatMap((entry) => entry.positions).filter((entry) => entry.seq > mark && entry.running).length,
    }
  }
  // Waits on hook state, not on a count of turns: the bound only ends a run that never reaches it.
  const until = async (reached: () => boolean) => {
    for (let turn = 0; turn < 5_000 && !reached(); turn += 1) await Promise.resolve()
  }
  // Paused or stopped: no running transport is sent after the mark. Playing: the session runs from the locate.
  const expectLive = async (running: boolean, sec: number, mark: number, edit: B6fLiveEdit) => {
    const expected = () => ({
      faults: [], playing: running, portableActive: running, prepared: true, playhead: sec, openSessions: 1,
      position: { sec, running }, edit, runningAfterMark: running ? summary(mark).runningAfterMark : 0,
    })
    await until(() => !playback.isPreparingPlayback() && Bun.deepEquals(summary(mark), expected()))
    expect(summary(mark)).toEqual(expected())
  }
  const playFrom = async (sec: number) => {
    playback.setPlayhead(sec, tracks())
    await playback.handlePlay(tracks())
    await expectLive(true, sec, world.seq, 'none')
  }
  const pausedAt = async (sec: number) => {
    await playFrom(sec)
    const mark = world.seq
    await playback.handlePause()
    await expectLive(false, sec, mark, 'none')
  }
  // Timeline.tsx:923-929: a structural edit rebuilds the backend the Timeline sees prepared, with the captured intent.
  const timelineReschedule = () => {
    if (!playback.isNativePlaybackPrepared() && !playback.isPortableBrowserPlaybackPrepared()) return Promise.resolve()
    return playback.restartTimelineSchedule(tracks(), {
      rebuildBackend: true, resumePlayback: playback.isPlaying(), playheadSec: playback.playheadSec(),
      owner: 'portable-browser', projectId: projectId(), projectGeneration: generation(),
    })
  }
  const resumingRebuild = () => playback.restartTimelineSchedule(tracks(), {
    rebuildBackend: true, resumePlayback: true, playheadSec: 2, owner: 'portable-browser', projectId: projectId(), projectGeneration: generation(),
  })
  return { playback, tracks, setTracks, setProjectId, setGeneration, holds, until, summary, expectLive, playFrom, pausedAt,
    timelineReschedule, resumingRebuild, mark: () => world.seq, liveSession: () => world.sessions.filter((session) => !session.closed).at(-1) }
}

const runB6fLive = async (body: (live: ReturnType<typeof mountB6fLive>) => Promise<void>, nativeEnabled = true) => {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'),
    AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  }
  const world: B6fLiveWorld = { seq: 0, sessions: [], transportHold: b6fLiveHold() }
  class FakeAudioContext {
    readonly sampleRate = 48_000
    readonly destination = {}
    readonly audioWorklet = { addModule: async () => undefined }
  }
  class FakeAudioWorkletNode {
    readonly port: { onmessage: ((event: { data: PortableWasmStatusMessage }) => void) | null; postMessage: (message: PortableWasmControlMessage) => void; close: () => void }
    constructor() {
      const session: B6fLiveSession = { createdSeq: ++world.seq, closed: false, graph: '', positions: [] }
      world.sessions.push(session)
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          world.seq += 1
          if (message.type === 'prepare-graph') session.graph = JSON.stringify(message.snapshot)
          if (message.type === 'install-schedule') session.positions.push({ seq: world.seq, sec: message.schedule.timeOrigin.timelineSec, running: false })
          if (message.type === 'transport') session.positions.push({ seq: world.seq, sec: message.frame / 48_000, running: message.running })
          const response = portableResponseFor(message)
          if (!response) return
          const deliver = () => queueMicrotask(() => this.port.onmessage?.({ data: response }))
          if (message.type === 'transport' && message.running && world.transportHold.armed) holdB6fLive(world.transportHold, deliver)
          else deliver()
        },
        close: () => { session.closed = true },
      }
    }
    onprocessorerror: (() => {}) | null = null
    connect = () => {}
    disconnect = () => {}
  }
  const manifest = await readFile(new URL('../../public/audio-core/daw-audio-core.manifest.json', import.meta.url), 'utf8')
  const wasm = await readFile(new URL('../../public/audio-core/daw-audio-core.wasm', import.meta.url))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string | URL) => (
    String(input).endsWith('.manifest.json') ? new Response(manifest, { status: 200 }) : new Response(wasm, { status: 200 })) })
  try {
    await withFakeRaf(() => createRoot(async (dispose) => {
      try {
        await body(mountB6fLive(world, nativeEnabled))
      } finally {
        dispose()
      }
    }))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('B6f a Stop while playing or paused leaves a live paused portable session at the start', async () => {
  for (const from of ['playing', 'paused'] as const) await runB6fLive(async (live) => {
    if (from === 'playing') await live.playFrom(1)
    else await live.pausedAt(1)
    const mark = live.mark()
    await live.playback.handleStop()
    await live.expectLive(false, 0, mark, 'none')
  })
})

test('B6f a Pause or Stop that cancels a pending Play leaves a live paused portable session', async () => {
  for (const [start, hold, action] of [['warm', 'transport', 'pause'], ['cold', 'compile', 'stop']] as const) await runB6fLive(async (live) => {
    if (start === 'warm') await live.pausedAt(1)
    else live.playback.setPlayhead(1, live.tracks())
    live.holds[hold].armed = true
    const play = live.playback.handlePlay(live.tracks())
    await live.holds[hold].reached.promise
    expect(live.playback.isPreparingPlayback()).toBeTrue()
    const mark = live.mark()
    const cancel = action === 'pause' ? live.playback.handlePause() : live.playback.handleStop()
    releaseB6fLive(live.holds[hold])
    await Promise.allSettled([play, cancel])
    await live.expectLive(false, action === 'stop' ? 0 : 1, mark, 'none')
  })
})

test('B6f a Pause or Stop during a resuming rebuild leaves a live paused portable session of the edit', async () => {
  for (const [hold, action] of [['compile', 'pause'], ['transport', 'stop']] as const) await runB6fLive(async (live) => {
    await live.playFrom(1)
    live.setTracks(b6fLiveEditedTracks)
    live.holds[hold].armed = true
    const rebuild = live.resumingRebuild()
    await live.holds[hold].reached.promise
    expect(live.playback.isStructuralRebuildInProgress()).toBeTrue()
    const mark = live.mark()
    const cancel = action === 'pause' ? live.playback.handlePause() : live.playback.handleStop()
    const playheadAtAction = live.playback.playheadSec()
    releaseB6fLive(live.holds[hold])
    await Promise.allSettled([rebuild, cancel])
    await live.expectLive(false, action === 'stop' ? 0 : playheadAtAction, mark, 'structure')
  })
})

test("B6f a locate during a pending Play or a rebuild's Play plays from the locate", async () => {
  for (const route of ['pending-play', 'rebuild'] as const) await runB6fLive(async (live) => {
    const hold = route === 'pending-play' ? live.holds.compile : live.holds.transport
    let pending: Promise<unknown>
    if (route === 'pending-play') {
      live.playback.setPlayhead(1, live.tracks())
      hold.armed = true
      pending = live.playback.handlePlay(live.tracks())
    } else {
      await live.playFrom(1)
      live.setTracks(b6fLiveEditedTracks)
      hold.armed = true
      pending = live.resumingRebuild()
    }
    await hold.reached.promise
    expect(live.playback.isPreparingPlayback() || live.playback.isStructuralRebuildInProgress()).toBeTrue()
    const mark = live.mark()
    live.playback.setPlayhead(3, live.tracks())
    releaseB6fLive(hold)
    await pending
    await live.expectLive(true, 3, mark, route === 'rebuild' ? 'structure' : 'none')
  })
})

test('B6f a paused locate moves the live paused portable session to the locate', async () => {
  await runB6fLive(async (live) => {
    await live.pausedAt(1)
    const mark = live.mark()
    live.playback.setPlayhead(3, live.tracks())
    await live.expectLive(false, 3, mark, 'none')
  })
})

test('B6f a mixer edit without a Timeline rebuild leaves a live paused portable session carrying it', async () => {
  for (const when of ['paused', 'playing-then-pause'] as const) await runB6fLive(async (live) => {
    if (when === 'paused') await live.pausedAt(1)
    else await live.playFrom(1)
    const mark = live.mark()
    // useTimelineMixerController.ts setTrackVolume reaches the resolved tracks, not restartTimelineSchedule.
    live.setTracks([{ ...track, volume: 0.5 }])
    if (when === 'playing-then-pause') await live.playback.handlePause()
    await live.expectLive(false, 1, mark, 'volume')
  })
})

test('B6f a project switch leaves a live paused portable session of the new project at the start', async () => {
  for (const nativeEnabled of [true, false]) await runB6fLive(async (live) => {
    await live.pausedAt(1)
    const previous = live.liveSession()
    const mark = live.mark()
    // useTimelineProjectRoute.ts:79-81 moves the generation, then the project id; the new project's tracks load once
    // the previous project's session is gone.
    live.setGeneration(2)
    live.setProjectId('project-b')
    await live.until(() => previous?.closed === true)
    expect(previous?.closed).toBeTrue()
    live.setTracks(b6fLiveEditedTracks)
    await live.timelineReschedule()
    await live.expectLive(false, 0, mark, 'structure')
  }, nativeEnabled)
})

// B6f2: each kept guard and wait of ensureLivePortableSession, driven through the route that needs it. The runner is
// runB6fLive's plus the root's dispose and a hold on the worklet's `transport running:false` reply (a Pause in flight).
type B6f2Root = { dispose: () => void; pauseHold: B6fLiveHold }
const runB6f2Live = async (body: (live: ReturnType<typeof mountB6fLive>, root: B6f2Root) => Promise<void>, nativeEnabled = true) => {
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'),
    AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  }
  const world: B6fLiveWorld = { seq: 0, sessions: [], transportHold: b6fLiveHold() }
  const pauseHold = b6fLiveHold()
  class FakeAudioContext {
    readonly sampleRate = 48_000
    readonly destination = {}
    readonly audioWorklet = { addModule: async () => undefined }
  }
  class FakeAudioWorkletNode {
    readonly port: { onmessage: ((event: { data: PortableWasmStatusMessage }) => void) | null; postMessage: (message: PortableWasmControlMessage) => void; close: () => void }
    constructor() {
      const session: B6fLiveSession = { createdSeq: ++world.seq, closed: false, graph: '', positions: [] }
      world.sessions.push(session)
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          world.seq += 1
          if (message.type === 'prepare-graph') session.graph = JSON.stringify(message.snapshot)
          if (message.type === 'install-schedule') session.positions.push({ seq: world.seq, sec: message.schedule.timeOrigin.timelineSec, running: false })
          if (message.type === 'transport') session.positions.push({ seq: world.seq, sec: message.frame / 48_000, running: message.running })
          const response = portableResponseFor(message)
          if (!response) return
          const deliver = () => queueMicrotask(() => this.port.onmessage?.({ data: response }))
          if (message.type === 'transport' && message.running && world.transportHold.armed) holdB6fLive(world.transportHold, deliver)
          else if (message.type === 'transport' && !message.running && pauseHold.armed) holdB6fLive(pauseHold, deliver)
          else deliver()
        },
        close: () => { session.closed = true },
      }
    }
    onprocessorerror: (() => {}) | null = null
    connect = () => {}
    disconnect = () => {}
  }
  const manifest = await readFile(new URL('../../public/audio-core/daw-audio-core.manifest.json', import.meta.url), 'utf8')
  const wasm = await readFile(new URL('../../public/audio-core/daw-audio-core.wasm', import.meta.url))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string | URL) => (
    String(input).endsWith('.manifest.json') ? new Response(manifest, { status: 200 }) : new Response(wasm, { status: 200 })) })
  try {
    await withFakeRaf(() => createRoot(async (dispose) => {
      try {
        await body(mountB6fLive(world, nativeEnabled), { dispose, pauseHold })
      } finally {
        dispose()
      }
    }))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

test('B6f2 a paused locate during a pending Pause moves the live paused portable session to the locate', async () => {
  await runB6f2Live(async (live, root) => {
    await live.playFrom(1)
    const mark = live.mark()
    root.pauseHold.armed = true
    const pause = live.playback.handlePause()
    await root.pauseHold.reached.promise
    live.playback.setPlayhead(3, live.tracks())
    releaseB6fLive(root.pauseHold)
    await pause
    await live.expectLive(false, 3, mark, 'none')
  })
})

test('B6f2 a project switch that moves the generation, then the project id, with unchanged tracks leaves a live paused portable session at the start', async () => {
  for (const nativeEnabled of [true, false]) await runB6f2Live(async (live) => {
    await live.pausedAt(1)
    const previous = live.liveSession()
    const mark = live.mark()
    // useTimelineProjectRoute.ts setProjectId moves them one after the other; nothing re-runs the paused-preview effect.
    live.setGeneration(2)
    live.setProjectId('project-b')
    await live.until(() => previous?.closed === true)
    expect(previous?.closed).toBeTrue()
    await live.expectLive(false, 0, mark, 'none')
  }, nativeEnabled)
})

test('B6f2 an unmount during the Stop re-prepare leaves no portable session behind', async () => {
  await runB6f2Live(async (live, root) => {
    await live.pausedAt(1)
    live.holds.resume.armed = true
    const stop = live.playback.handleStop()
    await live.holds.resume.reached.promise
    root.dispose()
    releaseB6fLive(live.holds.resume)
    await stop
    await live.until(() => live.summary(0).openSessions > 0)
    expect(live.summary(0).openSessions).toBe(0)
  })
})

test('B6f2 a paused locate whose re-prepare settles after a Play committed keeps the Play running', async () => {
  await runB6f2Live(async (live) => {
    await live.pausedAt(1)
    const mark = live.mark()
    live.holds.resume.armed = true
    live.playback.setPlayhead(3, live.tracks())
    await live.holds.resume.reached.promise
    live.holds.resume.armed = false
    const play = live.playback.handlePlay(live.tracks())
    await live.expectLive(true, 3, mark, 'none')
    releaseB6fLive(live.holds.resume)
    await play
    // Nothing after the Play's running transport: the locate's re-prepare does not pause it.
    const afterRunning = () => {
      const positions = live.liveSession()?.positions.filter((entry) => entry.seq > mark) ?? []
      return positions.slice(positions.map((entry) => entry.running).lastIndexOf(true) + 1)
    }
    await live.until(() => afterRunning().length > 0)
    expect(afterRunning()).toEqual([])
    expect(live.summary(mark)).toMatchObject({ playing: true, position: { sec: 3, running: true } })
  })
})

test('B6f2 two paused locates while the first compile is pending end at the second', async () => {
  await runB6f2Live(async (live) => {
    await live.pausedAt(1)
    const mark = live.mark()
    live.holds.compile.armed = true
    live.playback.setPlayhead(3, live.tracks())
    await live.holds.compile.reached.promise
    live.playback.setPlayhead(5, live.tracks())
    releaseB6fLive(live.holds.compile)
    await live.expectLive(false, 5, mark, 'none')
  })
})

// B6f3: a browser restored from preferences saved at versions 5 to 8 can run with native playback off
// (app-preferences-core.ts:254-257). A worklet fault while playing then reaches only the paused-preview effect's disabled
// branch, which must bring the paused session back as the enabled branch's tail does.
test('B6f3 a portable session fault while playing leaves a live paused portable session, native playback off or on', async () => {
  for (const nativeEnabled of [false, true]) await runB6fLive(async (live) => {
    // The backend creates its worklet nodes itself; record them so the live one can fail as a crashed processor does.
    const nodes: AudioWorkletNode[] = []
    const FakeNode = globalThis.AudioWorkletNode
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class extends FakeNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args)
        nodes.push(this)
      }
    } })
    await live.playFrom(1)
    expect(nodes).toHaveLength(1)
    const mark = live.mark()
    nodes[0]?.onprocessorerror?.(new ErrorEvent('processorerror'))
    const expected = {
      faults: ['Portable audio-core AudioWorklet processing failed.'], playing: false, portableActive: false, prepared: true,
      playhead: 1, openSessions: 1, position: { sec: 1, running: false }, edit: 'none', runningAfterMark: 0,
    }
    await live.until(() => !live.playback.isPreparingPlayback() && Bun.deepEquals(live.summary(mark), expected))
    expect(live.summary(mark)).toEqual(expected)
  }, nativeEnabled)
})

// B6f4: with native playback off (app-preferences-core.ts:254-257) a paused mixer edit reaches only the paused-preview
// effect's disabled branch, and ensurePrepared keeps a paused session that already stands at the playhead: the branch must
// replace the session compiled before the edit, and keep the replacement while nothing changes.
test('B6f4 a mixer edit with native playback off leaves a live paused portable session carrying it', async () => {
  for (const when of ['paused', 'playing-then-pause'] as const) await runB6fLive(async (live) => {
    if (when === 'paused') await live.pausedAt(1)
    else await live.playFrom(1)
    const mark = live.mark()
    // useTimelineMixerController.ts setTrackVolume reaches the resolved tracks, not restartTimelineSchedule.
    live.setTracks([{ ...track, volume: 0.5 }])
    if (when === 'playing-then-pause') await live.playback.handlePause()
    await live.expectLive(false, 1, mark, 'volume')
    const graph = JSON.parse(live.liveSession()?.graph ?? '{}')
    expect(graph.nodes?.find((node: { id: string }) => node.id === track.id)?.mixer.gain).toBe(0.5)
  }, false)
})

test('B6f4 a paused-preview re-run with native playback off and no edit keeps the paused portable session', async () => {
  await runB6fLive(async (live) => {
    // The backend creates one worklet node per prepared session; count them as the re-prepares.
    const nodes: AudioWorkletNode[] = []
    const FakeNode = globalThis.AudioWorkletNode
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: class extends FakeNode {
      constructor(...args: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...args)
        nodes.push(this)
      }
    } })
    await live.pausedAt(1)
    const mark = live.mark()
    live.setTracks([{ ...track, volume: 0.5 }])
    await live.expectLive(false, 1, mark, 'volume')
    const session = live.liveSession()
    const prepared = nodes.length
    // Equal tracks in a new array re-run the effect, which reads them for its fingerprint, without changing that fingerprint.
    live.setTracks([{ ...track, volume: 0.5 }])
    await live.until(() => session?.closed === true || nodes.length !== prepared)
    expect({ disposed: session?.closed, prepares: nodes.length - prepared }).toEqual({ disposed: false, prepares: 0 })
    await live.expectLive(false, 1, mark, 'volume')
  }, false)
})

// B6f5: a playing portable session follows every edit as native adoption does. What the session carries live (mixer,
// master, automation) is adopted on the same core; anything else rebuilds it where the transport stands. A pending Play,
// rebuild or re-prepare ends carrying the newest edit (AE-08). The fixture is the browser build's, as B6f's, with the
// Timeline's processor and instrument bindings (Timeline.tsx:447-468) and a worklet that records what each session holds.
type B6f5Session = { createdSeq: number; closed: boolean; graph: AudioCoreGraphSnapshot | undefined; publishedRevision: number | undefined
  parameters: string; adoptions: number; positions: { seq: number; sec: number; running: boolean }[]
  proc: { seq: number; values: number[] }[]; inst: { seq: number; values: number[] }[] }
type B6f5World = { seq: number; sessions: B6f5Session[]; transportHold: B6fLiveHold
  pauseHold: B6fLiveHold; onNode?: () => void }
type B6f5Kind = 'mixer' | 'master' | 'automation' | 'structural' | 'proc-live' | 'proc-nonlive' | 'synth-live' | 'synth-nonlive' | 'sampled'
const b6f5LiveKinds = new Set<B6f5Kind>(['proc-live', 'synth-live'])
// What a playing session adopts on its own core (D5); elsewhere these reach the session as any edit does.
const b6f5AdoptedKinds = new Set<B6f5Kind>(['mixer', 'master', 'automation'])
const b6f5TrackS: Track = { ...track, id: 'track-s', name: 'Sampled' }
const b6f5TrackB: Track = { ...track, id: 'track-b6f', name: 'B6f5 edit' }
const b6f5Utility0: UtilityParamsEnvelope = { version: 1, state: createDefaultUtilityParams() }
const b6f5Synth0: TrackInstrumentParams = { kind: 'synth', instanceId: 'synth:1', params: createDefaultSynthParams() }
const b6f5Sampler0: TrackInstrumentParams = { kind: 'sampler', instanceId: 'sampler:1', params: createDefaultSamplerParams() }
const b6f5Automation: AutomationEnvelope = { id: 'automation-b6f5', projectId: 'project-a', target: { kind: 'track', trackId: 'track-1' },
  targetKey: 'automation-b6f5', parameterId: 'volume', enabled: true,
  points: [{ id: 'point', timeSec: 0, value: 0.25, interpolation: 'hold' }], updatedAt: 1 }

const b6f5UtilityInstance = (params: UtilityParamsEnvelope): AudioEffectRuntimeInstance => ({ id: 'utility-1', kind: 'utility', params })

const b6f5Bindings = async () => {
  const source = await readFile(new URL('../components/Timeline.tsx', import.meta.url), 'utf8')
  const { portable, structural } = extractTimelineBindings(source)
  const transpile = (code: string) => new Bun.Transpiler({ loader: 'ts' }).transformSync(code)
  const makePortable = new Function('deps', transpile(`
    const { liveProcessorControl, rebuildPlaybackBackend, renderTracks, SYNTH_KIND_ID } = deps;
    return ({ ${portable} }).applyPortableProcessor;`))
  const makeStructural = new Function('deps', transpile(`
    const { mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
      isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
      rebuildPlaybackBackend, renderTracks, captureStructuralPlaybackIntent, notify } = deps;
    let instrumentPlaybackChangeTail = Promise.resolve();
    return ({ ${structural} }).onStructuralPlaybackChange;`))
  return { makePortable, makeStructural }
}

const mountB6f5 = (world: B6f5World, nativeEnabled: boolean, bindings: Awaited<ReturnType<typeof b6f5Bindings>>) => {
  const fake = createFakeEngine({ clipId: 'clip-1', startSec: 1, endSec: 2 })
  const audioContext = new AudioContext()
  let audioCreated = false
  const resumeHold = b6fLiveHold()
  const compileHold = b6fLiveHold()
  const [tracks, setTracks] = createSignal<Track[]>([track, b6f5TrackS])
  const [projectId] = createSignal('project-a')
  const [generation] = createSignal(1)
  const [utility, setUtility] = createSignal(b6f5Utility0)
  const [synth, setSynth] = createSignal(b6f5Synth0)
  const [sampler, setSampler] = createSignal(b6f5Sampler0)
  const [masterVolume, setMasterVolume] = createSignal(1)
  const [automation, setAutomation] = createSignal<AutomationEnvelope[]>([])
  const fxOf = (instrumentOverride?: { targetId: string; instrument: TrackInstrumentParams }) => ({
    masterVolume: masterVolume(), masterFxInstances: [],
    trackFx: {
      'track-1': { instances: [b6f5UtilityInstance(utility())],
        instrument: instrumentOverride?.targetId === 'track-1' ? instrumentOverride.instrument : synth() },
      'track-s': { instances: [], instrument: instrumentOverride?.targetId === 'track-s' ? instrumentOverride.instrument : sampler() },
    },
  })
  // Timeline.tsx:447-468: the registry observes the effective projection; the playback inputs carry master volume,
  // automation and the processor structure.
  const registry = createProcessorEditRegistry(() => 120)
  createComputed(() => { const fx = fxOf(); untrack(() => registry.observe(fx)) })
  const playbackInputs = createMemo(() => ({ masterVolume: masterVolume(), automationEnvelopes: automation(),
    processorStructure: registry.structure() }))
  const faults: string[] = []
  let compiles = 0
  const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]['transport'], context?: LivePlaybackCompileContext) => {
    if (compileHold.armed) await new Promise<void>((resolve) => holdB6fLive(compileHold, resolve))
    compiles += 1
    return compileLivePlaybackSnapshot({ revision: compiles, bpm: 120, transport, tracks: tracks(),
      renderState: { fx: fxOf(context?.instrumentOverride), automationEnvelopes: automation() }, sidechainRoutes: [] })
  }
  const engine = {
    ...fake.engine,
    ensureAudio: () => { audioCreated = true },
    getAudioContext: () => audioCreated ? audioContext : null,
    resume: async () => { if (resumeHold.armed) await new Promise<void>((resolve) => holdB6fLive(resumeHold, resolve)) },
  }
  const playback = useTimelinePlayback(engine, { getTracks: () => tracks() }, {
    enabled: () => nativeEnabled, projectId, projectGeneration: generation, compileSnapshot, playbackInputs,
    reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
  }, { projectGeneration: generation, compileSnapshot, reportFault: (message) => faults.push(message) })
  // Timeline.tsx:871-895 and :923-934, as written there.
  type B6f5Intent = NonNullable<Parameters<typeof playback.restartTimelineSchedule>[1]>
  const captureStructuralPlaybackIntent = (): B6f5Intent => ({
    resumePlayback: playback.isPlaying(), playheadSec: playback.playheadSec(),
    owner: playback.isNativePlaybackPrepared() ? 'native' : playback.isPortableBrowserPlaybackPrepared() ? 'portable-browser' : undefined,
    projectId: projectId(), projectGeneration: generation(),
  })
  const rebuildPlaybackBackend = (next: Track[], intent?: B6f5Intent,
    instrumentOverride?: { targetId: string; instrument: TrackInstrumentParams }) => playback.restartTimelineSchedule(next, {
    rebuildBackend: true, ...(intent ?? captureStructuralPlaybackIntent()), instrumentOverride: instrumentOverride ? instrumentOverride : undefined })
  const rescheduleTimeline = () => {
    if (playback.isNativePlaybackPrepared() || playback.isPortableBrowserPlaybackPrepared()) {
      void rebuildPlaybackBackend(tracks()).catch((cause: unknown) => faults.push(`rebuild: ${String(cause)}`))
      return
    }
    if (playback.isPlaying()) playback.restartTimelineSchedule(tracks()).catch((cause: unknown) => faults.push(`reschedule: ${String(cause)}`))
  }
  const applyPortableProcessor: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined> = bindings.makePortable({
    liveProcessorControl: playback.liveProcessorControl, rebuildPlaybackBackend, renderTracks: tracks, SYNTH_KIND_ID })
  const announce: (targetId: string, instrument: TrackInstrumentParams | undefined) => Promise<void> = bindings.makeStructural({
    mountedProjectGeneration: generation, awaitPlaybackPreparation: playback.awaitPlaybackPreparation,
    preparedInstrument: playback.preparedInstrument, isStructuralRebuildInProgress: playback.isStructuralRebuildInProgress,
    isPreparingPlayback: playback.isPreparingPlayback, isPlaying: playback.isPlaying,
    isNativePlaybackPrepared: playback.isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared: playback.isPortableBrowserPlaybackPrepared,
    rebuildPlaybackBackend, renderTracks: tracks, captureStructuralPlaybackIntent,
    notify: (title: string, message: string) => { faults.push(`${title}: ${message}`) },
  })
  const work: Promise<unknown>[] = []
  let lastEdit: LiveProcessorEditIdentity | undefined
  const setVolume = (volume: number) => setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, volume } : entry))
  // One user edit of each kind, delivered the way the product delivers it.
  const edit = (kind: B6f5Kind) => {
    if (kind === 'mixer') setVolume(0.5)
    if (kind === 'master') setMasterVolume(0.5)
    if (kind === 'automation') setAutomation([b6f5Automation])
    if (kind === 'structural') { setTracks((current) => [...current, b6f5TrackB]); rescheduleTimeline() }
    if (kind === 'proc-live' || kind === 'proc-nonlive') {
      const to: UtilityParamsEnvelope = { version: 1, state: kind === 'proc-live' ? { ...utility().state, gainDb: 3.25 } : { ...utility().state, swap: true } }
      const allocated = registry.allocate({ targetId: track.id, instanceId: 'utility-1', effect: 'utility', from: utility(), to })
      if (!allocated) throw new Error('Missing utility edit')
      lastEdit = allocated
      setUtility(to)
      work.push(applyPortableProcessor(allocated).catch((cause: unknown) => faults.push(`apply: ${String(cause)}`)))
    }
    if (kind === 'synth-live' || kind === 'synth-nonlive') {
      const current = synth()
      const to: TrackInstrumentParams = current.kind === 'synth' ? { ...current, params: mergeSynthParams(current.params,
        kind === 'synth-live' ? { filter: { frequencyHz: 1500 } } : { polyphony: 4 }) } : current
      const allocated = registry.allocate({ targetId: track.id, effect: 'instrument', from: to, to })
      if (!allocated) throw new Error('Missing synth edit')
      lastEdit = allocated
      setSynth(to)
      // create-effects-panel-state.ts applies the Synth through applyPortableProcessor; the release announces it.
      work.push(applyPortableProcessor(allocated).then(() => announce(track.id, to)).catch((cause: unknown) => faults.push(`synth: ${String(cause)}`)))
    }
    if (kind === 'sampled') {
      const current = sampler()
      const to: TrackInstrumentParams = current.kind === 'sampler' ? { ...current, params: { ...current.params, filterFrequencyHz: 5000 } } : current
      setSampler(to)
      work.push(announce(b6f5TrackS.id, to).catch((cause: unknown) => faults.push(`sampled: ${String(cause)}`)))
    }
    if (b6f5LiveKinds.has(kind) && Object.keys(lastEdit?.content.values ?? {}).length === 0) throw new Error(`B6f5 live edit ${kind} has no values`)
  }
  // The graph the newest desired state prepares, through the controller's own compilers (preparedSession).
  const desiredGraph = () => {
    const compiled = compileLivePlaybackSnapshot({ revision: 1, bpm: 120, tracks: tracks(), sidechainRoutes: [],
      transport: { state: 'paused', playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
      renderState: { fx: fxOf(), automationEnvelopes: automation() } })
    if (!compiled.supported) throw new Error(compiled.reasons.join(' '))
    const prepared = compilePreparedPortableLiveSession(compiled.snapshot, { assetRegistry: { projectGeneration: 1, assets: [] },
      sampleRateHz: 48_000, transportEpoch: 1, timeOrigin: { timelineSec: 0, frame: 0 }, rangeEndSec: 1, sourceFirstSequence: 1 })
    if (!prepared.supported) throw new Error('B6f5 desired graph is unsupported')
    return prepared.graph
  }
  // What the worklet holds: its prepared graph and installed schedule, plus the live values it took.
  const carries = (kind: B6f5Kind, session: B6f5Session | undefined) => {
    const graph = session?.graph
    if (!graph) return false
    const desired = desiredGraph()
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id)
    const changed = (id: string, field: 'processorOrder' | 'instrument') => JSON.stringify(node(id)?.[field])
      !== JSON.stringify(desired.nodes.find((entry) => entry.id === id)?.[field])
    const values = Object.values(lastEdit?.content.values ?? {}).toSorted()
    const liveTook = (batches: { values: number[] }[]) => batches.some((batch) => Bun.deepEquals(batch.values.toSorted(), values))
    if (kind === 'mixer') return node(track.id)?.mixer?.gain === 0.5
    if (kind === 'master') return node(graph.masterNodeId)?.mixer?.gain === 0.5
    if (kind === 'automation') return session.parameters.includes('"value":0.25')
    if (kind === 'structural') return node(b6f5TrackB.id) !== undefined
    if (kind === 'proc-live') return !changed(track.id, 'processorOrder') || liveTook(session.proc)
    if (kind === 'proc-nonlive') return !changed(track.id, 'processorOrder')
    if (kind === 'synth-live') return !changed(track.id, 'instrument') || liveTook(session.inst)
    if (kind === 'synth-nonlive') return !changed(track.id, 'instrument')
    return !changed(b6f5TrackS.id, 'instrument')
  }
  const summary = (mark: number, kind: B6f5Kind) => {
    const open = world.sessions.filter((session) => !session.closed)
    const session = open.at(-1)
    const position = session?.positions.at(-1)
    return {
      faults: [...faults], playing: playback.isPlaying(), portableActive: playback.isPortableBrowserPlayback(),
      prepared: playback.isPortableBrowserPlaybackPrepared(), openSessions: open.length,
      position: position && { sec: position.sec, running: position.running }, playhead: playback.playheadSec(),
      carries: carries(kind, session),
      runningAfterMark: world.sessions.flatMap((entry) => entry.positions).filter((entry) => entry.seq > mark && entry.running).length,
      sessionsAfterMark: world.sessions.filter((entry) => entry.createdSeq > mark).length,
    }
  }
  const until = async (reached: () => boolean) => {
    for (let turn = 0; turn < 5_000 && !reached(); turn += 1) await Promise.resolve()
  }
  // Once the transport settles the one live session carries the newest edit: paused or stopped at the playhead with
  // nothing running after the mark, or playing, and without a new session for an edit the playing session takes live.
  const expectEnd = async (running: boolean, sec: number | undefined, mark: number, kind: B6f5Kind, noRebuild: boolean) => {
    const expected = (): ReturnType<typeof summary> => {
      const now = summary(mark, kind)
      return {
        faults: [], playing: running, portableActive: running, prepared: true, openSessions: 1,
        position: { sec: (running ? now.position?.sec : sec) ?? Number.NaN, running }, playhead: (running ? now.playhead : sec) ?? Number.NaN, carries: true,
        runningAfterMark: running ? now.runningAfterMark : 0, sessionsAfterMark: noRebuild ? 0 : now.sessionsAfterMark,
      }
    }
    const settled = () => !playback.isPreparingPlayback() && !playback.isStructuralRebuildInProgress() && Bun.deepEquals(summary(mark, kind), expected())
    await until(settled)
    await Promise.allSettled(work)
    await until(settled)
    expect(summary(mark, kind)).toEqual(expected())
    // Settled means settled: no further session is prepared once the end state holds.
    const sessions = world.sessions.length
    await until(() => world.sessions.length !== sessions)
    expect(world.sessions.length).toBe(sessions)
  }
  const settle = () => until(() => !playback.isPreparingPlayback() && !playback.isStructuralRebuildInProgress())
  const playFrom = async (sec: number) => {
    playback.setPlayhead(sec, tracks())
    await playback.handlePlay(tracks())
    await until(() => playback.isPortableBrowserPlayback() && !playback.isPreparingPlayback())
    expect(playback.isPortableBrowserPlayback()).toBeTrue()
  }
  const pausedAt = async (sec: number) => {
    await playFrom(sec)
    await playback.handlePause()
    await until(() => playback.isPortableBrowserPlaybackPrepared() && !playback.isPreparingPlayback())
  }
  const resumingRebuild = () => playback.restartTimelineSchedule(tracks(), {
    rebuildBackend: true, resumePlayback: true, playheadSec: 2, owner: 'portable-browser', projectId: projectId(), projectGeneration: generation(),
  })
  return { playback, edit, expectEnd, settle, until, playFrom, pausedAt, resumingRebuild, setTracks, setVolume, mark: () => world.seq,
    liveSession: () => world.sessions.filter((session) => !session.closed).at(-1),
    holds: { resume: resumeHold, compile: compileHold, transport: world.transportHold, pause: world.pauseHold } }
}

const runB6f5 = async (body: (live: ReturnType<typeof mountB6f5>, world: B6f5World) => Promise<void>, nativeEnabled: boolean) => {
  const bindings = await b6f5Bindings()
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    AudioContext: Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'),
    AudioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode'),
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
  }
  const world: B6f5World = { seq: 0, sessions: [], transportHold: b6fLiveHold(), pauseHold: b6fLiveHold() }
  class FakeAudioContext {
    readonly sampleRate = 48_000
    readonly destination = {}
    readonly audioWorklet = { addModule: async () => undefined }
  }
  class FakeAudioWorkletNode {
    readonly port: { onmessage: ((event: { data: PortableWasmStatusMessage }) => void) | null; postMessage: (message: PortableWasmControlMessage) => void; close: () => void }
    constructor() {
      const session: B6f5Session = { createdSeq: ++world.seq, closed: false, graph: undefined, publishedRevision: undefined, parameters: '',
        adoptions: 0, positions: [], proc: [], inst: [] }
      world.sessions.push(session)
      world.onNode?.()
      this.port = {
        onmessage: null,
        postMessage: (message) => {
          world.seq += 1
          if (message.type === 'prepare-graph') session.graph = message.snapshot
          if (message.type === 'publish-graph') {
            session.publishedRevision = message.revision
            if (message.requireContinuity) session.adoptions += 1
          }
          if (message.type === 'install-schedule') {
            session.parameters = JSON.stringify(message.schedule.events.filter((event) => event.type.startsWith('parameter')))
            // A schedule staged for the next revision moves no transport: the publish swaps it in at the playing frame.
            const staged = session.publishedRevision !== undefined && message.schedule.revision > session.publishedRevision
            if (!staged) session.positions.push({ seq: world.seq, sec: message.schedule.timeOrigin.timelineSec, running: false })
          }
          if (message.type === 'transport') session.positions.push({ seq: world.seq, sec: message.frame / 48_000, running: message.running })
          let response = portableResponseFor(message)
          if (message.type === 'processor-events') {
            session.proc.push({ seq: world.seq, values: message.events.map((event) => event.value) })
            response = { version: portableWasmProtocolVersion, type: 'processor-events-applied', requestId: message.requestId,
              revision: message.revision, epoch: message.epoch, sequence: message.sequence, result: 'applied' }
          }
          if (message.type === 'instrument-parameters') {
            session.inst.push({ seq: world.seq, values: message.events.map((event) => event.value) })
            response = { version: portableWasmProtocolVersion, type: 'instrument-events-applied', requestId: message.requestId,
              revision: message.revision, epoch: message.epoch, sequence: message.sequence, result: 'applied' }
          }
          if (!response) return
          const answer = response
          const deliver = () => queueMicrotask(() => this.port.onmessage?.({ data: answer }))
          if (message.type === 'transport' && message.running && world.transportHold.armed) holdB6fLive(world.transportHold, deliver)
          else if (message.type === 'transport' && !message.running && world.pauseHold.armed) holdB6fLive(world.pauseHold, deliver)
          else deliver()
        },
        close: () => { session.closed = true },
      }
    }
    onprocessorerror: (() => {}) | null = null
    connect = () => {}
    disconnect = () => {}
  }
  const manifest = await readFile(new URL('../../public/audio-core/daw-audio-core.manifest.json', import.meta.url), 'utf8')
  const wasm = await readFile(new URL('../../public/audio-core/daw-audio-core.wasm', import.meta.url))
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string | URL) => (
    String(input).endsWith('.manifest.json') ? new Response(manifest, { status: 200 }) : new Response(wasm, { status: 200 })) })
  try {
    await withFakeRaf(() => createRoot(async (dispose) => {
      try {
        await body(mountB6f5(world, nativeEnabled, bindings), world)
      } finally {
        dispose()
      }
    }))
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

type B6f5State = 'paused' | 'stopped' | 'playing' | 'pending-warm-play' | 'pending-cold-play-precompile' | 'pending-cold-play-postcompile'
  | 'pending-pause' | 'pending-stop' | 'rebuild-precompile' | 'rebuild-before-commit' | 'rebuild-after-commit'
  | 'paused-reprepare-precompile' | 'paused-reprepare-postcompile'

// One cell of the newest-edit matrix: drive the transport into `state`, make one edit of `kind`, and expect the end state.
const b6f5Cell = (state: B6f5State, kind: B6f5Kind, nativeEnabled: boolean) => runB6f5(async (live, world) => {
  const { playback } = live
  if (state === 'paused' || state === 'stopped') {
    await live.pausedAt(1)
    if (state === 'stopped') { await playback.handleStop(); await live.settle() }
    const mark = live.mark()
    live.edit(kind)
    return live.expectEnd(false, state === 'stopped' ? 0 : 1, mark, kind, b6f5LiveKinds.has(kind))
  }
  if (state === 'playing') {
    await live.playFrom(1)
    const mark = live.mark()
    live.edit(kind)
    return live.expectEnd(true, undefined, mark, kind, b6f5LiveKinds.has(kind) || b6f5AdoptedKinds.has(kind))
  }
  if (state === 'pending-warm-play' || state === 'pending-cold-play-precompile' || state === 'pending-cold-play-postcompile') {
    if (state === 'pending-warm-play') await live.pausedAt(1)
    else playback.setPlayhead(1, [])
    const hold = state === 'pending-cold-play-precompile' ? live.holds.compile : live.holds.transport
    hold.armed = true
    const play = playback.handlePlay([])
    await hold.reached.promise
    const mark = live.mark()
    live.edit(kind)
    releaseB6fLive(hold)
    await play
    return live.expectEnd(true, undefined, mark, kind, false)
  }
  if (state === 'pending-pause' || state === 'pending-stop') {
    await live.playFrom(1)
    const mark = live.mark()
    live.holds.pause.armed = true
    const action = state === 'pending-pause' ? playback.handlePause() : playback.handleStop()
    await live.holds.pause.reached.promise
    live.edit(kind)
    releaseB6fLive(live.holds.pause)
    await action
    return live.expectEnd(false, state === 'pending-stop' ? 0 : 1, mark, kind, false)
  }
  if (state === 'rebuild-precompile' || state === 'rebuild-before-commit') {
    await live.playFrom(1)
    const hold = state === 'rebuild-precompile' ? live.holds.compile : live.holds.transport
    hold.armed = true
    const rebuild = live.resumingRebuild()
    await hold.reached.promise
    const mark = live.mark()
    live.edit(kind)
    releaseB6fLive(hold)
    await rebuild.catch(() => undefined)
    return live.expectEnd(true, undefined, mark, kind, false)
  }
  if (state === 'rebuild-after-commit') {
    await live.playFrom(1)
    const before = live.mark()
    const rebuild = live.resumingRebuild()
    // The rebuild's own session runs and the hook committed it while the rebuild still owns the transport.
    const committed = () => playback.isPortableBrowserPlayback() && playback.isPlayPending() === false && playback.isStructuralRebuildInProgress()
      && (world.sessions.at(-1)?.createdSeq ?? 0) > before && world.sessions.at(-1)?.positions.at(-1)?.running === true
      && world.sessions.filter((session) => !session.closed).length === 1
    await live.until(committed)
    expect(committed()).toBeTrue()
    const mark = live.mark()
    live.edit(kind)
    await rebuild.catch(() => undefined)
    return live.expectEnd(true, undefined, mark, kind, false)
  }
  await live.pausedAt(1)
  const mark = live.mark()
  if (state === 'paused-reprepare-precompile') {
    live.holds.compile.armed = true
    playback.setPlayhead(3, [])
    await live.holds.compile.reached.promise
    live.edit(kind)
    releaseB6fLive(live.holds.compile)
  } else {
    // The compile has run and the session is still being prepared.
    let armed = true
    world.onNode = () => { if (armed) { armed = false; queueMicrotask(() => live.edit(kind)) } }
    playback.setPlayhead(3, [])
    await live.until(() => !armed)
    expect(armed).toBeFalse()
  }
  return live.expectEnd(false, 3, mark, kind, false)
}, nativeEnabled)

test('B6f5 A a mixer, master or automation edit while playing is adopted by the playing portable session', async () => {
  for (const nativeEnabled of [false, true]) for (const kind of b6f5AdoptedKinds) await runB6f5(async (live) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const mark = live.mark()
    live.edit(kind)
    await live.expectEnd(true, undefined, mark, kind, true)
    expect({ kind, same: live.liveSession() === session, adoptions: session?.adoptions }).toEqual({ kind, same: true, adoptions: 1 })
  }, nativeEnabled)
})

test('B6f5 A an edit the playing portable session cannot carry live rebuilds it once', async () => {
  await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const mark = live.mark()
    // A track the resolved tracks gain without a Timeline rebuild: only the playing session's follow can carry it.
    live.setTracks((current) => [...current, b6f5TrackB])
    await live.expectEnd(true, undefined, mark, 'structural', false)
    expect({ adoptions: session?.adoptions, closed: session?.closed, sessionsAfterMark: world.sessions.filter((entry) => entry.createdSeq > mark).length })
      .toEqual({ adoptions: 0, closed: true, sessionsAfterMark: 1 })
  }, false)
})

test('B6f5 B an edit during a Play whose compile has run reaches the session that Play commits', async () => {
  const kinds: B6f5Kind[] = ['mixer', 'structural', 'proc-nonlive']
  for (const kind of kinds) await b6f5Cell('pending-cold-play-postcompile', kind, false)
})

test('B6f5 C an edit during a resuming rebuild reaches the session the rebuild commits', async () => {
  const states: B6f5State[] = ['rebuild-before-commit', 'rebuild-after-commit']
  const kinds: B6f5Kind[] = ['mixer', 'proc-nonlive']
  for (const state of states) for (const kind of kinds) await b6f5Cell(state, kind, false)
})

test('B6f5 D a structural edit during a warm Play keeps the Play and reaches its session', async () => {
  const kinds: B6f5Kind[] = ['structural', 'proc-nonlive']
  for (const kind of kinds) await b6f5Cell('pending-warm-play', kind, false)
})

test('B6f5 E with native playback on, an edit during a pending browser Play keeps the session that Play starts from', async () => {
  const cells: [B6f5State, B6f5Kind][] = [['pending-cold-play-precompile', 'mixer'], ['pending-warm-play', 'sampled'], ['pending-warm-play', 'synth-nonlive']]
  for (const [state, kind] of cells) await b6f5Cell(state, kind, true)
})

test('B6f5 F a live processor edit during a Play or re-prepare in flight reaches the session it commits', async () => {
  const cells: [B6f5State, B6f5Kind][] = [['pending-cold-play-postcompile', 'proc-live'], ['paused-reprepare-postcompile', 'proc-live'],
    ['paused-reprepare-postcompile', 'synth-live']]
  for (const [state, kind] of cells) await b6f5Cell(state, kind, false)
})

test('B6f5 twenty settled volume commits while playing are twenty adoptions and no rebuild; a burst coalesces', async () => {
  await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const sessions = world.sessions.length
    for (let frame = 1; frame <= 20; frame += 1) {
      live.setVolume(frame / 40)
      await live.until(() => session?.adoptions === frame)
    }
    const settled = { sessions: world.sessions.length - sessions, adoptions: session?.adoptions }
    for (let frame = 1; frame <= 20; frame += 1) live.setVolume(0.5 + frame / 100)
    // Published, not only prepared: the adoption that carries the burst's last value has answered.
    await live.until(() => session?.graph?.nodes.find((node) => node.id === track.id)?.mixer?.gain === 0.7
      && session.publishedRevision === session.graph.revision)
    expect({ settled, burstAdoptions: (session?.adoptions ?? 0) - 20, burstSessions: world.sessions.length - sessions, playing: live.playback.isPlaying() })
      .toEqual({ settled: { sessions: 0, adoptions: 20 }, burstAdoptions: expect.any(Number), burstSessions: 0, playing: true })
    expect((session?.adoptions ?? 0) - 20).toBeWithin(1, 3)
  }, false)
})

// B6f5 step 5b: a track's name and colour change nothing a session plays, so a playing session neither adopts nor rebuilds.
test('B6f5 renaming and recolouring a track while playing is neither adopted nor rebuilt', async () => {
  for (const nativeEnabled of [false, true]) await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const sessions = world.sessions.length
    live.setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, name: 'Renamed', color: '#123456' } : entry))
    await live.until(() => world.sessions.length !== sessions || (session?.adoptions ?? 0) > 0)
    await live.settle()
    expect({ nativeEnabled, rebuilds: world.sessions.length - sessions, adoptions: session?.adoptions, open: session?.closed === false,
      playing: live.playback.isPlaying() })
      .toEqual({ nativeEnabled, rebuilds: 0, adoptions: 0, open: true, playing: true })
  }, nativeEnabled)
})

// B6f5 step 5b: native paused preview reads the same track fingerprint. A rename or recolour recompiles nothing; a field
// the compile reads still re-prepares the preview.
test('B6f5 renaming a track while paused on native does not recompile the paused preview; a volume edit does', async () => {
  const previousWindow = globalThis.window
  const [tracks, setTracks] = createSignal([audioTrack(new TestAudioBuffer())])
  const fixture = createNativeHookBridge(undefined, undefined, undefined, undefined, "failed", true)
  const faults: string[] = []
  let compiles = 0
  const compileSnapshot = async (transport: Parameters<typeof compileLivePlaybackSnapshot>[0]["transport"]) => {
    compiles += 1
    return compileLivePlaybackSnapshot({ revision: 1, bpm: 120, transport, tracks: tracks(),
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] }, sidechainRoutes: [] })
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dawDesktop: { audioHost: fixture.audioHost } } })
  try {
    let dispose = () => {}
    const playback = createRoot((cleanup) => {
      dispose = cleanup
      return useTimelinePlayback(createFakeEngine({ clipId: "clip-audio", startSec: 0, endSec: 1 }).engine, { getTracks: () => tracks() }, {
        requiresNativeAudio: true, enabled: () => true, projectId: () => "project", compileSnapshot,
        reportFault: (fault) => faults.push(nativePlaybackFaultText(fault)),
      })
    })
    await flushMicrotasks()
    const prepared = { compiles, begins: fixture.calls.filter((call) => call === "begin").length, prepared: playback.isNativePlaybackPrepared() }
    setTracks((current) => current.map((entry) => ({ ...entry, name: "Renamed", color: "#123456" })))
    await flushMicrotasks()
    const renamed = { compiles: compiles - prepared.compiles, begins: fixture.calls.filter((call) => call === "begin").length - prepared.begins }
    setTracks((current) => current.map((entry) => ({ ...entry, volume: 0.25 })))
    await flushMicrotasks()
    expect({ prepared: prepared.prepared, renamed, volumeRecompiled: compiles - prepared.compiles - renamed.compiles > 0, faults })
      .toEqual({ prepared: true, renamed: { compiles: 0, begins: 0 }, volumeRecompiled: true, faults: [] })
    dispose()
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow })
  }
})

// B6f5 step 5b: a warm resume compiles nothing, so its commit takes the state the last compile read, an adoption's
// included. After an adopted edit it plays the newest state at once, with no follow compiling it again.
test('B6f5 a warm resume after an adoption plays the newest state without another compile', async () => {
  for (const nativeEnabled of [false, true]) await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    live.setVolume(0.5)
    await live.until(() => session?.adoptions === 1)
    // The hook records what the adoption carries once its answer arrives, after the publish this waits for.
    for (let turn = 0; turn < 2_000; turn += 1) await Promise.resolve()
    await live.playback.handlePause()
    await live.settle()
    live.holds.compile.armed = true
    await live.playback.handlePlay([])
    for (let turn = 0; turn < 3_000; turn += 1) await Promise.resolve()
    const compiles = live.holds.compile.held.length
    releaseB6fLive(live.holds.compile)
    await live.until(() => live.playback.isPortableBrowserPlayback() && !live.playback.isPreparingPlayback())
    expect({ nativeEnabled, compiles, sessions: world.sessions.length, same: live.liveSession() === session, playing: live.playback.isPlaying(),
      gain: live.liveSession()?.graph?.nodes.find((node) => node.id === track.id)?.mixer?.gain })
      .toEqual({ nativeEnabled, compiles: 0, sessions: 1, same: true, playing: true, gain: 0.5 })
  }, nativeEnabled)
})

// B6f5 step 5b: an adoption that only finds a renamed track, after an edit and its undo coalesce, plays what it played:
// the resolved mixer graph's channel label is not content.
test('B6f5 a rename coalesced with an edit and its undo is neither adopted nor rebuilt', async () => {
  await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const sessions = world.sessions.length
    live.holds.compile.armed = true
    live.setVolume(0.5)
    await live.holds.compile.reached.promise
    live.setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, name: 'Renamed' } : entry))
    live.setVolume(track.volume)
    releaseB6fLive(live.holds.compile)
    await live.until(() => world.sessions.length !== sessions || (session?.adoptions ?? 0) > 0)
    await live.settle()
    expect({ rebuilds: world.sessions.length - sessions, adoptions: session?.adoptions, playing: live.playback.isPlaying(),
      gain: session?.graph?.nodes.find((node) => node.id === track.id)?.mixer?.gain })
      .toEqual({ rebuilds: 0, adoptions: 0, playing: true, gain: track.volume })
  }, false)
})

// B6f5 step 5b: mute and solo are fields the compile reads (createMixerChannel), so a playing session adopts them.
test('B6f5 a mute or solo edit while playing is adopted by the playing portable session', async () => {
  const fields: ('muted' | 'soloed')[] = ['muted', 'soloed']
  for (const field of fields) await runB6f5(async (live, world) => {
    await live.playFrom(1)
    const session = live.liveSession()
    const sessions = world.sessions.length
    // Mute is a node's mixer state; solo resolves through the routing, so the whole graph is compared.
    const graphContent = () => JSON.stringify({ ...session?.graph, revision: undefined })
    const before = graphContent()
    live.setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, [field]: true } : entry))
    await live.until(() => world.sessions.length !== sessions || (session?.adoptions ?? 0) > 0)
    await live.settle()
    expect({ field, rebuilds: world.sessions.length - sessions, adoptions: session?.adoptions, graphChanged: graphContent() !== before })
      .toEqual({ field, rebuilds: 0, adoptions: 1, graphChanged: true })
  }, false)
})

// B6f5c: a clip's name and colour reach no compile (export, control and UI code read them), so a playing session neither
// adopts nor rebuilds for them. A clip field the compile reads (its start) still rebuilds.
const b6f5cClip: Track['clips'][number] = { id: 'clip-b6f5c', name: 'B6f5c clip', color: '#ffffff', startSec: 0, duration: 8,
  midi: { wave: 'sine', notes: Array.from({ length: 8 }, (_, index) => ({ id: `note-b6f5c-${index}`, pitch: 60, beat: index, length: 0.5, velocity: 0.8 })) } }
const b6f5cGroup: Track = { ...track, id: 'track-g', name: 'B6f5c group', channelRole: 'group' }
const b6f5cEditOutcome = async (live: ReturnType<typeof mountB6f5>, world: B6f5World, edit: () => void) => {
  const session = live.liveSession()
  const sessions = world.sessions.length
  edit()
  await live.until(() => world.sessions.length !== sessions || (session?.adoptions ?? 0) > 0)
  await live.settle()
  return { rebuilds: world.sessions.length - sessions, adoptions: session?.adoptions, open: session?.closed === false, playing: live.playback.isPlaying() }
}

test('B6f5c recolouring or renaming a clip while playing is neither adopted nor rebuilt; a clip move still rebuilds', async () => {
  const edits: [string, (clip: Track['clips'][number]) => Track['clips'][number], number][] = [
    ['color', (clip) => ({ ...clip, color: '#123456' }), 0],
    ['name', (clip) => ({ ...clip, name: 'Renamed clip' }), 0],
    ['startSec', (clip) => ({ ...clip, startSec: 0.25 }), 1],
  ]
  for (const nativeEnabled of [false, true]) for (const [field, patch, rebuilds] of edits) await runB6f5(async (live, world) => {
    live.setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, kind: 'instrument', clips: [b6f5cClip] } : entry))
    await live.playFrom(1)
    const outcome = await b6f5cEditOutcome(live, world, () => live.setTracks((current) => current.map((entry) => entry.id === track.id
      ? { ...entry, clips: entry.clips.map(patch) } : entry)))
    expect({ nativeEnabled, field, ...outcome }).toEqual({ nativeEnabled, field, rebuilds, adoptions: 0, open: rebuilds === 0, playing: true })
  }, nativeEnabled)
})

// B6f5c: a group track's colour cascades to its members' clips (planSetTrackColor); the cascade is cosmetic too.
test('B6f5c a group colour cascading to its clips while playing is neither adopted nor rebuilt', async () => {
  for (const nativeEnabled of [false, true]) await runB6f5(async (live, world) => {
    live.setTracks((current) => [...current.map((entry): Track => entry.id === track.id
      ? { ...entry, kind: 'instrument', groupId: b6f5cGroup.id, outputTargetId: b6f5cGroup.id, clips: [b6f5cClip] } : entry), b6f5cGroup])
    await live.playFrom(1)
    let cascaded = 0
    const outcome = await b6f5cEditOutcome(live, world, () => live.setTracks((current) => {
      const plan = planSetTrackColor(current, b6f5cGroup.id, '#ff0000')
      cascaded = plan?.clipUpdates.length ?? 0
      return current.map((entry) => ({
        ...entry,
        color: plan?.trackUpdates.find((update) => update.trackId === entry.id)?.to ?? entry.color,
        clips: entry.clips.map((clip) => ({ ...clip,
          color: plan?.clipUpdates.find((update) => update.trackId === entry.id && update.clipId === clip.id)?.to ?? clip.color })),
      }))
    }))
    expect({ nativeEnabled, cascaded, ...outcome }).toEqual({ nativeEnabled, cascaded: 1, rebuilds: 0, adoptions: 0, open: true, playing: true })
  }, nativeEnabled)
})

// B6f5c: a structural edit made during a portable take is held (the rebuild would end the take). Once the take stops or
// is cancelled with the transport still playing (record toggled off), the playing session carries it. The worklet and the
// writer worker answer the recording messages as the real ones do.
const b6f5cRecording = () => {
  const controls: string[] = []
  const previous = { node: Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode'), worker: Object.getOwnPropertyDescriptor(globalThis, 'Worker') }
  const Base = globalThis.AudioWorkletNode
  class RecordingNode extends Base {
    constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
      super(context, name, options)
      const port = this.port
      const post = port.postMessage.bind(port)
      let take: { generation: number; sessionId: number } | undefined
      port.postMessage = (message: PortableWasmControlMessage) => {
        if (!message.type.startsWith('recording-capture-')) return post(message)
        controls.push(message.type)
        if (message.type === 'recording-capture-configure') take = { generation: message.generation, sessionId: message.sessionId }
        const action = message.type === 'recording-capture-configure' ? 'configured'
          : message.type === 'recording-capture-finalize' ? 'finalized' : message.type === 'recording-capture-cancel' ? 'cancelled' : undefined
        if (!take || !action) return
        const data: PortableWasmStatusMessage = { version: portableWasmProtocolVersion, type: 'recording-capture-applied', ...take, action, frame: 0 }
        queueMicrotask(() => port.onmessage?.call(port, new MessageEvent('message', { data })))
      }
    }
  }
  class WriterWorker {
    onmessage: ((event: { data: object }) => void) | null = null
    postMessage(message: { type: string; generation: number; sessionId: string; capturedFrames?: number }) {
      const reply = message.type === 'start' ? { type: 'ready' } : message.type === 'finalize' ? { type: 'finalized', capturedFrames: message.capturedFrames }
        : message.type === 'abort' ? { type: 'aborted' } : undefined
      if (reply) queueMicrotask(() => this.onmessage?.({ data: { ...reply, generation: message.generation, sessionId: message.sessionId } }))
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: RecordingNode })
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WriterWorker })
  Object.defineProperty(globalThis.AudioContext.prototype, 'createMediaStreamSource', { configurable: true,
    value: () => ({ connect: () => undefined, disconnect: () => undefined }) })
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live', getSettings: () => ({ channelCount: 1 }), addEventListener: () => undefined, removeEventListener: () => undefined })
  const stream: MediaStream = Object.assign(Object.create(null), { getTracks: () => [mediaTrack], getAudioTracks: () => [mediaTrack] })
  const input: Parameters<ReturnType<typeof mountB6f5>['playback']['portableRecording']['start']>[0] = {
    appSessionId: 'take-b6f5c', stream, layout: 'mono', inputChannel: 0, gain: 1, polarity: 1, monitoring: false, punchStartFrame: 0 }
  const restore = () => {
    for (const [key, descriptor] of [['AudioWorkletNode', previous.node], ['Worker', previous.worker]] satisfies [string, PropertyDescriptor | undefined][]) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
  return { controls, input, restore }
}

test('B6f5c a structural edit held by a portable take reaches the playing session once the take stops or is cancelled', async () => {
  for (const end of ['stop', 'cancel']) await runB6f5(async (live, world) => {
    const recording = b6f5cRecording()
    try {
      await live.playFrom(1)
      const session = live.liveSession()
      await live.playback.portableRecording.start(recording.input)
      const mark = live.mark()
      live.setTracks((current) => [...current, b6f5TrackB])
      // The follow answers rebuild and the take holds it.
      for (let turn = 0; turn < 3_000; turn += 1) await Promise.resolve()
      await live.settle()
      expect({ end, held: { sessions: world.sessions.length, open: session?.closed === false,
        carries: session?.graph?.nodes.some((node) => node.id === b6f5TrackB.id), controls: [...recording.controls] } })
        .toEqual({ end, held: { sessions: 1, open: true, carries: false, controls: ['recording-capture-configure'] } })
      await (end === 'stop' ? live.playback.portableRecording.stop() : live.playback.portableRecording.cancel())
      await live.expectEnd(true, undefined, mark, 'structural', false)
      expect({ end, sessionsAfterMark: world.sessions.filter((entry) => entry.createdSeq > mark).length, adoptions: session?.adoptions,
        controls: recording.controls }).toEqual({ end, sessionsAfterMark: 1, adoptions: 0,
        controls: ['recording-capture-configure', end === 'stop' ? 'recording-capture-finalize' : 'recording-capture-cancel'] })
    } finally { recording.restore() }
  }, false)
})

// B6f5c: the routing fields the track fingerprint keeps (createMixerChannel, normalizeTrackRouting) each change the graph
// a session plays. An edit to one while playing reaches the playing session, adopted or rebuilt as continuity decides,
// and it then plays the graph a fresh Play of the edited project prepares.
const b6f5cGraph = (session: B6f5Session | undefined) => JSON.stringify({ ...session?.graph, revision: undefined })
const b6f5cReturn: Track = { ...track, id: 'track-r', name: 'B6f5c return', channelRole: 'return' }
const b6f5cGroup2: Track = { ...track, id: 'track-g2', name: 'B6f5c group 2', channelRole: 'group', outputTargetId: b6f5cGroup.id }
const b6f5cOn = (id: string, patch: Partial<Track>) => (current: Track[]) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)

test('B6f5c a send, output target, channel role or group edit while playing reaches the playing session', async () => {
  const cases: [string, (current: Track[]) => Track[], (current: Track[]) => Track[]][] = [
    ['sends', (current) => [...current, b6f5cReturn], b6f5cOn(track.id, { sends: [{ targetId: b6f5cReturn.id, amount: 0.5 }] })],
    ['outputTargetId', (current) => [...current, b6f5cGroup], b6f5cOn(track.id, { outputTargetId: b6f5cGroup.id })],
    ['channelRole', (current) => [...b6f5cOn(track.id, { outputTargetId: b6f5cGroup.id })(current), { ...b6f5cGroup, channelRole: 'track' }],
      b6f5cOn(b6f5cGroup.id, { channelRole: 'group' })],
    ['groupId', (current) => [...current, b6f5cGroup, b6f5cGroup2], b6f5cOn(b6f5cGroup2.id, { groupId: b6f5cGroup.id })],
  ]
  for (const [field, setup, edit] of cases) {
    let fresh = ''
    await runB6f5(async (live) => {
      live.setTracks((current) => edit(setup(current)))
      await live.playFrom(1)
      fresh = b6f5cGraph(live.liveSession())
    }, false)
    await runB6f5(async (live, world) => {
      live.setTracks(setup)
      await live.playFrom(1)
      const before = b6f5cGraph(live.liveSession())
      const outcome = await b6f5cEditOutcome(live, world, () => live.setTracks(edit))
      const after = b6f5cGraph(live.liveSession())
      expect({ field, changes: before !== fresh, followed: outcome.rebuilds + (outcome.adoptions ?? 0) > 0, carries: after === fresh,
        playing: outcome.playing }).toEqual({ field, changes: true, followed: true, carries: true, playing: true })
    }, false)
  }
})

// C0f item 1, through the hook: a reactive edit while playing publishes a staged revision, and Pause then Play
// resumes the same prepared native session (no stop, teardown or configure).
test('C0F Pause then Play after a staged live publication resumes warm through the hook', async () => {
  const fx = () => ({ masterVolume: 1, masterFxInstances: [], trackFx: {} })
  const inputs = () => ({ masterVolume: 1, automation: [], sidechains: [] })
  const retained: Track = { ...track, id: 'track-c0f-retained', name: 'Retained', clips: [] }
  const [tracks, setTracks] = createSignal<Track[]>([retained])
  const f = await mountStep5Playback({ projectId: 'c0f-resume', tracks, playbackInputs: inputs, desiredFx: fx,
    renderState: async () => ({ fx: fx(), automationEnvelopes: [] }) })
  try {
    await f.playback.handlePlay(untrack(tracks)); await f.frame()
    const edit = f.mark()
    setTracks([...untrack(tracks), { ...track, id: 'track-c0f-added', name: 'Track 4', clips: [] }])
    await f.frame(); await settleStep5Playback()
    expect(f.counts(edit).publishes).toBe(1)
    await f.playback.handlePause(); await f.frame()
    const resume = f.mark()
    await f.playback.handlePlay(untrack(tracks)); await f.frame()
    expect(f.host.calls.slice(resume.calls).filter((call) =>
      ['stop', 'teardown', 'begin', 'configure', 'graph', 'commit', 'start'].includes(call))).toEqual([])
    expect(f.counts(resume).teardowns).toBe(0)
    expect(f.playback.isPlaying()).toBe(true)
    expect(f.faults).toEqual([])
  } finally { await f.close() }
})

// C0g, step 5b: the clip entry names its fields, as the track entry does. A recorder around each clip sees which fields
// the playback compiles read: compileLivePlaybackSnapshot, then, from its snapshot, the native projection (which projects
// audio through projectPortableClipEvents) and the portable session (which schedules MIDI through the frame schedule). A
// property read counts; a whole-object copy (a spread, a rest or structuredClone) does not. Every field a compile reads is
// named, a named field no compile reads is one the hook reads itself, and no compile reads a name, colour or waveform key.
test('C0G the clip fingerprint names every clip field a playback compile reads, and no name, colour or waveform key', async () => {
  const source = await readFile(new URL("./useTimelinePlayback.ts", import.meta.url), "utf8")
  const fingerprint = source.slice(
    source.indexOf("const readNativePreviewTrackFingerprint"),
    source.indexOf("  const disposeNativePreview", source.indexOf("const readNativePreviewTrackFingerprint")),
  )
  const named = fingerprint.match(/const \{ ([^}]+) \} = clip/)?.[1]?.split(/,\s*/).map((field) => field.trim())
  const returned = fingerprint.match(/return \{ (id, [^}]+?),\s*buffer: readBufferFingerprint\(buffer\) \}/)?.[1]?.split(/,\s*/).map((field) => field.trim())
  const reads = new Set<string>()
  const stages = new Map<string, Set<string>>()
  let stage = 'snapshot'
  const recorded = <Clip extends object>(clip: Clip): Clip => {
    const values = new Map(Object.entries(clip))
    let described: string | symbol | undefined
    return new Proxy(clip, {
      getOwnPropertyDescriptor: (target, key) => {
        described = key
        return Object.getOwnPropertyDescriptor(target, key)
      },
      get: (_target, key) => {
        const field = [...values.keys()].find((name) => name === key)
        if (field !== undefined && key !== described) {
          reads.add(field)
          stages.set(stage, new Set([...stages.get(stage) ?? [], field]))
        }
        described = undefined
        return field === undefined ? undefined : values.get(field)
      },
    })
  }
  const duration = 4 / 48_000
  const audio: Track<AudioBuffer> = { ...track, id: 'track-c0g-audio', clips: [{ id: 'clip-c0g-audio', historyRef: 'clip-c0g-audio',
    name: 'Audio', mediaStatus: undefined, startSec: 0, duration, sourceAssetKey: 'asset-c0g', waveformAssetKey: 'waveform:asset-c0g',
    sourceKind: 'upload', sourceDurationSec: duration, sourceSampleRate: 48_000, sourceChannelCount: 1, leftPadSec: 0, bufferOffsetSec: 0,
    audioWarp: undefined, gain: 0.5, fades: undefined, color: '#fff', sampleUrl: 'https://r2.example/asset-c0g.wav', midi: undefined,
    midiOffsetBeats: 0, buffer: new TestAudioBuffer() }] }
  const instrument: Track<AudioBuffer> = { ...track, id: 'track-c0g-midi', kind: 'instrument', clips: [{ ...b6f5cClip, id: 'clip-c0g-midi',
    historyRef: 'clip-c0g-midi', mediaStatus: undefined, sourceAssetKey: undefined, waveformAssetKey: undefined, sourceKind: undefined,
    sourceDurationSec: undefined, sourceSampleRate: undefined, sourceChannelCount: undefined, leftPadSec: 0, bufferOffsetSec: 0,
    audioWarp: undefined, gain: undefined, fades: undefined, sampleUrl: undefined, midiOffsetBeats: 0, buffer: null }] }
  const compiled = compileLivePlaybackSnapshot({ revision: 1, bpm: 120,
    transport: { state: "playing", playheadSec: 0, loopEnabled: false, loopStartSec: 0, loopEndSec: 0 },
    tracks: [audio, instrument].map((entry) => ({ ...entry, clips: entry.clips.map(recorded) })),
    renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { [instrument.id]: { instances: [], instrument: b6f5Synth0 } } },
      automationEnvelopes: [] }, sidechainRoutes: [] })
  if (!compiled.supported) throw new Error(`C0G compile: ${compiled.reasons.join(' ')}`)
  const snapshot = { ...compiled.snapshot, tracks: compiled.snapshot.tracks.map((entry) => ({ ...entry, clips: entry.clips.map(recorded) })) }
  stage = 'native'
  const native = compileLiveNativeProjection({ tracks: snapshot.tracks, bpm: 120, sampleRateHz: 48_000, revision: 1, epoch: 1,
    firstSequence: 1, fx: snapshot.mixer.fx })
  // The portable session compiles the MIDI track; its audio would need a decoded asset registry.
  stage = 'portable'
  const portable = compilePreparedPortableLiveSession({ ...snapshot, tracks: snapshot.tracks.filter((entry) => entry.id === instrument.id) },
    { assetRegistry: { projectGeneration: 1, assets: [] },
    sampleRateHz: 48_000, transportEpoch: 1, timeOrigin: { timelineSec: 0, frame: 0 }, rangeEndSec: 4, sourceFirstSequence: 1 })
  const compileRead = [...reads].filter((field) => field !== 'buffer').toSorted()
  console.log('C0G-CLIP-READS', JSON.stringify({ named, compileRead, native: native.supported, portable: portable.supported,
    stages: Object.fromEntries([...stages].map(([name, fields]) => [name, [...fields].toSorted()])) }))
  expect({ named, returned: returned?.join(), native: native.supported, portable: portable.supported,
    compileRead,
    unnamedReads: compileRead.filter((field) => !named?.includes(field)),
    namedUnread: named?.filter((field) => !reads.has(field)),
    excludedRead: ['name', 'color', 'waveformAssetKey'].filter((field) => reads.has(field)),
    excludedNamed: ['name', 'color', 'waveformAssetKey', 'buffer'].filter((field) => named?.includes(field)) })
    .toEqual({ named: ['id', 'historyRef', 'mediaStatus', 'startSec', 'duration', 'sourceAssetKey', 'sourceKind', 'sourceDurationSec',
      'sourceSampleRate', 'sourceChannelCount', 'leftPadSec', 'bufferOffsetSec', 'audioWarp', 'gain', 'fades', 'sampleUrl', 'midi',
      'midiOffsetBeats'], returned: named?.join(), native: true, portable: true,
      compileRead: ['audioWarp', 'bufferOffsetSec', 'duration', 'fades', 'gain', 'id', 'leftPadSec', 'midi', 'midiOffsetBeats', 'sampleUrl',
        'sourceAssetKey', 'sourceChannelCount', 'sourceDurationSec', 'sourceKind', 'sourceSampleRate', 'startSec'],
      // The hook reads these itself: mediaStatus gates hydration (hasPendingAudioClipHydration), historyRef names the clip.
      unnamedReads: [], namedUnread: ['historyRef', 'mediaStatus'], excludedRead: [], excludedNamed: [] })
})

// C0g, step 5c: a clip whose waveform key or key order changes while playing plays what it played, so the playing
// session neither adopts nor rebuilds (a persisted row and a projected create of one clip order its keys differently).
test('C0G a clip waveform key or key order change while playing is neither adopted nor rebuilt', async () => {
  const edits: [string, (clip: Track['clips'][number]) => Track['clips'][number]][] = [
    ['waveformAssetKey', (clip) => ({ ...clip, waveformAssetKey: 'waveform:other' })],
    ['keyOrder', ({ id, name, color, startSec, duration, midi, ...rest }) => ({ ...rest, midi, duration, startSec, color, name, id })],
  ]
  for (const nativeEnabled of [false, true]) for (const [field, patch] of edits) await runB6f5(async (live, world) => {
    live.setTracks((current) => current.map((entry) => entry.id === track.id ? { ...entry, kind: 'instrument', clips: [b6f5cClip] } : entry))
    await live.playFrom(1)
    const outcome = await b6f5cEditOutcome(live, world, () => live.setTracks((current) => current.map((entry) => entry.id === track.id
      ? { ...entry, clips: entry.clips.map(patch) } : entry)))
    expect({ nativeEnabled, field, ...outcome }).toEqual({ nativeEnabled, field, rebuilds: 0, adoptions: 0, open: true, playing: true })
  }, nativeEnabled)
})
