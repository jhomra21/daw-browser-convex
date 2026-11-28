import '~/index.css'
import { render } from 'solid-js/web'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/solid-router'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { ColorModeProvider } from '@kobalte/core'
import Timeline from '~/components/Timeline'
import { AppPreferencesProvider } from '~/context/app-preferences'
import { MidiAccessProvider } from '~/context/midi-access'
import { defaultAppPreferences } from '~/lib/preferences/app-preferences'
import { createLocalProject } from '~/lib/local-project-db'
import { saveLocalProjectState, loadLocalProjectState } from '~/lib/local-project-state'
import { createLocalControlService } from '~/lib/local-control/local-control-service'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { controlApprovalResultSchemaV1, controlPreviewResultSchemaV1, projectSnapshotSchemaV2 } from '@daw-browser/control'
import { hostControl, timelineState, preparedInstrumentIdentity, instrumentPanel, instrumentEvidence, timelineSeek, closeTimeline, retireTimeline, loseTimelineHost } from './native-playback-lifecycle.browser-runtime'
import { createPortableBrowserPlaybackController } from '~/lib/portable-browser-playback-controller'
import { compileLivePlaybackSnapshot } from '~/lib/live-playback-snapshot'
import type { PortableWasmBackendSelection } from '@daw-browser/audio-engine/wasm-audio-worklet-backend'
import type { PortableWasmStatusMessage } from '@daw-browser/audio-engine/portable-wasm-protocol'
import { audioCoreContractVersion } from '@daw-browser/audio-core-contract'
import { audioCoreWasmAbiVersion, audioCoreWasmArtifactVersion, audioCoreWasmPagedAbiVersion } from '@daw-browser/audio-core-wasm'
import { createDefaultSynthParams, type JsonValue, type TrackInstrumentParams } from '@daw-browser/shared'
import { setLocalEffect, deleteLocalEffect } from '~/lib/local-effects'
import { mapNativeBuiltInParameterCommit } from '~/lib/desktop/native-built-in-parameter-mapper'

// Emulate only the worklet boundary; compile, schedule, start/resume and map
// positions through the production portable controller in real Chromium.
const portableLoopProbe = async (refreshProbe = false) => {
  const context = new AudioContext({ sampleRate: 48_000 })
  let report: ((position: Extract<PortableWasmStatusMessage, { type: 'transport-position' }>) => void) | undefined
  let epoch = 0
  const liveValues: { session: number; epoch: number; target: number; value: number }[] = []
  let graphPublications = 0
  let sessions = 0
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const applied = Promise.withResolvers<void>()
  let installs = 0
  const starts: { session: number; frame: number }[] = []
  const coverage: { session: number; startFrame: number; endFrame: number }[] = []
  const portableFaults: string[] = []
  const synth = { kind: 'synth', instanceId: 'portable:synth', params: createDefaultSynthParams() } satisfies TrackInstrumentParams
  const controller = createPortableBrowserPlaybackController({
    // The in-place extension fits whole pages (16 384 frames), so the window has to be longer than one.
    scheduleHorizonSec: refreshProbe ? 1.2 : undefined,
    reportFault: (message) => portableFaults.push(message),
    getAudioContext: () => context,
    compileSnapshot: async (transport) => compileLivePlaybackSnapshot({
      revision: 1, bpm: 120, transport, tracks: [{ id: 'portable-track', name: 'Portable synth', kind: 'instrument', volume: 1, clips: [] }],
      renderState: { fx: { masterVolume: 1, masterFxInstances: [], trackFx: { 'portable-track': { instances: [], instrument: synth } } }, automationEnvelopes: [] },
      sidechainRoutes: [],
    }),
    select: async (): Promise<PortableWasmBackendSelection> => ({
      selected: true,
      capability: {
        available: true, sharedQueue: 'available',
        artifact: {
          bytes: new ArrayBuffer(0),
          module: new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
          manifest: {
            version: audioCoreWasmArtifactVersion, abiVersion: audioCoreWasmAbiVersion,
            pagedAbi: audioCoreWasmPagedAbiVersion, contractVersion: audioCoreContractVersion,
            contractHash: 'fixture', fixedMemory: true, memoryBytes: 1, sha256: 'fixture', wasmUrl: 'fixture',
          },
        },
      },
    }),
    backend: { createPlaybackSession: async () => {
      const session = ++sessions
      if (refreshProbe && session > 1) {
        // A handoff that rebuilds would otherwise wait forever for an install that never reaches the held one.
        const rebuilt = new Error('The schedule handoff rebuilt the session instead of extending it in place.')
        reached.reject(rebuilt)
        throw rebuilt
      }
      return {
      connectInput: () => () => undefined, dispose: () => undefined,
      installSchedule: async (schedule) => {
        if (refreshProbe) coverage.push({
          session, startFrame: schedule.timeOrigin.frame, endFrame: schedule.timeOrigin.frame + 4_800,
        })
        // The handoff extends the running session in place: its second install is the held one.
        if (refreshProbe && (installs += 1) === 2) { reached.resolve(); await release.promise }
      }, markActive: () => undefined,
      onFault: () => () => true, onRecordingStatus: () => () => true,
      postRecordingControl: () => undefined, prepareGraph: async () => undefined,
      publishGraph: async () => { graphPublications += 1 },
      queueInstrumentEvents: async (deliveryEpoch, events) => {
        liveValues.push(...events.map(event => ({ session, epoch: deliveryEpoch, target: event.note, value: event.value })))
        if (refreshProbe) await applied.promise
      },
      registerAsset: async () => ({ status: 'registered', handle: { slot: 0, generation: 1 } }),
      scheduleSources: async () => undefined, setTransport: async (nextEpoch, running, frame) => {
        epoch = nextEpoch
        if (running) starts.push({ session, frame })
      },
      onTransportPosition: (listener) => { report = listener; return () => { report = undefined; return true } },
    } } },
  })
  const start = async (sec: number) => {
    const result = await controller.start({ state: 'playing', playheadSec: sec, loopEnabled: true, loopStartSec: 0.2, loopEndSec: 0.4 })
    if (result !== 'started') throw new Error(`Portable probe did not start: ${portableFaults.join('; ')}`)
    return controller.currentPositionSec()
  }
  try {
    const cold = await start(refreshProbe ? 0 : 0.8)
    if (refreshProbe) {
      report?.({ version: 2, type: 'transport-position', sessionId: 1, epoch, sequence: 1, running: true, frame: 50_000 })
      const refresh = controller.refreshSchedule()
      await reached.promise
      let settled = false
      const flush = controller.liveProcessorControl.flush({
        instanceId: synth.instanceId, values: [{ parameterId: 'synth.filterCutoffHz', value: 913 }],
      }).then(result => { settled = true; return result })
      await Promise.resolve()
      await Promise.resolve()
      const settledBeforeApplied = settled
      applied.resolve()
      const result = await flush
      controller.rememberInstrumentParameters('portable-track', {
        ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: 913 } },
      })
      // Keep editing throughout the held preparation, not just before refresh.
      for (let value = 914; value <= 945; value += 1) {
        await controller.liveProcessorControl.flush({
          instanceId: synth.instanceId, values: [{ parameterId: 'synth.filterCutoffHz', value }],
        })
        controller.rememberInstrumentParameters('portable-track', {
          ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: value } },
        })
      }
      const pending = controller.liveProcessorControl.flush({
        instanceId: synth.instanceId, values: [{ parameterId: 'synth.filterCutoffHz', value: 947 }],
      })
      const handoffStarted = performance.now()
      release.resolve()
      const pendingResult = await pending
      controller.rememberInstrumentParameters('portable-track', {
        ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: 947 } },
      })
      const concurrent = await controller.liveProcessorControl.flush({
        instanceId: synth.instanceId, values: [{ parameterId: 'synth.filterCutoffHz', value: 946 }],
      })
      controller.rememberInstrumentParameters('portable-track', {
        ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: 946 } },
      })
      const staleRefresh = await refresh
      const handoffMs = performance.now() - handoffStarted
      const preserved = controller.preparedInstrument('portable-track')
      const nextRefresh = await controller.refreshSchedule()
      const replacement = controller.preparedInstrument('portable-track')
      return { settledBeforeApplied, result, pendingResult, concurrent, staleRefresh, nextRefresh, preserved, replacement, sessions, liveValues, starts, coverage, handoffMs, faults: portableFaults }
    }
    const mapped = mapNativeBuiltInParameterCommit({
      targetId: 'portable-track', effect: 'instrument', from: synth,
      to: { ...synth, params: { ...synth.params, filter: { ...synth.params.filter, frequencyHz: 913 } } },
    }, 120)
    if (!mapped) throw new Error('Portable synth cutoff was not mapped.')
    const publicationsBefore = graphPublications
    const liveResult = await controller.liveProcessorControl.flush(mapped)
    const publicationsAfter = graphPublications
    await controller.pause(0.8)
    const resumed = await start(0.8)
    controller.dispose()
    await start(0.1)
    report?.({ version: 2, type: 'transport-position', sessionId: 1, epoch, sequence: 1, running: true, frame: 24_000 })
    return { cold, resumed, beforeLoopWrap: controller.currentPositionSec(), liveResult, liveValues, publicationsBefore, publicationsAfter }
  } finally {
    controller.dispose()
    await context.close()
  }
}

export const mountTimeline = async () => {
  const project = await createLocalProject('Native loop production journey')
  const repository = createLocalTimelineRepository(project.id)
  await repository.createTrack({ name: 'Audio', kind: 'audio' })
  let instrumentTrackId: string | undefined
  let remoteTrackId: string | undefined
  let remoteClipId: string | undefined
  let coalescedTrackId: string | undefined
  if (new URL(location.href).searchParams.has('layout')) {
    const track = await repository.createTrack({ name: 'Click fixture', kind: 'instrument' })
    instrumentTrackId = track.id
    await setLocalEffect(project.id, track.id, 'instrument', {
      kind: 'synth',
      instanceId: 'instrument:layout-fixture',
      params: createDefaultSynthParams(),
    })
    await repository.createClip({ trackId: track.id, name: 'Click fixture', startSec: 0, duration: 8, midi: { wave: 'sine', notes: [{ id: 'held', beat: 0, length: 16, pitch: 60, velocity: 0.8 }] } })
    const emptyTrack = await repository.createTrack({ name: 'Empty instrument fixture', kind: 'instrument' })
    remoteTrackId = emptyTrack.id
    const emptyClip = await repository.createClip({ trackId: emptyTrack.id, name: 'Empty instrument fixture', startSec: 0, duration: 8, midi: { wave: 'sine', notes: [{ id: 'remote-held', beat: 0, length: 16, pitch: 64, velocity: 0.8 }] } })
    remoteClipId = emptyClip.id
    const coalescedTrack = await repository.createTrack({ name: 'Coalesced instrument fixture', kind: 'instrument' })
    coalescedTrackId = coalescedTrack.id
    await repository.createClip({ trackId: coalescedTrack.id, name: 'Coalesced instrument fixture', startSec: 0, duration: 8, midi: { wave: 'sine', notes: [{ id: 'coalesced-held', beat: 0, length: 16, pitch: 67, velocity: 0.8 }] } })
  }
  await saveLocalProjectState(project.id, 'loop', { enabled: false, startSec: 0.2, endSec: 0.4 })
  await saveLocalProjectState(project.id, 'grid', { enabled: false, denominator: 4 })
  await saveLocalProjectState(project.id, 'timelineScale', 100)
  history.replaceState(null, '', `?timeline&projectId=${project.id}`)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['session'], null)
  const route = createRootRoute({
    errorComponent: (props) => <pre>{String(props.error)} {props.error.stack}</pre>,
    component: () => <QueryClientProvider client={client}>
      <ColorModeProvider>
        <AppPreferencesProvider initialPreferences={defaultAppPreferences}>
          <MidiAccessProvider>
          <Timeline bootstrapIfEmpty={false} dashboardEnabled={false} dashboardView={() => null} setDashboardParam={() => {}} />
          </MidiAccessProvider>
        </AppPreferencesProvider>
      </ColorModeProvider>
    </QueryClientProvider>,
  })
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
  const dispose = render(() => <RouterProvider router={router} />, document.body)
  const service = createLocalControlService({ actor: { subject: 'local:00000000-0000-4000-8000-000000000000' } })
  Object.assign(window, {
    timelineJourney: {
      snapshot: timelineState,
      instrumentTrackId,
      remoteTrackId,
      remoteClipId,
      coalescedTrackId,
      preparedInstrumentIdentity,
      instrumentEvidence,
      changeSynthCutoff: (frequencyHz: number) => instrumentPanel()?.synth.change({ filter: { frequencyHz } }),
      flushInstrument: () => instrumentPanel()?.flushPending(),
      roomRows: () => [instrumentTrackId, remoteTrackId, coalescedTrackId].flatMap(trackId => {
        if (!trackId) return []
        const instrument = instrumentPanel()?.readInstrumentForTarget(trackId)
        return instrument ? [{ _id: `fixture:${trackId}`, _creationTime: 1, projectId: project.id,
          targetType: 'track', trackId, type: 'instrument', params: instrument }] : []
      }),
      removeInstrument: async (targetId: string) => {
        await deleteLocalEffect(project.id, targetId, 'instrument')
      },
      mirrorRoomInstrument: (targetId: string) => {
        const instrument = instrumentPanel()?.readInstrumentForTarget(targetId)
        if (!instrument) throw new Error('Room instrument was not observed.')
        return setLocalEffect(project.id, targetId, 'instrument', instrument)
      },
      setPanelInstrument: (targetId: string, instanceId: string, frequencyHz: number) =>
        instrumentPanel()?.setInstrumentForTarget(targetId, {
          kind: 'synth', instanceId,
          params: { ...createDefaultSynthParams(), filter: { ...createDefaultSynthParams().filter, frequencyHz } },
        }),
      setLocalStoreInstrument: async (targetId: string, instanceId: string, frequencyHz: number) => {
        await setLocalEffect(project.id, targetId, 'instrument', {
          kind: 'synth', instanceId,
          params: { ...createDefaultSynthParams(), filter: { ...createDefaultSynthParams().filter, frequencyHz } },
        })
      },
      coalescedInstrumentApply: async (instanceId: string) => {
        if (!coalescedTrackId) throw new Error('Coalesced instrument fixture is unavailable.')
        const instrument = instrumentPanel()
        if (!instrument) throw new Error('Production instrument panel is unavailable.')
        // Both calls occur before the first Promise-based apply completion.
        instrument.setInstrumentForTarget(coalescedTrackId, { kind: 'synth', instanceId, params: createDefaultSynthParams() })
        instrument.synth.change({ filter: { frequencyHz: 740 } })
        await instrument.flushPending()
      },
      portableLoopProbe,
      portableRefreshProbe: () => portableLoopProbe(true),
      seek: timelineSeek,
      retire: retireTimeline,
      loseHost: loseTimelineHost,
      loop: () => loadLocalProjectState(project.id, 'loop'),
      observe: async () => projectSnapshotSchemaV2.parse(await hostControl('control.snapshot', { projectId: project.id, readVersion: 'v2' })),
      // The desktop host's canonical path: snapshot, preview, approval when required, keyed commit. The mounted Timeline reconciles around the commit.
      commit: async (actions: JsonValue[]) => {
        const snapshot = projectSnapshotSchemaV2.parse(await hostControl('control.snapshot', { projectId: project.id, readVersion: 'v2' }))
        const request = { version: 'v1', projectId: project.id, expectedRevision: snapshot.project.revision, actions }
        const preview = controlPreviewResultSchemaV1.parse(await hostControl('control.preview', request))
        if (!preview.applied) throw new Error('Expected local preview to apply.')
        const approvalToken = preview.approval?.required
          ? controlApprovalResultSchemaV1.parse(await hostControl('control.requestApproval', request)).approvalToken : undefined
        await hostControl('control.commit', { ...request, ...(approvalToken && { approvalToken }), idempotencyKey: crypto.randomUUID() })
      },
      commitLoop: async () => {
        service.capabilities()
        const snapshot = await service.snapshot({ projectId: project.id })
        const request = {
          version: 'v1', projectId: project.id, expectedRevision: snapshot.project.revision,
          actions: [{ kind: 'project.settings.set', loopEnabled: true, loopStartSec: 0.3, loopEndSec: 0.7 }],
        }
        const preview = await service.preview(request)
        if (!preview.applied) throw new Error('Expected local loop preview to apply.')
        await service.commit({ ...request, idempotencyKey: crypto.randomUUID() })
        return service.snapshot({ projectId: project.id })
      },
      close: async () => { await closeTimeline(); dispose(); client.clear() },
    },
  })
}
