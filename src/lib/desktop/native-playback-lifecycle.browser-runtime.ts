import { createEffect, createRoot, createSignal } from 'solid-js'
import { compileLivePlaybackSnapshot, type LivePlaybackTransport, type LivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import { useTimelinePlayback } from '~/hooks/useTimelinePlayback'
import { createPreparedStretchArtifactRepository } from '@daw-browser/audio-engine/prepared-stretch-store'
import type { NativeHostMeterBatch, NativeHostSpectrumFrame, NativeHostTransport, NativeScheduleProgress } from '@daw-browser/audio-engine/native-host-wire'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { createNativePlaybackController, nativePlaybackFaultText } from './native-playback-controller'
import { createEffectsPanelController } from '~/components/timeline/create-effects-panel-controller'
import { nativeGraphNodeId } from '@daw-browser/audio-engine/native-host-wire'
import { createDefaultSamplerParams, createDefaultGranularParams, createDefaultDrumRackParams, type TrackInstrumentParams, type SamplerZone } from '@daw-browser/shared'
import { sampledInstrumentRegionIdentity } from '@daw-browser/audio-engine/sampled-instrument-region'
import { createSampledInstrumentRegionBudget } from '~/lib/sampled-instrument-region-budget'
import { nativeInstrumentBudgetPolicy } from './native-instrument-budget-policy'

// This file is bundled only by the isolated Chromium E2E. No product debug API.
const trace: { sequence: number; event: string; owner: number; detail?: number | string }[] = []
let owner = 0
const record = (event: string, detail?: number | string) => {
  trace.push({ sequence: trace.length + 1, event, owner, detail })
}
let leaseAcquires = 0
let leaseReleases = 0
let liveLeases = 0
let duplicateLeaseReleases = 0
let controller: ReturnType<typeof createNativePlaybackController> | undefined
const disposals: Promise<void>[] = []
const timelineJourney = new URL(location.href).searchParams.has('timeline')
const sampledKind = new URL(location.href).searchParams.get('sampled')
const instrumentBudget = createSampledInstrumentRegionBudget(nativeInstrumentBudgetPolicy(18 * 1024 ** 3).aggregateBytes)
let sampleGeneration = 0
let installCalls = 0
let maximumPagePayload = 0
let configuredInstruments = 0
let liveNotes = 0
let holdPage = false
let pageGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
let timelinePlayback: ReturnType<typeof useTimelinePlayback> | undefined
let panel: ReturnType<typeof createEffectsPanelController> | undefined
let compiledSnapshot: LivePlaybackSnapshot | undefined
let compileGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
let compileHeld = false
let runGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
let runHeld = false
const desiredReads: Array<{ afterStart: boolean; capture: number; sequence: number; instruments: unknown }> = []
Object.assign(window, { dv01Timeline: {
  holdCapture: () => { compileGate = Promise.withResolvers<void>() },
  held: () => compileHeld,
  releaseCapture: () => { compileGate?.resolve(); compileGate = undefined; compileHeld = false },
  holdRun: () => { runGate = Promise.withResolvers<void>() },
  runHeld: () => runHeld,
  releaseRun: () => { runGate?.resolve(); runGate = undefined; runHeld = false },
  evidence: () => ({ reads: desiredReads, trace }),
} })
const instrumentNotifications: unknown[] = []
const nativeParameters: { nodeId: string; target: number; value: number }[] = []
const nativeInstrumentStates: { nodeId: string; cutoff: number }[] = []
export const observePanelController = (...args: Parameters<typeof createEffectsPanelController>) => {
  panel = createEffectsPanelController({ ...args[0], onStructuralPlaybackChange: async (targetId, next, edit) => {
    instrumentNotifications.push({ targetId, next, previous: timelinePlayback?.preparedInstrument(targetId) })
    await args[0].onStructuralPlaybackChange?.(targetId, next, edit)
  } })
  return panel
}
export const instrumentPanel = () => panel?.devices.instrument
let rebuildGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
let rebuildHeld = false
export const holdNextRebuild = () => { rebuildGate = Promise.withResolvers<void>() }
export const isRebuildHeld = () => rebuildHeld
export const releaseRebuild = () => { rebuildGate?.resolve(); rebuildGate = undefined; rebuildHeld = false }
Object.assign(window, { holdRebuildBeforeRetirement: async () => {
  if (!rebuildGate) return
  rebuildHeld = true
  await rebuildGate.promise
} })
export const instrumentEvidence = (targetId: string) => ({
  instrumentNotifications,
  instrument: timelinePlayback?.preparedInstrument(targetId) ?? null,
  desiredInstrument: panel?.devices.instrument.readInstrumentForTarget(targetId) ?? null,
  compiledInstrument: compiledSnapshot?.mixer.fx.trackFx?.[targetId]?.instrument ?? null,
  nativeStates: nativeInstrumentStates.filter(state => state.nodeId === String(nativeGraphNodeId(targetId))),
  nativeParameters: nativeParameters.filter(event => event.nodeId === String(nativeGraphNodeId(targetId))),
  trace: trace.slice(-40),
})
export const observePlayback = (...args: Parameters<typeof useTimelinePlayback>) => {
  const [engine, loop, native, portable] = args
  timelinePlayback = useTimelinePlayback(engine, loop, native ? { ...native, enabled: () => false } : native, portable)
  return timelinePlayback
}
export const timelineState = () => ({
  playing: timelinePlayback?.isPlaying() ?? false,
  rebuilding: timelinePlayback?.isStructuralRebuildInProgress() ?? false,
  preparing: timelinePlayback?.isPreparingPlayback() ?? false,
  prepared: controller?.isPrepared() ?? false,
  running: transport.running,
  cycleActive: transport.cycleActive,
  cycleStart: transport.cycleStartSec,
  cycleEnd: transport.cycleEndSec,
  position: controller?.currentPositionSec(),
  playheadSec: timelinePlayback?.playheadSec(),
  starts, stops, teardowns,
  pauses: trace.filter((entry) => entry.event === 'transport.pause').length,
})
export const preparedInstrumentIdentity = (targetId: string) =>
  timelinePlayback?.preparedInstrumentIdentity(targetId)
export const timelineSeek = (sec: number) => timelinePlayback?.setPlayhead(sec, [])
export const closeTimeline = () => timelinePlayback?.disposePreparedBackends(undefined, "e2e-timeline-close")
export const loseTimelineHost = () => {
  hostPrepared = false
  hostStarted = false
  mappedAssets.clear()
  for (const listener of lossListeners) listener('Native playback host connection was lost.')
}
export const retireTimeline = async () => {
  await timelinePlayback?.handlePause()
  await closeTimeline()
  timelineSeek(0.8)
}

// The bundle redirects only the hook's factory import here. All controller
// logic remains production code; this observes its existing repository seam.
export const observeController = (input: Parameters<typeof createNativePlaybackController>[0]) => {
  const desired = input.getDesiredProcessorState
  const productionController = createNativePlaybackController({
    ...input,
    instrumentBudget: sampledKind ? instrumentBudget : input.instrumentBudget,
    ...(desired && { getDesiredProcessorState: (snapshot: LivePlaybackSnapshot, rate: number) => {
      const projected = desired(snapshot, rate)
      desiredReads.push({ afterStart: hostStarted, capture: trace.filter(event => event.event === 'compile.complete').length,
        sequence: projected.sequence, instruments: [...projected.instruments ?? []] })
      record('desired.read')
      return projected
    } }),
    compileSnapshot: async (...args) => {
      record('compile.begin', JSON.stringify(args[1]))
      const result = await input.compileSnapshot(...args)
      record('compile.complete', String(result.supported))
      if (result.supported) compiledSnapshot = result.snapshot
      if (compileGate) { compileHeld = true; await compileGate.promise }
      return result
    },
    createPreparedStretchRepository: () => {
      const repository = createPreparedStretchArtifactRepository()
      return {
        ...repository,
        acquireLease: async (manifest) => {
          const lease = await repository.acquireLease(manifest)
          leaseAcquires += 1
          liveLeases += 1
          record('stretch.acquire')
          let released = false
          return {
            ...lease,
            release: async () => {
              if (released) duplicateLeaseReleases += 1
              released = true
              await lease.release()
              leaseReleases += 1
              liveLeases -= 1
              record('stretch.release')
            },
          }
        },
      }
    },
  })
  controller = {
    ...productionController,
    dispose: (options) => {
      const disposal = productionController.dispose(options)
      disposals.push(disposal)
      return disposal
    },
  }
  return controller
}

const progressListeners = new Set<(progress: NativeScheduleProgress) => void>()
const lossListeners = new Set<(error?: string) => void>()
const meterListeners = new Set<(batch: NativeHostMeterBatch) => void>()
const spectrumListeners = new Set<(frame: NativeHostSpectrumFrame) => void>()
const mappedAssets = new Set<number>()
let meterAdds = 0
let spectrumAdds = 0
let mappedCreates = 0
let pageWrites = 0
let attachmentCoordinates = 0
let starts = 0
let stops = 0
let teardowns = 0
let rollbacks = 0
let scheduleRejections = 0
let scheduleSubmissionsToReject = 0
let heldTransportProgress = false
let heldTransport = false
let token: string | undefined
let graphRevision = 1
let hostPrepared = false
let hostStarted = false
let holdCommit = false
let commitGate: ReturnType<typeof Promise.withResolvers<void>> | undefined
let failCommit = false
let progressSequence = 0n
let acceptedThroughFrame = 0n
let lastAcceptedWindowId = 0n
let appliedUrgentSequence = 0n
let transport: NativeHostTransport = {
  epoch: 1, frame: 0, running: false, bpm: 120,
  timeSignatureNumerator: 4, timeSignatureDenominator: 4, cycleActive: false,
}
const emitProgress = (advance = 0) => {
  transport = { ...transport, frame: transport.frame + advance }
  const progress: NativeScheduleProgress = {
    revision: graphRevision,
    epoch: transport.epoch,
    progressSequence: ++progressSequence,
    renderedThroughFrame: BigInt(transport.frame),
    acceptedThroughFrame,
    lastAcceptedWindowId,
    appliedTransportTransitionId: transport.transitionId ?? 0n,
    appliedUrgentSequence,
    appliedProcessorSequence: 0n,
    running: transport.running,
    scheduleComplete: false,
    instrumentCredits: 256,
    sourceCredits: 256,
    automationCredits: 256,
  }
  for (const listener of progressListeners) listener(progress)
}
type Reply = { ok: true } | { ok: false; error: string }
type DeliveryReply = { ok: true } | { ok: false; error: string; kind: "refused" | "unconfirmed" | "unavailable" }
const success = async (): Promise<Reply> => ({ ok: true })
const delivered = async (): Promise<DeliveryReply> => ({ ok: true })
const deviceId: `coreaudio:${string}` = 'coreaudio:isolated-browser-fixture'
const host = {
  instrumentBudgetPolicy: nativeInstrumentBudgetPolicy(18 * 1024 ** 3),
  resolveOutputDevice: async () => ({
    ok: true,
    device: { deviceId, name: 'Emulated stereo output', nominalSampleRateHz: 48_000,
      outputChannelCount: 2, maximumFramesPerBlock: 512, available: true },
  }),
  resolveInputDevice: async () => ({ ok: false, error: 'Recording is outside this fixture.' }),
  recordingSpool: {
    list: async () => ({ takes: [], nextCursor: null }),
    read: async () => new Uint8Array(),
    release: async () => undefined,
  },
  session: {
    beginTransaction: async () => {
      owner += 1
      token = `fixture-transaction-${owner}`
      record('transaction.begin')
      return { ok: true, transactionToken: token }
    },
    commitTransaction: async (transactionToken: string): Promise<Reply> => {
      if (transactionToken !== token) throw new Error('Fixture received stale Commit token.')
      if (failCommit) {
        failCommit = false
        record('commit.failed')
        return { ok: false, error: 'Genuine current Commit rejection (fixture).' }
      }
      token = undefined
      hostPrepared = true
      record('commit.host-completed')
      if (holdCommit) {
        holdCommit = false
        commitGate = Promise.withResolvers<void>()
        record('commit.delivery-held')
        await commitGate.promise
        commitGate = undefined
      }
      record('commit.renderer-delivery')
      return { ok: true }
    },
    rollbackTransaction: async (transactionToken: string): Promise<Reply> => {
      if (transactionToken !== token) throw new Error('Fixture received consumed rollback token.')
      rollbacks += 1
      token = undefined
      mappedAssets.clear()
      record('transaction.rollback')
      return { ok: true }
    },
    configure: async () => ({
      ok: true,
      hostIdentity: { pid: 123, generation: 1, configurationGeneration: 1 },
    }),
    coordinateVstAttachments: async (): Promise<Reply> => {
      attachmentCoordinates += 1
      record('attachment.coordinate-emulated')
      return { ok: true }
    },
    installAsset: async (): Promise<Reply> => { installCalls += 1; return { ok: true } },
    createMappedAsset: async (asset: { sessionAssetId: number }): Promise<Reply> => {
      mappedAssets.add(asset.sessionAssetId)
      mappedCreates += 1
      record('mapped.create', asset.sessionAssetId)
      return { ok: true }
    },
    writeMappedAssetPage: async (page: { planarPcm: Uint8Array }): Promise<Reply> => {
      pageWrites += 1
      maximumPagePayload = Math.max(maximumPagePayload, 24 + page.planarPcm.byteLength)
      record('mapped.write')
      if (holdPage) {
        holdPage = false
        pageGate = Promise.withResolvers<void>()
        await pageGate.promise
        pageGate = undefined
      }
      return { ok: true }
    },
    prepareMappedAssetRange: async (_id: number, _start: number, frames: number): Promise<Reply> => {
      record('mapped.prepare', frames)
      return { ok: true }
    },
    releaseAsset: async (assetId: number): Promise<Reply> => {
      mappedAssets.delete(assetId)
      record('mapped.release', assetId)
      return { ok: true }
    },
    publishGraph: async (bytes: Uint8Array): Promise<Reply> => {
      graphRevision = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, false))
      return { ok: true }
    },
    configureInstrumentStates: async (bytes: Uint8Array): Promise<Reply> => {
      configuredInstruments += 1
      record('instrument.configure')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let offset = 4
      for (let index = 0; index < view.getUint32(0, true); index += 1) {
        if (view.getUint32(offset + 8, true) === 1) nativeInstrumentStates.push({
          nodeId: String(view.getBigUint64(offset, true)), cutoff: view.getFloat32(offset + 24 + 72, true),
        })
        offset += 24 + view.getUint32(offset + 12, true) + view.getUint32(offset + 16, true)
      }
      return { ok: true }
    },
    queueInstrumentEvents: async (bytes: Uint8Array): Promise<DeliveryReply> => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      for (let index = 0; index < view.getUint32(0, true); index += 1) {
        const offset = 4 + index * 48
        const type = view.getUint32(offset + 32, true)
        if (type === 101) { liveNotes += 1; record('instrument.live-note') }
        // Mirror AudioHost::QueueInstrumentEvents and its applied-urgent gate.
        if (type === 5 || type >= 101 && type <= 104) {
          const sequence = view.getBigUint64(offset + 16, true)
          if (sequence > appliedUrgentSequence) appliedUrgentSequence = sequence
        }
        if (view.getUint32(offset + 32, true) === 5) nativeParameters.push({
          nodeId: String(view.getBigUint64(offset, true)),
          target: view.getUint32(offset + 40, true), value: view.getFloat32(offset + 44, true),
        })
      }
      queueMicrotask(() => emitProgress())
      return { ok: true }
    },
    queueParameterEvents: delivered,
    queueVstParameterEvents: success,
    queueSourceEvents: success,
    queueScheduleWindow: async (bytes: Uint8Array): Promise<Reply> => {
      if (scheduleSubmissionsToReject > 0) {
        scheduleSubmissionsToReject -= 1
        scheduleRejections += 1
        record('schedule.rejected')
        return { ok: false, error: 'Genuine schedule submission rejection (fixture).' }
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      acceptedThroughFrame = view.getBigUint64(24, true)
      lastAcceptedWindowId = view.getBigUint64(8, true)
      record('schedule.accept', Number(acceptedThroughFrame))
      queueMicrotask(() => emitProgress())
      return { ok: true }
    },
    setTransport: async (next: NativeHostTransport): Promise<Reply> => {
      if (next.epoch !== transport.epoch) {
        acceptedThroughFrame = BigInt(next.frame)
        lastAcceptedWindowId = 0n
      }
      transport = next
      record(next.running ? 'transport.run' : 'transport.pause')
      if (next.running && runGate) { runHeld = true; await runGate.promise }
      if (hostStarted) {
        if (heldTransportProgress && !next.running) {
          heldTransport = true
          heldTransportProgress = false
        } else queueMicrotask(() => emitProgress())
      }
      return { ok: true }
    },
    configureRecording: async () => ({ ok: false, error: 'Recording is outside this fixture.' }),
    startRecording: success,
    stopRecording: success,
    cancelRecording: success,
    start: async (): Promise<Reply> => {
      starts += 1
      hostStarted = true
      record('session.start')
      if (!hostPrepared) return { ok: false, error: 'Start after teardown has no committed graph.' }
      queueMicrotask(() => emitProgress())
      return { ok: true }
    },
    stop: async (): Promise<Reply> => {
      stops += 1
      hostStarted = false
      transport = { ...transport, running: false }
      record('session.stop')
      return { ok: true }
    },
    teardown: async (): Promise<Reply> => {
      teardowns += 1
      hostPrepared = false
      hostStarted = false
      token = undefined
      mappedAssets.clear()
      acceptedThroughFrame = 0n
      record('session.teardown')
      return { ok: true }
    },
    setSpectrumNode: success,
    onMeterBatch: (listener: (batch: NativeHostMeterBatch) => void) => {
      meterAdds += 1
      meterListeners.add(listener)
      record('meters.subscribe')
      return () => { meterListeners.delete(listener); record('meters.unsubscribe') }
    },
    onSpectrumFrame: (listener: (frame: NativeHostSpectrumFrame) => void) => {
      spectrumAdds += 1
      spectrumListeners.add(listener)
      record('spectrum.subscribe')
      return () => { spectrumListeners.delete(listener); record('spectrum.unsubscribe') }
    },
    onScheduleProgress: (listener: (progress: NativeScheduleProgress) => void) => {
      progressListeners.add(listener)
      record('schedule.subscribe')
      return () => { progressListeners.delete(listener); record('schedule.unsubscribe') }
    },
    onLoss: (listener: (error?: string) => void) => {
      lossListeners.add(listener)
      record('loss.subscribe')
      return () => { lossListeners.delete(listener); record('loss.unsubscribe') }
    },
    onRecordingStatus: () => () => undefined,
    onRecordingFailure: () => () => undefined,
  },
} satisfies NonNullable<Parameters<typeof createNativePlaybackController>[0]['bridge']>

// No binary is loaded or trusted by this browser fixture. This plan exercises
// only production attachment serialization and lifecycle coordination.
const attachmentPlan: NativeExternalAttachmentPlan = {
  version: 1,
  attachments: [{
    instanceId: '11111111-1111-4111-8111-111111111111',
    graphNodeId: 'track', nativeGraphNodeId: '123', stageIndex: 0,
    catalogIdentity: { format: 'vst3', classId: 'fixture', vendorId: 'fixture',
      architecture: 'arm64', scannerCatalogVersion: 2 },
    bundleFingerprint: 'a'.repeat(64), binaryFingerprint: 'b'.repeat(64),
    role: 'effect',
    inputBuses: [{ name: 'Main', channels: 2, enabled: true }],
    outputBuses: [{ name: 'Main', channels: 2, enabled: true }],
    workerTransport: { slotCount: 2, maximumFrames: 512, maximumEventsPerBlock: 128,
      inputChannels: 2, outputChannels: 2 },
    declaredLatencyFrames: 0, declaredTailFrames: null, bypassed: false, stateRevision: 0,
  }],
}
const buffer = new AudioBuffer({ numberOfChannels: 2, length: 48_000, sampleRate: 48_000 })
for (let channel = 0; channel < 2; channel += 1) {
  const samples = buffer.getChannelData(channel)
  for (let frame = 0; frame < samples.length; frame += 1) samples[frame] = Math.sin(frame * 0.03) * 0.1
}
const tracks: RuntimeTrack[] = [{
  id: 'track', name: 'Disposable lifecycle fixture', volume: 0.8,
  clips: [{
    id: 'ordinary', name: 'Mapped PCM', color: '#888', startSec: 0, duration: 1,
    sourceAssetKey: 'ordinary-source', buffer,
  }, {
    id: 'stretch', name: 'Stretch', color: '#888', startSec: 0, duration: 1,
    sourceAssetKey: 'stretch-source', buffer,
    audioWarp: { enabled: true, mode: 'stretch', sourceBpm: 120 },
  }],
}]
const sampledTracks: RuntimeTrack[] = [{
  id: 'track', kind: 'instrument', name: 'Instrument-only sample', volume: 0.8,
  clips: [{ id: 'notes', name: 'Notes', color: '#888', startSec: 0, duration: 8,
    midi: { wave: 'sine', notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.8 }] } }],
}]
const sampleBuffer = new AudioBuffer({ numberOfChannels: 2, length: 384_000, sampleRate: 48_000 })
sampleBuffer.getChannelData(0).fill(0.25)
sampleBuffer.getChannelData(1).fill(-0.5)
const sampledFx = () => {
  const sample: SamplerZone['sample'] = { assetKey: `instrument-source-${sampleGeneration}`, url: '/sample.wav', sourceKind: 'upload',
    source: { durationSec: 8, sampleRate: 48_000, channelCount: 2 } }
  const zone: SamplerZone = { id: 'zone', sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127,
    rootNote: 60, tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
    playbackMode: 'one-shot', startSec: 0, endSec: 8, crossfadeSec: 0, chokeGroup: 0 }
  const instrument: TrackInstrumentParams = sampledKind === 'sampler'
    ? { kind: 'sampler', instanceId: 'sampled', params: { ...createDefaultSamplerParams(), zones: [zone] } }
    : sampledKind === 'granular'
      ? { kind: 'granular', instanceId: 'sampled', params: { ...createDefaultGranularParams(), zone } }
      : { kind: 'drum-rack', instanceId: 'sampled', params: { ...createDefaultDrumRackParams(),
        pads: [{ ...createDefaultDrumRackParams().pads[0]!, sample, endSec: 8 }] } }
  const sampled = { buffer: sampleBuffer, sourceStartFrame: 0 }
  return { masterVolume: 1, masterFxInstances: [], trackFx: { track: { instances: [], instrument,
    samplerBuffers: new Map([['zone', sampled]]),
    granularBuffer: { ...sampled, assetKey: sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 0, sourceEndFrame: 384_000 }) },
    drumRackBuffers: new Map([[instrument.kind === 'drum-rack' ? instrument.params.pads[0]!.id : '', sampled]]),
  } } }
}
const compileSnapshot = async (next: LivePlaybackTransport) => {
  const result = compileLivePlaybackSnapshot({
    revision: 1, bpm: 120, transport: next, tracks: sampledKind ? sampledTracks : tracks,
    renderState: { fx: sampledKind ? sampledFx() : { masterVolume: 1, masterFxInstances: [], trackFx: {} }, automationEnvelopes: [] },
    sidechainRoutes: [],
  })
  return result.supported
    ? { ...result, snapshot: { ...result.snapshot, nativeExternalAttachmentPlan: attachmentPlan, requiresNativePlayback: true } }
    : result
}
Object.defineProperty(window, 'dawDesktop', { value: { setRequestHandler: () => undefined, onPrepareToClose: () => undefined, audioHost: timelineJourney ? {
  ...host,
  getLifecycle: async () => ({ state: 'ready', powerGeneration: 0 }),
  onLifecycle: () => () => undefined,
  onVstEditorCapturedState: () => () => undefined,
} : host }, configurable: true })
const faults: string[] = []
const operations: Promise<unknown>[] = []
const trackOperation = (operation: Promise<unknown>) => {
  operations.push(operation)
  void operation.catch((error) => faults.push(String(error)))
}
if (timelineJourney) {
  queueMicrotask(() => { void import('./native-playback-timeline.browser-runtime').then((journey) => journey.mountTimeline()).catch((error) => {
    document.body.textContent = `${String(error)} ${error?.stack ?? ''}`
  }) })
} else createRoot((disposeRoot) => {
  const [projectGeneration, setProjectGeneration] = createSignal(1)
  const [loop, setLoop] = createSignal({ enabled: false, startSec: 0, endSec: 1 })
  const playback = useTimelinePlayback({
    currentTimelineSec: 0,
    ensureAudio: () => undefined,
    resume: async () => undefined,
    applyAutomationAtTimelineSec: () => undefined,
    cancelAutomationSchedules: () => undefined,
    onTransportPause: () => undefined,
    onTransportSeek: () => undefined,
    onTransportStart: () => undefined,
    onTransportStop: () => undefined,
    rescheduleClipsAtPlayhead: () => ({ deferredStretchWindows: [] }),
    scheduleAllClipsFromPlayhead: () => ({ deferredStretchWindows: [] }),
    scheduleAutomationFromPlayhead: () => undefined,
    stopAllSources: () => undefined,
    subscribeStretchRenderState: () => () => true,
  }, {
    getTracks: () => tracks,
    loopEnabled: () => loop().enabled,
    loopStartSec: () => loop().startSec,
    loopEndSec: () => loop().endSec,
  }, {
    requiresNativeAudio: true,
    // Disable automatic paused preview so Play genuinely starts fresh.
    enabled: () => false,
    projectId: () => `disposable-project-${projectGeneration()}`,
    projectGeneration,
    compileSnapshot,
    reportFault: (fault) => { const message = nativePlaybackFaultText(fault); faults.push(message); record('product.fault', message) },
  })
  document.body.innerHTML = '<h1>Isolated native playback lifecycle</h1><p>Emulated host boundary, production playback ownership</p><button id="play">Play</button> <button id="pause">Pause</button> <button id="stop">Stop</button> <button id="seek">Ruler jump</button> <button id="rapid-seek">Rapid ruler jumps</button> <button id="loop">Toggle loop</button> <button id="follow">Toggle Follow</button> <button id="range-commit">Commit ruler loop range</button> <button id="fail-loop">Fail loop transition</button> <button id="switch">Switch project</button> <button id="preview">Preview</button> <button id="supersede">Supersede preview</button><pre id="status"></pre>'
  const on = (id: string, run: () => void) => document.getElementById(id)?.addEventListener('click', run)
  on('play', () => { record('ui.play'); trackOperation(playback.handlePlay(tracks)) })
  on('pause', () => { record('ui.pause'); trackOperation(playback.handlePause()) })
  on('stop', () => { record('ui.stop'); trackOperation(playback.handleStop()) })
  on('seek', () => { record('ui.seek'); playback.setPlayhead(0.25, tracks) })
  on('rapid-seek', () => {
    record('ui.rapid-seek')
    playback.setPlayhead(0.8, tracks)
    playback.setPlayhead(0.6, tracks)
    playback.setPlayhead(0.2, tracks)
  })
  on('loop', () => {
    record('ui.loop-toggle')
    setLoop((value) => ({ ...value, enabled: !value.enabled }))
  })
  on('follow', () => { record('ui.follow-toggle') })
  on('range-commit', () => {
    record('ui.ruler-loop-range-commit')
    setLoop((value) => ({ ...value, enabled: true, startSec: 0.2, endSec: 0.3 }))
    trackOperation(playback.updateNativeLoop())
  })
  on('fail-loop', () => {
    record('ui.failed-loop-range-commit')
    scheduleSubmissionsToReject = 8
    setLoop((value) => ({ ...value, enabled: true, startSec: 0.15, endSec: 0.6 }))
    trackOperation(playback.updateNativeLoop())
  })
  on('switch', () => { record('ui.project-switch'); setProjectGeneration((value) => value + 1) })
  on('preview', () => {
    record('ui.preview')
    if (controller) trackOperation(controller.ensureLivePreview(0, {}))
  })
  on('supersede', () => {
    record('ui.preview-supersede')
    if (controller) trackOperation(controller.ensureLivePreview(0.25, {}))
  })
  const snapshot = () => ({
    isPlaying: playback.isPlaying(),
    prepared: playback.isNativePlaybackPrepared(),
    preparing: playback.isPreparingPlayback(),
    active: playback.isNativePlayback(),
    projectGeneration: projectGeneration(),
    position: controller?.currentPositionSec() ?? null,
    playheadSec: playback.playheadSec(),
    hostRunning: transport.running,
    hostCycleActive: transport.cycleActive,
    hostCycleStartSec: transport.cycleStartSec ?? 0,
    hostCycleEndSec: transport.cycleEndSec ?? 0,
    hostPrepared, hostStarted,
    installCalls, maximumPagePayload, configuredInstruments, liveNotes,
    instrumentBytes: instrumentBudget.totalBytes(), instrumentReservedBytes: instrumentBudget.reservedBytes(),
    pageHeld: pageGate !== undefined,
    commitHeld: commitGate !== undefined,
    liveLeases, leaseAcquires, leaseReleases, duplicateLeaseReleases,
    meterSubscriptions: meterListeners.size,
    spectrumSubscriptions: spectrumListeners.size,
    scheduleSubscriptions: progressListeners.size,
    lossSubscriptions: lossListeners.size,
    meterAdds, spectrumAdds, mappedAssets: mappedAssets.size,
    mappedCreates, pageWrites, attachmentCoordinates, starts, stops, teardowns, rollbacks, scheduleRejections,
    faults: [...faults], trace: [...trace],
  })
  createEffect(() => {
    const status = document.getElementById('status')
    if (status) status.textContent = playback.isPlaying() ? 'Playing' : 'Stopped'
  })
  Object.assign(window, {
    nativeLifecycle: {
      snapshot,
      armPage: () => { holdPage = true },
      releasePage: () => pageGate?.resolve(),
      replaceSample: async () => {
        sampleGeneration += 1
        await controller?.dispose()
        return controller?.ensureLivePreview(0, {})
      },
      note: () => {
        const handle = controller?.startLiveMidiNote({ trackId: 'track', pitch: 60, velocity: 0.8 })
        if (handle) controller?.releaseLiveMidiNote(handle)
      },
      armCommit: () => { holdCommit = true; record('gate.armed') },
      failCommit: () => { failCommit = true },
      failNextSchedule: () => { scheduleSubmissionsToReject = 8 },
      holdNextPause: () => { heldTransportProgress = true },
      pauseHeld: () => heldTransport,
      releasePause: () => { heldTransport = false; emitProgress() },
      releaseCommit: () => { record('gate.release'); commitGate?.resolve() },
      // Event-driven settling, never sleep/poll to choose an interleaving.
      settle: async () => {
        await Promise.allSettled(operations)
        // Observe disposal already issued by the hook. Never repair leaked
        // ownership with another disposal before inspecting the stopped state.
        await Promise.all(disposals)
        return snapshot()
      },
      settlePlaying: async () => { await Promise.allSettled(operations); return snapshot() },
      advance: () => { emitProgress(512); return snapshot() },
      advanceFrames: (frames: number) => { emitProgress(frames); return snapshot() },
      setLoopProbePosition: (position: number) => playback.setPlayhead(position, tracks),
      setLoopRange: (startSec: number, endSec: number) => {
        setLoop({ enabled: true, startSec, endSec })
        trackOperation(playback.updateNativeLoop())
      },
      retireForColdPlay: async () => {
        await playback.handlePause()
        await playback.disposePreparedBackends(undefined, "e2e-preview-retirement")
        playback.setPlayhead(0.8, tracks)
      },
      loseHost: () => {
        hostPrepared = false
        hostStarted = false
        mappedAssets.clear()
        record('host.loss-emulated')
        for (const listener of lossListeners) listener('Native playback host connection was lost.')
      },
      close: async () => {
        await playback.disposePreparedBackends(undefined, "e2e-timeline-close")
        disposeRoot()
        await controller?.destroy()
        return snapshot()
      },
    },
  })
})
