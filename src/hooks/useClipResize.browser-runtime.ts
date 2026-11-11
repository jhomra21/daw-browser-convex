import { createEffect, createMemo, createRoot, createSignal, untrack } from 'solid-js'
import { ConvexClient } from 'convex/browser'

import { useClipResize } from './useClipResize'
import { useTimelineSelectionState } from './useTimelineSelectionState'
import { api } from '../../convex/_generated/api'
import { resolveTimelineTracks } from '~/lib/resolve-timeline-tracks'
import type { ClipTimelinePatch, PendingTrackEntry } from '~/lib/resolve-timeline-tracks'
import type { TimelineSnapshot } from '~/lib/timeline-repository/types'

const scroll = document.createElement('div')
scroll.style.cssText = 'position:fixed;left:0;top:0;width:1000px;height:400px'
document.body.append(scroll)

const clips = Array.from({ length: 10_001 }, (_, index) => ({
  id: `clip:${index}`,
  trackId: 'track:dense',
  historyRef: `clip:${index}`,
  name: `Clip ${index}`,
  startSec: index * 4,
  duration: index === 5_000 ? 2 : 1,
  color: 'blue',
  createdAt: 0,
  updatedAt: 0,
}))
let constraintComputations = 0
let committedDuration: number | undefined
const commitDurations: number[] = []
const snapshot: TimelineSnapshot = {
  projectId: 'local:resize',
  tracks: [{
    id: 'track:dense',
    historyRef: 'track:dense',
    name: 'Dense',
    index: 0,
    volume: 1,
    muted: false,
    soloed: false,
    kind: 'audio',
    channelRole: 'track',
    sends: [],
    createdAt: 0,
    updatedAt: 0,
  }, {
    id: 'track:remote',
    historyRef: 'track:remote',
    name: 'Remote',
    index: 1,
    volume: 1,
    muted: false,
    soloed: false,
    kind: 'audio',
    channelRole: 'track',
    sends: [],
    createdAt: 0,
    updatedAt: 0,
  }],
  clips,
}
const committedEdits = new Map<string, ClipTimelinePatch>()
const emptyMix = {
  syncMix: true,
  writableTrackIds: new Set<string>(),
  localByTrackId: {},
  pendingSharedTrackVolumes: new Map(),
  pendingSharedTrackRouting: new Map(),
  pendingSharedMixByTrackId: new Map(),
}
const emptyTrackState = {
  pendingEntriesById: new Map<string, PendingTrackEntry>(),
  removedIds: new Set<string>(),
  pendingLocksById: new Map<string, string | null>(),
  historyRefsById: new Map<string, string>(),
  namesByHistoryRef: new Map<string, string>(),
}
const emptyBuffers = {
  getBuffer: () => undefined,
  getMediaStatus: () => undefined,
}
const [drafts, setDrafts] = createSignal(new Map<string, { duration?: number }>())
const [visibleStartSec, setVisibleStartSec] = createSignal(20_000)
let dispose = () => {}
createRoot((cleanup) => {
  dispose = cleanup
  const [projectId] = createSignal('cloud-project')
  const [currentSnapshot, setCurrentSnapshot] = createSignal(snapshot)
  const [gridEnabled, setGridEnabled] = createSignal(false)
  const resolve = (draftEditsById: Map<string, { duration?: number }>) => resolveTimelineTracks({
    projectId: currentSnapshot().projectId,
    server: { localSnapshot: currentSnapshot() },
    client: {
      mix: emptyMix,
      tracks: emptyTrackState,
      clips: {
        pendingCreatesById: new Map(),
        removedIds: new Set(),
        committedEditsById: committedEdits,
        draftEditsById,
        previewByTrackId: new Map(),
        historyRefsById: new Map(),
      },
    },
    buffers: emptyBuffers,
  })
  const committedTracks = createMemo(() => {
    return resolve(committedEdits).map((track) => (
      track.id === 'track:dense'
        ? {
            ...track,
            clips: new Proxy(track.clips, {
        get(target, key) {
          if (key === Symbol.iterator) {
            return function* () {
              constraintComputations += 1
              yield* target
            }
          }
          if (key === 'find') {
            return (...args: Parameters<typeof target.find>) => target.find(...args)
          }
          return undefined
        },
            }),
          }
        : track
    ))
  })
  const resolvedTracks = createMemo(() => resolve(drafts()))
  createEffect(() => { resolvedTracks() })
  const selection = useTimelineSelectionState({ projectId, tracks: resolvedTracks })
  let projectionUpdates = 0
  const resize = useClipResize({
    tracks: committedTracks,
    draftClipTiming: (clipId) => drafts().get(clipId),
    setDraftClipTiming: (clipId, patch) => {
      setDrafts((current) => {
        const next = new Map(current)
        if (patch) next.set(clipId, patch)
        else next.delete(clipId)
        return next
      })
      projectionUpdates += 1
    },
    commitClipTiming: (_clipId, patch) => {
      committedDuration = patch.duration
      commitDurations.push(patch.duration)
    },
    canWriteClip: () => true,
    selection,
    convexClient: new ConvexClient('https://example.convex.cloud'),
    convexApi: api,
    userId: () => 'user',
    getScrollElement: () => scroll,
    bpm: () => 120,
    gridEnabled,
    gridDenominator: () => 4,
    pixelsPerSecond: () => 100,
    visibleStartSec,
    rescheduleChangedClips: () => {},
    projectId: () => 'cloud-project',
    historyPush: () => {},
  })
  const target = document.createElement('div')
  document.body.append(target)
  target.addEventListener('pointerdown', (event) => {
    resize.onClipResizeStart(
      'track:dense',
      'clip:5000',
      event.clientX < 200 ? 'left' : 'right',
      event,
    )
  })
  const startResize = (edge: 'left' | 'right', pointerId: number) => {
    target.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      pointerId,
      clientX: edge === 'left' ? 100 : 500,
      bubbles: true,
      cancelable: true,
    }))
  }
  const moveResize = (pointerId: number, clientX: number) => {
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientX }))
  }
  const readTiming = () => {
    const clip = untrack(resolvedTracks)
      .flatMap((track) => track.clips)
      .find((candidate) => candidate.id === 'clip:5000')
    return { startSec: clip?.startSec, duration: clip?.duration }
  }
  startResize('right', 4)
  const initialConstraintComputations = constraintComputations
  for (let index = 0; index < 50; index += 1) {
    moveResize(4, 150 + index)
  }
  const resolvedTarget = untrack(resolvedTracks)
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === 'clip:5000')
  const projectedDuration = resolvedTarget?.duration
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4 }))
  const initialCommittedDuration = committedDuration
  const noDraftConstraintComputations = constraintComputations - initialConstraintComputations
  const remoteNeighbor = {
    id: 'clip:remote-neighbor',
    trackId: 'track:dense',
    historyRef: 'clip:remote-neighbor',
    name: 'Remote neighbor',
    startSec: 20_002,
    duration: 1,
    color: 'blue',
    createdAt: 0,
    updatedAt: 0,
  }
  startResize('right', 5)
  setCurrentSnapshot({
    ...snapshot,
    clips: [...snapshot.clips, remoteNeighbor],
  })
  moveResize(5, 800)
  const insertedNeighborDuration = readTiming().duration
  setCurrentSnapshot({
    ...snapshot,
  })
  moveResize(5, 800)
  const removedNeighborDuration = readTiming().duration
  setCurrentSnapshot({
    ...snapshot,
    tracks: [
      { ...snapshot.tracks[1], index: 0 },
      { ...snapshot.tracks[0], index: 1 },
    ],
    clips: snapshot.clips.map((clip) => (
      clip.id === 'clip:5001' ? { ...clip, startSec: 20_007 } : clip
    )),
  })
  moveResize(5, 800)
  const reorderedTrackDuration = readTiming().duration
  const remoteConstraintComputations = constraintComputations - initialConstraintComputations
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 5 }))
  setCurrentSnapshot(snapshot)
  setGridEnabled(true)
  startResize('left', 6)
  moveResize(6, 151)
  const snappedLeftTiming = readTiming()
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 6 }))
  startResize('right', 7)
  moveResize(7, 231)
  const snappedRightTiming = readTiming()
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }))
  const commitCountBeforeCancel = commitDurations.length
  startResize('right', 8)
  moveResize(8, 500)
  window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 8 }))
  const canceledTiming = readTiming()
  const cancelDidNotCommit = commitDurations.length === commitCountBeforeCancel
  const commitCountBeforeDialogEscape = commitDurations.length
  setGridEnabled(false)
  startResize('right', 9)
  moveResize(9, 650)
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const dialogButton = document.createElement('button')
  dialog.append(dialogButton)
  document.body.append(dialog)
  const dialogEscape = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
  dialogButton.dispatchEvent(dialogEscape)
  const dialogEscapeNotConsumed = !dialogEscape.defaultPrevented && resize.isResizing()
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9 }))
  dialog.remove()
  const dialogEscapeDoesNotCancelResize = dialogEscapeNotConsumed
    && commitDurations.length === commitCountBeforeDialogEscape + 1

  const commitCountBeforeTrackRemoval = commitDurations.length
  startResize('right', 10)
  moveResize(10, 650)
  setCurrentSnapshot({
    ...snapshot,
    tracks: [snapshot.tracks[1]],
    clips: snapshot.clips.filter((clip) => clip.trackId !== 'track:dense'),
  })
  window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 10 }))
  const removedTrackDoesNotCommit = commitDurations.length === commitCountBeforeTrackRemoval
  const removedTrackClearsDraft = !drafts().has('clip:5000')
  const removedTrackEndsResize = !resize.isResizing()
  setCurrentSnapshot(snapshot)

  setGridEnabled(false)
  setVisibleStartSec(19_996)
  startResize('left', 11)
  setCurrentSnapshot({
    ...snapshot,
    clips: snapshot.clips.map((clip) => (
      clip.id === 'clip:4999' ? { ...clip, startSec: 19_998, duration: 1.5 } : clip
    )),
  })
  moveResize(11, 250)
  const leftResizeWithRemoteNeighborStartSec = readTiming().startSec ?? 0
  window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 11 }))

  Object.defineProperty(window, '__clipResizeDenseResult', {
    value: {
      constraintComputations: remoteConstraintComputations,
      noDraftConstraintComputations,
      duration: projectedDuration,
      committedDuration: initialCommittedDuration,
      projectionUpdates,
      isResizing: resize.isResizing(),
      insertedNeighborDuration,
      removedNeighborDuration,
      reorderedTrackDuration,
      snappedLeftStartSec: snappedLeftTiming.startSec,
      snappedLeftDuration: snappedLeftTiming.duration,
      snappedRightDuration: snappedRightTiming.duration,
      canceledStartSec: canceledTiming.startSec,
      canceledDuration: canceledTiming.duration,
      cancelDidNotCommit,
      dialogEscapeDoesNotCancelResize,
      removedTrackDoesNotCommit,
      removedTrackClearsDraft,
      removedTrackEndsResize,
      leftResizeWithRemoteNeighborStartSec,
    },
  })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
  dispose()
  target.remove()
  scroll.remove()
})
