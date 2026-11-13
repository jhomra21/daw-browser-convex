import 'fake-indexeddb/auto'
import { expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createPreparedStretchArtifactRepository } from '@daw-browser/audio-engine/prepared-stretch-store'
import { extractTimelineBindings } from '~/lib/timeline-source-test-support'
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import type { AudioEffectRuntimeInstance, EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import type { AudioCoreGraphSnapshot } from '@daw-browser/audio-core-contract'
import { SYNTH_KIND_ID, nativeSynthStructureKey, type LiveProcessorEditIdentity } from '~/lib/live-processor-control'
import {
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultLimiterParams,
  createDefaultSamplerParams,
  createDefaultSpectralParams,
  createDefaultSynthParams,
  createDefaultUtilityParams,
  mergeSynthParams,
  type DrumRackPadSample,
  type SamplerZone,
  type SynthParamsUpdate,
  type TrackInstrumentParams,
  type UtilityParamsEnvelope,
} from '@daw-browser/shared'
import { resolveLiveMixerGraph } from '@daw-browser/audio-engine/live-mixer-runtime'
import { compilePortableSynthState } from '@daw-browser/audio-engine/mixer/graph-contract'
import type { PortableFrameSchedule } from '@daw-browser/audio-engine/portable-frame-scheduling'
import {
  portableWasmPagedMaxChannels,
  portableWasmPagedPageFrames,
  portableWasmPagedSlotCount,
  type PortableWasmControlMessage,
  type PortableWasmStatusMessage,
} from '@daw-browser/audio-engine/portable-wasm-protocol'
import { audioCoreContractVersion } from '@daw-browser/audio-core-contract'
import {
  audioCoreWasmAbiVersion,
  audioCoreWasmArtifactVersion,
  audioCoreWasmPagedAbiVersion,
} from '@daw-browser/audio-core-wasm'
import type { PortableWasmBackendSelection, PortableWasmPlaybackSession } from '@daw-browser/audio-engine/wasm-audio-worklet-backend'
import { portableWasmPagedPreparationCount } from '@daw-browser/audio-engine/wasm-audio-worklet-backend'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { LivePlaybackSnapshot, LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import { createPortableBrowserPlaybackController, type PortableAdoptionResult } from '~/lib/portable-browser-playback-controller'

test("3B1 r3 extraction ignores stale commented callbacks and rejects missing or ambiguous bindings", async () => {
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8")
  const { portable } = extractTimelineBindings(source)
  const live = 'applyPortableProcessor: async (_edit: LiveProcessorEditIdentity) => "dropped",'
  const canary = `/* ${portable}\n      onPreviewNote: stale */\n` + source.replace(portable, live)
  expect(extractTimelineBindings(canary).portable.trim()).toBe(live)
  expect(() => extractTimelineBindings(source.replace(portable, ""))).toThrow()
  expect(() => extractTimelineBindings(source + `\nconst duplicate = { ${portable} };`)).toThrow()
})

test.each(["synth", "master", "master-structural"])("3B1 r3 portable %s live gain stays live and Utility Swap is left to the schedule follow", async (schedule) => {
  const targetId = schedule === "synth" ? "synth" : "master"
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8")
  const { portable: handler } = extractTimelineBindings(source)
  const makeCallback = new Function("liveProcessorControl", "isPortableBrowserPlaybackPrepared", "isNativePlaybackPrepared", "syncPlaybackBackend", "SYNTH_KIND_ID",
    new Bun.Transpiler({ loader: "ts" }).transformSync(`return ({ ${handler} }).applyPortableProcessor;`))
  const calls: string[] = [], batches: unknown[] = []
  const graphs: Parameters<PortableWasmPlaybackSession["prepareGraph"]>[0][] = []
  const initial: UtilityParamsEnvelope = { version: 1, state: createDefaultUtilityParams() }
  const changed: UtilityParamsEnvelope = { version: 1, state: { ...initial.state, swap: true } }
  let projected = initial, rebuilds = 0
  const revision = 1
  const snapshot = () => {
    const base = compilation()
    const instances: AudioEffectRuntimeInstance[] = [{ id: "utility:r2", kind: "utility", params: projected }]
    const fx = { ...base.snapshot.mixer.fx, masterFxInstances: targetId === "master" ? instances : [],
      trackFx: { synth: { ...base.snapshot.mixer.fx.trackFx.synth, instances: targetId === "synth" ? instances : [] } } }
    return { ...base.snapshot, revision, mixer: { ...base.snapshot.mixer, fx,
      graph: resolveLiveMixerGraph([track], fx.trackFx, { masterFxInstances: fx.masterFxInstances }) } }
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => ({ supported: true, snapshot: snapshot() }),
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => ({
      ...createSession(calls, async () => {}),
      prepareGraph: async graph => { graphs.push(graph) },
      queueProcessorEvents: async (...args) => { batches.push(args) },
    }) },
  })
  try {
    expect(await controller.start(snapshot().transport)).toBe("started")
    const apply: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined> = makeCallback(
      () => controller.liveProcessorControl, () => true, () => false, async () => { rebuilds++ }, SYNTH_KIND_ID)
    const registry = createProcessorEditRegistry(() => 120)
    const allocate = (to: UtilityParamsEnvelope) => targetId === "master"
      ? registry.allocate({ targetId, instanceId: "utility:r2", effect: "master-utility", from: initial, to })
      : registry.allocate({ targetId, instanceId: "utility:r2", effect: "utility", from: initial, to })
    const liveBatches = schedule === "master-structural" ? 0 : 1
    if (liveBatches) {
      const gain = allocate({ version: 1, state: { ...initial.state, gainDb: 1 } })
      if (!gain) throw new Error("Missing live edit")
      expect(await apply(gain)).toBe("applied")
      expect(batches).toHaveLength(liveBatches)
    }
    const edit = allocate(changed)
    if (!edit) throw new Error("Missing structural edit")
    projected = changed
    // The edit is neither applied live nor rebuilt for: the schedule follow adopts it at a seam (WHT W-C9-proc-3).
    expect(await apply(edit)).toBeUndefined()
    expect({ rebuilds, graphs: graphs.length, liveBatches: batches.length }).toEqual({ rebuilds: 0, graphs: 1, liveBatches })
  } finally { controller.dispose() }
})

const track: RuntimeTrack = {
  id: 'synth',
  kind: 'instrument',
  name: 'Synth',
  volume: 0.8,
  clips: [{
    id: 'clip',
    name: 'MIDI',
    color: '#fff',
    startSec: 0,
    duration: 1,
    midiOffsetBeats: 0,
    midi: {
      wave: 'sine',
      notes: [{ id: 'note', beat: 0, length: 1, pitch: 60, velocity: 0.8 }],
      cc: [],
      mappings: [],
    },
  }],
}

// B30 failure inventory: live mapper fields must not prepare/publish another
// portable graph, and every input must reach the existing worklet session.
test("STEP5 B30 portable twenty live edits without rebuild", async () => {
  const calls: string[] = [];
  const batches: unknown[] = [];
  let compiles = 0;
  const base = compilation();
  const initial: UtilityParamsEnvelope = { version: 1, state: createDefaultUtilityParams() };
  const instances: AudioEffectRuntimeInstance[] = [{ id: "utility-b30", kind: "utility", params: initial }];
  const fx = { ...base.snapshot.mixer.fx, masterFxInstances: instances };
  const snapshot = { ...base.snapshot, mixer: { ...base.snapshot.mixer, fx,
    graph: resolveLiveMixerGraph([track], fx.trackFx, { masterFxInstances: instances }) } };
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => { compiles++; return { supported: true, snapshot }; },
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => ({
      ...createSession(calls, async () => {}),
      queueProcessorEvents: async (...args) => { batches.push(args); },
    }) },
  });
  try {
    expect(await controller.start(snapshot.transport)).toBe("started");
    const before = { compiles, calls: calls.length };
    const registry = createProcessorEditRegistry(() => 120);
    let previous = initial;
    for (let index = 1; index <= 20; index++) {
      const next: UtilityParamsEnvelope = { version: 1, state: { ...initial.state, gainDb: index / 10 } };
      const edit = registry.allocate({ targetId: "master", instanceId: "utility-b30", effect: "master-utility", from: previous, to: next });
      if (!edit) throw new Error("Missing portable edit");
      expect(await controller.liveProcessorControl.flush({ instanceId: "utility-b30",
        values: Object.entries(edit.content.values ?? {}).map(([parameterId, value]) => ({ parameterId, value })),
        edit })).toMatchObject({ accepted: true });
      previous = next;
    }
    console.log("STEP5 portable guard", JSON.stringify({ compiles: compiles - before.compiles,
      calls: calls.slice(before.calls), liveSends: batches.length }));
    expect(compiles - before.compiles).toBe(0);
    expect(calls.slice(before.calls)).toEqual([]);
    expect(batches).toHaveLength(20);
  } finally { controller.dispose(); }
});

const compilation = () => {
  const mixer = resolveLiveMixerGraph([track], {})
  return {
    supported: true as const,
    snapshot: {
      revision: 1,
      bpm: 120,
      transport: {
        state: 'playing' as const,
        playheadSec: 0,
        loopEnabled: false,
        loopStartSec: 0,
        loopEndSec: 0,
      },
      tracks: [track],
      assets: [],
      mixer: {
        graph: mixer,
        fx: {
          masterFxInstances: [],
          trackFx: {
            synth: {
              instances: [],
              instrument: {
                kind: 'synth' as const,
                instanceId: 'synth:1',
                params: createDefaultSynthParams(),
              },
            },
          },
        },
        automationEnvelopes: [],
        sidechainRoutes: [],
      },
    },
  }
}

const pagedAssetFrameCount = portableWasmPagedPageFrames * 96
const pagedAssetIds = ['asset-a', 'asset-b'] as const
const pagedTracks: RuntimeTrack[] = pagedAssetIds.map((assetId, index) => ({
  id: `audio-${index}`,
  kind: 'audio',
  name: `Audio ${index}`,
  volume: 1,
  clips: [{
    id: `clip-${index}`,
    name: `Clip ${index}`,
    color: '#fff',
    startSec: 0,
    duration: 30,
    sourceAssetKey: assetId,
  }],
}))

const pagedCompilation = (transport: LivePlaybackTransport = compilation().snapshot.transport) => {
  const mixer = resolveLiveMixerGraph(pagedTracks, {})
  return {
    supported: true as const,
    snapshot: {
      ...compilation().snapshot,
      transport,
      tracks: pagedTracks,
      assets: pagedAssetIds.map((assetId) => ({
        assetId,
        source: {
          durationSec: pagedAssetFrameCount / 48_000,
          sampleRate: 48_000,
          channelCount: 1,
        },
      })),
      mixer: {
        ...compilation().snapshot.mixer,
        graph: mixer,
        fx: {
          ...compilation().snapshot.mixer.fx,
          trackFx: {},
        },
      },
    },
  }
}

const manyPagedCompilation = (
  sourceCount: number,
  transport: LivePlaybackTransport = compilation().snapshot.transport,
) => {
  const assetId = 'asset-many'
  const tracks: RuntimeTrack[] = Array.from({ length: sourceCount }, (_, index) => ({
    id: `many-audio-${index}`,
    kind: 'audio',
    name: `Many audio ${index}`,
    volume: 1,
    clips: [{
      id: `many-clip-${index}`,
      name: `Many clip ${index}`,
      color: '#fff',
      startSec: 0,
      duration: 31,
      sourceAssetKey: assetId,
    }],
  }))
  const mixer = resolveLiveMixerGraph(tracks, {})
  const base = compilation()
  return {
    supported: true as const,
    snapshot: {
      ...base.snapshot,
      transport,
      tracks,
      assets: [{
        assetId,
        source: {
          durationSec: 128 * portableWasmPagedPageFrames / 48_000,
          sampleRate: 48_000,
          channelCount: 1,
        },
      }],
      mixer: {
        ...base.snapshot.mixer,
        graph: mixer,
        fx: {
          ...base.snapshot.mixer.fx,
          trackFx: {},
        },
      },
    },
  }
}

const pagedDescriptor = (
  assetId: string,
  readCalls: string[],
  frameCount = pagedAssetFrameCount,
) => ({
  identity: `descriptor:${assetId}`,
  durationSec: frameCount / 48_000,
  frameCount,
  sampleRate: 48_000,
  channelCount: 1,
  readPages: async function* (options: { startFrame?: number; endFrame?: number } = {}) {
    const startFrame = options.startFrame ?? 0
    const endFrame = options.endFrame ?? frameCount
    readCalls.push(`${assetId}:${startFrame}:${endFrame}`)
    for (let frame = startFrame; frame < endFrame; frame += portableWasmPagedPageFrames) {
      const frameCount = Math.min(portableWasmPagedPageFrames, endFrame - frame)
      yield {
        startFrame: frame,
        frameCount,
        sampleRate: 48_000,
        channelCount: 1,
        planes: [new Float32Array(frameCount)],
      }
    }
  },
})

const context: AudioContext = Object.assign(Object.create(null), { sampleRate: 48_000 })

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 1
  readonly length = 48_000
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  copyFromChannel(destination: Float32Array, channelNumber: number) { destination.fill(0); void channelNumber }
  copyToChannel() {}
  getChannelData() { return new Float32Array(this.length) }
}

const createRecordingFixture = (calls: string[]) => {
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live',
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    stop: (): void => { calls.push('track-stop') },
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const source: MediaStreamAudioSourceNode = Object.assign(Object.create(null), {
    disconnect: (): void => { calls.push('source-disconnect') },
  })
  const recordingContext: AudioContext = Object.assign(Object.create(context), {
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
  })
  return { stream, recordingContext }
}

const selected: PortableWasmBackendSelection = {
  selected: true,
  capability: {
    available: true,
    artifact: {
      bytes: new ArrayBuffer(0),
      module: new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
      manifest: {
        version: audioCoreWasmArtifactVersion,
        abiVersion: audioCoreWasmAbiVersion,
        pagedAbi: audioCoreWasmPagedAbiVersion,
        contractVersion: audioCoreContractVersion,
        contractHash: 'test',
        fixedMemory: true,
        memoryBytes: 1,
        sha256: 'test',
        wasmUrl: 'test',
      },
    },
    sharedQueue: 'available',
  },
}

const createSession = (
  calls: string[],
  install: (schedule: PortableFrameSchedule) => Promise<void>,
  setTransport: (running: boolean, frame: number) => Promise<void> = async () => undefined,
  paged = false,
) => {
  const record = (call: string) => calls.push(call)
  const faults = new Set<(error: Error) => void>()
  const allFaultListeners = new Set<(error: Error) => void>()
  let recordingStatus: ((message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => void) | undefined
  let transportPosition: ((message: Extract<PortableWasmStatusMessage, { type: "transport-position" }>) => void) | undefined
  let recordingGeneration = 0
  let recordingSessionId = 0
  const transports: Array<{ running: boolean; frame: number }> = []
  const writtenPages = new Set<string>()
  const preparations = new Set<number>()
  const registeredAssets: string[] = []
  let nextPreparationId = 1
  return {
    transports,
    writtenPages,
    preparations,
    registeredAssets,
    pagedCapabilities: paged ? {
      pagedAbi: audioCoreWasmPagedAbiVersion,
      pageFrames: portableWasmPagedPageFrames,
      slotCount: portableWasmPagedSlotCount,
      maxChannels: portableWasmPagedMaxChannels,
      preparationCount: portableWasmPagedPreparationCount,
    } : undefined,
    connectInput: () => {
      record('connect-input')
      return () => record('disconnect-input')
    },
    dispose: () => record('dispose'),
    markActive: () => record('mark-active'),
    onFault: (listener: (error: Error) => void) => {
      faults.add(listener)
      allFaultListeners.add(listener)
      return () => {
        return faults.delete(listener)
      }
    },
    onRecordingStatus: (listener: (message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => void) => {
      recordingStatus = listener
      return () => {
        if (recordingStatus !== listener) return false
        recordingStatus = undefined
        return true
      }
    },
    onTransportPosition: (listener: (message: Extract<PortableWasmStatusMessage, { type: "transport-position" }>) => void) => {
      transportPosition = listener
      return () => {
        if (transportPosition === listener) transportPosition = undefined
        return true
      }
    },
    postRecordingControl: (message: Extract<PortableWasmControlMessage, { type: `recording-${string}` }>) => {
      record(message.type)
      if (message.type === 'recording-capture-configure') {
        recordingGeneration = message.generation
        recordingSessionId = message.sessionId
      }
      const action = message.type === 'recording-capture-configure'
        ? 'configured'
        : message.type === 'recording-capture-finalize'
          ? 'finalized'
          : message.type === 'recording-capture-cancel'
            ? 'cancelled'
            : null
      if (action) queueMicrotask(() => recordingStatus?.({
        version: 2,
        type: 'recording-capture-applied',
        generation: recordingGeneration,
        sessionId: recordingSessionId,
        action,
        frame: 120,
      }))
    },
    prepareGraph: async () => { record('prepare-graph') },
    publishGraph: async () => { record('publish-graph') },
    registerAsset: async (asset: Parameters<PortableWasmPlaybackSession['registerAsset']>[0]) => {
      registeredAssets.push(asset.assetId)
      return { status: 'registered' as const, handle: { slot: 0, generation: 1 } }
    },
    installSchedule: async (schedule: PortableFrameSchedule) => {
      record(`install-schedule:${schedule.events.length}`)
      await install(schedule)
    },
    scheduleSources: async () => { record('schedule-sources') },
    registerPagedAsset: async () => ({ status: 'registered' as const, handle: { slot: 0, generation: 1 } }),
    writeAssetPage: async (assetId: string, _generation: number, pageIndex: number) => {
      writtenPages.add(`${assetId}:${pageIndex}`)
      return { status: 'written' as const }
    },
    prepareAssetRange: async (
      assetId: string,
      _generation: number,
      sourceOffsetFrame: number,
      sourceFrameCount: number,
    ) => {
      const firstPage = Math.floor(sourceOffsetFrame / portableWasmPagedPageFrames)
      const lastPage = Math.floor((sourceOffsetFrame + sourceFrameCount - 1) / portableWasmPagedPageFrames)
      const missingPage = Array.from(
        { length: lastPage - firstPage + 1 },
        (_, index) => firstPage + index,
      ).find((page) => !writtenPages.has(`${assetId}:${page}`))
      if (missingPage !== undefined) return { status: 'missing-page' as const, firstMissingPage: missingPage }
      const preparationId = nextPreparationId
      nextPreparationId += 1
      preparations.add(preparationId)
      return { status: 'prepared' as const, preparationId }
    },
    schedulePreparedSources: async () => { record('schedule-prepared-sources') },
    releaseAssetPreparation: async (preparationId: number) => {
      preparations.delete(preparationId)
      return 'released' as const
    },
    setTransport: async (_epoch: number, running: boolean, frame: number) => {
      record(running ? 'start-transport' : 'stop-transport')
      transports.push({ running, frame })
      await setTransport(running, frame)
    },
    fail: (error: Error) => {
      for (const listener of allFaultListeners) listener(error)
    },
    emitPosition: (frame: number, sequence = 1, running = true) => transportPosition?.({
      version: 2,
      type: "transport-position",
      sessionId: 1,
      epoch: 1,
      sequence,
      running,
      frame,
    }),
    recordingStatus: (message: Extract<PortableWasmStatusMessage, { type: `recording-${string}` }>) => recordingStatus?.(message),
  }
}

test('prepares a partially missing Drum Rack with its healthy pads in browser playback', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  const params = createDefaultDrumRackParams()
  const firstPad = params.pads[0]
  const secondPad = params.pads[1]
  if (!firstPad || !secondPad) throw new Error('Default Drum Rack pads are unavailable.')
  const source = { durationSec: 1, sampleRate: 48_000, channelCount: 1 }
  const missingSample: DrumRackPadSample = {
    assetKey: 'missing-drum-asset',
    url: 'local-asset:missing-drum-asset',
    sourceKind: 'upload',
    source,
  }
  const healthySample: DrumRackPadSample = {
    assetKey: 'healthy-drum-asset',
    url: 'local-asset:healthy-drum-asset',
    sourceKind: 'upload',
    source,
  }
  const paramsWithSamples = {
    ...params,
    pads: params.pads.map((pad) => pad.id === firstPad.id
      ? { ...pad, sample: missingSample }
      : pad.id === secondPad.id
        ? { ...pad, sample: healthySample }
        : pad),
  }
  const base = compilation()
  const instrument: TrackInstrumentParams = {
    kind: 'drum-rack',
    instanceId: 'drums:1',
    params: paramsWithSamples,
  }
  const snapshot = {
    ...base.snapshot,
    assets: [{
      assetId: 'healthy-drum-asset',
      source,
      buffer: new TestAudioBuffer(),
    }],
    mixer: {
      ...base.snapshot.mixer,
      fx: {
        ...base.snapshot.mixer.fx,
        trackFx: {
          synth: {
            instances: [],
            instrument,
            unavailableSampleAssetKeys: ['missing-drum-asset'],
          },
        },
      },
    },
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => ({ supported: true, snapshot }),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })

  await expect(controller.start(snapshot.transport)).resolves.toBe('started')
  expect(session.registeredAssets).toEqual(['healthy-drum-asset'])
  expect(calls).toContain('install-schedule:2')
  controller.dispose()
})

test('installs an acknowledged MIDI schedule before starting portable output once', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  const result = await controller.start(compilation().snapshot.transport)
  expect(result, faults.join('\n')).toBe('started')
  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  expect(calls).toEqual([
    'prepare-graph',
    'publish-graph',
    'stop-transport',
    'install-schedule:2',
    'schedule-sources',
    'start-transport',
    'mark-active',
  ])
  expect(controller.isActive()).toBe(true)
})

test('reports the portable playhead inside the active loop without changing raw transport frames', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  const loopTransport = {
    ...compilation().snapshot.transport,
    loopEnabled: true,
    loopStartSec: 1.5,
    loopEndSec: 3.5,
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })

  await expect(controller.start(loopTransport)).resolves.toBe("started")
  session.emitPosition(48_000, 1)
  expect(controller.currentPositionSec()).toBe(1)
  session.emitPosition(168_000, 2)
  expect(controller.currentPositionSec()).toBe(1.5)
  session.emitPosition(348_000, 3)
  expect(controller.currentPositionSec()).toBe(3.25)
  controller.dispose()
})

test('refreshes the portable schedule before its installed range ends', async () => {
  const calls: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  const firstRefresh = controller.refreshSchedule()
  expect(controller.refreshSchedule()).toBe(firstRefresh)
  await expect(firstRefresh).resolves.toBe("started")

  expect(sessionIndex).toBe(2)
  expect(calls.filter((call) => call === "mark-active")).toHaveLength(2)
  expect(calls.filter((call) => call === "dispose")).toHaveLength(1)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('refreshes from the latest old-session position without overlapping sessions', async () => {
  const calls: string[] = []
  const replacementInstalling = Promise.withResolvers<void>()
  const releaseReplacement = Promise.withResolvers<void>()
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => {
      replacementInstalling.resolve()
      await releaseReplacement.promise
    }),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  const refresh = controller.refreshSchedule()
  await replacementInstalling.promise
  sessions[0]?.emitPosition(90_000, 2)
  releaseReplacement.resolve()

  await expect(refresh).resolves.toBe("started")
  expect(sessions[2]?.transports).toEqual([
    { running: false, frame: 90_000 },
    { running: true, frame: 90_000 },
  ])
  expect(calls.lastIndexOf("dispose")).toBeLessThan(calls.lastIndexOf("start-transport"))
  expect(calls.lastIndexOf("dispose")).toBeLessThan(calls.lastIndexOf("mark-active"))
  expect(controller.currentPositionSec()).toBe(90_000 / context.sampleRate)
  sessions[0]?.fail(new Error("stale old-session fault"))
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('keeps the current portable session active when a rolling refresh fails', async () => {
  const calls: string[] = []
  let sessionIndex = 0
  let activeSession: ReturnType<typeof createSession> | undefined
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        sessionIndex += 1
        const session = createSession(calls, async () => {
          if (sessionIndex === 2) throw new Error("replacement rejected")
        })
        if (sessionIndex === 1) activeSession = session
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  expect(controller.isActive()).toBeTrue()
  activeSession?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")
  expect(sessionIndex).toBe(2)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('keeps the old session and retries once when the replacement range is stale', async () => {
  const calls: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined),
  ]
  let sessionIndex = 0
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls += 1
      const base = compilation()
      const snapshotTransport = compileCalls > 1
        ? { ...transport, playheadSec: 0 }
        : transport
      return { ...base, snapshot: { ...base.snapshot, transport: snapshotTransport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")

  expect(compileCalls).toBe(3)
  expect(sessionIndex).toBe(3)
  expect(controller.isActive()).toBeTrue()
  expect(calls.filter((call) => call === "dispose")).toHaveLength(2)
  controller.dispose()
})

test('stops truthfully when a prepared replacement cannot start after old disposal', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const sessions = [
    createSession(calls, async () => undefined),
    createSession(calls, async () => undefined, async (running) => {
      if (running) throw new Error("replacement start rejected")
    }),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    scheduleHorizonSec: 2,
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error("Unexpected extra portable session.")
        return session
      },
    },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  await expect(controller.start(compilation().snapshot.transport)).resolves.toBe("started")
  sessions[0]?.emitPosition(80_000)
  await expect(controller.refreshSchedule()).resolves.toBe("unavailable")

  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
  expect(faults).toContain("replacement start rejected")
  expect(calls.indexOf("dispose")).toBeLessThan(calls.lastIndexOf("start-transport"))
  controller.dispose()
})

test('prepares a fresh portable session while keeping transport paused', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })

  expect(await controller.ensurePrepared(compilation().snapshot.transport)).toBe('started')
  expect(calls).toEqual([
    'prepare-graph',
    'publish-graph',
    'stop-transport',
    'install-schedule:2',
    'schedule-sources',
  ])
  expect(controller.isActive()).toBe(false)
  expect(controller.isPrepared()).toBe(true)
  controller.dispose()
})

test('rebuilds a paused portable session from its authoritative transport position', async () => {
  const calls: string[] = []
  let sessionCount = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        sessionCount += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const transport = {
    ...compilation().snapshot.transport,
    state: 'paused' as const,
    playheadSec: 3,
  }

  expect(await controller.ensurePrepared(transport)).toBe('started')
  expect(await controller.rebuildPrepared(transport)).toBe('started')
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(sessionCount).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(2)
  controller.dispose()
})

test('rejects unsupported prepared sources before creating or activating a worklet session', async () => {
  const calls: string[] = []
  let createdSessions = 0
  const unsupportedSource: RuntimeTrack = {
    id: 'audio',
    kind: 'audio',
    name: 'Audio',
    volume: 1,
    clips: [{
      id: 'missing-source',
      name: 'Missing source',
      color: '#fff',
      startSec: 0,
      duration: 1,
      sourceAssetKey: 'missing',
    }],
  }
  const sourceCompilation = compilation()
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => ({
      ...sourceCompilation,
      snapshot: {
        ...sourceCompilation.snapshot,
        tracks: [unsupportedSource],
      },
    }),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })

  expect(await controller.start(sourceCompilation.snapshot.transport)).toBe('unavailable')
  expect(createdSessions).toBe(0)
  expect(calls).toEqual([])
  expect(controller.isActive()).toBeFalse()
})

test('shares one in-flight portable playback startup across concurrent callers', async () => {
  const calls: string[] = []
  const compile = Promise.withResolvers<ReturnType<typeof compilation>>()
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => compile.promise,
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })

  const first = controller.start(compilation().snapshot.transport)
  const second = controller.start(compilation().snapshot.transport)
  expect(second).toBe(first)
  compile.resolve(compilation())

  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'mark-active')).toHaveLength(1)
})

test('promotes a pending portable preview without recompiling at the requested transport', async () => {
  const calls: string[] = []
  const compile = Promise.withResolvers<ReturnType<typeof compilation>>()
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => {
      compileCalls += 1
      return compile.promise
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const playTransport = {
    ...compilation().snapshot.transport,
    playheadSec: 0,
  }

  const preview = controller.ensurePrepared(previewTransport)
  const started = controller.start(playTransport)
  expect(started).not.toBe(preview)
  compile.resolve(compilation())

  await expect(preview).resolves.toBe('started')
  await expect(started).resolves.toBe('started')
  expect(compileCalls).toBe(1)
  expect(createdSessions).toBe(1)
  // The resume locates first (a stop at the new epoch), then runs.
  expect(session.transports).toEqual([
    { running: false, frame: 0 },
    { running: false, frame: 0 },
    { running: true, frame: 0 },
  ])
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('resumes a portable preview in place at a playhead outside its schedule', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const requestedTransport = { ...compilation().snapshot.transport, playheadSec: 31 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(requestedTransport)).resolves.toBe('started')

  expect(compileCalls).toEqual([previewTransport])
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(0)
  expect(calls.filter((call) => call === 'mark-active')).toHaveLength(1)
  controller.dispose()
})

test('resumes a portable preview in place near the end of its schedule', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const, playheadSec: 0 }
  const originalStartTransport = { ...compilation().snapshot.transport, playheadSec: 0 }
  const nearEndTransport = { ...compilation().snapshot.transport, playheadSec: 29 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(originalStartTransport)).resolves.toBe('started')
  await controller.pause(0)
  await expect(controller.start(nearEndTransport)).resolves.toBe('started')

  expect(compileCalls).toEqual([previewTransport])
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(0)
  controller.dispose()
})

test('resumes a portable preview in place when loop semantics change', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return {
        ...base,
        snapshot: { ...base.snapshot, transport },
      }
    },
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => createSession(calls, async () => undefined) },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const loopTransport = {
    ...compilation().snapshot.transport,
    loopEnabled: true,
    loopStartSec: 1,
    loopEndSec: 4,
  }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  await expect(controller.start(loopTransport)).resolves.toBe('started')

  expect(compileCalls).toEqual([previewTransport])
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(0)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('shares one resume for concurrent starts of a paused portable session', async () => {
  const calls: string[] = []
  let compileCalls = 0
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: (transport) => {
      compileCalls += 1
      const base = compilation()
      return Promise.resolve({
        ...base,
        snapshot: { ...base.snapshot, transport },
      })
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const firstTransport = { ...compilation().snapshot.transport, playheadSec: 31 }
  const secondTransport = { ...compilation().snapshot.transport, playheadSec: 32 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  const first = controller.start(firstTransport)
  const second = controller.start(secondTransport)
  expect(second).toBe(first)

  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(1)
  expect(createdSessions).toBe(1)
  controller.dispose()
})

test('disposal during a portable resume prevents activation', async () => {
  const calls: string[] = []
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })
  const previewTransport = { ...compilation().snapshot.transport, state: 'paused' as const }
  const requestedTransport = { ...compilation().snapshot.transport, playheadSec: 31 }

  await expect(controller.ensurePrepared(previewTransport)).resolves.toBe('started')
  const started = controller.start(requestedTransport)
  controller.dispose()

  await expect(started).resolves.toBe('unavailable')
  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls).not.toContain('mark-active')
  expect(controller.isActive()).toBeFalse()
})

test('shares concurrent portable starts during preview promotion', async () => {
  const calls: string[] = []
  const promotion = Promise.withResolvers<void>()
  const session = createSession(calls, async () => undefined, async (running) => {
    if (running) await promotion.promise
  })
  let compileCalls = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => {
      compileCalls += 1
      return compilation()
    },
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
  })
  const transport = { ...compilation().snapshot.transport, playheadSec: 0 }

  await expect(controller.ensurePrepared({ ...transport, state: 'paused' as const })).resolves.toBe('started')
  const first = controller.start(transport)
  const second = controller.start({ ...transport, playheadSec: 1.5 })
  expect(second).toBe(first)

  promotion.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(1)
  expect(session.transports).toHaveLength(3)
  controller.dispose()
})

test('does not promote an unavailable portable preview', async () => {
  const calls: string[] = []
  const selection = Promise.withResolvers<PortableWasmBackendSelection>()
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: () => selection.promise,
  })
  const transport = compilation().snapshot.transport

  const preview = controller.ensurePrepared({ ...transport, state: 'paused' as const })
  const started = controller.start(transport)
  selection.resolve({ selected: false, reason: 'not available' })

  await expect(preview).resolves.toBe('unavailable')
  await expect(started).resolves.toBe('unavailable')
  expect(calls).toEqual([])
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeFalse()
})

test('cancellation during portable preview prevents late promotion', async () => {
  for (const invalidation of ['dispose', 'project-generation'] as const) {
    const calls: string[] = []
    const installing = Promise.withResolvers<void>()
    const releaseInstall = Promise.withResolvers<void>()
    const session = createSession(calls, async () => {
      installing.resolve()
      await releaseInstall.promise
    })
    let projectGeneration = 1
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async () => compilation(),
      getAudioContext: () => context,
      getProjectGeneration: () => projectGeneration,
      backend: { createPlaybackSession: async () => session },
      select: async () => selected,
    })
    const transport = {
      ...compilation().snapshot.transport,
      playheadSec: 0.5,
    }

    const preview = controller.ensurePrepared({ ...transport, state: 'paused' as const })
    await installing.promise
    const started = controller.start(transport)
    if (invalidation === 'dispose') controller.dispose()
    else projectGeneration += 1
    releaseInstall.resolve()

    await expect(preview).resolves.toBe('unavailable')
    await expect(started).resolves.toBe('unavailable')
    expect(calls).not.toContain('start-transport')
    expect(calls).not.toContain('mark-active')
    expect(controller.isActive()).toBeFalse()
  }
})

test('pause and resume retain the prepared portable graph and session', async () => {
  const calls: string[] = []
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })

  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  await controller.pause(0)
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  expect(await controller.start({ ...compilation().snapshot.transport, playheadSec: 0 })).toBe('started')

  expect(createdSessions).toBe(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(1)
  expect(calls.filter((call) => call === 'publish-graph')).toHaveLength(1)
  expect(calls.filter((call) => call === 'start-transport')).toHaveLength(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(0)
})

test('project generation changes dispose the retained portable session before rebuilding', async () => {
  const calls: string[] = []
  let projectGeneration = 1
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    getProjectGeneration: () => projectGeneration,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return createSession(calls, async () => undefined)
      },
    },
    select: async () => selected,
  })

  await controller.start(compilation().snapshot.transport)
  await controller.pause(0.25)
  projectGeneration += 1
  await controller.start({ ...compilation().snapshot.transport, playheadSec: 0.25 })

  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'prepare-graph')).toHaveLength(2)
})

test('dispose invalidates pending portable playback startup before late activation', async () => {
  const calls: string[] = []
  const installing = Promise.withResolvers<void>()
  const releaseInstall = Promise.withResolvers<void>()
  const session = createSession(calls, async () => {
    installing.resolve()
    await releaseInstall.promise
  })
  const faults: string[] = []
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  const starting = controller.start(compilation().snapshot.transport)
  await installing.promise
  controller.dispose()
  releaseInstall.resolve()

  await expect(starting).resolves.toBe('unavailable')
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls).not.toContain('mark-active')
  expect(controller.isActive()).toBeFalse()
  expect(faults).toEqual([])
})

test('rolls back rejected or timed out schedule installation before activation', async () => {
  for (const message of ['schedule rejected', 'Portable playback control request timed out.']) {
    const calls: string[] = []
    const session = createSession(calls, async () => { throw new Error(message) })
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async () => compilation(),
      getAudioContext: () => context,
      backend: { createPlaybackSession: async () => session },
      select: async () => selected,
    })

    expect(await controller.start(compilation().snapshot.transport)).toBe('unavailable')
    expect(calls).toEqual([
      'prepare-graph',
      'publish-graph',
      'stop-transport',
      'install-schedule:2',
      'dispose',
    ])
    expect(controller.isActive()).toBe(false)
  }
})

test('stops portable playback when its active worklet faults', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => context,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
  })

  await controller.start(compilation().snapshot.transport)
  session.fail(new Error('AudioWorklet processor fault.'))

  expect(controller.isActive()).toBe(false)
  expect(faults).toEqual(['AudioWorklet processor fault.'])
})

test('fits metadata-only ordinary startup pages and refreshes from the bounded horizon', async () => {
  const calls: string[] = []
  const readCalls: string[] = []
  const sessions = [
    createSession(calls, async () => undefined, undefined, true),
    createSession(calls, async () => undefined, undefined, true),
  ]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => pagedCompilation(transport),
    getAudioContext: () => context,
    scheduleHorizonSec: 30,
    resolveSource: async (clip) => pagedDescriptor(clip.sourceAssetKey ?? 'missing', readCalls),
    backend: {
      createPlaybackSession: async () => {
        const session = sessions[sessionIndex]
        sessionIndex += 1
        if (!session) throw new Error('Unexpected extra portable session.')
        return session
      },
    },
    select: async () => selected,
  })

  await expect(controller.start(pagedCompilation().snapshot.transport)).resolves.toBe('started')
  const initialSession = sessions[0]
  if (!initialSession) throw new Error('Initial session is missing.')
  expect(initialSession.writtenPages.size).toBe(portableWasmPagedSlotCount)
  expect(initialSession.preparations.size).toBeLessThanOrEqual(64)
  expect(readCalls).toHaveLength(initialSession.writtenPages.size)
  expect(pagedCompilation().snapshot.assets.every((asset) => !('buffer' in asset))).toBeTrue()

  initialSession.emitPosition(20 * context.sampleRate)
  await expect(controller.refreshSchedule()).resolves.toBe('started')
  expect(sessionIndex).toBe(2)
  expect(sessions[1]?.writtenPages.size).toBeGreaterThan(0)
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('reports unavailable before graph publication when the minimum paged window cannot fit', async () => {
  const calls: string[] = []
  const readCalls: string[] = []
  const overfullTrack: RuntimeTrack = {
    id: 'overfull-audio',
    kind: 'audio',
    name: 'Overfull audio',
    volume: 1,
    clips: Array.from({ length: 129 }, (_, index) => ({
      id: `overfull-clip-${index}`,
      name: `Overfull clip ${index}`,
      color: '#fff',
      startSec: 0,
      duration: portableWasmPagedPageFrames / context.sampleRate,
      sourceAssetKey: 'asset-overfull',
      bufferOffsetSec: index * portableWasmPagedPageFrames / context.sampleRate,
    })),
  }
  const base = pagedCompilation()
  const overfull = {
    ...base,
    snapshot: {
      ...base.snapshot,
      tracks: [overfullTrack],
      assets: [{
        assetId: 'asset-overfull',
        source: {
          durationSec: portableWasmPagedPageFrames * 160 / context.sampleRate,
          sampleRate: context.sampleRate,
          channelCount: 1,
        },
      }],
      mixer: {
        ...base.snapshot.mixer,
        graph: resolveLiveMixerGraph([overfullTrack], {}),
      },
    },
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => overfull,
    getAudioContext: () => context,
    scheduleHorizonSec: 30,
    resolveSource: async () => pagedDescriptor(
      'asset-overfull',
      readCalls,
      portableWasmPagedPageFrames * 160,
    ),
    backend: {
      createPlaybackSession: async () => createSession(calls, async () => undefined, undefined, true),
    },
    select: async () => selected,
    reportFault: (message) => calls.push(`fault:${message}`),
  })

  await expect(controller.start(overfull.snapshot.transport)).resolves.toBe('unavailable')
  expect(calls).toContain('fault:Portable paged playback requires 130 resident pages, but only 128 are available.')
  expect(calls).not.toContain('prepare-graph')
  expect(readCalls).toHaveLength(0)
  controller.dispose()
})

test('preflights recording refresh preparation capacity at the exact boundary', async () => {
  for (const sourceCount of [33, 32]) {
    const calls: string[] = []
    const faults: string[] = []
    const session = createSession(calls, async () => undefined, undefined, true)
    const { stream, recordingContext } = createRecordingFixture(calls)
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async (transport) => manyPagedCompilation(sourceCount, transport),
      getAudioContext: () => recordingContext,
      scheduleHorizonSec: 30,
      resolveSource: async () => pagedDescriptor(
        'asset-many',
        [],
        128 * portableWasmPagedPageFrames,
      ),
      backend: { createPlaybackSession: async () => session },
      select: async () => selected,
      reportFault: (message) => faults.push(message),
      createRecordingWriter: () => ({
        ready: Promise.resolve(),
        write: () => undefined,
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => undefined,
        terminate: () => undefined,
      }),
    })

    const started = await controller.start(manyPagedCompilation(sourceCount).snapshot.transport)
    expect(started, faults.join('\n')).toBe('started')
    const startTransportCount = session.transports.filter((transport) => transport.running).length
    if (sourceCount === 33) {
      await expect(controller.startRecording({
        appSessionId: `over-capacity-${sourceCount}`,
        stream,
        layout: 'mono',
        inputChannel: 0,
        gain: 1,
        polarity: 1,
        monitoring: false,
        punchStartFrame: 0,
      })).rejects.toThrow('Portable recording is unavailable')
      expect(controller.isRecording()).toBeFalse()
      expect(controller.isActive()).toBeTrue()
      expect(session.transports.filter((transport) => transport.running)).toHaveLength(startTransportCount)
      expect(session.transports.filter((transport) => !transport.running)).toHaveLength(1)
      expect(faults).toEqual([])
    } else {
      const recordingStart = controller.startRecording({
        appSessionId: `at-capacity-${sourceCount}`,
        stream,
        layout: 'mono',
        inputChannel: 0,
        gain: 1,
        polarity: 1,
        monitoring: false,
        punchStartFrame: 0,
      })
      await expect(recordingStart).resolves.toMatchObject({ sampleRate: 48_000, channelCount: 1 })
      expect(controller.isRecording()).toBeTrue()
      session.emitPosition(26 * context.sampleRate)
      await expect(controller.refreshSchedule()).resolves.toBe('started')
      expect(controller.isActive()).toBeTrue()
      expect(controller.isRecording()).toBeTrue()
      expect(session.transports.filter((transport) => !transport.running)).toHaveLength(1)
      await controller.cancelRecording()
      expect(controller.isRecording()).toBeFalse()
    }
    controller.dispose()
  }
})

test('starts and finalizes portable recording through acknowledged bounded adapters', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const failures: string[] = []
  const session = createSession(calls, async () => undefined)
  let endedListener: (() => void) | undefined
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live',
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: (_type: string, listener: () => void) => {
      endedListener = listener
    },
    removeEventListener: (_type: string, listener: () => void) => {
      if (endedListener === listener) endedListener = undefined
    },
    stop: (): void => { calls.push('track-stop') },
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const source: MediaStreamAudioSourceNode = Object.assign(Object.create(null), {
    disconnect: (): void => { calls.push('source-disconnect') },
  })
  const recordingContext: AudioContext = Object.assign(Object.create(context), {
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
  })
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => recordingContext,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
    createRecordingWriter: () => ({
        ready: Promise.resolve(),
        write: () => undefined,
        finalize: async () => {
          calls.push('writer-finalize')
          return { capturedFrames: 0 }
        },
        abort: async () => {
          calls.push('writer-abort')
        },
        terminate: () => calls.push('writer-terminate'),
      }),
  })

  expect(await controller.start(compilation().snapshot.transport)).toBe('started')
  expect(await controller.startRecording({
    appSessionId: 'take-1',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: true,
    punchStartFrame: 120,
  })).toEqual({ sampleRate: 48_000, channelCount: 1, startFrame: 120 })
  expect(controller.isRecording()).toBeTrue()
  expect(calls).toContain('connect-input')
  expect(calls).toContain('recording-capture-configure')

  expect(await controller.stopRecording()).toEqual({ capturedFrames: 0 })
  expect(controller.isRecording()).toBeFalse()
  expect(calls).toContain('recording-capture-finalize')
  expect(calls).toContain('writer-finalize')
  expect(calls).toContain('disconnect-input')
  expect(calls).toContain('source-disconnect')

  await controller.startRecording({
    appSessionId: 'take-2',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 240,
    onFailure: (error) => failures.push(error.message),
  })
  endedListener?.()
  await Promise.resolve()
  expect(controller.isRecording()).toBeFalse()
  expect(calls).toContain('recording-capture-cancel')
  expect(calls).toContain('writer-abort')
  expect(faults).toEqual([])
  expect(failures).toEqual(['Portable recording device ended.'])
})

test('preserves caller-owned recording streams when portable writer startup fails', async () => {
  const calls: string[] = []
  const faults: string[] = []
  const session = createSession(calls, async () => undefined)
  const mediaTrack: MediaStreamTrack = Object.assign(Object.create(null), {
    readyState: 'live',
    getSettings: () => ({ channelCount: 1 }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    stop: () => calls.push('track-stop'),
  })
  const stream: MediaStream = Object.assign(Object.create(null), {
    getTracks: () => [mediaTrack],
    getAudioTracks: () => [mediaTrack],
  })
  const source: MediaStreamAudioSourceNode = Object.assign(Object.create(null), {
    disconnect: () => calls.push('source-disconnect'),
  })
  const recordingContext: AudioContext = Object.assign(Object.create(context), {
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
  })
  let writerTerminations = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(),
    getAudioContext: () => recordingContext,
    backend: { createPlaybackSession: async () => session },
    select: async () => selected,
    reportFault: (message) => faults.push(message),
    createRecordingWriter: () => ({
      ready: Promise.reject(new Error('writer startup failed')),
      write: () => undefined,
      finalize: async () => ({ capturedFrames: 0 }),
      abort: () => new Promise<void>(() => undefined),
      terminate: () => {
        writerTerminations += 1
      },
    }),
  })

  await controller.start(compilation().snapshot.transport)
  await expect(controller.startRecording({
    appSessionId: 'fallback-take',
    stream,
    layout: 'mono',
    inputChannel: 0,
    gain: 1,
    polarity: 1,
    monitoring: false,
    punchStartFrame: 0,
  })).rejects.toThrow('writer startup failed')

  expect(controller.isActive()).toBeTrue()
  expect(faults).toEqual([])
  expect(calls).not.toContain('track-stop')
  expect(calls).toContain('source-disconnect')
  expect(writerTerminations).toBe(1)
  expect(controller.isRecording()).toBeFalse()
})

// P1: a prepared portable session takes a Synth edit live only when the edit differs from the instrument the
// session compiled in live parameters alone. What it takes becomes its prepared snapshot, so the release announce
// (the real Timeline handlers) rebuilds only for what it did not take.
const p1Initial: TrackInstrumentParams = { kind: 'synth', instanceId: 'synth:1', params: createDefaultSynthParams() }
const p1Synth = (from: TrackInstrumentParams, update: SynthParamsUpdate): TrackInstrumentParams =>
  from.kind === 'synth' ? { ...from, params: mergeSynthParams(from.params, update) } : from
const p1Fixture = async (options: { failBatches?: boolean; failPrepare?: number; failCompile?: number; initial?: TrackInstrumentParams; assetKeys?: readonly string[]; holdAdoptionCompile?: Promise<void>; holdPrepare?: Promise<void> } = {}) => {
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8")
  const { portable, structural } = extractTimelineBindings(source)
  const transpile = (code: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(code)
  const makePortable = new Function("liveProcessorControl", "isPortableBrowserPlaybackPrepared", "isNativePlaybackPrepared", "syncPlaybackBackend", "renderTracks", "SYNTH_KIND_ID",
    transpile(`return ({ ${portable} }).applyPortableProcessor;`))
  const makeStructural = new Function("deps", transpile(`
    const { mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
      isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
      syncPlaybackBackend, renderTracks, captureStructuralPlaybackIntent, notify } = deps;
    let instrumentPlaybackChangeTail = Promise.resolve();
    return ({ ${structural} }).onStructuralPlaybackChange;`))
  let projected: TrackInstrumentParams = options.initial ?? p1Initial, revision = 1, rebuilds = 0
  const calls: string[] = [], batches: Array<readonly unknown[]> = [], notes: string[] = [], faults: string[] = []
  const graphs: Parameters<PortableWasmPlaybackSession["prepareGraph"]>[0][] = []
  const snapshot = () => {
    const base = compilation()
    const trackFx = { synth: { ...base.snapshot.mixer.fx.trackFx.synth, instrument: projected } }
    const fx = { ...base.snapshot.mixer.fx, trackFx }
    const assets = (options.assetKeys ?? []).map(assetId => ({ assetId, source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 }, buffer: new TestAudioBuffer() }))
    return { ...base.snapshot, revision, assets, mixer: { ...base.snapshot.mixer, fx,
      graph: resolveLiveMixerGraph([track], fx.trackFx, { masterFxInstances: [] }) } }
  }
  let refused = 0, settled = 0, compileFailures = 0, playing = false
  let registered: readonly string[] = []
  let emitPosition = (_frame: number, _sequence: number) => {}
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (_transport, compileContext) => {
      if (playing && compileFailures < (options.failCompile ?? 0)) { compileFailures++; throw new Error('P1 compile threw') }
      // The project is read when the compile starts, as a real compile does; the hold is the time it takes.
      const compiled = snapshot()
      if (compileContext?.liveAdoption) await options.holdAdoptionCompile
      return { supported: true, snapshot: compiled }
    },
    fingerprintSnapshot: next => JSON.stringify({ ...next, revision: 0, mixer: { ...next.mixer, graph: undefined } }),
    getAudioContext: () => context, select: async () => selected,
    onAdoptionResubmitted: () => { settled++ },
    reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => {
      const session = createSession(calls, async () => {})
      emitPosition = (frame, sequence) => session.emitPosition(frame, sequence)
      registered = session.registeredAssets
      return {
        ...session,
        prepareGraph: async graph => {
          if (graphs.length > 0 && refused < (options.failPrepare ?? 0)) { refused++; throw new Error('P1 prepare refused') }
          if (graphs.length > 0) await options.holdPrepare
          graphs.push(graph)
        },
        queueInstrumentEvents: async (_epoch: number, events: readonly unknown[]) => {
          if (options.failBatches) throw new Error('P1 portable bridge down')
          batches.push(events)
        },
      }
    } },
  })
  // One transport-position report per call, as the worklet sends them; the retry waits on these.
  let reports = 0
  const report = async (count = 1) => {
    for (let index = 0; index < count; index++) { emitPosition(1_000 + ++reports, reports); await Bun.sleep(0) }
  }
  expect(await controller.start(snapshot().transport)).toBe('started')
  playing = true
  const rebuild = async () => {
    rebuilds++
    revision++
    expect(await controller.rebuildPrepared(snapshot().transport)).toBe('started')
  }
  const apply: (edit: LiveProcessorEditIdentity) => Promise<EngineDisposition | undefined> = makePortable(
    () => controller.liveProcessorControl, () => controller.isPrepared(), () => false, rebuild, () => [track], SYNTH_KIND_ID)
  const announce: (targetId: string, instrument: TrackInstrumentParams | undefined) => Promise<void> = makeStructural({
    mountedProjectGeneration: () => 0, awaitPlaybackPreparation: async () => {},
    preparedInstrument: (targetId: string) => controller.preparedInstrument(targetId),
    isStructuralRebuildInProgress: () => false, isPreparingPlayback: () => controller.isPreparing(),
    isPlaying: () => true, isNativePlaybackPrepared: () => false,
    isPortableBrowserPlaybackPrepared: () => controller.isPrepared(),
    syncPlaybackBackend: rebuild, renderTracks: () => [track],
    captureStructuralPlaybackIntent: () => ({}), notify: (title: string, message: string) => { notes.push(`${title}: ${message}`) },
  })
  const registry = createProcessorEditRegistry(() => 120)
  // The persisted adapter projects each written value before its edit reaches playback.
  const allocate = (instrument: TrackInstrumentParams) => {
    const allocated = registry.allocate({ targetId: 'synth', effect: 'instrument', from: instrument, to: instrument })
    if (!allocated) throw new Error('Missing Synth edit')
    return allocated
  }
  const edit = (instrument: TrackInstrumentParams) => {
    projected = instrument
    return allocate(instrument)
  }
  const flush = (allocated: LiveProcessorEditIdentity) => controller.liveProcessorControl.flush({
    instanceId: allocated.target.instanceId,
    values: Object.entries(allocated.content.values ?? {}).map(([parameterId, value]) => ({ parameterId, value })),
    edit: allocated,
  })
  const sessionStructure = () => {
    const instrument = graphs.at(-1)?.nodes.find(node => node.id === 'synth')?.instrument
    return instrument?.kind === 'synth' ? nativeSynthStructureKey(instrument) : undefined
  }
  const structureOf = (instrument: TrackInstrumentParams) =>
    instrument.kind === 'synth' ? nativeSynthStructureKey(compilePortableSynthState(instrument.params)) : undefined
  return { controller, apply, announce, edit, allocate, flush, setProjected: (instrument: TrackInstrumentParams) => { projected = instrument }, batches, graphs, notes, faults, rebuilds: () => rebuilds, sessionStructure, structureOf,
    report, refused: () => refused, settled: () => settled, registered: () => registered }
}

test('P1 a live Synth edit is accepted and the prepared portable snapshot follows it', async () => {
  const f = await p1Fixture()
  try {
    const next = p1Synth(p1Initial, { filter: { frequencyHz: 1500 } })
    expect(await f.flush(f.edit(next))).toMatchObject({ accepted: true })
    expect({ batches: f.batches.length, prepared: f.controller.preparedInstrument('synth') }).toEqual({ batches: 1, prepared: next })
  } finally { f.controller.dispose() }
})

test.each<[string, SynthParamsUpdate]>([
  ['oscillator level', { oscillators: [{ level: 0.3 }] }],
  ['polyphony', { polyphony: 4 }],
  ['retrigger', { retrigger: !createDefaultSynthParams().retrigger }],
  ['oscillator waveform', { oscillators: [{ wave: 'square' }] }],
])('P1 a non-live Synth %s edit is adopted as a published configuration, never rebuilt', async (_name, update) => {
  const f = await p1Fixture()
  try {
    const next = p1Synth(p1Initial, update)
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 2, notes: [] })
    expect(f.sessionStructure()).toBe(f.structureOf(next))
  } finally { f.controller.dispose() }
})

test('P1 a live Synth drag is heard once per frame and its release does not rebuild', async () => {
  const f = await p1Fixture()
  try {
    let current: TrackInstrumentParams = p1Initial
    const results: Array<EngineDisposition | undefined> = [], frameBatches: number[] = []
    for (let frame = 0; frame < 20; frame++) {
      current = p1Synth(current, { filter: { frequencyHz: 1000 + frame * 50 } })
      const before = f.batches.length
      results.push(await f.apply(f.edit(current)))
      frameBatches.push(f.batches.length - before)
    }
    expect({ results, frameBatches, rebuilds: f.rebuilds() })
      .toEqual({ results: Array(20).fill('applied'), frameBatches: Array(20).fill(1), rebuilds: 0 })
    expect(await f.apply(f.edit(current))).toBe('applied')
    await f.announce('synth', current)
    expect({ batches: f.batches.length, rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes })
      .toEqual({ batches: 21, rebuilds: 0, graphs: 1, notes: [] })
    expect(f.controller.preparedInstrument('synth')).toEqual(current)
  } finally { f.controller.dispose() }
})

test('P1 live then non-live Synth edits in one gesture keep the last live state and release adopts once', async () => {
  const f = await p1Fixture()
  try {
    const live = p1Synth(p1Synth(p1Initial, { filter: { frequencyHz: 1500 } }), { filter: { frequencyHz: 1600 } })
    const structural = p1Synth(live, { oscillators: [{ level: 0.3 }] })
    const after = p1Synth(structural, { filter: { frequencyHz: 1700 } })
    const results: Array<EngineDisposition | undefined> = []
    for (const instrument of [p1Synth(p1Initial, { filter: { frequencyHz: 1500 } }), live, structural, after]) results.push(await f.apply(f.edit(instrument)))
    expect({ results, batches: f.batches.length, rebuilds: f.rebuilds(), prepared: f.controller.preparedInstrument('synth') })
      .toEqual({ results: ['applied', 'applied', 'applied', 'applied'], batches: 4, rebuilds: 0, prepared: live })
    expect(await f.apply(f.edit(after))).toBe('applied')
    await f.announce('synth', after)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 2, notes: [] })
    expect(f.sessionStructure()).toBe(f.structureOf(after))
    expect(f.controller.preparedInstrument('synth')).toEqual(after)
  } finally { f.controller.dispose() }
})

test.each<[string, TrackInstrumentParams, TrackInstrumentParams]>([
  ['Sampler', { kind: 'sampler', instanceId: 'sampler:1', params: createDefaultSamplerParams() },
    { kind: 'sampler', instanceId: 'sampler:1', params: { ...createDefaultSamplerParams(), polyphony: 4 } }],
  ['Drum Rack', { kind: 'drum-rack', instanceId: 'drums:1', params: createDefaultDrumRackParams() },
    { kind: 'drum-rack', instanceId: 'drums:1', params: { ...createDefaultDrumRackParams(), pads: createDefaultDrumRackParams().pads.map((pad, index) => index === 0 ? { ...pad, gain: 0.5 } : pad) } }],
  ['Granular', { kind: 'granular', instanceId: 'granular:1', params: createDefaultGranularParams() },
    { kind: 'granular', instanceId: 'granular:1', params: { ...createDefaultGranularParams(), grainSizeMs: 90 } }],
])('P1 a %s edit while playing is adopted as a published configuration, never rebuilt', async (_name, initial, next) => {
  const f = await p1Fixture({ initial })
  try {
    await f.announce('synth', next)
    f.setProjected(next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 2, notes: [] })
    expect(f.controller.preparedInstrument('synth')).toEqual(next)
  } finally { f.controller.dispose() }
})

test('P1 a Sampler zone edit and a sample swap with real buffers are adopted on the same session, never rebuilt', async () => {
  const sampler = (zone: Partial<SamplerZone>, assetKey = 'asset-a'): TrackInstrumentParams => ({
    kind: 'sampler', instanceId: 'sampler:1',
    params: { ...createDefaultSamplerParams(), zones: [{
      id: 'zone', keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 60, tuneCents: 0, gain: 1, pan: 0,
      // A one-shot zone with a start offset is supported (9a532e9f).
      roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: 'one-shot', startSec: 0, crossfadeSec: 0, chokeGroup: 0,
      sample: { assetKey, url: `local-asset:${assetKey}`, sourceKind: 'upload', source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 } },
      ...zone,
    }] },
  })
  const initial = sampler({})
  const f = await p1Fixture({ initial, assetKeys: ['asset-a', 'asset-b'] })
  try {
    const steps = [sampler({ startSec: 0.25 }), sampler({ startSec: 0.25, tuneCents: 200 }), sampler({ startSec: 0.25, tuneCents: 200 }, 'asset-b')]
    const results: PortableAdoptionResult[] = []
    for (const next of steps) {
      await f.announce('synth', next)
      f.setProjected(next)
      results.push(await f.controller.adoptSchedule(noLoop))
    }
    expect({ results, rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes, registered: f.registered() })
      .toEqual({ results: ['adopted', 'adopted', 'adopted'], rebuilds: 0, graphs: 4, notes: [], registered: ['asset-a', 'asset-b'] })
    expect(f.controller.preparedInstrument('synth')).toEqual(steps[2])
  } finally { f.controller.dispose() }
})

test('P1 a failed adoption of an instrument edit keeps the playing graph, never rebuilds, and the next adoption stages it', async () => {
  const f = await p1Fixture({ failPrepare: 1 })
  try {
    const next = p1Synth(p1Initial, { polyphony: 4 })
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 1, notes: [] })
    expect(f.controller.isActive()).toBeTrue()
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length }).toEqual({ rebuilds: 0, graphs: 2 })
    expect(f.sessionStructure()).toBe(f.structureOf(next))
  } finally { f.controller.dispose() }
})

test('M4 an instrument compile that throws keeps the playing graph, never rebuilds, and the next adoption stages it', async () => {
  const f = await p1Fixture({ failCompile: 1 })
  try {
    const next = p1Synth(p1Initial, { polyphony: 4 })
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 1, notes: [] })
    expect(f.controller.isActive()).toBeTrue()
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length }).toEqual({ rebuilds: 0, graphs: 2 })
  } finally { f.controller.dispose() }
})

test('UD 8 a transient staging failure is retried at the next block boundary and applies', async () => {
  const f = await p1Fixture({ failPrepare: 1 })
  try {
    const next = p1Synth(p1Initial, { polyphony: 4 })
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    expect(f.graphs.length).toBe(1)
    await f.report()
    await Bun.sleep(0)
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, settled: f.settled(), notes: f.notes }).toEqual({ rebuilds: 0, graphs: 2, settled: 1, notes: [] })
    expect(f.sessionStructure()).toBe(f.structureOf(next))
  } finally { f.controller.dispose() }
})

test('UD 8 a persistent staging failure stops after 8 resubmits with a defect log, keeps the old graph, and the next publication applies it', async () => {
  const f = await p1Fixture({ failPrepare: 9 })
  const logged: string[] = []
  const warn = spyOn(console, 'warn').mockImplementation((message: string) => { logged.push(`warn ${message}`) })
  const error = spyOn(console, 'error').mockImplementation((message: string) => { logged.push(`error ${message}`) })
  try {
    const next = p1Synth(p1Initial, { polyphony: 4 })
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    // Waits grow as min(2^r, 16(r+1)) reports: 1, 2, 4, ... 128 over eight resubmits.
    await f.report(300)
    await Bun.sleep(0)
    expect({ refused: f.refused(), graphs: f.graphs.length, rebuilds: f.rebuilds(), notes: f.notes, active: f.controller.isActive() })
      .toEqual({ refused: 9, graphs: 1, rebuilds: 0, notes: [], active: true })
    expect(logged.filter(line => line.startsWith('warn')).length).toBe(8)
    expect(logged.filter(line => line.startsWith('error')).length).toBe(1)
    // The exhausted retry is also the user's notice: the edit is not playing.
    expect(f.faults).toHaveLength(1)
    await f.report(300)
    expect(f.refused()).toBe(9)
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ graphs: f.graphs.length, rebuilds: f.rebuilds() }).toEqual({ graphs: 2, rebuilds: 0 })
    expect(f.sessionStructure()).toBe(f.structureOf(next))
  } finally { warn.mockRestore(); error.mockRestore(); f.controller.dispose() }
})

// A Synth's non-live fields travel in the published configuration, so any edit of the same instrument is live-eligible.
// An edit that replaces the instrument itself (another kind or another instance) is not an edit of it and sends nothing.
test.each<[string, TrackInstrumentParams]>([
  ['another kind', { kind: 'sampler', instanceId: 'synth:1', params: createDefaultSamplerParams() }],
  ['another instance', { ...p1Initial, instanceId: 'synth:2' }],
])('P1 an edit that replaces the Synth with %s is refused and sends no live events', async (_name, replacement) => {
  const f = await p1Fixture()
  try {
    const allocated = f.allocate(p1Initial)
    const result = await f.controller.liveProcessorControl.flush({
      instanceId: allocated.target.instanceId,
      values: [{ parameterId: 'synth.outputGain', value: 0.5 }],
      edit: { ...allocated, content: { ...allocated.content, params: replacement } },
    })
    expect({ result, batches: f.batches.length, prepared: f.controller.preparedInstrument('synth') })
      .toEqual({ result: { accepted: false, reason: 'unsupported' }, batches: 0, prepared: p1Initial })
  } finally { f.controller.dispose() }
})

test('P1 a Synth portable bridge error is still reported and never rebuilds', async () => {
  const f = await p1Fixture({ failBatches: true })
  try {
    await expect(f.apply(f.edit(p1Synth(p1Initial, { filter: { frequencyHz: 1500 } })))).rejects.toThrow('P1 portable bridge down')
    await expect(f.apply(f.edit(p1Synth(p1Initial, { oscillators: [{ level: 0.3 }] })))).rejects.toThrow('P1 portable bridge down')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, prepared: f.controller.preparedInstrument('synth') })
      .toEqual({ rebuilds: 0, graphs: 1, prepared: p1Initial })
  } finally { f.controller.dispose() }
})

test('B6f ensurePrepared moves a live paused session to a newer playhead instead of answering at the old one', async () => {
  const calls: string[] = []
  const compileCalls: LivePlaybackTransport[] = []
  const session = createSession(calls, async () => undefined)
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      compileCalls.push(transport)
      const base = compilation()
      return { ...base, snapshot: { ...base.snapshot, transport } }
    },
    getAudioContext: () => context,
    backend: {
      createPlaybackSession: async () => {
        createdSessions += 1
        return session
      },
    },
    select: async () => selected,
  })
  const paused = { ...compilation().snapshot.transport, state: 'paused' as const }

  expect(await controller.ensurePrepared(paused)).toBe('started')
  expect(await controller.ensurePrepared({ ...paused, playheadSec: 1 })).toBe('started')
  // The paused session now stands at the newer playhead, and nothing ever ran.
  expect(session.transports.at(-1)).toEqual({ running: false, frame: 48_000 })
  expect(session.transports.filter((transport) => transport.running)).toEqual([])
  const sent = session.transports.length
  const compiled = compileCalls.length
  // At the playhead it already stands on, it answers without a message, a compile or a session.
  expect(await controller.ensurePrepared({ ...paused, playheadSec: 1 })).toBe('started')
  expect(session.transports).toHaveLength(sent)
  expect(compileCalls).toHaveLength(compiled)
  expect(createdSessions).toBe(compiled)
  expect(controller.isActive()).toBeFalse()
  expect(controller.isPrepared()).toBeTrue()
  controller.dispose()
})

// B6f5: a playing portable session adopts mixer and automation edits on the same core, as native does.
const noLoop: Pick<LivePlaybackTransport, 'loopEnabled' | 'loopStartSec' | 'loopEndSec'> = { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
const b6f5Fingerprint = (snapshot: { revision: number; transport: LivePlaybackTransport }) =>
  JSON.stringify({ ...snapshot, revision: undefined, transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } })
// The Timeline's fingerprint leaves the resolved mixer graph out: it is compiled from the tracks and effects it also holds.
const b6f5ContentFingerprint = (snapshot: LivePlaybackSnapshot) => JSON.stringify({ ...snapshot, revision: undefined,
  transport: { ...snapshot.transport, playheadSec: undefined, state: undefined }, mixer: { ...snapshot.mixer, graph: undefined } })
const b6f5Compilation = (transport: LivePlaybackTransport, volume: number, clipDuration = 1, masterUtility?: UtilityParamsEnvelope) => {
  const base = compilation()
  const edited: RuntimeTrack = { ...track, volume, clips: track.clips.map((clip) => ({ ...clip, duration: clipDuration })) }
  const masterFxInstances: AudioEffectRuntimeInstance[] = masterUtility ? [{ id: 'utility-b6f5', kind: 'utility', params: masterUtility }] : []
  const fx = { ...base.snapshot.mixer.fx, masterFxInstances }
  return { ...base, snapshot: { ...base.snapshot, transport, tracks: [edited], mixer: { ...base.snapshot.mixer, fx,
    graph: resolveLiveMixerGraph([edited], fx.trackFx, { masterFxInstances }) } } }
}
type PublishOptions = Parameters<PortableWasmPlaybackSession['publishGraph']>[1]
type B6f5Publish = { revision: number; options: PublishOptions }
const b6f5Session = (calls: string[], graphs: AudioCoreGraphSnapshot[], publishes: B6f5Publish[],
  publish: (options?: PublishOptions) => Promise<void> = async () => undefined) => ({
  ...createSession(calls, async () => undefined),
  prepareGraph: async (graph: AudioCoreGraphSnapshot) => { calls.push('prepare-graph'); graphs.push(graph) },
  publishGraph: async (revision: number, options?: PublishOptions) => {
    calls.push('publish-graph')
    publishes.push({ revision, options })
    await publish(options)
  },
})
const b6f5Gain = (graph: AudioCoreGraphSnapshot | undefined) => graph?.nodes.find((node) => node.id === 'synth')?.mixer?.gain

test('B6f5 a playing portable session adopts a mixer edit on the same session and follows it', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  let volume = 0.8
  let sessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => { sessions += 1; return b6f5Session(calls, graphs, publishes) } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    const before = calls.length
    volume = 0.5
    const adopted = await controller.adoptSchedule(noLoop)
    // The accepted revision is what the session plays now: the same desired state again is unchanged, not a second publish.
    const again = await controller.adoptSchedule(noLoop)
    expect({ adopted, again, sessions, calls: calls.slice(before), publishes: publishes.slice(1), gain: b6f5Gain(graphs.at(-1)), revision: graphs.at(-1)?.revision })
      .toEqual({ adopted: 'adopted', again: 'unchanged', sessions: 1, calls: ['prepare-graph', 'install-schedule:1', 'publish-graph'],
        publishes: [{ revision: 2, options: { requireContinuity: true, publicationFrame: 12_000, sources: { epoch: 1, ordinary: [], prepared: [] } } }], gain: 0.5, revision: 2 })
  } finally { controller.dispose() }
})

test('B6f5 a refused adoption answers failed and keeps the session revision; a MIDI clip edit is adopted at a seam', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  let volume = 0.8
  let clipDuration = 1
  let refuse = true
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume, clipDuration),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => b6f5Session(calls, graphs, publishes, async (options) => {
      if (refuse && options) throw new Error('Portable playback graph-published was rejected.')
    }) },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    volume = 0.5
    const refused = await controller.adoptSchedule(noLoop)
    refuse = false
    const retried = await controller.adoptSchedule(noLoop)
    const before = calls.length
    clipDuration = 2
    const structural = await controller.adoptSchedule(noLoop)
    expect({ refused, retried, structural, revisions: publishes.slice(1).map((entry) => entry.revision), afterStructural: calls.slice(before),
      active: controller.isActive() })
      .toEqual({ refused: 'failed', retried: 'adopted', structural: 'adopted', revisions: [2, 2, 3],
        afterStructural: ['prepare-graph', 'install-schedule:2', 'publish-graph'], active: true })
  } finally { controller.dispose() }
})

// R2: the worklet faults a live send whose revision is not the one it plays (WK processor-events). A send that crosses
// an adoption publish waits for it, accepted or refused.
test('B6f5 R2 a live send crossing an adoption publish never faults the session', async () => {
  for (const accept of [true, false]) {
    const calls: string[] = []
    const graphs: AudioCoreGraphSnapshot[] = []
    const publishes: B6f5Publish[] = []
    const faults: string[] = []
    const sent: number[] = []
    const gate = Promise.withResolvers<void>()
    let volume = 0.8
    let playingRevision = 0
    const base = b6f5Session(calls, graphs, publishes)
    const session = {
      ...base,
      publishGraph: async (revision: number, options?: PublishOptions) => {
        publishes.push({ revision, options })
        if (!options) { playingRevision = revision; return }
        // The worklet handles the publish in port order; its answer arrives later.
        if (accept) playingRevision = revision
        await gate.promise
        if (!accept) throw new Error('Portable playback graph-published was rejected.')
      },
      queueProcessorEvents: async (revision: number) => {
        sent.push(revision)
        if (revision !== playingRevision) {
          base.fail(new Error('Portable audio-core AudioWorklet control request failed.'))
          throw new Error('fault')
        }
      },
    }
    const utility: UtilityParamsEnvelope = { version: 1, state: createDefaultUtilityParams() }
    const controller = createPortableBrowserPlaybackController({
      compileSnapshot: async (transport) => b6f5Compilation(transport, volume, 1, utility),
      fingerprintSnapshot: b6f5Fingerprint,
      getAudioContext: () => context, select: async () => selected, reportFault: (message) => faults.push(message),
      backend: { createPlaybackSession: async () => session },
    })
    try {
      expect(await controller.start(compilation().snapshot.transport)).toBe('started')
      volume = 0.5
      const adoption = controller.adoptSchedule(noLoop)
      for (let turn = 0; turn < 50 && publishes.length < 2; turn += 1) await Promise.resolve()
      const live = controller.liveProcessorControl.flush({ instanceId: 'utility-b6f5', values: [{ parameterId: 'utility.gainDb', value: 1 }] })
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve()
      const sentDuringPublish = sent.length
      gate.resolve()
      expect({ accept, adoption: await adoption, live: await live, sentDuringPublish, sent, faults, active: controller.isActive() })
        .toEqual({ accept, adoption: accept ? 'adopted' : 'failed', live: expect.objectContaining({ accepted: true }), sentDuringPublish: 0,
          sent: [accept ? 2 : 1], faults: [], active: true })
    } finally { controller.dispose() }
  }
})

// Review m1: the published configuration is compiled from the project, which a knob drag reaches only on release. A live
// synth value the session accepted while the adoption compiled or prepared must be in that configuration, or the core
// slews every live target back to the stale one when it publishes (/tmp/m1-proof, case B: about six times louder).
const m1Gain = (graphs: readonly AudioCoreGraphSnapshot[]) => {
  const instrument = graphs.at(-1)?.nodes.find(node => node.id === 'synth')?.instrument
  return instrument?.kind === 'synth' ? { gain: instrument.outputGain, level: instrument.oscillators?.[0]?.level } : undefined
}

test('B6f5 m1 a live synth value accepted during an adoption compile is in the configuration the adoption publishes', async () => {
  const hold = Promise.withResolvers<void>()
  const f = await p1Fixture({ holdAdoptionCompile: hold.promise })
  try {
    f.setProjected(p1Synth(p1Initial, { oscillators: [{ level: 0.3 }] }))
    const adoption = f.controller.adoptSchedule(noLoop)
    for (let turn = 0; turn < 50; turn++) await Promise.resolve()
    const live = await f.flush(f.allocate(p1Synth(p1Initial, { gain: 0.125 })))
    hold.resolve()
    expect({ live: live.accepted, adoption: await adoption, published: m1Gain(f.graphs), prepared: f.controller.preparedInstrument('synth') })
      .toEqual({ live: true, adoption: 'adopted', published: { gain: 0.125, level: 0.3 },
        prepared: p1Synth(p1Synth(p1Initial, { oscillators: [{ level: 0.3 }] }), { gain: 0.125 }) })
  } finally { f.controller.dispose() }
})

test('B6f5 m1 a live synth send while the adoption prepares waits for the publish and reaches the revision that carries it', async () => {
  const hold = Promise.withResolvers<void>()
  const f = await p1Fixture({ holdPrepare: hold.promise })
  try {
    f.setProjected(p1Synth(p1Initial, { oscillators: [{ level: 0.3 }] }))
    const adoption = f.controller.adoptSchedule(noLoop)
    for (let turn = 0; turn < 50; turn++) await Promise.resolve()
    const live = f.flush(f.allocate(p1Synth(p1Initial, { gain: 0.125 })))
    for (let turn = 0; turn < 50; turn++) await Promise.resolve()
    const sentWhilePreparing = f.batches.length
    hold.resolve()
    expect({ sentWhilePreparing, adoption: await adoption, live: (await live).accepted, batches: f.batches.length })
      .toEqual({ sentWhilePreparing: 0, adoption: 'adopted', live: true, batches: 1 })
  } finally { f.controller.dispose() }
})

test('B6f5 adoptions coalesce to one in flight and one queued that carries the newest edit', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const hold = Promise.withResolvers<void>()
  let volume = 0.8
  let adoptionCompiles = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport, compileContext) => {
      const value = volume
      if (compileContext?.liveAdoption && ++adoptionCompiles === 1) await hold.promise
      return b6f5Compilation(transport, value)
    },
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => b6f5Session(calls, graphs, publishes) },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    volume = 0.1
    const first = controller.adoptSchedule(noLoop)
    for (let turn = 0; turn < 20 && adoptionCompiles === 0; turn += 1) await Promise.resolve()
    const queued = [0.2, 0.3, 0.4, 0.5].map((next) => { volume = next; return controller.adoptSchedule(noLoop) })
    hold.resolve()
    const outcomes = await Promise.all([first, ...queued])
    expect({ outcomes, adoptionCompiles, gains: graphs.slice(1).map(b6f5Gain), publishes: publishes.length - 1 })
      .toEqual({ outcomes: ['adopted', 'adopted', 'adopted', 'adopted', 'adopted'], adoptionCompiles: 2, gains: [0.1, 0.5], publishes: 2 })
  } finally { controller.dispose() }
})

// R6: the session owns its revision once it adopts one; a schedule refresh compiled at the Timeline's revision still
// continues the adopted graph.
test('B6f5 R6 a schedule refresh after an adoption continues the adopted revision', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  let volume = 0.8
  const sessions = [b6f5Session(calls, graphs, publishes), b6f5Session(calls, graphs, publishes)]
  let sessionIndex = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => {
      const session = sessions[sessionIndex]
      sessionIndex += 1
      if (!session) throw new Error('Unexpected extra portable session.')
      return session
    } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    volume = 0.5
    expect(await controller.adoptSchedule(noLoop)).toBe('adopted')
    sessions[0]?.emitPosition(80_000)
    expect({ refresh: await controller.refreshSchedule(), faults, sessions: sessionIndex, refreshedRevision: graphs.at(-1)?.revision, gain: b6f5Gain(graphs.at(-1)) })
      .toEqual({ refresh: 'started', faults: [], sessions: 2, refreshedRevision: 2, gain: 0.5 })
  } finally { controller.dispose() }
})

// B6f5 step 5b, R6: a compile the session cannot continue (a structural edit since its start) is never installed on it.
// The refresh skips it without a fault, as it did before adoption; the follow adopts it at a seam.
// The structural edit is a Spectral fftSize change, which the core carries as a ghost of the old stage plus a fresh one.
const b6f5Spectral = (fftSize: 512 | 1024): AudioEffectRuntimeInstance => ({ id: 'spectral-b6f5-structure', kind: 'spectral', params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize } } })
const b6f5AddedEffect = b6f5Spectral(1024)
const b6f5StructuralCompilation = (transport: LivePlaybackTransport, added: AudioEffectRuntimeInstance | undefined) => {
  const base = compilation()
  const trackFx = Object.fromEntries(Object.entries(base.snapshot.mixer.fx.trackFx ?? {})
    .map(([id, entry]) => [id, id === track.id ? { ...entry, instances: [...entry.instances, added ?? b6f5Spectral(512)] } : entry]))
  const fx = { ...base.snapshot.mixer.fx, trackFx }
  return { ...base, snapshot: { ...base.snapshot, transport, mixer: { ...base.snapshot.mixer, fx, graph: resolveLiveMixerGraph(base.snapshot.tracks, fx.trackFx) } } }
}
// WK installSchedule answers `rejected` for an event whose target the prepared graph lacks (`!targets.has(key)`).
const b6f5StrictSession = (calls: string[], graphs: AudioCoreGraphSnapshot[], publishes: B6f5Publish[]) => {
  const base = b6f5Session(calls, graphs, publishes)
  let nodes = new Set<string>()
  return { ...base,
    prepareGraph: async (graph: AudioCoreGraphSnapshot) => { await base.prepareGraph(graph); nodes = new Set(graph.nodes.map((node) => node.id)) },
    installSchedule: async (schedule: PortableFrameSchedule) => {
      await base.installSchedule(schedule)
      if (schedule.events.some((event) => event.target.kind === 'instrument' && !nodes.has(event.target.trackId)))
        throw new Error('Portable playback schedule-installed was rejected.')
    } }
}
type B6f5RecordingInput = Parameters<ReturnType<typeof createPortableBrowserPlaybackController>['startRecording']>[0]
const b6f5RecordingInput = (stream: MediaStream): B6f5RecordingInput => ({ appSessionId: 'take-b6f5', stream, layout: 'mono', inputChannel: 0,
  gain: 1, polarity: 1, monitoring: false, punchStartFrame: 0 })

test('B6f5 step5b R6 a recording refresh after a structural edit skips without a fault and the follow adopts it during the take', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const sessions: ReturnType<typeof b6f5StrictSession>[] = []
  let added: AudioEffectRuntimeInstance | undefined
  const { stream, recordingContext } = createRecordingFixture(calls)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5StructuralCompilation(transport, added),
    fingerprintSnapshot: b6f5ContentFingerprint,
    getAudioContext: () => recordingContext, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { const session = b6f5StrictSession(calls, graphs, publishes); sessions.push(session); return session } },
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: () => undefined, finalize: async () => ({ capturedFrames: 0 }),
      abort: async () => undefined, terminate: () => undefined }),
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    await controller.startRecording(b6f5RecordingInput(stream))
    added = b6f5AddedEffect
    sessions[0]?.emitPosition(80_000)
    const refresh = await controller.refreshSchedule()
    const follow = await controller.adoptSchedule(noLoop)
    expect({ refresh, follow, faults, recording: controller.isRecording(), playing: controller.isActive(), sessions: sessions.length,
      ended: calls.filter((call) => call === 'dispose' || call === 'recording-capture-cancel') })
      .toEqual({ refresh: 'unavailable', follow: 'adopted', faults: [], recording: true, playing: true, sessions: 1, ended: [] })
    expect(graphs.at(-1)?.nodes.some((node) => node.id === track.id && node.processorOrder.length > 0)).toBe(true)
    expect(await controller.stopRecording()).toEqual({ capturedFrames: 0 })
  } finally { controller.dispose() }
})

test('B6f5 step5b R6 a normal refresh after a structural edit skips without a fault and the follow adopts it', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const sessions: ReturnType<typeof b6f5Session>[] = []
  let added: AudioEffectRuntimeInstance | undefined
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5StructuralCompilation(transport, added),
    fingerprintSnapshot: b6f5ContentFingerprint,
    getAudioContext: () => context, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { const session = b6f5Session(calls, graphs, publishes); sessions.push(session); return session } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    added = b6f5AddedEffect
    sessions[0]?.emitPosition(80_000)
    const refresh = await controller.refreshSchedule()
    const follow = await controller.adoptSchedule(noLoop)
    expect({ refresh, follow, faults, playing: controller.isActive(), sessions: sessions.length })
      .toEqual({ refresh: 'unavailable', follow: 'adopted', faults: [], playing: true, sessions: 1 })
    expect(graphs.at(-1)?.nodes.some((node) => node.id === track.id && node.processorOrder.length > 0)).toBe(true)
  } finally { controller.dispose() }
})

// D6: an adoption publishes on the session that captures the take, at the same epoch, so the take never notices it.
test('B6f5 D6 an adoption during portable recording keeps the take and its capture blocks continuous', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const written: number[] = []
  const gate = Promise.withResolvers<void>()
  let volume = 0.8
  let sessions = 0
  const base = b6f5Session(calls, graphs, publishes, async (options) => { if (options) await gate.promise })
  let configure: Extract<PortableWasmControlMessage, { type: 'recording-capture-configure' }> | undefined
  const session = { ...base, postRecordingControl: (message: Extract<PortableWasmControlMessage, { type: `recording-${string}` }>) => {
    if (message.type === 'recording-capture-configure') configure = message
    base.postRecordingControl(message)
  } }
  const block = (sequence: number) => base.recordingStatus({ version: 2, type: 'recording-capture-block', generation: configure?.generation ?? -1,
    sessionId: configure?.sessionId ?? -1, sequence, frameCount: 128, channelCount: 1, planes: [new Float32Array(128)], rms: 0, peak: 0 })
  const { stream, recordingContext } = createRecordingFixture(calls)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => recordingContext, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { sessions += 1; return session } },
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: (message) => { written.push(message.sequence) },
      finalize: async () => ({ capturedFrames: written.length * 128 }), abort: async () => undefined, terminate: () => undefined }),
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    await controller.startRecording(b6f5RecordingInput(stream))
    block(1)
    block(2)
    volume = 0.5
    const adoption = controller.adoptSchedule(noLoop)
    for (let turn = 0; turn < 50 && publishes.length < 2; turn += 1) await Promise.resolve()
    // A block the worklet captures while the publish is in flight, then one after it answered.
    block(3)
    gate.resolve()
    const adopted = await adoption
    block(4)
    expect({ adopted, written, faults, recording: controller.isRecording(), sessions, gain: b6f5Gain(graphs.at(-1)),
      ended: calls.filter((call) => call === 'dispose' || call === 'recording-capture-cancel' || call === 'recording-capture-finalize') })
      .toEqual({ adopted: 'adopted', written: [1, 2, 3, 4], faults: [], recording: true, sessions: 1, gain: 0.5, ended: [] })
    expect(await controller.stopRecording()).toEqual({ capturedFrames: 4 * 128 })
  } finally { controller.dispose() }
})

// Without a content fingerprint nothing is adopted, so the session keeps the Timeline's revision: its bump for a
// structural rebuild still makes the recording refresh skip, as before adoption.
test('B6f5 step5b R6 without a content fingerprint a Timeline revision bump still skips the recording refresh', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const sessions: ReturnType<typeof b6f5StrictSession>[] = []
  let added: AudioEffectRuntimeInstance | undefined
  const { stream, recordingContext } = createRecordingFixture(calls)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const compiled = b6f5StructuralCompilation(transport, added)
      return { ...compiled, snapshot: { ...compiled.snapshot, revision: added ? 2 : 1 } }
    },
    getAudioContext: () => recordingContext, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { const session = b6f5StrictSession(calls, graphs, publishes); sessions.push(session); return session } },
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: () => undefined, finalize: async () => ({ capturedFrames: 0 }),
      abort: async () => undefined, terminate: () => undefined }),
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    await controller.startRecording(b6f5RecordingInput(stream))
    added = b6f5AddedEffect
    sessions[0]?.emitPosition(80_000)
    expect({ refresh: await controller.refreshSchedule(), faults, recording: controller.isRecording(), playing: controller.isActive(), sessions: sessions.length })
      .toEqual({ refresh: 'unavailable', faults: [], recording: true, playing: true, sessions: 1 })
  } finally { controller.dispose() }
})

// AE-08 phase 8 step 1: failure-first witnesses. Each asserts the behaviour required once the phase lands and is
// `test.failing` until its implementing step flips it to `test`. The note and sequence ids are the design note's.
type W8Note = NonNullable<RuntimeTrack['clips'][number]['midi']>['notes'][number]
type W8Loop = typeof noLoop
const w8Note = (id: string, beat: number, length = 1): W8Note => ({ id, beat, length, pitch: 60, velocity: 0.8 })
const w8Fixture = async (initial: { bpm?: number; notes?: readonly W8Note[]; loop?: W8Loop; audioStartSec?: number; clipSec?: number } = {}, options: { refuse?: () => boolean; failInstall?: () => boolean; failTransport?: (epoch: number, running: boolean) => boolean; audioContext?: AudioContext } = {}) => {
  const state = { bpm: initial.bpm ?? 120, notes: initial.notes ?? [w8Note('note', 0)], audioStartSec: initial.audioStartSec, warped: false, projectGeneration: 0 }
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const installs: PortableFrameSchedule[] = []
  const epochs: number[] = []
  const faults: string[] = []
  const scheduledSources: { sequence: number; startFrame: number }[][] = []
  let sessions = 0
  let positionListener: ((message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) | undefined
  const compile = (transport: LivePlaybackTransport) => {
    const base = compilation()
    const midi: RuntimeTrack = { ...track, clips: track.clips.map((clip) => ({ ...clip, duration: initial.clipSec ?? clip.duration, midi: clip.midi && { ...clip.midi, notes: [...state.notes] } })) }
    const audio: RuntimeTrack[] = state.audioStartSec === undefined ? [] : [{ id: 'audio-w8', kind: 'audio', name: 'Audio', volume: 1, clips: [{
      id: 'clip-audio-w8', name: 'Audio', color: '#fff', startSec: state.audioStartSec, duration: 1, sourceAssetKey: 'asset-w8', buffer: new TestAudioBuffer(),
      ...(state.warped && { audioWarp: c9Stretch }) }] }]
    const tracks = [midi, ...audio]
    const assets = audio.length ? [{ assetId: 'asset-w8', buffer: new TestAudioBuffer() }] : []
    return { ...base, snapshot: { ...base.snapshot, bpm: state.bpm, transport, tracks, assets,
      mixer: { ...base.snapshot.mixer, graph: resolveLiveMixerGraph(tracks, base.snapshot.mixer.fx.trackFx) } } }
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => compile(transport),
    fingerprintSnapshot: b6f5Fingerprint, getProjectGeneration: () => state.projectGeneration,
    getAudioContext: () => options.audioContext ?? context, select: async () => selected,
    createPreparedStretchRepository: c9StretchRepository,
    reportFault: (message) => faults.push(message),
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: () => undefined, finalize: async () => ({ capturedFrames: 0 }),
      abort: async () => undefined, terminate: () => undefined }),
    backend: { createPlaybackSession: async () => {
      sessions += 1
      const base = b6f5Session(calls, graphs, publishes, async (publishOptions) => {
        if (publishOptions && options.refuse?.()) throw new Error('Portable playback graph-published was rejected.')
      })
      const withInstall = { ...base, ...createSession(calls, async (schedule) => {
        if (options.failInstall?.()) throw new Error('Portable playback install-schedule was rejected.')
        installs.push(schedule)
      }) }
      return { ...withInstall, prepareGraph: base.prepareGraph, publishGraph: base.publishGraph,
        scheduleSources: async (_revision: number, _epoch: number, events: readonly { sequence: number; startFrame: number }[]) => {
          calls.push('schedule-sources')
          scheduledSources.push(events.map((event) => ({ sequence: event.sequence, startFrame: event.startFrame })))
        },
        setTransport: async (epoch: number, running: boolean, frame: number) => {
          epochs.push(epoch)
          if (options.failTransport?.(epoch, running)) throw new Error('Portable playback transport was rejected.')
          await withInstall.setTransport(epoch, running, frame)
        },
        onTransportPosition: (listener: (message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) => {
          positionListener = listener
          return withInstall.onTransportPosition(listener)
        } }
    } },
  })
  const transport: LivePlaybackTransport = { ...compilation().snapshot.transport, ...(initial.loop ?? noLoop) }
  const adopt = controller.adoptSchedule
  const noteEvents = (schedule: PortableFrameSchedule | undefined, type: 'note-on' | 'note-off') =>
    (schedule?.events ?? []).flatMap((event) => event.type === type ? [{ noteId: event.noteId, frame: event.frame }] : [])
  const position = (frame: number, epoch = 1, sequence = 1) => positionListener?.({ version: 2, type: 'transport-position', sessionId: 1, epoch, sequence, running: true, frame })
  return { state, controller, transport, noLoop, calls, graphs, publishes, installs, epochs, faults, scheduledSources, sessions: () => sessions, adopt, noteEvents, position }
}
const w8ShippedStarts = (f: { publishes: readonly B6f5Publish[] }) =>
  (f.publishes.at(-1)?.options?.sources?.ordinary ?? []).map((source) => source.startFrame)

// W-F20a: a loop-bound edit while playing is adopted. Today the compile receives the old loop, both snapshots match,
// and the follow marks the edit applied without installing anything.
test('W-F20a a loop edit while playing installs and publishes a schedule for the new loop', async () => {
  const f = await w8Fixture({ loop: { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    const result = await f.adopt({ loopEnabled: true, loopStartSec: 0, loopEndSec: 2 })
    const installed = f.installs.slice(1)
    expect({ result, sessions: f.sessions(), calls: f.calls.slice(before).filter((call) => call !== 'mark-active').map((call) => call.split(':')[0]),
      publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame'),
      oldPeriodNoteOn: f.noteEvents(installed.at(-1), 'note-on').some((event) => event.frame === 48_000) })
      .toEqual({ result: 'adopted', sessions: 1, calls: ['prepare-graph', 'install-schedule', 'publish-graph'], publicationFrame: true, oldPeriodNoteOn: false })
  } finally { f.controller.dispose() }
})

// W-F20c: after the transport wrapped, raw frames are ahead of the arrangement. A loop edit installs its loop shifted by
// that difference: the schedule is the one a start at the seam's arrangement position would compile, moved by the
// difference; positions before the seam read the old loop and positions from it on the new one, with no jump; a refresh
// then starts from the arrangement position.
test('W-F20c a loop edit after a wrap maps positions across the seam, compiles the loop shifted and refreshes from the arrangement position', async () => {
  const notes = [0, 1, 2, 3].map((beat) => w8Note(`n${beat}`, beat, 0.25))
  const edited: W8Loop = { loopEnabled: true, loopStartSec: 0.5, loopEndSec: 1.5 }
  const f = await w8Fixture({ clipSec: 40, notes, loop: { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } })
  const reference = await w8Fixture({ clipSec: 40, notes, loop: edited })
  const sec = (frame: number) => frame / 48_000
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    expect(await reference.controller.start({ ...reference.transport, playheadSec: 0.5 })).toBe('started')
    f.position(60_000, 1, 1)
    expect(await f.adopt(edited)).toBe('adopted')
    const installed = f.installs.at(-1)
    const delta = 48_000
    const before = (frame: number) => frame < 1_300_000
    f.position(66_000, 1, 2)
    const old = f.controller.currentPositionSec()
    f.position(72_000, 1, 3)
    const atSeam = f.controller.currentPositionSec()
    f.position(125_000, 1, 4)
    const wrapped = f.controller.currentPositionSec()
    expect({ origin: installed?.timeOrigin, old, atSeam, wrapped,
      noteOns: f.noteEvents(installed, 'note-on').map((event) => event.frame).filter(before),
      referenceNoteOns: f.noteEvents(reference.installs[0], 'note-on').map((event) => event.frame + delta).filter(before) })
      .toEqual({ origin: { timelineSec: 0.5, frame: 72_000 }, old: sec(18_000), atSeam: sec(24_000), wrapped: sec(29_000),
        noteOns: f.noteEvents(reference.installs[0], 'note-on').map((event) => event.frame + delta).filter(before),
        referenceNoteOns: f.noteEvents(installed, 'note-on').map((event) => event.frame).filter(before) })
    f.position(1_250_000, 1, 5)
    expect(await f.controller.refreshSchedule()).toBe('started')
    expect({ sessions: f.sessions(), origin: f.installs.at(-1)?.timeOrigin, position: f.controller.currentPositionSec() })
      .toEqual({ sessions: 2, origin: { timelineSec: sec(50_000), frame: 50_000 }, position: sec(50_000) })
  } finally { f.controller.dispose(); reference.controller.dispose() }
})

// W-F20d: a loop repeats audio clips, so the sources an adoption ships are those compiled for the new loop at the seam:
// the 1 s clip starts at the seam (12000) and again once per 2 s iteration (96000), where the old 1 s loop restarted it
// every 48000 frames.
test('W-F20d a loop edit with an audio clip present is adopted with the sources compiled for the new loop', async () => {
  const f = await w8Fixture({ audioStartSec: 0, loop: { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const result = await f.adopt({ loopEnabled: true, loopStartSec: 0, loopEndSec: 2 })
    expect({ result, starts: w8ShippedStarts(f).filter((start) => start < 200_000), sessions: f.sessions(), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', starts: [12_000, 96_000, 192_000], sessions: 1, disposed: false })
  } finally { f.controller.dispose() }
})

// W-F20e: loop off and on while playing stay on one session. Off after a wrap continues linearly from the arrangement
// position; a loop whose end the playhead has passed stays off for the run, as a start would (its adoption installs a
// linear schedule); a wider loop turns on.
test('W-F20e toggling the loop while playing keeps the session, continues linearly and keeps a passed loop off', async () => {
  const f = await w8Fixture({ clipSec: 40, loop: { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 } })
  const sec = (frame: number) => frame / 48_000
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(60_000, 1, 1)
    const off = await f.adopt(f.noLoop)
    f.position(72_000, 1, 2)
    const atSeam = f.controller.currentPositionSec()
    f.position(100_000, 1, 3)
    const linear = f.controller.currentPositionSec()
    const passed = await f.adopt({ loopEnabled: true, loopStartSec: 0, loopEndSec: 1 })
    f.position(130_000, 1, 4)
    const stillLinear = f.controller.currentPositionSec()
    const wide = await f.adopt({ loopEnabled: true, loopStartSec: 0, loopEndSec: 2 })
    f.position(142_000, 1, 5)
    const atWideSeam = f.controller.currentPositionSec()
    f.position(150_000, 1, 6)
    const wrapped = f.controller.currentPositionSec()
    expect({ off, atSeam, linear, passed, stillLinear, wide, atWideSeam, wrapped, sessions: f.sessions(), disposed: f.calls.includes('dispose') })
      .toEqual({ off: 'adopted', atSeam: sec(24_000), linear: sec(52_000), passed: 'adopted', stillLinear: sec(82_000), wide: 'adopted',
        atWideSeam: sec(94_000), wrapped: sec(6_000), sessions: 1, disposed: false })
  } finally { f.controller.dispose() }
})

// W-E5-1: a tempo edit while playing is adopted on the same session at a seam; the playhead keeps its time (UD 18).
test('W-E5-1 a tempo edit while playing is adopted on the same session with the playhead time kept', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.bpm = 90
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    expect({ result, sessions: f.sessions(), disposed: f.calls.includes('dispose'), installs: f.installs.length, published: f.publishes.length,
      seam: installed?.timeOrigin.frame, noteOffs: f.noteEvents(installed, 'note-off').map((event) => event.frame), bpm: installed?.bpm })
      .toEqual({ result: 'adopted', sessions: 1, disposed: false, installs: 2, published: 2,
        seam: 12_000, noteOffs: [32_000], bpm: 90 })
  } finally { f.controller.dispose() }
})

// W-E5-3: a note deleted while it sounds is released once, at the seam, and never started again.
test('W-E5-3 a note removed while held gets one note-off at the seam and no note-on', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const heldId = f.noteEvents(f.installs[0], 'note-on')[0]?.noteId
    f.state.notes = []
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    expect({ result, noteOffs: f.noteEvents(installed, 'note-off'), noteOns: f.noteEvents(installed, 'note-on') })
      .toEqual({ result: 'adopted', noteOffs: [{ noteId: heldId, frame: installed?.timeOrigin.frame ?? -1 }], noteOns: [] })
  } finally { f.controller.dispose() }
})

// W-E5-4: a note that spans the seam and survives the edit keeps its voice: its note-on is not repeated, because a
// repeated Synth note-on needs two note-offs and a Sampler layers a second voice.
test('W-E5-4 a note kept while held is not re-triggered at the seam', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const heldId = f.noteEvents(f.installs[0], 'note-on')[0]?.noteId
    f.state.notes = [w8Note('note', 0), w8Note('later', 1.5, 0.25)]
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    expect({ result, heldNoteOns: f.noteEvents(installed, 'note-on').filter((event) => event.noteId === heldId),
      heldNoteOffs: f.noteEvents(installed, 'note-off').filter((event) => event.noteId === heldId).map((event) => event.frame),
      laterNoteOns: f.noteEvents(installed, 'note-on').filter((event) => event.noteId !== heldId).map((event) => event.frame) })
      .toEqual({ result: 'adopted', heldNoteOns: [], heldNoteOffs: [24_000], laterNoteOns: [36_000] })
  } finally { f.controller.dispose() }
})

// W-E5-5: a note whose pitch changes while it sounds is released at the seam and the new pitch starts there.
test('W-E5-5 a pitch change while held releases the old note at the seam and starts the new one', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const heldId = f.noteEvents(f.installs[0], 'note-on')[0]?.noteId
    f.state.notes = [{ ...w8Note('note', 0), pitch: 64 }]
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    const seam = installed?.timeOrigin.frame ?? -1
    expect({ result, offs: f.noteEvents(installed, 'note-off').map((event) => `${event.noteId === heldId}@${event.frame}`),
      ons: f.noteEvents(installed, 'note-on').map((event) => event.frame) })
      .toEqual({ result: 'adopted', offs: [`true@${seam}`, 'true@24000'], ons: [seam] })
  } finally { f.controller.dispose() }
})

// W-E5-11: a window that holds more events than the worklet installs shrinks until it fits.
test('W-E5-11 a tempo edit that makes the window exceed the install limit shrinks the window and is adopted', async () => {
  const f = await w8Fixture({ clipSec: 16, notes: Array.from({ length: 150 }, (_, index) => w8Note(`n${index}`, 0.5 + 0.2 * index, 0.1)) })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.bpm = 100
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    expect({ result, firstOverLimit: (f.installs[0]?.events.length ?? 0) > 256, lastFits: (installed?.events.length ?? 0) <= 256, rangeShrunk: (installed?.events.length ?? 0) > 100 })
      .toEqual({ result: 'adopted', firstOverLimit: true, lastFits: true, rangeShrunk: true })
  } finally { f.controller.dispose() }
})

// A tempo moves warped audio and the MIDI notes together (UD 18): the edit that warps the audio with the tempo is adopted
// on the same session, as native's adoption does, with the sources compiled for the new tempo.
test('W-E5 a tempo edit that warps audio is adopted with the new sources and no rebuild', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    f.state.bpm = 90
    f.state.warped = true
    const result: string = await f.adopt(f.noLoop)
    expect({ result, calls: f.calls.slice(before).filter((call) => call !== 'mark-active').map((call) => call.split(':')[0]), disposed: f.calls.includes('dispose'),
      shipped: f.publishes.at(-1)?.options?.sources !== undefined, noteOffs: f.noteEvents(f.installs.at(-1), 'note-off').map((event) => event.frame) })
      .toEqual({ result: 'adopted', calls: ['prepare-graph', 'install-schedule', 'publish-graph'], disposed: false, shipped: true, noteOffs: [32_000] })
  } finally { f.controller.dispose() }
})

// W-E5-8 and W-FB-1: a refused publish is a failed adoption that a resubmit completes, never a rebuild.
test('W-E5-8 a refused tempo publish answers failed, restores the revision and adopts on resubmit', async () => {
  let refuse = true
  const f = await w8Fixture({}, { refuse: () => refuse })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.bpm = 90
    const refused = await f.adopt(f.noLoop)
    refuse = false
    const retried = await f.adopt(f.noLoop)
    expect({ refused, retried, sessions: f.sessions(), disposed: f.calls.includes('dispose'), revisions: f.publishes.slice(1).map((entry) => entry.revision) })
      .toEqual({ refused: 'failed', retried: 'adopted', sessions: 1, disposed: false, revisions: [2, 2] })
  } finally { f.controller.dispose() }
})

// A refused publish and content the session cannot carry are failed adoptions, which the controller retries and logs; a
// missing fingerprint is a construction defect answered unavailable. None is a rebuild: the result type has no such member.
test('W-FB-1 a refused publish and uncarried content answer failed, a missing fingerprint answers unavailable, never a rebuild', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  let volume = 0.8
  let carried = true
  let refuse = true
  let sessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => carried ? b6f5Compilation(transport, volume) : { supported: false, reasons: ['not carried'] },
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => { sessions += 1; return b6f5Session(calls, graphs, publishes, async (options) => {
      if (refuse && options) throw new Error('Portable playback graph-published was rejected.')
    }) } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    volume = 0.5
    const refused = await controller.adoptSchedule(noLoop)
    refuse = false
    const retried = await controller.adoptSchedule(noLoop)
    carried = false
    const uncarried = await controller.adoptSchedule(noLoop)
    expect({ refused, retried, uncarried, sessions, disposed: calls.includes('dispose') })
      .toEqual({ refused: 'failed', retried: 'adopted', uncarried: 'failed', sessions: 1, disposed: false })
  } finally { controller.dispose() }

  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  const bare = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume),
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => b6f5Session(calls, graphs, publishes) },
  })
  try {
    expect(await bare.start(compilation().snapshot.transport)).toBe('started')
    const result = await bare.adoptSchedule(noLoop)
    expect({ result, errors: errors.length }).toEqual({ result: 'unavailable', errors: 1 })
  } finally { console.error = original; bare.dispose() }
})

// W-M3 guard: an audio clip edit that reaches the follow must never be adopted over the old sources. An adoption or an
// unchanged answer counts only when the sources it shipped place the clip where the edit put it.
test('W-M3 an audio clip move is never adopted or reported unchanged without shipping its new sources', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.audioStartSec = 0.5
    const result = await f.adopt(f.noLoop)
    const shipped = f.publishes.at(-1)?.options?.sources
    expect({ result, stale: (result === 'adopted' || result === 'unchanged') && !w8ShippedStarts(f).includes(24_000), shipped: shipped !== undefined })
      .toEqual({ result: 'adopted', stale: false, shipped: true })
  } finally { f.controller.dispose() }
})

// W-M3 end state: the audio class is carried: the move is adopted on the same session with its sources replaced.
test('W-M3 an audio clip move answers adopted with its sources replaced, not a rebuild', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    f.state.audioStartSec = 0.5
    const result: string = await f.adopt(f.noLoop)
    expect({ result, starts: w8ShippedStarts(f), calls: f.calls.slice(before).filter((call) => call !== 'mark-active').map((call) => call.split(':')[0]), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', starts: [24_000], calls: ['prepare-graph', 'install-schedule', 'publish-graph'], disposed: false })
  } finally { f.controller.dispose() }
})

// W-UD7p-1: an edit while paused is adopted in place; Play then resumes on the edited schedule with no re-prepare.
test('W-UD7p-1 a note edit on a paused prepared session is adopted in place', async () => {
  const f = await w8Fixture({ clipSec: 4 })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    const result = await f.adopt(f.noLoop)
    const started = await f.controller.start({ ...f.transport, state: 'playing' })
    expect({ result, started, sessions: f.sessions(), disposed: f.calls.includes('dispose'), seam: f.installs.at(-1)?.timeOrigin.frame,
      laterNoteOn: f.noteEvents(f.installs.at(-1), 'note-on').some((event) => event.frame === 96_000) })
      .toEqual({ result: 'adopted', started: 'started', sessions: 1, disposed: false, seam: 0, laterNoteOn: true })
  } finally { f.controller.dispose() }
})

// W-UD7p-3: a pause leaves its voices sounding, so the edit that deletes the note releases it once, at the paused frame.
test('W-UD7p-3 deleting a note that a pause left sounding releases it once at the paused frame', async () => {
  const f = await w8Fixture({ clipSec: 4, notes: [w8Note('held', 0, 4)] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const heldId = f.noteEvents(f.installs[0], 'note-on')[0]?.noteId
    await f.controller.pause(0.5)
    f.state.notes = []
    const result = await f.adopt(f.noLoop)
    const installed = f.installs.at(-1)
    expect({ result, sessions: f.sessions(), noteOns: f.noteEvents(installed, 'note-on'),
      noteOffs: f.noteEvents(installed, 'note-off').map((event) => `${event.noteId === heldId}@${event.frame}`) })
      .toEqual({ result: 'adopted', sessions: 1, noteOns: [], noteOffs: ['true@24000'] })
  } finally { f.controller.dispose() }
})

// W-UD7p-4: a tempo edit and a loop edit while paused are adopted at the paused frame; a locate after the tempo edit
// seeks the same session and compiles the edited tempo.
test('W-UD7p-4 a paused tempo edit and a paused loop edit are adopted in place and a locate seeks the edited schedule', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.bpm = 100
    const tempo = await f.adopt(f.noLoop)
    const tempoBpm = f.installs.at(-1)?.bpm
    const before = f.calls.length
    const located = await f.controller.ensurePrepared({ ...f.transport, state: 'paused', playheadSec: 0.25 })
    const seeked = { bpm: f.installs.at(-1)?.bpm, origin: f.installs.at(-1)?.timeOrigin.frame, calls: f.calls.slice(before).filter((call) => call.endsWith('-transport') || call === 'dispose') }
    const loop = await f.adopt({ loopEnabled: true, loopStartSec: 0.25, loopEndSec: 1.25 })
    expect({ tempo, tempoBpm, located, seeked, loop, loopNoteOns: f.noteEvents(f.installs.at(-1), 'note-on').slice(0, 2).map((event) => event.frame),
      sessions: f.sessions(), disposed: f.calls.includes('dispose') })
      .toEqual({ tempo: 'adopted', tempoBpm: 100, located: 'started', seeked: { bpm: 100, origin: 12_000, calls: ['stop-transport'] },
        loop: 'adopted', loopNoteOns: [12_000, 60_000], sessions: 1, disposed: false })
  } finally { f.controller.dispose() }
})

// W-UD7p-5: Play after a paused edit locates the session that adopted it and runs it: no prepare, no publish, no dispose.
test('W-UD7p-5 Play after a paused structural edit resumes the same session with no prepare or publish', async () => {
  const f = await w8Fixture({ clipSec: 4 })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    expect(await f.adopt(f.noLoop)).toBe('adopted')
    const before = f.calls.length
    const started = await f.controller.start({ ...f.transport, state: 'playing' })
    expect({ started, sessions: f.sessions(), rebuilt: f.calls.slice(before).filter((call) => ['dispose', 'prepare-graph', 'publish-graph'].includes(call)),
      laterNoteOn: f.noteEvents(f.installs.at(-1), 'note-on').some((event) => event.frame === 96_000) })
      .toEqual({ started: 'started', sessions: 1, rebuilt: [], laterNoteOn: true })
  } finally { f.controller.dispose() }
})

// W-R11: a kept paused session resumes in place whether its loop is on or off, from where it stands, and plays the edit.
test('W-R11 Play on a paused session with its loop on resumes the same session and plays the paused edit', async () => {
  const loop: W8Loop = { loopEnabled: true, loopStartSec: 0, loopEndSec: 2 }
  const f = await w8Fixture({ clipSec: 4, loop })
  const paused: LivePlaybackTransport = { ...f.transport, state: 'paused', playheadSec: 0.5 }
  try {
    expect(await f.controller.ensurePrepared(paused)).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 1)]
    expect(await f.adopt(loop)).toBe('adopted')
    const started = await f.controller.start({ ...paused, state: 'playing' })
    const installed = f.installs.at(-1)
    expect({ started, sessions: f.sessions(), disposed: f.calls.includes('dispose'), origin: installed?.timeOrigin.frame,
      laterNoteOn: f.noteEvents(installed, 'note-on').some((event) => event.frame === 24_000), playing: f.controller.isActive() })
      .toEqual({ started: 'started', sessions: 1, disposed: false, origin: 24_000, laterNoteOn: true, playing: true })
  } finally { f.controller.dispose() }
})

// W-UD7p-6: a locate right after a paused edit seeks the session that adopted it.
test('W-UD7p-6 a seek after a paused edit compiles the edited notes on the same session', async () => {
  const f = await w8Fixture({ clipSec: 4 })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    expect(await f.adopt(f.noLoop)).toBe('adopted')
    const seeked = await f.controller.seek(1, f.noLoop)
    expect({ seeked, sessions: f.sessions(), disposed: f.calls.includes('dispose'), origin: f.installs.at(-1)?.timeOrigin.frame,
      laterNoteOn: f.noteEvents(f.installs.at(-1), 'note-on').some((event) => event.frame === 96_000) })
      .toEqual({ seeked: 'started', sessions: 1, disposed: false, origin: 48_000, laterNoteOn: true })
  } finally { f.controller.dispose() }
})

// W-UD7p-7: a paused edit whose publish is refused leaves the session as it was. A paused session reports no rendered
// frames, so the UD 8 resubmit runs once Play makes them flow, and Play itself resumes the same session.
test('W-UD7p-7 a refused paused edit answers failed, keeps the session and is resubmitted once Play reports frames', async () => {
  let refuse = true
  const f = await w8Fixture({ clipSec: 4 }, { refuse: () => refuse })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    const failed = await f.adopt(f.noLoop)
    const started = await f.controller.start({ ...f.transport, state: 'playing' })
    refuse = false
    f.position(1_000, f.epochs.at(-1))
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    expect({ failed, started, sessions: f.sessions(), disposed: f.calls.includes('dispose'), revisions: f.publishes.slice(1).map((entry) => entry.revision),
      laterNoteOn: f.noteEvents(f.installs.at(-1), 'note-on').some((event) => event.frame === 96_000) })
      .toEqual({ failed: 'failed', started: 'started', sessions: 1, disposed: false, revisions: [2, 2], laterNoteOn: true })
  } finally { f.controller.dispose() }
})

test('W-E3-1 a seek while playing moves the transport in place at a new epoch', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    const startEpoch = f.epochs.at(-1) ?? 0
    const result = await f.controller.seek(1.5, f.noLoop)
    expect({ result, sessions: f.sessions(), rebuilt: f.calls.slice(before).filter((call) => ['dispose', 'prepare-graph', 'publish-graph'].includes(call)),
      epochs: [...new Set(f.epochs.slice(-2))], transports: f.calls.slice(before).filter((call) => call.endsWith('-transport')) })
      .toEqual({ result: 'started', sessions: 1, rebuilt: [], epochs: [startEpoch + 1], transports: ['stop-transport', 'start-transport'] })
  } finally { f.controller.dispose() }
})

test('W-E3-4 positions are reported again after a backward seek at the new epoch', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(96_000)
    await f.controller.seek(0.5, f.noLoop)
    f.position(25_000, (f.epochs.at(-1) ?? 0), 1)
    expect(f.controller.currentPositionSec()).toBeCloseTo(25_000 / 48_000, 6)
  } finally { f.controller.dispose() }
})

// W-E3-2: past the installed range the seek compiles its own window at the target: one session, a schedule at the new
// origin, sources replaced at the new epoch, and a loop around the target repeats from it.
test('W-E3-2 a seek outside the installed range compiles at the target on the same session, loop off and on', async () => {
  const far = [w8Note('far', 200, 1)]
  for (const loop of [{ loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }, { loopEnabled: true, loopStartSec: 90, loopEndSec: 110 }]) {
    const f = await w8Fixture({ clipSec: 200, notes: far })
    try {
      expect(await f.controller.start(f.transport)).toBe('started')
      const before = f.calls.length
      const result = await f.controller.seek(100, loop)
      expect({ loop: loop.loopEnabled, result, sessions: f.sessions(), origin: f.installs.at(-1)?.timeOrigin,
        noteOns: f.noteEvents(f.installs.at(-1), 'note-on').map((event) => event.frame),
        calls: f.calls.slice(before).filter((call) => !call.startsWith('install-schedule')) })
        .toEqual({ loop: loop.loopEnabled, result: 'started', sessions: 1, origin: { timelineSec: 100, frame: 4_800_000 },
          noteOns: loop.loopEnabled ? [4_800_000, 5_760_000] : [4_800_000],
          calls: ['stop-transport', 'schedule-sources', 'start-transport', 'mark-active'] })
    } finally { f.controller.dispose() }
  }
})

// W-E3-3, compile half (the core half is in the host test): a note that ended before the target is not started, and a
// note spanning it starts once at the target.
test('W-E3-3 a seek starts a note that spans the target once and none that ended before it', async () => {
  const f = await w8Fixture({ clipSec: 4, notes: [w8Note('spans', 0, 4), w8Note('ended', 0, 0.5)] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.controller.seek(1, f.noLoop)
    const installed = f.installs.at(-1)
    expect({ noteOns: f.noteEvents(installed, 'note-on').map((event) => event.frame), noteOffs: f.noteEvents(installed, 'note-off').map((event) => event.frame) })
      .toEqual({ noteOns: [48_000], noteOffs: [96_000] })
  } finally { f.controller.dispose() }
})

// W-E3-5: a seek waits for what is in flight and the newest one wins.
test('W-E3-5 a seek supersedes an adoption in flight, the older of two seeks, and waits for a refresh', async () => {
  const adoption = await w8Fixture({ clipSec: 4 })
  try {
    expect(await adoption.controller.start(adoption.transport)).toBe('started')
    adoption.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    const adopting = adoption.adopt(adoption.noLoop)
    const seeking = adoption.controller.seek(1.5, adoption.noLoop)
    const answers = { adopting: await adopting, seeking: await seeking }
    const afterwards = await adoption.adopt(adoption.noLoop)
    expect({ ...answers, afterwards, sessions: adoption.sessions(), published: adoption.publishes.length,
      seam: adoption.installs.at(-1)?.timeOrigin.frame })
      .toEqual({ adopting: 'unavailable', seeking: 'started', afterwards: 'adopted', sessions: 1, published: 2, seam: 72_000 + 12_000 })
  } finally { adoption.controller.dispose() }
  const twice = await w8Fixture()
  try {
    expect(await twice.controller.start(twice.transport)).toBe('started')
    const before = twice.calls.length
    const first = twice.controller.seek(1, twice.noLoop)
    const second = twice.controller.seek(2, twice.noLoop)
    expect({ first: await first, second: await second, origin: twice.installs.at(-1)?.timeOrigin.frame, position: twice.controller.currentPositionSec(),
      transports: twice.calls.slice(before).filter((call) => call.endsWith('-transport')) })
      .toEqual({ first: 'started', second: 'started', origin: 96_000, position: 2, transports: ['stop-transport', 'start-transport'] })
  } finally { twice.controller.dispose() }
  const refreshing = await w8Fixture({ clipSec: 40 })
  try {
    expect(await refreshing.controller.start(refreshing.transport)).toBe('started')
    refreshing.position(1_250_000, 1, 1)
    const refresh = refreshing.controller.refreshSchedule()
    const seek = refreshing.controller.seek(3, refreshing.noLoop)
    expect({ refresh: await refresh, seek: await seek, sessions: refreshing.sessions(), position: refreshing.controller.currentPositionSec(),
      origin: refreshing.installs.at(-1)?.timeOrigin.frame })
      .toEqual({ refresh: 'unavailable', seek: 'started', sessions: 2, position: 3, origin: 144_000 })
  } finally { refreshing.controller.dispose() }
})

test('W-E3-5 a seek during a take throws and leaves the transport alone', async () => {
  const calls: string[] = []
  const { stream, recordingContext } = createRecordingFixture(calls)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async () => compilation(), getAudioContext: () => recordingContext, select: async () => selected,
    backend: { createPlaybackSession: async () => createSession(calls, async () => undefined) },
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: () => undefined, finalize: async () => ({ capturedFrames: 0 }),
      abort: async () => undefined, terminate: () => undefined }),
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    await controller.startRecording(b6f5RecordingInput(stream))
    const before = calls.length
    await expect(controller.seek(1, noLoop)).rejects.toThrow('Portable recording must stop before playback can seek.')
    expect({ calls: calls.slice(before), playing: controller.isActive() }).toEqual({ calls: [], playing: true })
  } finally { controller.dispose() }
})

// W-E3-7: the seek plays the snapshot the session holds; the edit that landed is adopted after it.
test('W-E3-7 a seek with an edit pending plays the active snapshot and the next adoption carries the edit', async () => {
  const f = await w8Fixture({ clipSec: 4 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.notes = [w8Note('note', 0), w8Note('later', 4)]
    expect(await f.controller.seek(1.5, f.noLoop)).toBe('started')
    const seeked = f.noteEvents(f.installs.at(-1), 'note-on').map((event) => event.frame)
    const adopted = await f.adopt(f.noLoop)
    expect({ seeked, adopted, adoptedNoteOns: f.noteEvents(f.installs.at(-1), 'note-on').map((event) => event.frame) })
      .toEqual({ seeked: [], adopted: 'adopted', adoptedNoteOns: [96_000] })
  } finally { f.controller.dispose() }
})

// W-E3-8: a seek after a loop edit that moved the position map starts a fresh map at the target.
test('W-E3-8 a seek with the loop on after a wrap and a loop adoption resets the position map to the target', async () => {
  const notes = [0, 1, 2, 3].map((beat) => w8Note(`n${beat}`, beat, 0.25))
  const loop: W8Loop = { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 }
  const f = await w8Fixture({ clipSec: 40, notes, loop })
  const sec = (frame: number) => frame / 48_000
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(60_000, 1, 1)
    expect(await f.adopt({ loopEnabled: true, loopStartSec: 0.5, loopEndSec: 1.5 })).toBe('adopted')
    f.position(72_000, 1, 2)
    expect(await f.controller.seek(0.25, loop)).toBe('started')
    const atTarget = f.controller.currentPositionSec()
    f.position(80_000, f.epochs.at(-1) ?? 0, 1)
    expect({ atTarget, wrapped: f.controller.currentPositionSec() }).toEqual({ atTarget: 0.25, wrapped: sec(32_000) })
  } finally { f.controller.dispose() }
})

// D5 and R-E3-4: a locate stops at the new epoch first (the core clears its sources), then releases the old preparations
// and prepares the target's pages, then submits the schedule and the sources, then runs. The pages keep the generation
// the session registered them under, whatever the transport epoch.
test('W-E3-D5 a seek stops, prepares the target pages, installs, schedules sources and runs; pages keep the session generation', async () => {
  const calls: string[] = []
  const epochs: number[] = []
  const generations: number[] = []
  const faults: string[] = []
  let registered = 0
  let sessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => pagedCompilation(transport),
    getAudioContext: () => context, scheduleHorizonSec: 4, select: async () => selected, reportFault: (message) => faults.push(message),
    resolveSource: async (clip) => pagedDescriptor(clip.sourceAssetKey ?? 'missing', []),
    backend: { createPlaybackSession: async () => {
      sessions += 1
      const base = createSession(calls, async () => undefined, undefined, true)
      return { ...base,
        setTransport: async (epoch: number, running: boolean, frame: number) => { epochs.push(epoch); await base.setTransport(epoch, running, frame) },
        registerPagedAsset: async (_asset: Parameters<PortableWasmPlaybackSession['registerPagedAsset']>[0], generation: number) => {
          registered = generation; generations.push(generation); return base.registerPagedAsset()
        },
        prepareAssetRange: async (assetId: string, generation: number, offset: number, count: number) => {
          calls.push('prepare-range'); generations.push(generation)
          return generation === registered ? base.prepareAssetRange(assetId, generation, offset, count) : { status: 'stale-generation' as const }
        },
        writeAssetPage: async (assetId: string, generation: number, pageIndex: number) => {
          calls.push('write-page'); return base.writeAssetPage(assetId, generation, pageIndex)
        },
        releaseAssetPreparation: async (preparationId: number, generation: number) => {
          calls.push('release-preparation'); generations.push(generation)
          return generation === registered ? base.releaseAssetPreparation(preparationId) : 'stale-preparation' as const
        } }
    } },
  })
  try {
    expect(await controller.start(pagedCompilation().snapshot.transport)).toBe('started')
    const before = calls.length
    const result = await controller.seek(20, noLoop)
    const order = calls.slice(before).filter((call) => call !== 'write-page').filter((call, index, all) => call !== all[index - 1])
    expect({ result, faults, sessions, order, generations: [...new Set(generations)], epochs: [...new Set(epochs)] })
      .toEqual({ result: 'started', faults: [], sessions: 1,
        order: ['stop-transport', 'release-preparation', 'prepare-range', 'install-schedule:0', 'schedule-prepared-sources', 'start-transport', 'mark-active'],
        generations: [1], epochs: [1, 2] })
  } finally { controller.dispose() }
})

// D6: a seek that fails inside its burst keeps the transport running and is resubmitted after rendered-frame reports, up
// to the adoption retry limit; exhaustion is a logged defect and the transport-fault notice.
test('W-E3-D6 a seek failing inside the burst resubmits after a position report from where the transport stands', async () => {
  let failures = 0
  const f = await w8Fixture({}, { failInstall: () => failures-- > 0 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    failures = 1
    expect(await f.controller.seek(1.5, f.noLoop)).toBe('unavailable')
    const epoch = f.epochs.at(-1) ?? 0
    f.position(75_000, epoch, 1)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    expect({ sessions: f.sessions(), faults: f.faults, origin: f.installs.at(-1)?.timeOrigin.frame, epoch: f.epochs.at(-1), active: f.controller.isActive(),
      warned: warn.mock.calls.length })
      .toEqual({ sessions: 1, faults: [], origin: 75_000, epoch: epoch + 1, active: true, warned: 1 })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('W-E3-D6 a seek that keeps failing is a logged defect and the transport-fault notice after eight resubmits', async () => {
  let attempts = 0
  let armed = false
  const f = await w8Fixture({}, { failInstall: () => { if (armed) attempts += 1; return armed } })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    armed = true
    expect(await f.controller.seek(1.5, f.noLoop)).toBe('unavailable')
    for (let report = 1; report <= 400 && f.controller.isPrepared(); report += 1) {
      f.position(50_000 + report * 1_000, f.epochs.at(-1) ?? 0, report)
      for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    }
    expect({ attempts, prepared: f.controller.isPrepared(), faults: f.faults, disposed: f.calls.includes('dispose'),
      warned: warn.mock.calls.length, defects: error.mock.calls.length })
      .toEqual({ attempts: 9, prepared: false, faults: ['Portable playback install-schedule was rejected.'], disposed: true, warned: 8, defects: 1 })
  } finally { warn.mockRestore(); error.mockRestore(); f.controller.dispose() }
})

// N1 and the position map: the seek moves the transport epoch on its session. A report from the epoch it left is not a
// position of the new one, and positions of the new epoch read through the target's loop, not the loop the session ran.
test('W-E3-N1 a position report from the epoch a seek left does not tick the retry or move the position', async () => {
  let failures = 0
  const f = await w8Fixture({}, { failInstall: () => failures-- > 0 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const left = f.epochs.at(-1) ?? 0
    failures = 1
    expect(await f.controller.seek(1.5, f.noLoop)).toBe('unavailable')
    const epoch = f.epochs.at(-1) ?? 0
    const attempts = f.epochs.length
    f.position(100_000, left, 1)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    const afterStale = f.epochs.length - attempts
    f.position(75_000, epoch, 1)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    expect({ moved: epoch !== left, afterStale, origin: f.installs.at(-1)?.timeOrigin.frame })
      .toEqual({ moved: true, afterStale: 0, origin: 75_000 })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('W-E3-pos a seek restarts the position map: the resubmit starts where the new epoch stands, not through the loop the session ran', async () => {
  let failures = 0
  const f = await w8Fixture({}, { failInstall: () => failures-- > 0 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start({ ...f.transport, loopEnabled: true, loopStartSec: 0, loopEndSec: 1 })).toBe('started')
    f.position(60_000, f.epochs.at(-1) ?? 0, 1)
    failures = 1
    expect(await f.controller.seek(1.5, f.noLoop)).toBe('unavailable')
    f.position(75_000, f.epochs.at(-1) ?? 0, 1)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    expect(f.installs.at(-1)?.timeOrigin.frame).toBe(75_000)
  } finally { warn.mockRestore(); f.controller.dispose() }
})

// R1: the pages a seek prepared are released when the seek fails after preparing them, not left pinned in the worklet.
test('W-R1 a seek that fails after preparing the target pages releases them, however often it is tried', async () => {
  let failing = false
  const calls: string[] = []
  const base = createSession(calls, async () => { if (failing) throw new Error('Portable playback install-schedule was rejected.') }, undefined, true)
  const faults: string[] = []
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => pagedCompilation(transport),
    getAudioContext: () => context, scheduleHorizonSec: 4, select: async () => selected, reportFault: (message) => faults.push(message),
    resolveSource: async (clip) => pagedDescriptor(clip.sourceAssetKey ?? 'missing', []),
    backend: { createPlaybackSession: async () => base },
  })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await controller.start(pagedCompilation().snapshot.transport)).toBe('started')
    failing = true
    const held: number[] = []
    for (const sec of [20, 21, 22]) {
      expect(await controller.seek(sec, noLoop)).toBe('unavailable')
      held.push(base.preparations.size)
    }
    expect({ held, faults, prepared: controller.isPrepared() }).toEqual({ held: [0, 0, 0], faults: [], prepared: true })
  } finally { warn.mockRestore(); controller.dispose() }
})

// R2: a stop the worklet rejected changed nothing, so the old position keeps playing and the retry goes to the target.
test('W-R2 a seek whose first stop is rejected leaves the transport playing and retries the target, not the position', async () => {
  let failures = 0
  const f = await w8Fixture({}, { failTransport: () => failures-- > 0 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(60_000, 1, 1)
    failures = 1
    const before = f.calls.length
    const result = await f.controller.seek(1.5, f.noLoop)
    const transports = f.calls.slice(before).filter((call) => call.endsWith('-transport'))
    f.position(75_000, 1, 2)
    for (let turn = 0; turn < 200; turn += 1) await Promise.resolve()
    expect({ result, transports, origin: f.installs.at(-1)?.timeOrigin.frame, epoch: f.epochs.at(-1), sessions: f.sessions(), faults: f.faults })
      .toEqual({ result: 'unavailable', transports: [], origin: 72_000, epoch: 2, sessions: 1, faults: [] })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

// R9: a seek the session refuses without having failed (nothing was touched) is the caller's to rebuild.
test('W-R9 a seek on a session of another project generation answers rebuild and touches nothing', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.state.projectGeneration = 1
    const before = f.calls.length
    const result: string = await f.controller.seek(1.5, f.noLoop)
    expect({ result, calls: f.calls.slice(before), prepared: f.controller.isPrepared() }).toEqual({ result: 'rebuild', calls: [], prepared: true })
  } finally { f.controller.dispose() }
})

// R5: with the loop on, a note held across the seam of a later pass keeps its voice, and a note that restarts at a wrap
// seam is attacked again.
test('W-R5 a note held across an adoption seam in a later loop pass is neither released nor re-attacked', async () => {
  const loop: W8Loop = { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 }
  const f = await w8Fixture({ clipSec: 40, notes: [w8Note('held', 0, 1)], loop })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const heldId = f.noteEvents(f.installs[0], 'note-on').find((event) => event.frame === 96_000)?.noteId
    f.position(98_000, 1, 1)
    f.state.notes = [w8Note('held', 0, 1), w8Note('later', 1.5, 0.25)]
    const result = await f.adopt(loop)
    const installed = f.installs.at(-1)
    const seam = installed?.timeOrigin.frame
    expect({ result, seam, heldNoteOns: f.noteEvents(installed, 'note-on').filter((event) => event.noteId === heldId),
      heldNoteOffs: f.noteEvents(installed, 'note-off').filter((event) => event.noteId === heldId).map((event) => event.frame) })
      .toEqual({ result: 'adopted', seam: 110_000, heldNoteOns: [], heldNoteOffs: [120_000] })
  } finally { f.controller.dispose() }
})

test('W-R5 a note that restarts at the seam on a loop wrap keeps its attack', async () => {
  const loop: W8Loop = { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 }
  const f = await w8Fixture({ clipSec: 40, notes: [w8Note('whole', 0, 2)], loop })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(36_000, 1, 1)
    f.state.notes = [w8Note('whole', 0, 2), w8Note('later', 1.5, 0.25)]
    const result = await f.adopt(loop)
    const installed = f.installs.at(-1)
    expect({ result, seam: installed?.timeOrigin.frame, noteOnsAtSeam: f.noteEvents(installed, 'note-on').filter((event) => event.frame === 48_000).length })
      .toEqual({ result: 'adopted', seam: 48_000, noteOnsAtSeam: 1 })
  } finally { f.controller.dispose() }
})

// W-R7: dense MIDI shrinks an adoption's window below the one the start scheduled sources for; the recording refresh
// then extends from the shortened end, and an audio clip in the gap must not be scheduled a second time.
test('W-R7 an adoption that shortens the window while recording does not make the refresh schedule a source twice', async () => {
  const calls: string[] = []
  const { stream, recordingContext } = createRecordingFixture(calls)
  const dense = Array.from({ length: 200 }, (_, index) => w8Note(`dense-${index}`, 20 + index * 0.05, 0.01))
  const f = await w8Fixture({ clipSec: 30, notes: dense, audioStartSec: 20 }, { audioContext: recordingContext })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.controller.startRecording(b6f5RecordingInput(stream))
    f.position(20_000, 1, 1)
    f.state.notes = [...dense.slice(1), w8Note('extra', 3, 0.5)]
    const adopted = await f.adopt(f.noLoop)
    f.position(300_000, 1, 2)
    const refresh = await f.controller.refreshSchedule()
    expect({ adopted, refresh, faults: f.faults,
      audioSources: f.scheduledSources.at(-1)?.filter((source) => source.startFrame === 960_000).length })
      .toEqual({ adopted: 'adopted', refresh: 'started', faults: [], audioSources: 1 })
  } finally { f.controller.dispose() }
})

// W-R8a: a loop edit made during a take is not adopted, the take's refresh reads raw frames as arrangement frames and
// stops at a loop. The follow adopts it once the take has ended.
test('W-R8a a loop edit during a take is held, and adopted once the take has ended', async () => {
  const { stream, recordingContext } = createRecordingFixture([])
  const f = await w8Fixture({ clipSec: 4 }, { audioContext: recordingContext })
  const loop: W8Loop = { loopEnabled: true, loopStartSec: 0, loopEndSec: 1 }
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.controller.startRecording(b6f5RecordingInput(stream))
    const held = await f.adopt(loop)
    const installsHeld = f.installs.length
    f.position(40_000, 1, 1)
    const refresh = await f.controller.refreshSchedule()
    expect({ held, installsHeld, refresh, faults: f.faults }).toEqual({ held: 'unchanged', installsHeld: 1, refresh: 'started', faults: [] })
    await f.controller.stopRecording()
    const installsBefore = f.installs.length
    expect({ followed: await f.adopt(loop), installs: f.installs.length - installsBefore }).toEqual({ followed: 'adopted', installs: 1 })
  } finally { f.controller.dispose() }
})


// AE-08 phase 8 step 9a: an adoption carries the sources of its candidate with the publish and commits them with it.
// Two paged clips: one spans every seam, the other starts after them.
type C9Publish = { revision: number; options?: Parameters<PortableWasmPlaybackSession['publishGraph']>[1] }
const c9StretchRepository = () => createPreparedStretchArtifactRepository({
  sessionId: `c9-${crypto.randomUUID()}`,
  lockManager: { request: async (name, _options, callback) => callback({ name }) },
})
type C9Warp = NonNullable<RuntimeTrack['clips'][number]['audioWarp']>
type C9State = { volume: number; refusals: number; clip0Offset: number; clip1Start: number; clip1Present: boolean; clip1Asset: string; inUse: Set<string>; bpm: number; clip1Warp: C9Warp | undefined; clip1Duration: number }
const c9Stretch: C9Warp = { enabled: true, mode: 'stretch', sourceBpm: 120 }
const c9Tracks = (state: C9State): RuntimeTrack[] => [
  { id: 'audio-0', kind: 'audio', name: 'Audio 0', volume: state.volume, clips: [{ id: 'clip-0', name: 'Clip 0', color: '#fff', startSec: 0, duration: 30, bufferOffsetSec: state.clip0Offset, sourceAssetKey: 'asset-a' }] },
  { id: 'audio-1', kind: 'audio', name: 'Audio 1', volume: 1, clips: state.clip1Present
    ? [{ id: 'clip-1', name: 'Clip 1', color: '#fff', startSec: state.clip1Start, duration: state.clip1Duration, sourceAssetKey: state.clip1Asset, audioWarp: state.clip1Warp }] : [] },
]
const c9Fixture = async (options: { refusals?: number; clip1Warp?: C9Warp; clip1Duration?: number } = {}) => {
  const state: C9State = { volume: 1, refusals: options.refusals ?? 0, clip0Offset: 0, clip1Start: 5, clip1Present: true, clip1Asset: 'asset-b', inUse: new Set(), bpm: 120, clip1Warp: options.clip1Warp, clip1Duration: options.clip1Duration ?? 10 }
  // Stretch artifacts the controller leased and released; a lease is made once per artifact a preparation produces.
  const stretch = { leased: 0, released: 0 }
  const stretchRepository = c9StretchRepository()
  const calls: string[] = []
  const publishes: C9Publish[] = []
  const scheduled: PortableWasmPreparedSourceEventsOf[] = []
  const faults: string[] = []
  const base = createSession(calls, async () => undefined, undefined, true)
  const session = {
    ...base,
    prepareGraph: async () => { calls.push('prepare-graph') },
    publishGraph: async (revision: number, publishOptions?: C9Publish['options']) => {
      publishes.push({ revision, options: publishOptions })
      if (publishOptions) calls.push('publish')
      if (publishOptions && state.refusals-- > 0) throw new Error('Portable playback graph-published was rejected.')
    },
    schedulePreparedSources: async (_revision: number, _epoch: number, events: PortableWasmPreparedSourceEventsOf) => { scheduled.push(events) },
    registerPagedAsset: async (asset: { assetId: string }) => {
      calls.push(`register:${asset.assetId}`)
      return { status: 'registered' as const, handle: { slot: 0, generation: 1 } }
    },
    releaseAsset: async (assetId: string) => {
      calls.push(`release:${assetId}`)
      return { status: state.inUse.has(assetId) ? 'asset-in-use' as const : 'released' as const }
    },
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const compiled = pagedCompilation(transport)
      const tracks = c9Tracks(state)
      const assets = ['asset-a', state.clip1Asset].map((assetId) => ({ assetId, source: { durationSec: pagedAssetFrameCount / 48_000, sampleRate: 48_000, channelCount: 1 } }))
      return { ...compiled, snapshot: { ...compiled.snapshot, bpm: state.bpm, tracks, assets, mixer: { ...compiled.snapshot.mixer, graph: resolveLiveMixerGraph(tracks, {}) } } }
    },
    fingerprintSnapshot: b6f5Fingerprint, getAudioContext: () => context, scheduleHorizonSec: 8, select: async () => selected,
    reportFault: (message) => faults.push(message),
    resolveSource: async (clip) => pagedDescriptor(clip.sourceAssetKey ?? 'missing', []),
    createPreparedStretchRepository: () => ({ ...stretchRepository, acquireLease: async (manifest) => {
      const lease = await stretchRepository.acquireLease(manifest)
      stretch.leased += 1
      return { ...lease, release: async () => { stretch.released += 1; await lease.release() } }
    } }),
    backend: { createPlaybackSession: async () => session },
  })
  const transport = pagedCompilation().snapshot.transport
  let reports = 0
  const report = async (frame: number, count = 1) => {
    for (let index = 0; index < count; index += 1) {
      reports += 1
      base.emitPosition(frame, reports)
      await Bun.sleep(0)
    }
  }
  const sources = (publish?: C9Publish) => publish?.options?.sources
  return { state, controller, transport, base, calls, publishes, scheduled, faults, report, sources, stretch }
}
type PortableWasmPreparedSourceEventsOf = Parameters<PortableWasmPlaybackSession['schedulePreparedSources']>[2]
const c9Starts = (events: readonly { sourceNodeId: string; startFrame: number; sourceOffsetFrame: number }[] | undefined) =>
  (events ?? []).map((event) => [event.sourceNodeId, event.startFrame, event.sourceOffsetFrame])

test('C9a-1 an adoption ships the sources compiled at its seam with the publish; a clip after the seam is the source the start scheduled', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    const sources = f.sources(f.publishes.at(-1))
    const startup = f.scheduled[0]?.find((event) => event.sourceNodeId === 'audio-1')
    const shipped = sources?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    expect({ epoch: sources?.epoch, ordinary: sources?.ordinary, prepared: c9Starts(sources?.prepared), same: { ...shipped, preparationId: 0 } })
      .toEqual({ epoch: 1, ordinary: [], prepared: [['audio-0', 108_000, 108_000], ['audio-1', 240_000, 0]], same: { ...startup, preparationId: 0 } })
  } finally { f.controller.dispose() }
})

test('C9a-2 the preparations of the old sources are released once the position reaches the seam, the candidate\'s stay, and teardown releases all', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const held: number[] = [f.base.preparations.size]
    await f.report(96_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    held.push(f.base.preparations.size)
    await f.report(107_000)
    held.push(f.base.preparations.size)
    await f.report(108_000)
    held.push(f.base.preparations.size)
    f.controller.dispose()
    await Bun.sleep(0)
    held.push(f.base.preparations.size)
    expect(held).toEqual([2, 4, 4, 2, 0])
  } finally { f.controller.dispose() }
})

test('C9a-3 a refused publish keeps the old sources and their preparations, and a resubmit reuses the candidate preparations it still matches', async () => {
  const f = await c9Fixture({ refusals: 1 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    const afterRefusal = f.base.preparations.size
    await f.report(120_000)
    await f.report(300_000)
    const first = f.sources(f.publishes[1])?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    const second = f.sources(f.publishes[2])?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    expect({ afterRefusal, publishes: f.publishes.length, reusedAfterTheSeam: first?.preparationId === second?.preparationId, held: f.base.preparations.size })
      .toEqual({ afterRefusal: 4, publishes: 3, reusedAfterTheSeam: true, held: 2 })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('C9a-4 the candidate preparations a failed attempt kept are released when the desired state changes', async () => {
  const f = await c9Fixture({ refusals: 1 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    f.state.volume = 0.25
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    const first = f.sources(f.publishes[1])?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    const second = f.sources(f.publishes[2])?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    expect({ reused: first?.preparationId === second?.preparationId, held: f.base.preparations.size }).toEqual({ reused: false, held: 4 })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('C9a-5 the candidate preparations are released when the resubmits run out, and when the session is torn down', async () => {
  const f = await c9Fixture({ refusals: 100 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    const kept = f.base.preparations.size
    await f.report(120_000, 300)
    expect({ kept, publishes: f.publishes.length - 1, faults: f.faults.length, held: f.base.preparations.size }).toEqual({ kept: 4, publishes: 9, faults: 1, held: 2 })
    f.state.refusals = 1
    await f.controller.adoptSchedule(noLoop)
    f.controller.dispose()
    await Bun.sleep(0)
    expect(f.base.preparations.size).toBe(0)
  } finally { warn.mockRestore(); error.mockRestore(); f.controller.dispose() }
})
// AE-08 phase 8 step 9b: audio clip edits are carried at a seam. The sources shipped with the publish are those a start
// at the seam would compile for the edited clips; the session is never disposed or rebuilt.
test('W-C9-clip-1 a clip moved while playing is adopted: its source starts at the new frame and the old start is gone', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.clip1Start = 6
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, prepared: c9Starts(f.sources(f.publishes.at(-1))?.prepared), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', prepared: [['audio-0', 108_000, 108_000], ['audio-1', 288_000, 0]], disposed: false })
  } finally { f.controller.dispose() }
})

test('W-C9-clip-2 a trim of a clip that spans the seam starts its new source at the seam with the in-clip offset and its fraction', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.clip0Offset = 2 + 0.5 / 48_000
    const result = await f.controller.adoptSchedule(noLoop)
    const spanning = f.sources(f.publishes.at(-1))?.prepared.find((event) => event.sourceNodeId === 'audio-0')
    expect({ result, start: spanning?.startFrame, offset: spanning?.sourceOffsetFrame, fraction: spanning?.sourceOffsetFraction })
      .toEqual({ result: 'adopted', start: 108_000, offset: 204_000, fraction: expect.closeTo(0.5, 6) })
  } finally { f.controller.dispose() }
})

test('W-C9-clip-4 a clip move on a paused session is adopted in place with the seam at the position', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.clip1Start = 6
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, prepared: c9Starts(f.sources(f.publishes.at(-1))?.prepared), disposed: f.calls.includes('dispose'),
      publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame') })
      .toEqual({ result: 'adopted', prepared: [['audio-0', 0, 0], ['audio-1', 288_000, 0]], disposed: false, publicationFrame: false })
  } finally { f.controller.dispose() }
})

test('W-C9-clip-5 a loop edit with audio clips is adopted with each iteration sliced from the shifted loop', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(12_000)
    const result = await f.controller.adoptSchedule({ loopEnabled: true, loopStartSec: 0, loopEndSec: 1 })
    const prepared = f.sources(f.publishes.at(-1))?.prepared ?? []
    expect({ result, audio0: c9Starts(prepared.filter((event) => event.sourceNodeId === 'audio-0')).slice(0, 3),
      audio1: prepared.filter((event) => event.sourceNodeId === 'audio-1').length, disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', audio0: [['audio-0', 24_000, 24_000], ['audio-0', 48_000, 0], ['audio-0', 96_000, 0]], audio1: 0, disposed: false })
  } finally { f.controller.dispose() }
})

test('W-C9-clip-7 a clip deleted while playing leaves no source behind', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    f.state.clip1Present = false
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, prepared: c9Starts(f.sources(f.publishes.at(-1))?.prepared) }).toEqual({ result: 'adopted', prepared: [['audio-0', 108_000, 108_000]] })
  } finally { f.controller.dispose() }
})

// Recording decision: an audio clip edit made during a take is adopted like any other edit; only a loop edit is held. The
// refresh that extends the take's sources starts from the adopted state, so the moved clip is scheduled once, where it is.
test('W-C9-clip-R an audio clip move during a take is adopted and the take refresh schedules the moved clip once', async () => {
  const calls: string[] = []
  const { stream, recordingContext } = createRecordingFixture(calls)
  const f = await w8Fixture({ clipSec: 30, audioStartSec: 28 }, { audioContext: recordingContext })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.controller.startRecording(b6f5RecordingInput(stream))
    f.position(20_000, 1, 1)
    f.state.audioStartSec = 29
    const adopted = await f.adopt(f.noLoop)
    f.position(1_250_000, 1, 2)
    const tables = f.scheduledSources.length
    const refresh = await f.controller.refreshSchedule()
    const table = f.scheduledSources.at(-1) ?? []
    expect({ adopted, refresh, extended: f.scheduledSources.length > tables, faults: f.faults, held: table.filter((source) => source.startFrame === 1_344_000).length,
      moved: table.filter((source) => source.startFrame === 1_392_000).length, recording: f.controller.isRecording() })
      .toEqual({ adopted: 'adopted', refresh: 'started', extended: true, faults: [], held: 0, moved: 1, recording: true })
  } finally { f.controller.dispose() }
})

// AE-08 phase 8 step 9c: asset swaps are carried at a seam. The new asset is registered and paged before the publish; the
// old one is released only once the position has reached the seam, and again later while the core still reads it.
const c9Registered = (calls: readonly string[]) => calls.filter((call) => call.startsWith('register:'))
const c9Released = (calls: readonly string[]) => calls.filter((call) => call.startsWith('release:'))

test('W-C9-asset-1 a clip asset swapped while playing is registered and paged before the publish; the old one is released once the position reaches the seam', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    const mark = f.calls.length
    f.state.clip1Asset = 'asset-c'
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    const shipped = f.sources(f.publishes.at(-1))?.prepared.find((event) => event.sourceNodeId === 'audio-1')
    const released = [c9Released(adoption)]
    await f.report(107_000)
    released.push(c9Released(f.calls.slice(mark)))
    await f.report(108_000)
    released.push(c9Released(f.calls.slice(mark)))
    const started = f.scheduled[0]?.find((event) => event.sourceNodeId === 'audio-1')
    expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), newRange: shipped?.preparationId !== started?.preparationId,
      paged: [...f.base.writtenPages].some((page) => page.startsWith('asset-c:')), released, disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', order: ['register:asset-c', 'publish'], newRange: true, paged: true, released: [[], [], ['release:asset-b']], disposed: false })
  } finally { f.controller.dispose() }
})

test('W-C9-asset-2 a release answered asset-in-use is asked again at the next position report until the core lets go', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    const mark = f.calls.length
    f.state.inUse.add('asset-b')
    f.state.clip1Asset = 'asset-c'
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    await f.report(108_000)
    await f.report(109_000)
    f.state.inUse.clear()
    await f.report(110_000)
    await f.report(111_000)
    expect(c9Released(f.calls.slice(mark))).toEqual(['release:asset-b', 'release:asset-b', 'release:asset-b'])
  } finally { f.controller.dispose() }
})

test('W-C9-asset-3 a refused publish keeps the registered asset for the resubmit, which registers nothing again', async () => {
  const f = await c9Fixture({ refusals: 1 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    const mark = f.calls.length
    f.state.clip1Asset = 'asset-c'
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    const afterRefusal = { registered: c9Registered(f.calls.slice(mark)), released: c9Released(f.calls.slice(mark)) }
    await f.report(120_000)
    await f.report(300_000)
    expect({ afterRefusal, registered: c9Registered(f.calls.slice(mark)), released: c9Released(f.calls.slice(mark)), publishes: f.publishes.length })
      .toEqual({ afterRefusal: { registered: ['register:asset-c'], released: [] }, registered: ['register:asset-c'], released: ['release:asset-b'], publishes: 3 })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('W-C9-asset-4 the asset a failed attempt registered is released when the desired state changes, when the resubmits run out, and at teardown', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const changed = await c9Fixture({ refusals: 1 })
    expect(await changed.controller.start(changed.transport)).toBe('started')
    await changed.report(96_000)
    const mark = changed.calls.length
    changed.state.clip1Asset = 'asset-c'
    expect(await changed.controller.adoptSchedule(noLoop)).toBe('failed')
    changed.state.clip1Asset = 'asset-d'
    expect(await changed.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ registered: c9Registered(changed.calls.slice(mark)), released: c9Released(changed.calls.slice(mark)) })
      .toEqual({ registered: ['register:asset-c', 'register:asset-d'], released: ['release:asset-c'] })
    changed.controller.dispose()

    const exhausted = await c9Fixture({ refusals: 100 })
    expect(await exhausted.controller.start(exhausted.transport)).toBe('started')
    await exhausted.report(96_000)
    exhausted.state.clip1Asset = 'asset-c'
    expect(await exhausted.controller.adoptSchedule(noLoop)).toBe('failed')
    expect(c9Released(exhausted.calls)).toEqual([])
    await exhausted.report(120_000, 300)
    expect({ faults: exhausted.faults.length, released: c9Released(exhausted.calls) }).toEqual({ faults: 1, released: ['release:asset-c'] })
    exhausted.controller.dispose()

    const torndown = await c9Fixture({ refusals: 100 })
    expect(await torndown.controller.start(torndown.transport)).toBe('started')
    await torndown.report(96_000)
    torndown.state.clip1Asset = 'asset-c'
    expect(await torndown.controller.adoptSchedule(noLoop)).toBe('failed')
    torndown.controller.dispose()
    await Bun.sleep(0)
    expect(c9Released(torndown.calls)).toEqual(['release:asset-c'])
  } finally { warn.mockRestore(); error.mockRestore() }
})

test('W-C9-asset-5 a clip asset swap on a paused session is adopted in place and releases the old asset at once', async () => {
  const f = await c9Fixture()
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    const mark = f.calls.length
    f.state.clip1Asset = 'asset-c'
    const result = await f.controller.adoptSchedule(noLoop)
    await Bun.sleep(0)
    const adoption = f.calls.slice(mark)
    expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:') || call.startsWith('release:')), disposed: adoption.includes('dispose') })
      .toEqual({ result: 'adopted', order: ['register:asset-c', 'publish', 'release:asset-b'], disposed: false })
  } finally { f.controller.dispose() }
})

// A Drum Rack whose first pad (note 36) plays `padAsset`, held by one long note.
type D9State = { padAsset: string; volume: number }
const d9Source = { durationSec: 1, sampleRate: 48_000, channelCount: 1 }
const d9Track: RuntimeTrack = { ...track, clips: track.clips.map((clip) => ({ ...clip, duration: 8,
  midi: clip.midi && { ...clip.midi, notes: [{ id: 'held', beat: 0, length: 8, pitch: 36, velocity: 0.8 }] } })) }
const d9Fixture = async () => {
  const state: D9State = { padAsset: 'drum-a', volume: 1 }
  const calls: string[] = []
  const installs: PortableFrameSchedule[] = []
  const faults: string[] = []
  const base = createSession(calls, async (schedule) => { installs.push(schedule) })
  const session = {
    ...base,
    prepareGraph: async () => { calls.push('prepare-graph') },
    publishGraph: async (_revision: number, options?: Parameters<PortableWasmPlaybackSession['publishGraph']>[1]) => { if (options) calls.push('publish') },
    registerAsset: async (asset: { assetId: string }) => {
      calls.push(`register:${asset.assetId}`)
      return { status: 'registered' as const, handle: { slot: 0, generation: 1 } }
    },
    releaseAsset: async (assetId: string) => {
      calls.push(`release:${assetId}`)
      return { status: 'released' as const }
    },
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const base = compilation()
      const params = createDefaultDrumRackParams()
      const instrument: TrackInstrumentParams = { kind: 'drum-rack', instanceId: 'drums:1', params: { ...params, pads: params.pads.map((pad, index) => index === 0
        ? { ...pad, sample: { assetKey: state.padAsset, url: `local-asset:${state.padAsset}`, sourceKind: 'upload' as const, source: d9Source } } : pad) } }
      const tracks = [{ ...d9Track, volume: state.volume }]
      const fx = { ...base.snapshot.mixer.fx, trackFx: { synth: { instances: [], instrument } } }
      return { ...base, snapshot: { ...base.snapshot, transport, tracks, assets: [{ assetId: state.padAsset, source: d9Source, buffer: new TestAudioBuffer() }],
        mixer: { ...base.snapshot.mixer, fx, graph: resolveLiveMixerGraph(tracks, fx.trackFx) } } }
    },
    fingerprintSnapshot: b6f5Fingerprint, getAudioContext: () => context, select: async () => selected,
    reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => session },
  })
  const transport = compilation().snapshot.transport
  let reports = 0
  const report = async (frame: number) => { reports += 1; base.emitPosition(frame, reports); await Bun.sleep(0) }
  const events = (type: 'note-on' | 'note-off') => (installs.at(-1)?.events ?? []).flatMap((event) => event.type === type ? [event.frame] : [])
  return { state, controller, transport, calls, installs, faults, report, events }
}

test('W-C9-asset-6 a Drum Rack pad sample swapped while a note is held registers the asset before the publish and is adopted without a rebuild', async () => {
  const f = await d9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    const mark = f.calls.length
    f.state.padAsset = 'drum-b'
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), disposed: adoption.includes('dispose') })
      .toEqual({ result: 'adopted', order: ['register:drum-b', 'publish'], disposed: false })
    await f.report(60_000)
    expect(c9Released(f.calls)).toEqual(['release:drum-a'])
  } finally { f.controller.dispose() }
})

// M-D and D-5: the core replaces an instrument whose samples changed, so a note held across the seam is released on the old
// voice and its note-on starts the new one; an instrument that is the same keeps its voice, as native does.
test('W-C9-keeps-1 a held note of an instrument whose sample changed is released at the seam and started again there', async () => {
  const f = await d9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.padAsset = 'drum-b'
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ noteOffs: f.events('note-off').slice(0, 1), noteOns: f.events('note-on') }).toEqual({ noteOffs: [60_000], noteOns: [60_000] })
  } finally { f.controller.dispose() }
})

test('W-C9-keeps-2 a held note of an instrument that did not change keeps its voice through an edit elsewhere', async () => {
  const f = await d9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.volume = 0.5
    expect(await f.controller.adoptSchedule(noLoop)).toBe('adopted')
    expect({ noteOns: f.events('note-on'), noteOffs: f.events('note-off') }).toEqual({ noteOns: [], noteOffs: [192_000] })
  } finally { f.controller.dispose() }
})

// AE-08 phase 8 step 9d: warped audio is carried at a seam (class 2). A Stretch clip's artifact depends on the tempo and on
// the clip's placement and warp, so the candidate's artifacts are prepared, leased and registered before the publish, and
// the session's own are released once the position has reached the seam.
const c9Artifacts = (calls: readonly string[]) => c9Registered(calls).filter((call) => call !== 'register:asset-a' && call !== 'register:asset-b')
// Stretch renders the clip for real, so the clip is short.
const c9WarpFixture = (options: { refusals?: number; clip1Warp?: C9Warp } = {}) => c9Fixture({ clip1Duration: 1, ...options })
const c9Settled = async (done: () => boolean) => { for (let turn = 0; turn < 500 && !done(); turn += 1) await Bun.sleep(0) }
const c9Phases = (calls: readonly string[]) => calls.filter((call) => call === 'publish' || call.startsWith('register:')).map((call) => call.split(':')[0])

test('W-C9-warp-1 a tempo edit with a Stretch clip prepares its artifact at the new tempo before the publish and releases the old leases after the seam', async () => {
  const f = await c9WarpFixture({ clip1Warp: c9Stretch })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const [oldArtifact] = c9Artifacts(f.calls)
    await f.report(96_000)
    const mark = f.calls.length
    f.state.bpm = 100
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    const [newArtifact] = c9Artifacts(adoption)
    const leases = [[f.stretch.leased, f.stretch.released]]
    const released = [c9Released(adoption)]
    await f.report(107_000)
    leases.push([f.stretch.leased, f.stretch.released])
    released.push(c9Released(f.calls.slice(mark)))
    await f.report(108_000)
    await c9Settled(() => f.stretch.released === 1)
    leases.push([f.stretch.leased, f.stretch.released])
    released.push(c9Released(f.calls.slice(mark)))
    const shipped = f.sources(f.publishes.at(-1))?.prepared
    expect({ result, order: c9Phases(adoption), fresh: newArtifact !== undefined && newArtifact !== oldArtifact,
      paged: [...f.base.writtenPages].some((page) => page.startsWith(`${newArtifact?.slice('register:'.length)}:`)),
      unwarped: c9Starts(shipped).find((start) => start[0] === 'audio-0'), leases, released, disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', order: ['register', 'publish'], fresh: true, paged: true, unwarped: ['audio-0', 108_000, 108_000],
        leases: [[2, 0], [2, 0], [2, 1]], released: [[], [], [`release:${oldArtifact?.slice('register:'.length)}`]], disposed: false })
  } finally { f.controller.dispose() }
})

// The seam is chosen after the preparation, so a slow Stretch does not spend the lead; what a late publish costs is the
// attempt after it. Its candidate keeps the artifact, so the resubmit leases and registers nothing again (D-4).
test('W-C9-warp-2 a publish that answers late is retried on the Stretch artifact the first attempt prepared, which nothing prepares again', async () => {
  const f = await c9WarpFixture({ clip1Warp: c9Stretch, refusals: 1 })
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(96_000)
    const mark = f.calls.length
    f.state.bpm = 100
    expect(await f.controller.adoptSchedule(noLoop)).toBe('failed')
    const afterRefusal = { leased: f.stretch.leased, registered: c9Artifacts(f.calls.slice(mark)).length, released: f.stretch.released }
    await f.report(120_000)
    await c9Settled(() => f.publishes.length === 3)
    await f.report(300_000)
    await c9Settled(() => f.stretch.released === 1)
    expect({ afterRefusal, leased: f.stretch.leased, released: f.stretch.released, registered: c9Artifacts(f.calls.slice(mark)).length, publishes: f.publishes.length, faults: f.faults })
      .toEqual({ afterRefusal: { leased: 2, registered: 1, released: 0 }, leased: 2, released: 1, registered: 1, publishes: 3, faults: [] })
  } finally { warn.mockRestore(); f.controller.dispose() }
})

test('W-C9-warp-3 a warp marker edit is adopted on a new artifact registered before the publish', async () => {
  const f = await c9WarpFixture({ clip1Warp: c9Stretch })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const [oldArtifact] = c9Artifacts(f.calls)
    await f.report(96_000)
    const mark = f.calls.length
    f.state.clip1Warp = { ...c9Stretch, markers: [{ id: 'start', sourceBeat: 0, timelineBeat: 0 }, { id: 'stretched', sourceBeat: 2, timelineBeat: 3 }] }
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    expect({ result, order: c9Phases(adoption), fresh: c9Artifacts(adoption)[0] !== oldArtifact, disposed: adoption.includes('dispose') })
      .toEqual({ result: 'adopted', order: ['register', 'publish'], fresh: true, disposed: false })
  } finally { f.controller.dispose() }
})

test('W-C9-warp-4 warp turned on or off while playing swaps the ordinary asset and the Stretch artifact at the seam', async () => {
  const on = await c9WarpFixture()
  try {
    expect(await on.controller.start(on.transport)).toBe('started')
    await on.report(96_000)
    const mark = on.calls.length
    on.state.clip1Warp = c9Stretch
    const result = await on.controller.adoptSchedule(noLoop)
    await on.report(108_000)
    expect({ result, order: c9Phases(on.calls.slice(mark)), leased: on.stretch.leased, ordinaryReleased: c9Released(on.calls.slice(mark)) })
      .toEqual({ result: 'adopted', order: ['register', 'publish'], leased: 1, ordinaryReleased: ['release:asset-b'] })
  } finally { on.controller.dispose() }
  const off = await c9WarpFixture({ clip1Warp: c9Stretch })
  try {
    expect(await off.controller.start(off.transport)).toBe('started')
    const [artifact] = c9Artifacts(off.calls)
    await off.report(96_000)
    const mark = off.calls.length
    off.state.clip1Warp = undefined
    const result = await off.controller.adoptSchedule(noLoop)
    await off.report(108_000)
    await c9Settled(() => off.stretch.released === 1)
    expect({ result, registered: c9Registered(off.calls.slice(mark)), released: [off.stretch.released, c9Released(off.calls.slice(mark))] })
      .toEqual({ result: 'adopted', registered: ['register:asset-b'], released: [1, [`release:${artifact?.slice('register:'.length)}`]] })
  } finally { off.controller.dispose() }
})

test('W-C9-warp-5 a tempo edit on a paused session with a Stretch clip is adopted in place and releases the old artifact at once', async () => {
  const f = await c9WarpFixture({ clip1Warp: c9Stretch })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    const mark = f.calls.length
    f.state.bpm = 100
    const result = await f.controller.adoptSchedule(noLoop)
    await c9Settled(() => f.stretch.released === 1)
    const adoption = f.calls.slice(mark)
    expect({ result, order: c9Phases(adoption), leases: [f.stretch.leased, f.stretch.released], disposed: adoption.includes('dispose'),
      publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame') })
      .toEqual({ result: 'adopted', order: ['register', 'publish'], leases: [2, 1], disposed: false, publicationFrame: false })
  } finally { f.controller.dispose() }
})

test('W-C9-warp-6 the Stretch artifact a failed attempt kept is released when the desired state changes, when the resubmits run out, and at teardown', async () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const changed = await c9WarpFixture({ clip1Warp: c9Stretch, refusals: 1 })
    expect(await changed.controller.start(changed.transport)).toBe('started')
    await changed.report(96_000)
    changed.state.bpm = 100
    expect(await changed.controller.adoptSchedule(noLoop)).toBe('failed')
    expect([changed.stretch.leased, changed.stretch.released]).toEqual([2, 0])
    changed.state.bpm = 90
    expect(await changed.controller.adoptSchedule(noLoop)).toBe('adopted')
    await c9Settled(() => changed.stretch.released === 1)
    expect([changed.stretch.leased, changed.stretch.released]).toEqual([3, 1])
    changed.controller.dispose()

    const exhausted = await c9WarpFixture({ clip1Warp: c9Stretch, refusals: 100 })
    expect(await exhausted.controller.start(exhausted.transport)).toBe('started')
    await exhausted.report(96_000)
    exhausted.state.bpm = 100
    expect(await exhausted.controller.adoptSchedule(noLoop)).toBe('failed')
    await exhausted.report(120_000, 300)
    await c9Settled(() => exhausted.stretch.released === 1)
    expect({ faults: exhausted.faults.length, leased: exhausted.stretch.leased, released: exhausted.stretch.released }).toEqual({ faults: 1, leased: 2, released: 1 })
    exhausted.controller.dispose()

    const torndown = await c9WarpFixture({ clip1Warp: c9Stretch, refusals: 100 })
    expect(await torndown.controller.start(torndown.transport)).toBe('started')
    await torndown.report(96_000)
    torndown.state.bpm = 100
    expect(await torndown.controller.adoptSchedule(noLoop)).toBe('failed')
    torndown.controller.dispose()
    await c9Settled(() => torndown.stretch.released === 2)
    expect([torndown.stretch.leased, torndown.stretch.released]).toEqual([2, 2])
  } finally { warn.mockRestore(); error.mockRestore() }
})

// AE-08 phase 8 step 9e: a track added or deleted is carried at a seam (class 3). A track's place among the others sounds
// like nothing, so a reorder is the session's own graph again. A deleted track's held notes and sources end with the
// core's 5 ms ghost fade (D-3): a note-off for its node would reject the whole staged schedule. A track that moves
// another route's delay is carried too (9h): the core moves the read heads.
const e9Source = { durationSec: pagedAssetFrameCount / 48_000, sampleRate: 48_000, channelCount: 1 }
const e9Midi = (id: string): RuntimeTrack => ({ ...track, id, name: id, clips: track.clips.map((clip) => ({ ...clip, id: `${id}-clip`, duration: 8,
  midi: clip.midi && { ...clip.midi, notes: [{ id: `${id}-held`, beat: 0, length: 8, pitch: 60, velocity: 0.8 }] } })) })
const e9Audio = (id: string, assetId: string): RuntimeTrack => ({ id, kind: 'audio', name: id, volume: 1,
  clips: [{ id: `${id}-clip`, name: id, color: '#fff', startSec: 0, duration: 30, sourceAssetKey: assetId }] })
// `instruments` replaces the Synth a MIDI track gets by default.
type E9State = {
  tracks: readonly RuntimeTrack[]; effects: readonly AudioEffectRuntimeInstance[]; refusals: number
  instruments: Readonly<Record<string, TrackInstrumentParams>>
}
const e9Zone = (assetKey: string): SamplerZone => ({
  id: 'zone', keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 60, tuneCents: 0, gain: 1, pan: 0,
  roundRobinGroup: 0, roundRobinIndex: 0, playbackMode: 'one-shot', startSec: 0, crossfadeSec: 0, chokeGroup: 0,
  sample: { assetKey, url: `local-asset:${assetKey}`, sourceKind: 'upload', source: d9Source },
})
const e9Granular = (instanceId: string, assetKey: string): TrackInstrumentParams => ({ kind: 'granular', instanceId, params: { ...createDefaultGranularParams(), zone: e9Zone(assetKey) } })
const e9Sampler = (instanceId: string, assetKey: string): TrackInstrumentParams => ({ kind: 'sampler', instanceId, params: { ...createDefaultSamplerParams(), zones: [e9Zone(assetKey)] } })
const e9Fixture = async (options: { tracks?: readonly RuntimeTrack[]; compressed?: boolean; effects?: readonly AudioEffectRuntimeInstance[];
  instruments?: E9State['instruments'] } = {}) => {
  const state: E9State = { tracks: options.tracks ?? [e9Midi('midi-a'), e9Audio('audio-a', 'asset-a')], instruments: options.instruments ?? {},
    effects: options.effects ?? (options.compressed ? [{ id: 'compressor-a', kind: 'compressor', params: createDefaultCompressorParams() }] : []), refusals: 0 }
  const calls: string[] = []
  const installs: PortableFrameSchedule[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: C9Publish[] = []
  const faults: string[] = []
  const base = createSession(calls, async (schedule) => { installs.push(schedule) }, undefined, true)
  const session = {
    ...base,
    prepareGraph: async (graph: AudioCoreGraphSnapshot) => { calls.push('prepare-graph'); graphs.push(graph) },
    publishGraph: async (revision: number, publishOptions?: C9Publish['options']) => {
      publishes.push({ revision, options: publishOptions })
      if (publishOptions) calls.push('publish')
      if (publishOptions && state.refusals-- > 0) throw new Error('Portable playback graph-published was rejected.')
    },
    registerAsset: async (asset: { assetId: string }) => {
      calls.push(`register:${asset.assetId}`)
      return { status: 'registered' as const, handle: { slot: 0, generation: 1 } }
    },
    registerPagedAsset: async (asset: { assetId: string }) => {
      calls.push(`register:${asset.assetId}`)
      return { status: 'registered' as const, handle: { slot: 0, generation: 1 } }
    },
    releaseAsset: async (assetId: string) => {
      calls.push(`release:${assetId}`)
      return { status: 'released' as const }
    },
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => {
      const compiled = pagedCompilation(transport)
      const trackFx = Object.fromEntries(state.tracks.flatMap((entry) => entry.kind === 'instrument'
        ? [[entry.id, { instances: [], instrument: state.instruments[entry.id] ?? { kind: 'synth' as const, instanceId: `synth:${entry.id}`, params: createDefaultSynthParams() } }]]
        : entry.id === 'audio-a' && state.effects.length > 0 ? [[entry.id, { instances: [...state.effects] }]] : []))
      const assetIds = new Set(state.tracks.flatMap((entry) => entry.clips.flatMap((clip) => clip.sourceAssetKey ?? [])))
      const sampleKeys = state.tracks.flatMap((entry) => {
        const instrument = state.instruments[entry.id]
        return instrument?.kind === 'sampler' ? instrument.params.zones.map((zone) => zone.sample.assetKey)
          : instrument?.kind === 'granular' && instrument.params.zone ? [instrument.params.zone.sample.assetKey] : []
      })
      const assets = [...[...assetIds].map((assetId) => ({ assetId, source: e9Source })),
        ...sampleKeys.map((assetId) => ({ assetId, source: d9Source, buffer: new TestAudioBuffer() }))]
      return { ...compiled, snapshot: { ...compiled.snapshot, tracks: state.tracks, assets,
        mixer: { ...compiled.snapshot.mixer, fx: { ...compiled.snapshot.mixer.fx, trackFx }, graph: resolveLiveMixerGraph(state.tracks, trackFx) } } }
    },
    fingerprintSnapshot: b6f5Fingerprint, getAudioContext: () => context, scheduleHorizonSec: 8, select: async () => selected,
    reportFault: (message) => faults.push(message),
    resolveSource: async (clip) => pagedDescriptor(clip.sourceAssetKey ?? 'missing', []),
    backend: { createPlaybackSession: async () => session },
  })
  const transport = pagedCompilation().snapshot.transport
  let reports = 0
  const report = async (frame: number) => { reports += 1; base.emitPosition(frame, reports); await Bun.sleep(0) }
  const shipped = () => c9Starts(publishes.at(-1)?.options?.sources?.prepared)
  const nodes = () => (graphs.at(-1)?.nodes ?? []).flatMap((node) => node.id === '$master' ? [] : [node.id])
  const notes = (type: 'note-on' | 'note-off') => (installs.at(-1)?.events ?? []).flatMap((event) => event.type === type ? [[event.target.trackId, event.frame]] : [])
    .toSorted((left, right) => String(left).localeCompare(String(right)))
  const published = () => publishes.filter((publish) => publish.options).length
  return { state, controller, transport, calls, graphs, publishes, installs, faults, report, shipped, nodes, notes, published }
}

test('W-C9-track-1 an audio track added while playing is adopted: its node is published, its asset registered first, its clip starts at the seam', async () => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    const mark = f.calls.length
    f.state.tracks = [...f.state.tracks, e9Audio('audio-b', 'asset-b')]
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    expect({ result, nodes: f.nodes(), order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), disposed: adoption.includes('dispose'),
      shipped: f.shipped(), noteOns: f.notes('note-on'), noteOffs: f.notes('note-off') })
      .toEqual({ result: 'adopted', nodes: ['midi-a', 'audio-a', 'audio-b'], order: ['register:asset-b', 'publish'], disposed: false,
        shipped: [['audio-a', 60_000, 60_000], ['audio-b', 60_000, 60_000]], noteOns: [], noteOffs: [['midi-a', 192_000]] })
  } finally { f.controller.dispose() }
})

test('W-C9-track-2 a MIDI track added while playing is adopted: its note that spans the seam starts there and the held note elsewhere keeps its voice', async () => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.tracks = [...f.state.tracks, e9Midi('midi-b')]
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, nodes: f.nodes(), disposed: f.calls.includes('dispose'), noteOns: f.notes('note-on'), noteOffs: f.notes('note-off') })
      .toEqual({ result: 'adopted', nodes: ['midi-a', 'audio-a', 'midi-b'], disposed: false, noteOns: [['midi-b', 60_000]],
        noteOffs: [['midi-a', 192_000], ['midi-b', 192_000]] })
  } finally { f.controller.dispose() }
})

test('W-C9-track-3 an audio track deleted while playing leaves no source or node, and its asset is released once the position reaches the seam', async () => {
  const f = await e9Fixture({ tracks: [e9Midi('midi-a'), e9Audio('audio-a', 'asset-a'), e9Audio('audio-b', 'asset-b')] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.tracks = f.state.tracks.filter((entry) => entry.id !== 'audio-b')
    const result = await f.controller.adoptSchedule(noLoop)
    const before = c9Released(f.calls)
    await f.report(59_999)
    const early = c9Released(f.calls)
    await f.report(60_000)
    expect({ result, nodes: f.nodes(), shipped: f.shipped(), disposed: f.calls.includes('dispose'), released: [before, early, c9Released(f.calls)] })
      .toEqual({ result: 'adopted', nodes: ['midi-a', 'audio-a'], shipped: [['audio-a', 60_000, 60_000]], disposed: false, released: [[], [], ['release:asset-b']] })
  } finally { f.controller.dispose() }
})

test('W-C9-track-4 the held note of a deleted MIDI track gets no note-off: its node is not in the candidate and the core ghost ends the voice', async () => {
  const f = await e9Fixture({ tracks: [e9Midi('midi-a'), e9Midi('midi-b'), e9Audio('audio-a', 'asset-a')] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.tracks = f.state.tracks.filter((entry) => entry.id !== 'midi-b')
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, nodes: f.nodes(), disposed: f.calls.includes('dispose'), noteOns: f.notes('note-on'), noteOffs: f.notes('note-off') })
      .toEqual({ result: 'adopted', nodes: ['midi-a', 'audio-a'], disposed: false, noteOns: [], noteOffs: [['midi-a', 192_000]] })
  } finally { f.controller.dispose() }
})

test('W-C9-track-5 a reorder is the session\'s own graph again: unchanged, nothing published, and the next edit keeps the node order', async () => {
  const f = await e9Fixture({ tracks: [e9Midi('midi-a'), e9Audio('audio-a', 'asset-a'), e9Audio('audio-b', 'asset-b')] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    const [midiA, audioA, audioB] = f.state.tracks
    f.state.tracks = [audioB, midiA, audioA]
    const reordered = await f.controller.adoptSchedule(noLoop)
    const published = f.published()
    f.state.tracks = [audioB, midiA, { ...audioA, volume: 0.5 }]
    const edited = await f.controller.adoptSchedule(noLoop)
    expect({ reordered, published, edited, nodes: f.nodes(), disposed: f.calls.includes('dispose') })
      .toEqual({ reordered: 'unchanged', published: 0, edited: 'adopted', nodes: ['midi-a', 'audio-a', 'audio-b'], disposed: false })
  } finally { f.controller.dispose() }
})

test('W-C9-track-6 a track added and then deleted on a paused session is adopted in place with the seam at the position', async () => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.tracks = [...f.state.tracks, e9Audio('audio-b', 'asset-b')]
    const added = await f.controller.adoptSchedule(noLoop)
    const addedState = { nodes: f.nodes(), shipped: f.shipped(), publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame') }
    f.state.tracks = f.state.tracks.filter((entry) => entry.id !== 'audio-b')
    const deleted = await f.controller.adoptSchedule(noLoop)
    expect({ added, addedState, deleted, nodes: f.nodes(), shipped: f.shipped(), released: c9Released(f.calls), disposed: f.calls.includes('dispose') })
      .toEqual({ added: 'adopted', addedState: { nodes: ['midi-a', 'audio-a', 'audio-b'], shipped: [['audio-a', 0, 0], ['audio-b', 0, 0]], publicationFrame: false },
        deleted: 'adopted', nodes: ['midi-a', 'audio-a'], shipped: [['audio-a', 0, 0]], released: ['release:asset-b'], disposed: false })
  } finally { f.controller.dispose() }
})

// A track whose add or delete moves another route's delay is adopted like any other: the core moves the read heads (9h, D-1).
test('W-C9-track-7 a track added or deleted where a latency-bearing effect gives routes a delay is adopted with one publish', async () => {
  const added = await e9Fixture({ compressed: true })
  const deletedPlain = await e9Fixture({ compressed: true, tracks: [e9Midi('midi-a'), e9Audio('audio-a', 'asset-a'), e9Audio('audio-b', 'asset-b')] })
  const deletedLatent = await e9Fixture({ compressed: true, tracks: [e9Midi('midi-a'), e9Audio('audio-a', 'asset-a'), e9Audio('audio-b', 'asset-b')] })
  try {
    expect(await added.controller.start(added.transport)).toBe('started')
    expect(await deletedPlain.controller.start(deletedPlain.transport)).toBe('started')
    expect(await deletedLatent.controller.start(deletedLatent.transport)).toBe('started')
    added.state.tracks = [...added.state.tracks, e9Audio('audio-b', 'asset-b')]
    deletedPlain.state.tracks = deletedPlain.state.tracks.filter((entry) => entry.id !== 'audio-b')
    deletedLatent.state.tracks = deletedLatent.state.tracks.filter((entry) => entry.id !== 'audio-a')
    expect({ added: await added.controller.adoptSchedule(noLoop), deletedPlain: await deletedPlain.controller.adoptSchedule(noLoop),
      deletedLatent: await deletedLatent.controller.adoptSchedule(noLoop), published: [added, deletedPlain, deletedLatent].map((f) => f.published()) })
      .toEqual({ added: 'adopted', deletedPlain: 'adopted', deletedLatent: 'adopted', published: [1, 1, 1] })
  } finally { added.controller.dispose(); deletedPlain.controller.dispose(); deletedLatent.controller.dispose() }
})

// AE-08 phase 8 step 9f: effects inserted, removed, replaced and reordered on a track the session plays are carried at a
// seam (class 4a). The core keeps a survivor's history by instance id, fades a removed effect over its 5 ms ghost (D-3),
// dips a node whose stages were reordered and, as 9h adds, moves the read heads where an effect changes the node's delay.
const f9Utility = (id: string): AudioEffectRuntimeInstance => ({ id, kind: 'utility', params: { version: 1, state: createDefaultUtilityParams() } })
const f9Delay = (id: string): AudioEffectRuntimeInstance => ({ id, kind: 'delay', params: createDefaultDelayParams() })
const f9Limiter = (id: string): AudioEffectRuntimeInstance => ({ id, kind: 'limiter', params: { version: 1, state: createDefaultLimiterParams() } })
const f9Compressor = (id: string): AudioEffectRuntimeInstance => ({ id, kind: 'compressor', params: createDefaultCompressorParams() })
const f9Chain = (f: Awaited<ReturnType<typeof e9Fixture>>) => f.graphs.at(-1)?.nodes.find((node) => node.id === 'audio-a')?.processorOrder.map((processor) => processor.id)
const f9Edits: ReadonlyArray<readonly [string, readonly AudioEffectRuntimeInstance[], readonly AudioEffectRuntimeInstance[], string[]]> = [
  ['inserted', [], [f9Utility('util-a')], ['util-a']],
  ['inserted beside a delaying effect it keeps', [f9Limiter('limiter-a')], [f9Limiter('limiter-a'), f9Utility('util-a')], ['limiter-a', 'util-a']],
  ['removed', [f9Utility('util-a'), f9Delay('delay-a')], [f9Delay('delay-a')], ['delay-a']],
  ['moved', [f9Utility('util-a'), f9Delay('delay-a')], [f9Delay('delay-a'), f9Utility('util-a')], ['delay-a', 'util-a']],
  ['replaced', [f9Utility('util-a')], [f9Delay('delay-b')], ['delay-b']],
]

test.each(f9Edits)('W-C9-fx-1 an effect %s while playing is adopted in place: one publish, nothing disposed, the new chain', async (_name, before, after, chain) => {
  const f = await e9Fixture({ effects: before })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.effects = after
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, chain: f9Chain(f), published: f.published(), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', chain, published: 1, disposed: false })
  } finally { f.controller.dispose() }
})

test.each(f9Edits)('W-C9-fx-1p an effect %s on a paused session is adopted in place with the seam at the position', async (_name, before, after, chain) => {
  const f = await e9Fixture({ effects: before })
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    f.state.effects = after
    const result = await f.controller.adoptSchedule(noLoop)
    expect({ result, chain: f9Chain(f), published: f.published(), publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame'), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', chain, published: 1, publicationFrame: false, disposed: false })
  } finally { f.controller.dispose() }
})

// An effect that delays the signal is carried like any other (9h, D-1): the core moves the node's read heads.
test('W-C9-fx-4 an effect that delays the signal inserted, removed, replaced or moved is adopted with one publish', async () => {
  const cases: ReadonlyArray<readonly [readonly AudioEffectRuntimeInstance[], readonly AudioEffectRuntimeInstance[]]> = [
    [[], [f9Limiter('limiter-a')]],
    [[f9Limiter('limiter-a')], []],
    [[f9Utility('util-a')], [f9Limiter('limiter-b')]],
    [[f9Limiter('limiter-a')], [f9Limiter('limiter-b')]],
    [[f9Limiter('limiter-a'), f9Compressor('compressor-a')], [f9Compressor('compressor-a'), f9Limiter('limiter-a')]],
  ]
  const results: { result: PortableAdoptionResult; published: number }[] = []
  for (const tracks of [undefined, [e9Audio('audio-a', 'asset-a')]]) for (const [before, after] of cases) {
    const f = await e9Fixture({ tracks, effects: before })
    try {
      expect(await f.controller.start(f.transport)).toBe('started')
      await f.report(48_000)
      f.state.effects = after
      results.push({ result: await f.controller.adoptSchedule(noLoop), published: f.published() })
    } finally { f.controller.dispose() }
  }
  expect(results).toEqual(Array.from({ length: 2 * cases.length }, () => ({ result: 'adopted', published: 1 })))
})

// A removal the core cannot ghost because earlier ghosts are still fading is refused at its prepare (CORE:7958-7960).
// The retry waits one rendered-frame report, which is at least 2400 frames at 48 kHz against a 240 frame ghost
// (WK:2462, CORE:7806), so it meets free ghosts and converges: WHT W-C9-fx-7 pins the core side.
test('W-C9-fx-6 a removal refused by ghost capacity is retried after one position report and adopted', async () => {
  const f = await e9Fixture({ effects: [f9Utility('util-a'), f9Delay('delay-a')] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.refusals = 1
    f.state.effects = []
    const first = await f.controller.adoptSchedule(noLoop)
    expect({ first, published: f.published(), chain: f9Chain(f) }).toEqual({ first: 'failed', published: 1, chain: [] })
    await f.report(60_000)
    await c9Settled(() => f.published() === 2)
    expect({ published: f.published(), chain: f9Chain(f), faults: f.faults, disposed: f.calls.includes('dispose') })
      .toEqual({ published: 2, chain: [], faults: [], disposed: false })
  } finally { f.controller.dispose() }
})

// AE-08 phase 8 step 9g: an instrument replaced (another kind or another instance), a processor parameter the live path
// does not take, and a Granular sample are carried at a seam (class 5). The core keeps the replaced node's slot rendering
// while it crossfades out; the held note is released on it by the note-off at the seam and the spanning note-on starts the
// new instrument (D-5, NS:1227-1235). A parameter that changes an effect's latency (a spectral fftSize) is carried the same way.
const g9Replacements: ReadonlyArray<readonly [string, TrackInstrumentParams, string[]]> = [
  ['kind', e9Sampler('sampler:midi-a', 'smp-a'), ['register:smp-a', 'publish']],
  ['instance', { kind: 'synth', instanceId: 'synth:replacement', params: createDefaultSynthParams() }, ['publish']],
]
test.each(g9Replacements)('W-C9-inst-1 a %s replacement of the instrument while a note is held is adopted: released on the old voice at the seam, started on the new instrument', async (_name, replacement, order) => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    const mark = f.calls.length
    f.state.instruments = { 'midi-a': replacement }
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), disposed: adoption.includes('dispose'),
      noteOns: f.notes('note-on'), noteOffs: f.notes('note-off') })
      .toEqual({ result: 'adopted', order, disposed: false, noteOns: [['midi-a', 60_000]], noteOffs: [['midi-a', 192_000], ['midi-a', 60_000]] })
  } finally { f.controller.dispose() }
})

test.each(g9Replacements)('W-C9-inst-1p a %s replacement of the instrument on a paused session is adopted in place with the seam at the position', async (_name, replacement, order) => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
    const mark = f.calls.length
    f.state.instruments = { 'midi-a': replacement }
    const result = await f.controller.adoptSchedule(noLoop)
    const adoption = f.calls.slice(mark)
    expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), published: f.published(),
      publicationFrame: JSON.stringify(f.publishes.at(-1)?.options).includes('publicationFrame'), disposed: adoption.includes('dispose') })
      .toEqual({ result: 'adopted', order, published: 1, publicationFrame: false, disposed: false })
  } finally { f.controller.dispose() }
})

// The core rejects the publish of a replacement when the node already carries 8 unfinished ones (CORE:8297-8305, at the
// instrument configuration the publish runs, WK:1177). Native configures through the same core call, so this is a limit at
// parity; the retry waits one position report, which is longer than the 5 ms blend (WHT W-C9-inst-5).
test('W-C9-inst-6 a replacement refused by blend capacity is retried after one position report and adopted', async () => {
  const f = await e9Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.refusals = 1
    f.state.instruments = { 'midi-a': e9Sampler('sampler:midi-a', 'smp-a') }
    const first = await f.controller.adoptSchedule(noLoop)
    expect({ first, published: f.published() }).toEqual({ first: 'failed', published: 1 })
    await f.report(60_000)
    await c9Settled(() => f.published() === 2)
    expect({ published: f.published(), faults: f.faults, disposed: f.calls.includes('dispose'), registered: c9Registered(f.calls).filter((call) => call === 'register:smp-a') })
      .toEqual({ published: 2, faults: [], disposed: false, registered: ['register:smp-a'] })
  } finally { f.controller.dispose() }
})

const g9Utility = (swap: boolean): AudioEffectRuntimeInstance => ({ id: 'util-a', kind: 'utility', params: { version: 1, state: { ...createDefaultUtilityParams(), swap } } })
const g9Spectral = (fftSize: 512 | 1024): AudioEffectRuntimeInstance => ({ id: 'spectral-a', kind: 'spectral', params: { version: 1, state: { ...createDefaultSpectralParams(), fftSize } } })
const g9State = (f: Awaited<ReturnType<typeof e9Fixture>>) => Array.from(f.graphs.at(-1)?.nodes.find((node) => node.id === 'audio-a')?.processorOrder[0]?.state ?? [])

test('W-C9-proc-1 a processor parameter the live path does not take is adopted in place, playing and paused, with the new state in the published graph', async () => {
  for (const paused of [false, true]) {
    const f = await e9Fixture({ effects: [g9Utility(false)] })
    try {
      if (paused) expect(await f.controller.ensurePrepared({ ...f.transport, state: 'paused' })).toBe('started')
      else { expect(await f.controller.start(f.transport)).toBe('started'); await f.report(48_000) }
      const before = g9State(f)
      f.state.effects = [g9Utility(true)]
      const result = await f.controller.adoptSchedule(noLoop)
      expect({ paused, result, changed: JSON.stringify(g9State(f)) !== JSON.stringify(before), chain: f9Chain(f), published: f.published(), disposed: f.calls.includes('dispose') })
        .toEqual({ paused, result: 'adopted', changed: true, chain: ['util-a'], published: 1, disposed: false })
    } finally { f.controller.dispose() }
  }
})

// The core replaces the stage: the old one fades out as a ghost, a fresh one of the new size starts (WHT W-C9-spectral-1).
test('W-C9-proc-2 a Spectral fftSize change is adopted in place with one publish and the new size in the published graph', async () => {
  const f = await e9Fixture({ effects: [g9Spectral(512)] })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    f.state.effects = [g9Spectral(1024)]
    expect({ result: await f.controller.adoptSchedule(noLoop), published: f.published(), chain: f9Chain(f), disposed: f.calls.includes('dispose') })
      .toEqual({ result: 'adopted', published: 1, chain: ['spectral-a'], disposed: false })
  } finally { f.controller.dispose() }
})

// A Granular cloud is configured from the registry at the publish, like a Sampler zone: its sample registers first, a
// track that carries one is added and deleted like any other, and the old sample is released after the seam.
test('W-C9-asset-7 a Granular sample changed, and a Granular track added and deleted, while playing are adopted with the asset registered before the publish', async () => {
  const f = await e9Fixture({ instruments: { 'midi-a': e9Granular('granular:a', 'grain-a') } })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.report(48_000)
    const steps: Array<readonly [() => void, string[], string[]]> = [
      [() => { f.state.instruments = { 'midi-a': e9Granular('granular:a', 'grain-b') } }, ['register:grain-b', 'publish'], ['release:grain-a']],
      [() => { f.state.tracks = [...f.state.tracks, e9Midi('midi-g')]; f.state.instruments = { 'midi-a': e9Granular('granular:a', 'grain-b'), 'midi-g': e9Granular('granular:g', 'grain-g') } }, ['register:grain-g', 'publish'], []],
      [() => { f.state.tracks = f.state.tracks.filter((entry) => entry.id !== 'midi-g') }, ['publish'], ['release:grain-g']],
    ]
    let frame = 60_000
    for (const [edit, order, released] of steps) {
      const mark = f.calls.length
      const releasedBefore = c9Released(f.calls).length
      edit()
      const result = await f.controller.adoptSchedule(noLoop)
      const adoption = f.calls.slice(mark)
      await f.report(frame)
      frame += 48_000
      expect({ result, order: adoption.filter((call) => call === 'publish' || call.startsWith('register:')), released: c9Released(f.calls).slice(releasedBefore), disposed: f.calls.includes('dispose') })
        .toEqual({ result: 'adopted', order, released, disposed: false })
    }
    expect(f.nodes()).toEqual(['midi-a', 'audio-a'])
  } finally { f.controller.dispose() }
})

// Recording decision: native has no controller-level rule (its adoption path only refuses a seek during a take,
// native-playback-controller.ts:2698). A take's own track, its group and its routes cannot be deleted or rerouted at all:
// the Timeline's recording target lock refuses it before the edit exists (track-recording-target.ts:57-72, 96). Any other
// track add or delete is adopted like any edit, and the take goes on.
test('W-C9-track-R a track added and deleted during a take is adopted and the take goes on', async () => {
  const calls: string[] = []
  const { stream, recordingContext } = createRecordingFixture(calls)
  const f = await w8Fixture({ clipSec: 30 }, { audioContext: recordingContext })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    await f.controller.startRecording(b6f5RecordingInput(stream))
    f.position(20_000, 1, 1)
    f.state.audioStartSec = 28
    const added = await f.adopt(f.noLoop)
    f.position(40_000, 1, 2)
    f.state.audioStartSec = undefined
    const deleted = await f.adopt(f.noLoop)
    expect({ added, deleted, faults: f.faults, recording: f.controller.isRecording(), sessions: f.sessions() })
      .toEqual({ added: 'adopted', deleted: 'adopted', faults: [], recording: true, sessions: 1 })
  } finally { f.controller.dispose() }
})
