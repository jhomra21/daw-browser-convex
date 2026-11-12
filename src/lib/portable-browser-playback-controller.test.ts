import { expect, spyOn, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { extractTimelineBindings } from '~/lib/timeline-source-test-support'
import { createProcessorEditRegistry } from '~/components/timeline/create-processor-edit-registry'
import type { AudioEffectRuntimeInstance, EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import type { AudioCoreGraphSnapshot } from '@daw-browser/audio-core-contract'
import { SYNTH_KIND_ID, nativeSynthStructureKey, type LiveProcessorEditIdentity } from '~/lib/live-processor-control'
import {
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultSamplerParams,
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
import type { LivePlaybackTransport } from '~/lib/live-playback-snapshot'
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

test.each(["synth", "master", "master-structural"])("3B1 r3 portable %s live gain stays live and Utility Swap rebuilds", async (schedule) => {
  const targetId = schedule === "synth" ? "synth" : "master"
  const source = await readFile(new URL("../components/Timeline.tsx", import.meta.url), "utf8")
  const { portable: handler } = extractTimelineBindings(source)
  const makeCallback = new Function("liveProcessorControl", "rebuildPlaybackBackend", "renderTracks", "SYNTH_KIND_ID",
    new Bun.Transpiler({ loader: "ts" }).transformSync(`return ({ ${handler} }).applyPortableProcessor;`))
  const calls: string[] = [], batches: unknown[] = []
  const graphs: Parameters<PortableWasmPlaybackSession["prepareGraph"]>[0][] = []
  const initial: UtilityParamsEnvelope = { version: 1, state: createDefaultUtilityParams() }
  const changed: UtilityParamsEnvelope = { version: 1, state: { ...initial.state, swap: true } }
  let projected = initial, revision = 1, rebuilds = 0
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
      () => controller.liveProcessorControl, async () => {
        rebuilds++
        revision++
        expect(await controller.rebuildPrepared(snapshot().transport)).toBe("started")
      }, () => [track], SYNTH_KIND_ID)
    const registry = createProcessorEditRegistry(() => 120)
    const allocate = (to: UtilityParamsEnvelope) => targetId === "master"
      ? registry.allocate({ targetId, instanceId: "utility:r2", effect: "master-utility", from: initial, to })
      : registry.allocate({ targetId, instanceId: "utility:r2", effect: "utility", from: initial, to })
    const liveBatches = schedule === "master-structural" ? 0 : 1
    if (liveBatches) {
      const gain = allocate({ version: 1, state: { ...initial.state, gainDb: 1 } })
      if (!gain) throw new Error("Missing live edit")
      expect(await apply(gain)).toBe("applied")
      expect({ rebuilds, liveBatches: batches.length }).toEqual({ rebuilds: 0, liveBatches })
    }
    const edit = allocate(changed)
    if (!edit) throw new Error("Missing structural edit")
    projected = changed
    expect(await apply(edit)).toBe("applied")
    expect({ rebuilds, liveBatches: batches.length }).toEqual({ rebuilds: 1, liveBatches })
    const configured = graphs.at(-1)?.nodes.flatMap(node => node.processorOrder).find(processor => processor.id === "utility:r2")
    expect(configured?.state).toEqual(edit.content.state)
    expect(graphs).toHaveLength(2)
    // Once the new structure really is installed, the same whole edit can go live.
    expect(await apply(edit)).toBe("applied")
    expect({ rebuilds, liveBatches: batches.length }).toEqual({ rebuilds: 1, liveBatches: liveBatches + 1 })
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
  expect(session.transports).toEqual([
    { running: false, frame: 0 },
    { running: true, frame: 0 },
  ])
  expect(controller.isActive()).toBeTrue()
  controller.dispose()
})

test('rebuilds a portable preview when the requested playhead is outside its schedule', async () => {
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

  expect(compileCalls).toEqual([previewTransport, requestedTransport])
  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(calls.filter((call) => call === 'mark-active')).toHaveLength(1)
  controller.dispose()
})

test('requires the full live schedule horizon before promoting a portable preview', async () => {
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

  expect(compileCalls).toEqual([previewTransport, nearEndTransport])
  expect(createdSessions).toBe(2)
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  controller.dispose()
})

test('rebuilds instead of promoting a portable preview when loop semantics change', async () => {
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

  expect(compileCalls).toEqual([previewTransport, loopTransport])
  expect(calls.filter((call) => call === 'dispose')).toHaveLength(1)
  expect(controller.isPrepared()).toBeTrue()
})

test('shares one rebuild for concurrent incompatible portable starts', async () => {
  const calls: string[] = []
  const rebuild = Promise.withResolvers<ReturnType<typeof compilation>>()
  let compileCalls = 0
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: (transport) => {
      compileCalls += 1
      if (compileCalls === 1) {
        const base = compilation()
        return Promise.resolve({
          ...base,
          snapshot: { ...base.snapshot, transport },
        })
      }
      return rebuild.promise
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

  const base = compilation()
  rebuild.resolve({ ...base, snapshot: { ...base.snapshot, transport: firstTransport } })
  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(2)
  expect(createdSessions).toBe(2)
  controller.dispose()
})

test('disposal during an incompatible portable rebuild prevents activation', async () => {
  const calls: string[] = []
  const rebuild = Promise.withResolvers<ReturnType<typeof compilation>>()
  let compileCalls = 0
  let createdSessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: () => {
      compileCalls += 1
      return compileCalls === 1 ? Promise.resolve(compilation()) : rebuild.promise
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
  const started = controller.start(requestedTransport)
  controller.dispose()
  rebuild.resolve(compilation())

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
  expect(session.transports).toEqual([
    { running: false, frame: 0 },
    { running: true, frame: 0 },
  ])

  promotion.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual(['started', 'started'])
  expect(compileCalls).toBe(1)
  expect(session.transports).toHaveLength(2)
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
  const makePortable = new Function("liveProcessorControl", "rebuildPlaybackBackend", "renderTracks", "SYNTH_KIND_ID",
    transpile(`return ({ ${portable} }).applyPortableProcessor;`))
  const makeStructural = new Function("deps", transpile(`
    const { mountedProjectGeneration, awaitPlaybackPreparation, preparedInstrument, isStructuralRebuildInProgress,
      isPreparingPlayback, isPlaying, isNativePlaybackPrepared, isPortableBrowserPlaybackPrepared,
      rebuildPlaybackBackend, renderTracks, captureStructuralPlaybackIntent, notify } = deps;
    let instrumentPlaybackChangeTail = Promise.resolve();
    return ({ ${structural} }).onStructuralPlaybackChange;`))
  let projected: TrackInstrumentParams = options.initial ?? p1Initial, revision = 1, rebuilds = 0
  const calls: string[] = [], batches: Array<readonly unknown[]> = [], notes: string[] = []
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
    () => controller.liveProcessorControl, rebuild, () => [track], SYNTH_KIND_ID)
  const announce: (targetId: string, instrument: TrackInstrumentParams | undefined) => Promise<void> = makeStructural({
    mountedProjectGeneration: () => 0, awaitPlaybackPreparation: async () => {},
    preparedInstrument: (targetId: string) => controller.preparedInstrument(targetId),
    isStructuralRebuildInProgress: () => false, isPreparingPlayback: () => controller.isPreparing(),
    isPlaying: () => true, isNativePlaybackPrepared: () => false,
    isPortableBrowserPlaybackPrepared: () => controller.isPrepared(),
    rebuildPlaybackBackend: rebuild, renderTracks: () => [track],
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
  return { controller, apply, announce, edit, allocate, flush, setProjected: (instrument: TrackInstrumentParams) => { projected = instrument }, batches, graphs, notes, rebuilds: () => rebuilds, sessionStructure, structureOf,
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
    expect(await f.controller.adoptSchedule()).toBe('adopted')
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
    expect(await f.controller.adoptSchedule()).toBe('adopted')
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
    expect(await f.controller.adoptSchedule()).toBe('adopted')
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
      results.push(await f.controller.adoptSchedule())
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
    expect(await f.controller.adoptSchedule()).toBe('failed')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 1, notes: [] })
    expect(f.controller.isActive()).toBeTrue()
    expect(await f.controller.adoptSchedule()).toBe('adopted')
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
    expect(await f.controller.adoptSchedule()).toBe('failed')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length, notes: f.notes }).toEqual({ rebuilds: 0, graphs: 1, notes: [] })
    expect(f.controller.isActive()).toBeTrue()
    expect(await f.controller.adoptSchedule()).toBe('adopted')
    expect({ rebuilds: f.rebuilds(), graphs: f.graphs.length }).toEqual({ rebuilds: 0, graphs: 2 })
  } finally { f.controller.dispose() }
})

test('UD 8 a transient staging failure is retried at the next block boundary and applies', async () => {
  const f = await p1Fixture({ failPrepare: 1 })
  try {
    const next = p1Synth(p1Initial, { polyphony: 4 })
    expect(await f.apply(f.edit(next))).toBe('applied')
    await f.announce('synth', next)
    expect(await f.controller.adoptSchedule()).toBe('failed')
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
    expect(await f.controller.adoptSchedule()).toBe('failed')
    // Waits grow as min(2^r, 16(r+1)) reports: 1, 2, 4, ... 128 over eight resubmits.
    await f.report(300)
    await Bun.sleep(0)
    expect({ refused: f.refused(), graphs: f.graphs.length, rebuilds: f.rebuilds(), notes: f.notes, active: f.controller.isActive() })
      .toEqual({ refused: 9, graphs: 1, rebuilds: 0, notes: [], active: true })
    expect(logged.filter(line => line.startsWith('warn')).length).toBe(8)
    expect(logged.filter(line => line.startsWith('error')).length).toBe(1)
    await f.report(300)
    expect(f.refused()).toBe(9)
    expect(await f.controller.adoptSchedule()).toBe('adopted')
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
const b6f5Fingerprint = (snapshot: { revision: number; transport: LivePlaybackTransport }) =>
  JSON.stringify({ ...snapshot, revision: undefined, transport: { ...snapshot.transport, playheadSec: undefined, state: undefined } })
const b6f5Compilation = (transport: LivePlaybackTransport, volume: number, clipDuration = 1, masterUtility?: UtilityParamsEnvelope) => {
  const base = compilation()
  const edited: RuntimeTrack = { ...track, volume, clips: track.clips.map((clip) => ({ ...clip, duration: clipDuration })) }
  const masterFxInstances: AudioEffectRuntimeInstance[] = masterUtility ? [{ id: 'utility-b6f5', kind: 'utility', params: masterUtility }] : []
  const fx = { ...base.snapshot.mixer.fx, masterFxInstances }
  return { ...base, snapshot: { ...base.snapshot, transport, tracks: [edited], mixer: { ...base.snapshot.mixer, fx,
    graph: resolveLiveMixerGraph([edited], fx.trackFx, { masterFxInstances }) } } }
}
type B6f5Publish = { revision: number; options: unknown }
const b6f5Session = (calls: string[], graphs: AudioCoreGraphSnapshot[], publishes: B6f5Publish[],
  publish: (options?: { requireContinuity: true }) => Promise<void> = async () => undefined) => ({
  ...createSession(calls, async () => undefined),
  prepareGraph: async (graph: AudioCoreGraphSnapshot) => { calls.push('prepare-graph'); graphs.push(graph) },
  publishGraph: async (revision: number, options?: { requireContinuity: true }) => {
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
    const adopted = await controller.adoptSchedule()
    // The accepted revision is what the session plays now: the same desired state again is unchanged, not a second publish.
    const again = await controller.adoptSchedule()
    expect({ adopted, again, sessions, calls: calls.slice(before), publishes: publishes.slice(1), gain: b6f5Gain(graphs.at(-1)), revision: graphs.at(-1)?.revision })
      .toEqual({ adopted: 'adopted', again: 'unchanged', sessions: 1, calls: ['prepare-graph', 'install-schedule:1', 'publish-graph'],
        publishes: [{ revision: 2, options: { requireContinuity: true, publicationFrame: 12_000 } }], gain: 0.5, revision: 2 })
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
    const refused = await controller.adoptSchedule()
    refuse = false
    const retried = await controller.adoptSchedule()
    const before = calls.length
    clipDuration = 2
    const structural = await controller.adoptSchedule()
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
      publishGraph: async (revision: number, options?: { requireContinuity: true }) => {
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
      const adoption = controller.adoptSchedule()
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
    const adoption = f.controller.adoptSchedule()
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
    const adoption = f.controller.adoptSchedule()
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
    const first = controller.adoptSchedule()
    for (let turn = 0; turn < 20 && adoptionCompiles === 0; turn += 1) await Promise.resolve()
    const queued = [0.2, 0.3, 0.4, 0.5].map((next) => { volume = next; return controller.adoptSchedule() })
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
    expect(await controller.adoptSchedule()).toBe('adopted')
    sessions[0]?.emitPosition(80_000)
    expect({ refresh: await controller.refreshSchedule(), faults, sessions: sessionIndex, refreshedRevision: graphs.at(-1)?.revision, gain: b6f5Gain(graphs.at(-1)) })
      .toEqual({ refresh: 'started', faults: [], sessions: 2, refreshedRevision: 2, gain: 0.5 })
  } finally { controller.dispose() }
})

// B6f5 step 5b, R6: a compile the session cannot continue (a structural edit since its start) is never installed on it.
// The refresh skips it without a fault, as it did before adoption; the follow asks for the rebuild that carries it.
const b6f5AddedSynth: RuntimeTrack = { ...track, id: 'synth-b', name: 'Synth B', clips: [{ ...track.clips[0], id: 'clip-b', name: 'MIDI B',
  color: '#fff', startSec: 0, duration: 10, midiOffsetBeats: 0, midi: { wave: 'sine', cc: [], mappings: [],
    notes: Array.from({ length: 20 }, (_, index) => ({ id: `note-b-${index}`, beat: index, length: 0.5, pitch: 62, velocity: 0.8 })) } }] }
const b6f5AddedAudio: RuntimeTrack = { id: 'audio-b', kind: 'audio', name: 'Audio B', volume: 1, clips: [{ id: 'clip-audio-b',
  name: 'Audio B', color: '#fff', startSec: 2, duration: 1, sourceAssetKey: 'asset-b', buffer: new TestAudioBuffer() }] }
const b6f5StructuralCompilation = (transport: LivePlaybackTransport, added: RuntimeTrack | undefined) => {
  const base = compilation()
  if (!added) return { ...base, snapshot: { ...base.snapshot, transport } }
  const tracks = [track, added]
  const instrument: TrackInstrumentParams = { kind: 'synth', instanceId: 'synth:2', params: createDefaultSynthParams() }
  const trackFx = added.kind === 'instrument'
    ? { ...base.snapshot.mixer.fx.trackFx, [added.id]: { instances: [], instrument } }
    : base.snapshot.mixer.fx.trackFx
  const fx = { ...base.snapshot.mixer.fx, trackFx }
  const assets = added.kind === 'audio' ? [{ assetId: 'asset-b', buffer: new TestAudioBuffer() }] : []
  return { ...base, snapshot: { ...base.snapshot, transport, tracks, assets, mixer: { ...base.snapshot.mixer, fx,
    graph: resolveLiveMixerGraph(tracks, fx.trackFx) } } }
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

test('B6f5 step5b R6 a recording refresh after a structural edit skips without a fault and keeps the take', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const sessions: ReturnType<typeof b6f5StrictSession>[] = []
  let added: RuntimeTrack | undefined
  const { stream, recordingContext } = createRecordingFixture(calls)
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5StructuralCompilation(transport, added),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => recordingContext, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { const session = b6f5StrictSession(calls, graphs, publishes); sessions.push(session); return session } },
    createRecordingWriter: () => ({ ready: Promise.resolve(), write: () => undefined, finalize: async () => ({ capturedFrames: 0 }),
      abort: async () => undefined, terminate: () => undefined }),
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    await controller.startRecording(b6f5RecordingInput(stream))
    added = b6f5AddedSynth
    sessions[0]?.emitPosition(80_000)
    const refresh = await controller.refreshSchedule()
    const follow = await controller.adoptSchedule()
    expect({ refresh, follow, faults, recording: controller.isRecording(), playing: controller.isActive(), sessions: sessions.length,
      ended: calls.filter((call) => call === 'dispose' || call === 'recording-capture-cancel') })
      .toEqual({ refresh: 'unavailable', follow: 'rebuild', faults: [], recording: true, playing: true, sessions: 1, ended: [] })
    // The take ends; the rebuild the follow asked for (dispose, then start, as the hook's rebuild) carries the newest state.
    expect(await controller.stopRecording()).toEqual({ capturedFrames: 0 })
    controller.dispose()
    expect(await controller.start({ ...compilation().snapshot.transport, playheadSec: 80_000 / 48_000 })).toBe('started')
    expect({ faults, sessions: sessions.length, carries: graphs.at(-1)?.nodes.some((node) => node.id === b6f5AddedSynth.id) })
      .toEqual({ faults: [], sessions: 2, carries: true })
  } finally { controller.dispose() }
})

test('B6f5 step5b R6 a normal refresh after a structural edit skips without a fault and the rebuild carries it', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const faults: string[] = []
  const sessions: ReturnType<typeof b6f5Session>[] = []
  let added: RuntimeTrack | undefined
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5StructuralCompilation(transport, added),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, scheduleHorizonSec: 2, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => { const session = b6f5Session(calls, graphs, publishes); sessions.push(session); return session } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    added = b6f5AddedAudio
    sessions[0]?.emitPosition(80_000)
    const refresh = await controller.refreshSchedule()
    const follow = await controller.adoptSchedule()
    expect({ refresh, follow, faults, playing: controller.isActive(), sessions: sessions.length })
      .toEqual({ refresh: 'unavailable', follow: 'rebuild', faults: [], playing: true, sessions: 1 })
    controller.dispose()
    expect(await controller.start({ ...compilation().snapshot.transport, playheadSec: 80_000 / 48_000 })).toBe('started')
    const graph = graphs.at(-1)
    expect({ faults, sessions: sessions.length, node: graph?.nodes.some((node) => node.id === b6f5AddedAudio.id),
      asset: graph?.assets.length })
      .toEqual({ faults: [], sessions: 2, node: true, asset: 1 })
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
    const adoption = controller.adoptSchedule()
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
  let added: RuntimeTrack | undefined
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
    added = b6f5AddedSynth
    sessions[0]?.emitPosition(80_000)
    expect({ refresh: await controller.refreshSchedule(), faults, recording: controller.isRecording(), playing: controller.isActive(), sessions: sessions.length })
      .toEqual({ refresh: 'unavailable', faults: [], recording: true, playing: true, sessions: 1 })
  } finally { controller.dispose() }
})

// AE-08 phase 8 step 1: failure-first witnesses. Each asserts the behaviour required once the phase lands and is
// `test.failing` until its implementing step flips it to `test`. The note and sequence ids are the design note's.
type W8Note = NonNullable<RuntimeTrack['clips'][number]['midi']>['notes'][number]
type W8Loop = Pick<LivePlaybackTransport, 'loopEnabled' | 'loopStartSec' | 'loopEndSec'>
type W8Adopt = (loop: W8Loop) => Promise<PortableAdoptionResult>
const w8Note = (id: string, beat: number, length = 1): W8Note => ({ id, beat, length, pitch: 60, velocity: 0.8 })
const w8Fixture = async (initial: { bpm?: number; notes?: readonly W8Note[]; loop?: W8Loop; audioStartSec?: number; clipSec?: number } = {}, options: { refuse?: () => boolean } = {}) => {
  const state = { bpm: initial.bpm ?? 120, notes: initial.notes ?? [w8Note('note', 0)], audioStartSec: initial.audioStartSec, warped: false }
  const noLoop: W8Loop = { loopEnabled: false, loopStartSec: 0, loopEndSec: 0 }
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  const installs: PortableFrameSchedule[] = []
  const epochs: number[] = []
  const faults: string[] = []
  let sessions = 0
  let positionListener: ((message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) | undefined
  const compile = (transport: LivePlaybackTransport) => {
    const base = compilation()
    const midi: RuntimeTrack = { ...track, clips: track.clips.map((clip) => ({ ...clip, duration: initial.clipSec ?? clip.duration, midi: clip.midi && { ...clip.midi, notes: [...state.notes] } })) }
    const audio: RuntimeTrack[] = state.audioStartSec === undefined ? [] : [{ id: 'audio-w8', kind: 'audio', name: 'Audio', volume: 1, clips: [{
      id: 'clip-audio-w8', name: 'Audio', color: '#fff', startSec: state.audioStartSec, duration: 1, sourceAssetKey: 'asset-w8', buffer: new TestAudioBuffer(),
      ...(state.warped && { audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 } }) }] }]
    const tracks = [midi, ...audio]
    const assets = audio.length ? [{ assetId: 'asset-w8', buffer: new TestAudioBuffer() }] : []
    return { ...base, snapshot: { ...base.snapshot, bpm: state.bpm, transport, tracks, assets,
      mixer: { ...base.snapshot.mixer, graph: resolveLiveMixerGraph(tracks, base.snapshot.mixer.fx.trackFx) } } }
  }
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => compile(transport),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected, reportFault: (message) => faults.push(message),
    backend: { createPlaybackSession: async () => {
      sessions += 1
      const base = b6f5Session(calls, graphs, publishes, async (publishOptions) => {
        if (publishOptions && options.refuse?.()) throw new Error('Portable playback graph-published was rejected.')
      })
      const withInstall = { ...base, ...createSession(calls, async (schedule) => { installs.push(schedule) }) }
      return { ...withInstall, prepareGraph: base.prepareGraph, publishGraph: base.publishGraph,
        setTransport: async (epoch: number, running: boolean, frame: number) => { epochs.push(epoch); await withInstall.setTransport(epoch, running, frame) },
        onTransportPosition: (listener: (message: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) => {
          positionListener = listener
          return withInstall.onTransportPosition(listener)
        } }
    } },
  })
  const transport: LivePlaybackTransport = { ...compilation().snapshot.transport, ...(initial.loop ?? noLoop) }
  const adopt: W8Adopt = controller.adoptSchedule
  const noteEvents = (schedule: PortableFrameSchedule | undefined, type: 'note-on' | 'note-off') =>
    (schedule?.events ?? []).flatMap((event) => event.type === type ? [{ noteId: event.noteId, frame: event.frame }] : [])
  const position = (frame: number, epoch = 1, sequence = 1) => positionListener?.({ version: 2, type: 'transport-position', sessionId: 1, epoch, sequence, running: true, frame })
  return { state, controller, transport, noLoop, calls, graphs, publishes, installs, epochs, faults, sessions: () => sessions, adopt, noteEvents, position }
}
// The phase adds `seek(sec, loop)` to the controller. Until it exists the E3 witnesses fail here; the implementing step
// replaces this stub with `f.controller.seek`.
const w8Seek = (_controller: ReturnType<typeof createPortableBrowserPlaybackController>): ((sec: number, loop: W8Loop) => Promise<string>) => {
  throw new Error('controller.seek does not exist yet')
}
const w8SourceCalls = (calls: readonly string[]) => calls.filter((call) => call.includes('sources'))

// W-F20a: a loop-bound edit while playing is adopted. Today the compile receives the old loop, both snapshots match,
// and the follow marks the edit applied without installing anything.
test.failing('W-F20a a loop edit while playing installs and publishes a schedule for the new loop', async () => {
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

// A tempo moves warped audio, whose sources a seam does not replace: the gate refuses it. A session that already plays
// warped audio needs prepared Stretch assets, which this fixture cannot start, so the edit turns the warp on with the tempo.
test('W-E5 a tempo edit that warps audio is refused and installs nothing', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    f.state.bpm = 90
    f.state.warped = true
    const result: string = await f.adopt(f.noLoop)
    expect({ result, calls: f.calls.slice(before).filter((call) => call !== 'mark-active') }).toEqual({ result: 'rebuild', calls: [] })
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

test('W-FB-1 a refused or structural adoption is failed or adopted and never asks for a rebuild', async () => {
  const calls: string[] = []
  const graphs: AudioCoreGraphSnapshot[] = []
  const publishes: B6f5Publish[] = []
  let volume = 0.8
  let clipDuration = 1
  let refuse = true
  let sessions = 0
  const controller = createPortableBrowserPlaybackController({
    compileSnapshot: async (transport) => b6f5Compilation(transport, volume, clipDuration),
    fingerprintSnapshot: b6f5Fingerprint,
    getAudioContext: () => context, select: async () => selected,
    backend: { createPlaybackSession: async () => { sessions += 1; return b6f5Session(calls, graphs, publishes, async (options) => {
      if (refuse && options) throw new Error('Portable playback graph-published was rejected.')
    }) } },
  })
  try {
    expect(await controller.start(compilation().snapshot.transport)).toBe('started')
    volume = 0.5
    const refused = await controller.adoptSchedule()
    refuse = false
    const retried = await controller.adoptSchedule()
    clipDuration = 2
    const structural: string = await controller.adoptSchedule()
    expect({ refused, retried, structuralRebuild: structural === 'rebuild', sessions, disposed: calls.includes('dispose') })
      .toEqual({ refused: 'failed', retried: 'adopted', structuralRebuild: false, sessions: 1, disposed: false })
  } finally { controller.dispose() }
})

// W-M3 guard: an audio clip edit that reaches the follow must never be adopted over the old sources. Green today
// (the gate refuses it); it stays green when the audio class is carried, because a carry replaces the sources.
test('W-M3 an audio clip move is never adopted or reported unchanged without touching the sources', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    f.state.audioStartSec = 0.5
    const result = await f.adopt(f.noLoop)
    const touched = w8SourceCalls(f.calls.slice(before)).length > 0
    expect({ result, staleAdoption: (result === 'adopted' || result === 'unchanged') && !touched }).toMatchObject({ staleAdoption: false })
  } finally { f.controller.dispose() }
})

// W-M3 end state: PortableAdoptionResult loses "rebuild"; the audio class is carried (adopted with new sources).
test.failing('W-M3 an audio clip move answers adopted with its sources replaced, not a rebuild', async () => {
  const f = await w8Fixture({ audioStartSec: 0 })
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const before = f.calls.length
    f.state.audioStartSec = 0.5
    const result: string = await f.adopt(f.noLoop)
    expect({ result, sourcesTouched: w8SourceCalls(f.calls.slice(before)).length > 0 }).toEqual({ result: 'adopted', sourcesTouched: true })
  } finally { f.controller.dispose() }
})

// W-UD7p-1: an edit while paused is adopted in place; Play then resumes on the edited schedule with no re-prepare.
test.failing('W-UD7p-1 a note edit on a paused prepared session is adopted in place', async () => {
  const f = await w8Fixture()
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

// W-E3-1 and W-E3-4 call the `seek(sec, loop)` method the phase adds; today the controller has none.
test.failing('W-E3-1 a seek while playing moves the transport in place at a new epoch', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    const seek = w8Seek(f.controller)
    const before = f.calls.length
    const startEpoch = f.epochs.at(-1) ?? 0
    const result = await seek(1.5, f.noLoop)
    expect({ result, sessions: f.sessions(), rebuilt: f.calls.slice(before).filter((call) => ['dispose', 'prepare-graph', 'publish-graph'].includes(call)),
      epochs: [...new Set(f.epochs.slice(-2))], transports: f.calls.slice(before).filter((call) => call.endsWith('-transport')) })
      .toEqual({ result: 'started', sessions: 1, rebuilt: [], epochs: [startEpoch + 1], transports: ['stop-transport', 'start-transport'] })
  } finally { f.controller.dispose() }
})

test.failing('W-E3-4 positions are reported again after a backward seek at the new epoch', async () => {
  const f = await w8Fixture()
  try {
    expect(await f.controller.start(f.transport)).toBe('started')
    f.position(96_000)
    const seek = w8Seek(f.controller)
    await seek(0.5, f.noLoop)
    f.position(25_000, (f.epochs.at(-1) ?? 0), 1)
    expect(f.controller.currentPositionSec()).toBeCloseTo(25_000 / 48_000, 6)
  } finally { f.controller.dispose() }
})
