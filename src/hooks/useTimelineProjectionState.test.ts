import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'

import { createEffect, createRoot, createSignal } from 'solid-js'
import { isServer } from 'solid-js/web'
import type { TimelineSnapshot } from '~/lib/timeline-repository/types'
import { clearClipMovePatch, reconcileTimelineProjectionSnapshot, useTimelineProjectionState } from './useTimelineProjectionState'

import { convexApi, convexClient } from '~/lib/convex'
import { createLocalProject } from '~/lib/local-project-db'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { installHermeticWindow } from '~/lib/test/hermetic-browser-environment'
import { loadTrackEffectSnapshot } from '~/lib/track-state-snapshot'
import { buildTrackDeleteHistoryEntry } from '~/lib/undo/builders'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { mountStep5Playback, settleStep5Playback } from '../../tools/acceptance/b5c-playback-witness-support'
import { useTimelineHistory, type TimelineHistoryActions } from './useTimelineHistory'
import { useTimelineIdentity } from './useTimelineIdentity'
import { useTimelineLocalMix } from './useTimelineLocalMix'
import { useTimelineMixerController } from './useTimelineMixerController'
import { useTimelineResolvedModel } from './useTimelineResolvedModel'
test.skipIf(!isServer)('local projection reconciliation runs Solid effects', async () => {
  const child = Bun.spawn(["bun", "test", "--conditions=browser", import.meta.path, "-t", "^local canonical"],
    { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  expect(code).toBe(0)
})

test.skipIf(isServer)('local canonical snapshots retire reflected overlays without clearing unsaved drafts', async () => {
  const clip = { id: "clip-1", trackId: "track-1", historyRef: "clip-1", name: "Clip",
    color: "#fff", startSec: 0, duration: 4, createdAt: 1, updatedAt: 1 }
  const snapshot: TimelineSnapshot = { projectId: "local_project-projection", tracks: [{
    id: "track-1", historyRef: "track-1", name: "Track", index: 0, volume: 1,
    muted: false, soloed: false, kind: "audio", channelRole: "track", sends: [], createdAt: 1, updatedAt: 1,
  }], clips: [clip] }
  let dispose = () => {}
  const projection = createRoot((cleanup) => {
    dispose = cleanup
    return useTimelineProjectionState({
      projectId: () => snapshot.projectId, serverData: () => undefined,
      rememberTrackProjection: () => {}, rememberClipHistoryRef: () => {},
    })
  })
  const setSnapshot = projection.reconcileLocalSnapshot
  try {
    await Promise.resolve()
    projection.commitClipTiming(clip.id, { startSec: 2 })
    projection.setDraftClipTiming("unsaved-draft", { startSec: 9 })
    projection.insertLocalClip("track-1", { id: "unsaved-create", name: "Draft", startSec: 8, duration: 2, color: "#fff" })
    setSnapshot({ ...snapshot, clips: [{ ...clip, startSec: 2 }] })
    expect(projection.committedClipEditsById().size).toBe(0)
    expect(projection.draftClipEditsById().get("unsaved-draft")).toEqual({ startSec: 9 })
    expect(projection.pendingClipCreatesById().has("unsaved-create")).toBe(true)
    setSnapshot({ ...snapshot, clips: [{ ...clip, startSec: 3 }] })
    expect(projection.committedClipEditsById().size).toBe(0)
    projection.replaceLocalClip("track-1", { ...clip, startSec: 7 })
    setSnapshot({ ...snapshot, clips: [{ ...clip, startSec: 3 }] })
    expect(projection.pendingClipCreatesById().get(clip.id)?.clip.startSec).toBe(7)
    setSnapshot({ ...snapshot, clips: [{ ...clip, startSec: 7 }] })
    expect(projection.pendingClipCreatesById().has(clip.id)).toBe(false)
    projection.replaceLocalClip("track-1", { ...clip, color: "#f00" })
    setSnapshot(snapshot)
    expect(projection.pendingClipCreatesById().get(clip.id)?.clip.color).toBe("#f00")
    setSnapshot({ ...snapshot, clips: [{ ...clip, color: "#f00" }] })
    expect(projection.pendingClipCreatesById().has(clip.id)).toBe(false)
    expect(projection.draftClipEditsById().size).toBe(1)
  } finally { dispose() }
})

test('clears a reflected committed fade patch without affecting other projection state', () => {
  const fades = { fadeInSec: 1, fadeOutSec: 2, fadeInCurve: 0.5, fadeOutCurve: -0.5 }
  const pendingTrackEntriesById = new Map()
  const pendingClipCreatesById = new Map()
  const removedTrackIds = new Set<string>()
  const removedClipIds = new Set<string>()
  const pendingTrackLocksById = new Map()

  const next = reconcileTimelineProjectionSnapshot({
    committedClipEditsById: new Map([['clip-1', { fades }]]),
    pendingTrackEntriesById,
    pendingClipCreatesById,
    removedTrackIds,
    removedClipIds,
    pendingTrackLocksById,
  }, {
    tracks: [],
    clips: [{
      _id: 'clip-1',
      trackId: 'track-1',
      startSec: 0,
      duration: 4,
      fades,
    }],
  })

  expect(next.committedClipEditsById).toEqual(new Map())
  expect(next.pendingTrackEntriesById).toBe(pendingTrackEntriesById)
  expect(next.pendingClipCreatesById).toBe(pendingClipCreatesById)
  expect(next.removedTrackIds).toBe(removedTrackIds)
  expect(next.removedClipIds).toBe(removedClipIds)
  expect(next.pendingTrackLocksById).toBe(pendingTrackLocksById)
})

test('retains a fade draft when clearing unrelated move fields', () => {
  const fades = { fadeInSec: 1, fadeOutSec: 2, fadeInCurve: 0.5, fadeOutCurve: -0.5 }

  expect(clearClipMovePatch({
    trackId: 'track-2',
    startSec: 3,
    fades,
  })).toEqual({ fades })
})

// C0f item 3. The renderer pieces Timeline composes for a local project (identity, projection overlays over the local
// snapshot, resolved tracks, local mix, mixer routing, history), with Timeline's history actions, while native plays.
// Each playing compile records the tracks it read, and each publication is diffed against the one before it.
class C0fAudioBuffer implements AudioBuffer {
  readonly sampleRate = 48_000
  readonly duration: number
  private readonly channel: Float32Array<ArrayBuffer>
  constructor(readonly length: number, readonly numberOfChannels: number) {
    this.duration = length / this.sampleRate
    this.channel = new Float32Array(length)
  }
  copyFromChannel(destination: Float32Array) { destination.set(this.channel.subarray(0, destination.length)) }
  copyToChannel(source: Float32Array) { this.channel.set(source.subarray(0, this.channel.length)) }
  getChannelData() { return this.channel }
}

// One entry per track and clip field, plus the clip's key order, which JSON fingerprints see.
const c0fView = (tracks: RuntimeTrack[], bufferIds: Map<AudioBuffer, number>) => {
  const view = new Map([['order', tracks.map((track) => track.id).join(',')]])
  for (const { clips, ...track } of tracks) {
    for (const [key, value] of Object.entries(track)) view.set(`${track.id}.${key}`, JSON.stringify(value) ?? 'undefined')
    view.set(`${track.id}.clipOrder`, clips.map((clip) => clip.id).join(','))
    for (const { buffer, ...clip } of clips) {
      view.set(`${track.id}.${clip.id}.keyOrder`, Object.keys(clip).join(','))
      view.set(`${track.id}.${clip.id}.buffer`, String(buffer ? bufferIds.get(buffer) : null))
      for (const [key, value] of Object.entries(clip)) view.set(`${track.id}.${clip.id}.${key}`, JSON.stringify(value) ?? 'undefined')
    }
  }
  return view
}

test.skipIf(isServer)('C0F a track-delete undo while native plays publishes once per user action', async () => {
  const restoreWindow = installHermeticWindow({ clearTimeout, setTimeout })
  const audioBuffer = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer')
  if (!audioBuffer) Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: C0fAudioBuffer })
  let dispose = () => {}
  let mounted: Awaited<ReturnType<typeof mountStep5Playback>> | undefined
  try {
    const project = await createLocalProject(`C0F remove-readd ${crypto.randomUUID()}`)
    const repository = createLocalTimelineRepository(project.id)
    const retainedTrack = (await repository.loadSnapshot()).tracks[0]
    if (!retainedTrack) throw new Error('Expected a persisted track.')
    const changedTrack = await repository.createTrack({ index: 1, name: 'Changed right' })
    const source = { sourceKind: 'upload' as const, sourceDurationSec: 0.25, sourceSampleRate: 48_000, sourceChannelCount: 2 }
    const retainedClip = await repository.createClip({ trackId: retainedTrack.id, name: 'retained.wav', startSec: 0,
      duration: 0.25, sourceAssetKey: 'asset-c0f-retained', ...source })
    const changedClip = await repository.createClip({ trackId: changedTrack.id, name: 'changed.wav', startSec: 0,
      duration: 0.25, sourceAssetKey: 'asset-c0f-changed', ...source })
    const buffers = new Map<string, AudioBuffer>([[retainedClip.id, new C0fAudioBuffer(12_000, 2)], [changedClip.id, new C0fAudioBuffer(12_000, 2)]])
    const bufferIds = new Map([...buffers.values()].map((buffer, index) => [buffer, index + 1]))
    const [localSnapshot] = createSignal<TimelineSnapshot | null>(await repository.loadSnapshot())
    const projectId = () => project.id
    const undone = Promise.withResolvers<void>()
    let historyActions: TimelineHistoryActions | undefined
    let rescheduleChangedClips = (_clipIds: string[]) => {}
    const timeline = createRoot((cleanup) => {
      dispose = cleanup
      const identity = useTimelineIdentity({ projectId, serverData: () => undefined })
      const projection = useTimelineProjectionState({ projectId, serverData: () => undefined,
        rememberTrackProjection: identity.rememberTrackProjection, rememberClipHistoryRef: identity.rememberClipHistoryRef })
      const [renderTracks, setRenderTracks] = createSignal<RuntimeTrack[]>([])
      const writable = new Set([retainedTrack.id, changedTrack.id])
      const writableTrackIds = () => writable
      const localMix = useTimelineLocalMix({ projectId, writableTrackIds })
      const mixer = useTimelineMixerController({ projectId, userId: () => '', syncMix: () => false, tracks: renderTracks, localMix,
        optimisticTrackIds: () => new Set(), canWriteTrack: () => true, pushHistory: () => undefined, serverTrackState: () => null })
      const resolved = useTimelineResolvedModel({ projectId, fullViewData: () => undefined, localSnapshot, syncMix: () => false,
        writableTrackIds, serverTrackState: () => null, localMixByTrackId: localMix.byTrackId,
        pendingSharedTrackVolumes: mixer.pendingSharedTrackVolumes, pendingSharedTrackRouting: mixer.pendingSharedTrackRouting,
        pendingSharedTrackMix: mixer.pendingSharedTrackMix,
        projection: { pendingTrackEntriesById: projection.pendingTrackEntriesById, removedTrackIds: projection.removedTrackIds,
          pendingTrackLocksById: projection.pendingTrackLocksById, pendingClipCreatesById: projection.pendingClipCreatesById,
          removedClipIds: projection.removedClipIds, committedClipEditsById: projection.committedClipEditsById,
          draftClipEditsById: projection.draftClipEditsById, previewClipsByTrackId: projection.previewClipsByTrackId },
        identity, buffers: { getBuffer: (clipId) => buffers.get(clipId), getMediaStatus: () => undefined }, bufferVersion: () => 0 })
      createEffect(() => { setRenderTracks(resolved.renderTracks()) })
      const history = useTimelineHistory({ projectId, userId: () => 'local', getTracks: renderTracks, convexClient, convexApi,
        grantTrackWrite: () => {}, grantClipWrite: () => {}, persistLocalMix: (_projectId, trackId, patch) => localMix.persist(trackId, patch),
        notify: (title, message) => undone.reject(new Error(`${title}: ${message}`)),
        getActions: () => {
          if (!historyActions) throw new Error('Timeline history actions are not initialized.')
          return historyActions
        } })
      createEffect(() => { if (history.canRedo()) undone.resolve() })
      historyActions = {
        insertLocalTrack: projection.insertLocalTrack, removeLocalTrack: projection.removeLocalTrack,
        insertLocalClip: projection.insertLocalClip, replaceLocalClip: projection.replaceLocalClip,
        removeLocalClips: projection.removeLocalClips, commitClipMoves: projection.commitClipMoves,
        commitClipTiming: projection.commitClipTiming, commitClipAudioWarp: projection.commitClipAudioWarp,
        commitClipFades: projection.commitClipFades, commitClipMidi: () => {},
        rescheduleChangedClips: (clipIds) => rescheduleChangedClips(clipIds),
        cancelTrackVolumeWrite: mixer.cancelTrackVolumeWrite, cancelTrackRoutingWrite: mixer.cancelTrackRoutingWrite,
        cancelTrackMixWrite: mixer.cancelTrackMixWrite, applyTrackVolume: mixer.applyTrackVolume,
        applyTrackMixState: mixer.applyTrackMixState,
        applyTrackRouting: (trackId, routing) => mixer.applyTrackRouting(trackId, { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId }),
        applyTrackPatch: () => {}, applyAutomationEnvelope: () => {},
      }
      return { projection, renderTracks, history }
    })
    // What each playing compile read: the fixture compiles `tracks()` right after its render state resolves.
    const compiles: { at: number; view: Map<string, string> }[] = []
    let armed = false
    let hostCalls: readonly string[] = []
    const tracks = () => {
      const current = timeline.renderTracks()
      if (armed) {
        armed = false
        compiles.push({ at: hostCalls.length, view: c0fView(current, bufferIds) })
      }
      return current
    }
    const fx = () => ({ masterVolume: 1, masterFxInstances: [], trackFx: {} })
    const f = await mountStep5Playback({ projectId: project.id, tracks, playbackInputs: () => ({ masterVolume: 1, automation: [], sidechains: [] }),
      desiredFx: fx, renderState: async () => { armed = true; return { fx: fx(), automationEnvelopes: [] } } })
    mounted = f
    hostCalls = f.host.calls
    // Timeline.rescheduleChangedClips → rebuildPlaybackBackend with captureStructuralPlaybackIntent.
    rescheduleChangedClips = (clipIds) => {
      if (clipIds.length === 0 || !f.playback.isNativePlaybackPrepared()) return
      void f.playback.restartTimelineSchedule(timeline.renderTracks(), { rebuildBackend: true, resumePlayback: f.playback.isPlaying(),
        playheadSec: f.playback.playheadSec(), owner: 'native', projectId: project.id, projectGeneration: undefined })
    }
    await f.playback.handlePlay(timeline.renderTracks()); await f.frame()
    const actions: { name: string; from: number; to: number }[] = []
    const act = async (name: string, run: () => Promise<void>) => {
      const from = f.host.calls.length
      await run()
      await f.frame(); await settleStep5Playback(); await f.frame()
      actions.push({ name, from, to: f.host.calls.length })
    }
    // useTimelineClipActions.performDeleteTrack, local project branch.
    await act('delete', async () => {
      const snapshot = timeline.renderTracks()
      const deleted = snapshot.find((track) => track.id === changedTrack.id)
      if (!deleted) throw new Error('Changed track is not projected.')
      const entry = buildTrackDeleteHistoryEntry({ projectId: project.id, track: deleted, tracks: snapshot,
        effects: await loadTrackEffectSnapshot(project.id, deleted.id), automation: [], sidechainRoutes: [] })
      await createLocalTimelineRepository(project.id).deleteTrack(deleted.id)
      timeline.history.pushHistory({ type: 'section-edit', projectId: project.id, data: { entries: [entry] } })
      timeline.projection.removeLocalTrack(deleted.id)
    })
    await act('undo', async () => {
      timeline.history.handleUndo()
      await undone.promise
    })
    await act('trim', async () => { timeline.projection.commitClipTiming(changedClip.id, { duration: 0.2 }) })
    const publications = f.host.calls.flatMap((call, index) => {
      if (call !== 'revision.publish') return []
      const prepared = f.host.calls.lastIndexOf('revision.prepare', index)
      const compile = compiles.findLast((entry) => entry.at <= prepared)
      return [{ index, action: actions.find((entry) => entry.from <= index && index < entry.to)?.name, view: compile?.view ?? new Map<string, string>() }]
    })
    const baseline = compiles.findLast((entry) => entry.at < (actions[0]?.from ?? 0))?.view ?? new Map<string, string>()
    const report = publications.map((publication, index) => {
      const previous = publications[index - 1]?.view ?? baseline
      const paths = new Set([...previous.keys(), ...publication.view.keys()])
      return { action: publication.action, changed: [...paths].filter((path) => previous.get(path) !== publication.view.get(path))
        .map((path) => `${path}: ${previous.get(path) ?? '(absent)'} -> ${publication.view.get(path) ?? '(absent)'}`) }
    })
    console.log('C0F-RRT', JSON.stringify({ actions, calls: f.host.calls, compiledAt: compiles.map((entry) => entry.at),
      compilations: f.compilations.map((entry) => entry.mode), report }, null, 1))
    const restored = timeline.renderTracks().find((track) => track.id === changedTrack.id)
    expect({ perAction: Object.fromEntries(['delete', 'undo', 'trim'].map((name) => [name, report.filter((entry) => entry.action === name).length])),
      total: publications.length, restored: restored?.clips.map((clip) => ({ id: clip.id, duration: clip.duration, buffered: !!clip.buffer })),
      faults: f.faults })
      .toEqual({ perAction: { delete: 1, undo: 1, trim: 1 }, total: 3,
        restored: [{ id: changedClip.id, duration: 0.2, buffered: true }], faults: [] })
  } finally {
    await mounted?.close()
    dispose()
    restoreWindow()
    if (!audioBuffer) Reflect.deleteProperty(globalThis, 'AudioBuffer')
  }
})

// C0g. The C0f item 3 route with Timeline's compile revisions: Timeline.rescheduleChangedClips → rebuildPlaybackBackend
// bumps nativePlaybackRevision before its request. The changed track holds a local audio clip, a MIDI clip or an audio
// clip with a sampleUrl. The route ends with a trim (one publication per user action), or with Pause and Play (the
// resume plays the paused graph).
const c0gTrackDeleteUndo = async (variant: 'audio' | 'midi' | 'sampleUrl', ending: 'trim' | 'pause-play') => {
  const restoreWindow = installHermeticWindow({ clearTimeout, setTimeout })
  const audioBuffer = Object.getOwnPropertyDescriptor(globalThis, 'AudioBuffer')
  if (!audioBuffer) Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: C0fAudioBuffer })
  let dispose = () => {}
  let mounted: Awaited<ReturnType<typeof mountStep5Playback>> | undefined
  try {
    const project = await createLocalProject(`C0G remove-readd ${variant} ${crypto.randomUUID()}`)
    const repository = createLocalTimelineRepository(project.id)
    const retainedTrack = (await repository.loadSnapshot()).tracks[0]
    if (!retainedTrack) throw new Error('Expected a persisted track.')
    const changedTrack = await repository.createTrack({ index: 1, name: 'Changed right', kind: variant === 'midi' ? 'instrument' : 'audio' })
    const retainedClip = await repository.createClip({ trackId: retainedTrack.id, name: 'retained.wav', startSec: 0, duration: 0.25,
      sourceAssetKey: 'asset-c0g-retained', sourceKind: 'upload', sourceDurationSec: 0.25, sourceSampleRate: 48_000, sourceChannelCount: 2 })
    const changedClip = await repository.createClip(variant === 'midi'
      ? { trackId: changedTrack.id, name: 'changed', startSec: 0, duration: 0.25,
        midi: { wave: 'sine', notes: [{ id: 'note-c0g', pitch: 60, beat: 0, length: 0.25, velocity: 0.8 }] } }
      : { trackId: changedTrack.id, name: 'changed.wav', startSec: 0, duration: 0.25, sourceAssetKey: 'asset-c0g-changed',
        sourceKind: 'upload', sourceDurationSec: 0.25, sourceSampleRate: 48_000, sourceChannelCount: 2,
        sampleUrl: variant === 'sampleUrl' ? 'https://r2.example/asset-c0g-changed.wav' : undefined })
    const buffers = new Map<string, AudioBuffer>([[retainedClip.id, new C0fAudioBuffer(12_000, 2)]])
    if (variant !== 'midi') buffers.set(changedClip.id, new C0fAudioBuffer(12_000, 2))
    const bufferIds = new Map([...buffers.values()].map((buffer, index) => [buffer, index + 1]))
    const [localSnapshot] = createSignal<TimelineSnapshot | null>(await repository.loadSnapshot())
    const projectId = () => project.id
    const undone = Promise.withResolvers<void>()
    let historyActions: TimelineHistoryActions | undefined
    let rescheduleChangedClips = (_clipIds: string[]) => {}
    const timeline = createRoot((cleanup) => {
      dispose = cleanup
      const identity = useTimelineIdentity({ projectId, serverData: () => undefined })
      const projection = useTimelineProjectionState({ projectId, serverData: () => undefined,
        rememberTrackProjection: identity.rememberTrackProjection, rememberClipHistoryRef: identity.rememberClipHistoryRef })
      const [renderTracks, setRenderTracks] = createSignal<RuntimeTrack[]>([])
      const writable = new Set([retainedTrack.id, changedTrack.id])
      const writableTrackIds = () => writable
      const localMix = useTimelineLocalMix({ projectId, writableTrackIds })
      const mixer = useTimelineMixerController({ projectId, userId: () => '', syncMix: () => false, tracks: renderTracks, localMix,
        optimisticTrackIds: () => new Set(), canWriteTrack: () => true, pushHistory: () => undefined, serverTrackState: () => null })
      const resolved = useTimelineResolvedModel({ projectId, fullViewData: () => undefined, localSnapshot, syncMix: () => false,
        writableTrackIds, serverTrackState: () => null, localMixByTrackId: localMix.byTrackId,
        pendingSharedTrackVolumes: mixer.pendingSharedTrackVolumes, pendingSharedTrackRouting: mixer.pendingSharedTrackRouting,
        pendingSharedTrackMix: mixer.pendingSharedTrackMix,
        projection: { pendingTrackEntriesById: projection.pendingTrackEntriesById, removedTrackIds: projection.removedTrackIds,
          pendingTrackLocksById: projection.pendingTrackLocksById, pendingClipCreatesById: projection.pendingClipCreatesById,
          removedClipIds: projection.removedClipIds, committedClipEditsById: projection.committedClipEditsById,
          draftClipEditsById: projection.draftClipEditsById, previewClipsByTrackId: projection.previewClipsByTrackId },
        identity, buffers: { getBuffer: (clipId) => buffers.get(clipId), getMediaStatus: () => undefined }, bufferVersion: () => 0 })
      createEffect(() => { setRenderTracks(resolved.renderTracks()) })
      const history = useTimelineHistory({ projectId, userId: () => 'local', getTracks: renderTracks, convexClient, convexApi,
        grantTrackWrite: () => {}, grantClipWrite: () => {}, persistLocalMix: (_projectId, trackId, patch) => localMix.persist(trackId, patch),
        notify: (title, message) => undone.reject(new Error(`${title}: ${message}`)),
        getActions: () => {
          if (!historyActions) throw new Error('Timeline history actions are not initialized.')
          return historyActions
        } })
      createEffect(() => { if (history.canRedo()) undone.resolve() })
      historyActions = {
        insertLocalTrack: projection.insertLocalTrack, removeLocalTrack: projection.removeLocalTrack,
        insertLocalClip: projection.insertLocalClip, replaceLocalClip: projection.replaceLocalClip,
        removeLocalClips: projection.removeLocalClips, commitClipMoves: projection.commitClipMoves,
        commitClipTiming: projection.commitClipTiming, commitClipAudioWarp: projection.commitClipAudioWarp,
        commitClipFades: projection.commitClipFades, commitClipMidi: () => {},
        rescheduleChangedClips: (clipIds) => rescheduleChangedClips(clipIds),
        cancelTrackVolumeWrite: mixer.cancelTrackVolumeWrite, cancelTrackRoutingWrite: mixer.cancelTrackRoutingWrite,
        cancelTrackMixWrite: mixer.cancelTrackMixWrite, applyTrackVolume: mixer.applyTrackVolume,
        applyTrackMixState: mixer.applyTrackMixState,
        applyTrackRouting: (trackId, routing) => mixer.applyTrackRouting(trackId, { sends: routing.sends ?? [], outputTargetId: routing.outputTargetId }),
        applyTrackPatch: () => {}, applyAutomationEnvelope: () => {},
      }
      return { projection, renderTracks, history }
    })
    // Timeline's nativePlaybackRevision: every playing compile reads it, and each rebuild request bumps it first.
    let revision = 1
    const compiles: { at: number; revision: number; view: Map<string, string> }[] = []
    let armed = false
    let hostCalls: readonly string[] = []
    const tracks = () => {
      const current = timeline.renderTracks()
      if (armed) {
        armed = false
        compiles.push({ at: hostCalls.length, revision, view: c0fView(current, bufferIds) })
      }
      return current
    }
    const fx = () => ({ masterVolume: 1, masterFxInstances: [], trackFx: {} })
    const f = await mountStep5Playback({ projectId: project.id, tracks, playbackInputs: () => ({ masterVolume: 1, automation: [], sidechains: [] }),
      desiredFx: fx, renderState: async () => { armed = true; return { fx: fx(), automationEnvelopes: [] } }, revision: () => revision })
    mounted = f
    hostCalls = f.host.calls
    // Timeline.rescheduleChangedClips → rebuildPlaybackBackend with captureStructuralPlaybackIntent.
    rescheduleChangedClips = (clipIds) => {
      if (clipIds.length === 0 || !f.playback.isNativePlaybackPrepared()) return
      revision += 1
      void f.playback.restartTimelineSchedule(timeline.renderTracks(), { rebuildBackend: true, resumePlayback: f.playback.isPlaying(),
        playheadSec: f.playback.playheadSec(), owner: 'native', projectId: project.id, projectGeneration: undefined })
    }
    await f.playback.handlePlay(timeline.renderTracks()); await f.frame()
    const actions: { name: string; from: number; to: number }[] = []
    const act = async (name: string, run: () => Promise<void>) => {
      const from = f.host.calls.length
      await run()
      await f.frame(); await settleStep5Playback(); await f.frame()
      actions.push({ name, from, to: f.host.calls.length })
    }
    // useTimelineClipActions.performDeleteTrack, local project branch.
    await act('delete', async () => {
      const snapshot = timeline.renderTracks()
      const deleted = snapshot.find((track) => track.id === changedTrack.id)
      if (!deleted) throw new Error('Changed track is not projected.')
      const entry = buildTrackDeleteHistoryEntry({ projectId: project.id, track: deleted, tracks: snapshot,
        effects: await loadTrackEffectSnapshot(project.id, deleted.id), automation: [], sidechainRoutes: [] })
      await createLocalTimelineRepository(project.id).deleteTrack(deleted.id)
      timeline.history.pushHistory({ type: 'section-edit', projectId: project.id, data: { entries: [entry] } })
      timeline.projection.removeLocalTrack(deleted.id)
    })
    await act('undo', async () => {
      timeline.history.handleUndo()
      await undone.promise
    })
    if (ending === 'trim') await act('trim', async () => { timeline.projection.commitClipTiming(changedClip.id, { duration: 0.2 }) })
    else {
      await act('pause', () => f.playback.handlePause())
      await act('play', () => f.playback.handlePlay(timeline.renderTracks()))
    }
    const publications = f.host.calls.flatMap((call, index) => {
      if (call !== 'revision.publish') return []
      const prepared = f.host.calls.lastIndexOf('revision.prepare', index)
      const compile = compiles.findLast((entry) => entry.at <= prepared)
      return [{ index, action: actions.find((entry) => entry.from <= index && index < entry.to)?.name, view: compile?.view ?? new Map<string, string>() }]
    })
    const baseline = compiles.findLast((entry) => entry.at < (actions[0]?.from ?? 0))?.view ?? new Map<string, string>()
    const report = publications.map((publication, index) => {
      const previous = publications[index - 1]?.view ?? baseline
      const paths = new Set([...previous.keys(), ...publication.view.keys()])
      return { action: publication.action, changed: [...paths].filter((path) => previous.get(path) !== publication.view.get(path))
        .map((path) => `${path}: ${previous.get(path) ?? '(absent)'} -> ${publication.view.get(path) ?? '(absent)'}`) }
    })
    const play = actions.find((entry) => entry.name === 'play')
    const resumed = play ? f.host.calls.slice(play.from, play.to) : []
    console.log('C0G-RRT', JSON.stringify({ variant, ending, actions, calls: f.host.calls,
      compiled: compiles.map((entry) => ({ at: entry.at, revision: entry.revision })), report, resumed }, null, 1))
    const restored = timeline.renderTracks().find((track) => track.id === changedTrack.id)
    return {
      perAction: Object.fromEntries(actions.map(({ name }) => [name, report.filter((entry) => entry.action === name).length])),
      total: publications.length,
      restored: restored?.clips.map((clip) => ({ id: clip.id, duration: clip.duration, buffered: !!clip.buffer, midi: !!clip.midi,
        sampleUrl: clip.sampleUrl })),
      revisions: [...new Set(compiles.map((entry) => entry.revision))],
      cold: resumed.filter((call) => ['stop', 'teardown', 'begin', 'configure', 'graph', 'commit', 'start'].includes(call)),
      playing: f.playback.isPlaying(),
      faults: f.faults,
      changedClipId: changedClip.id,
    }
  } finally {
    await mounted?.close()
    dispose()
    restoreWindow()
    if (!audioBuffer) Reflect.deleteProperty(globalThis, 'AudioBuffer')
  }
}

test.skipIf(isServer)('C0G a track-delete undo of a MIDI clip while native plays publishes once per user action', async () => {
  const outcome = await c0gTrackDeleteUndo('midi', 'trim')
  expect({ ...outcome, changedClipId: undefined }).toEqual({ perAction: { delete: 1, undo: 1, trim: 1 }, total: 3,
    restored: [{ id: outcome.changedClipId, duration: 0.2, buffered: false, midi: true, sampleUrl: undefined }],
    revisions: [1, 2], cold: [], playing: true, faults: [], changedClipId: undefined })
})

test.skipIf(isServer)('C0G a track-delete undo of a sampleUrl clip while native plays publishes once per user action', async () => {
  const outcome = await c0gTrackDeleteUndo('sampleUrl', 'trim')
  expect({ ...outcome, changedClipId: undefined }).toEqual({ perAction: { delete: 1, undo: 1, trim: 1 }, total: 3,
    restored: [{ id: outcome.changedClipId, duration: 0.2, buffered: true, midi: false, sampleUrl: 'https://r2.example/asset-c0g-changed.wav' }],
    revisions: [1, 2], cold: [], playing: true, faults: [], changedClipId: undefined })
})

test.skipIf(isServer)('C0G play, delete a track, undo, Pause and Play resumes the paused graph warm', async () => {
  const outcome = await c0gTrackDeleteUndo('audio', 'pause-play')
  expect({ ...outcome, changedClipId: undefined }).toEqual({ perAction: { delete: 1, undo: 1, pause: 0, play: 0 }, total: 2,
    restored: [{ id: outcome.changedClipId, duration: 0.25, buffered: true, midi: false, sampleUrl: undefined }],
    revisions: [1, 2], cold: [], playing: true, faults: [], changedClipId: undefined })
})
