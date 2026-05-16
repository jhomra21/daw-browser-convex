import type { FunctionReturnType } from 'convex/server'
import { batch, type Accessor, type Setter } from 'solid-js'

import { buildClipCreateSnapshot, buildCreatedClipSelection, createProjectedClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import { buildClipRemoveManyMutationInput } from '~/lib/clip-mutation-args'
import { getTrackDeleteConflictMessage } from '~/lib/delete-conflict-messages'
import { buildTrackEffectQueryArgs } from '~/lib/effect-track-args'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isClipCompatibleWithTrack } from '~/lib/track-routing'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { calcNonOverlapStart, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { buildClipDeleteHistoryEntry, buildTrackDeleteHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, SelectedClip, Track } from '~/types/timeline'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi
type TrackDeleteResult = FunctionReturnType<ConvexApiType['tracks']['remove']>

type TimelineClipActionsOptions = {
  tracks: Accessor<Track[]>
  insertLocalClip: (trackId: Track['id'], clip: Clip) => void
  removeLocalClips: (clipIds: Iterable<string>) => void
  removeLocalTrack: (trackId: Track['id']) => void
  canWriteClip: (clipId: string) => boolean
  selection: TimelineSelectionController
  setPendingDeleteTrackId: Setter<Track['id'] | null>
  setConfirmOpen: Setter<boolean>
  roomId: Accessor<string | undefined>
  userId: Accessor<string | undefined>
  convexClient: ConvexClientType
  convexApi: ConvexApiType
  audioBufferCache: Map<string, AudioBuffer>
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  historyPush?: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  grantClipWrites?: (clipIds: Iterable<string>, scope?: OptimisticGrantScope | null) => void
}

type TimelineClipActionsHandlers = {
  onClipPointerUp: (trackId: Track['id'], clipId: string, event: PointerEvent) => void
  duplicateSelectedClips: () => Promise<void>
  performDeleteTrack: (trackId: Track['id']) => Promise<void>
  handleKeyboardAction: () => void
}

export function useTimelineClipActions(options: TimelineClipActionsOptions): TimelineClipActionsHandlers {
  const {
    tracks,
    insertLocalClip,
    removeLocalClips,
    removeLocalTrack,
    canWriteClip,
    selection,
    setPendingDeleteTrackId,
    setConfirmOpen,
    roomId,
    userId,
    convexClient,
    convexApi,
    audioBufferCache,
    bpm,
    gridEnabled,
    gridDenominator,
    historyPush,
    grantClipWrites,
  } = options

  const onClipPointerUp = (trackId: Track['id'], clipId: string, event: PointerEvent) => {
    event.stopPropagation()
    if (!event.shiftKey) {
      selection.selectPrimaryClip({ trackId, clipId })
      return
    }
    selection.appendClipToSelection({ trackId, clipId })
  }

  const getWritableSelectedClipIds = (selectedIds: Set<string>) => new Set(
    Array.from(selectedIds).filter((clipId) => canWriteClip(clipId)),
  )

  const selectedTrackId = selection.selectedTrackId
  const selectedClipIds = selection.selectedClipIds

  const showTrackDeleteFailure = (result: TrackDeleteResult | null | undefined) => {
    if (result?.status === 'conflict') {
      window.alert(getTrackDeleteConflictMessage(result.reason))
      return
    }
    window.alert('This track could not be deleted.')
  }

  const queryTrackEffect = async <TRow>(read: () => Promise<TRow>): Promise<TRow | null> => {
    try {
      return await read()
    } catch {
      return null
    }
  }

  const loadTrackDeleteEffects = async (trackId: Track['id']) => {
    const [eqRow, rvRow, synthRow, arpRow] = await Promise.all([
      queryTrackEffect(() => convexClient.query(convexApi.effects.getEqForTrack, buildTrackEffectQueryArgs(trackId))),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getReverbForTrack, buildTrackEffectQueryArgs(trackId))),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getSynthForTrack, buildTrackEffectQueryArgs(trackId))),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getArpeggiatorForTrack, buildTrackEffectQueryArgs(trackId))),
    ])

    return {
      eq: eqRow?.params,
      reverb: rvRow?.params,
      synth: synthRow?.params,
      arp: arpRow?.params,
    }
  }

  const deleteSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const uid = userId()
    if (!uid) return

    const snapshot = tracks()
    const result = await convexClient.mutation(
      convexApi.clips.removeMany,
      buildClipRemoveManyMutationInput({ clipIds: Array.from(writableSelectedIds), userId: uid }),
    )
    const removedIds = new Set<string>(
      Array.isArray(result?.removedClipIds)
        ? result.removedClipIds.map((clipId: unknown) => String(clipId))
        : [],
    )
    if (removedIds.size === 0) return

    const remainingSelectedIds = new Set(Array.from(selectedIds).filter((clipId) => !removedIds.has(clipId)))
    const nextPrimary: SelectedClip = (() => {
      if (remainingSelectedIds.size === 0) return null
      for (const track of snapshot) {
        const clip = track.clips.find((entry) => remainingSelectedIds.has(entry.id))
        if (clip) return { trackId: track.id, clipId: clip.id }
      }
      return null
    })()

    try {
      const rid = roomId()
      if (rid && typeof historyPush === 'function') {
        const entry = buildClipDeleteHistoryEntry({ roomId: rid, tracks: snapshot, clipIds: removedIds })
        if (entry.data.items.length > 0) historyPush(entry)
      }
    } catch {}

    removeLocalClips(removedIds)

    batch(() => {
      selection.setSelectedClip(nextPrimary)
      selection.setSelectedClipIds(remainingSelectedIds)
      if (nextPrimary) {
        selection.setSelectedTrackId(nextPrimary.trackId)
        selection.setSelectedFXTarget(nextPrimary.trackId)
      }
    })
  }

  const duplicateSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const tsSnapshot = tracks()
    const byTrack = new Map<Track['id'], Clip[]>()
    for (const track of tsSnapshot) {
      const selected = track.clips.filter(clip => writableSelectedIds.has(clip.id))
      if (selected.length > 0) byTrack.set(track.id, selected)
    }

    const pending: BatchClipCreateItem[] = []

    for (const [trackId, clipsToDup] of byTrack.entries()) {
      const track = tsSnapshot.find(entry => entry.id === trackId)
      if (!track) continue
      const sorted = clipsToDup.slice().sort((left, right) => left.startSec - right.startSec)
      const groupStart = Math.min(...sorted.map(clip => clip.startSec))
      const groupEnd = Math.max(...sorted.map(clip => clip.startSec + clip.duration))
      const baseStart = groupEnd + 0.0001
      let simulatedClips = track.clips.map(clip => ({ ...clip }))

      for (const clip of sorted) {
        if (!isClipCompatibleWithTrack(track, clip)) continue
        const offset = clip.startSec - groupStart
        const desiredStart = baseStart + offset
        const safeStart = gridEnabled()
          ? calcNonOverlapStartGridAligned(simulatedClips, null, desiredStart, clip.duration, bpm(), gridDenominator())
          : calcNonOverlapStart(simulatedClips, null, desiredStart, clip.duration)
        pending.push({
          trackId,
          buffer: clip.buffer ?? audioBufferCache.get(clip.id) ?? null,
          clip: {
            ...buildClipCreateSnapshot(clip, { preserveHistoryRef: false }),
            startSec: safeStart,
          },
        })
        simulatedClips = [...simulatedClips, { ...clip, startSec: safeStart }]
      }
    }

    const rid = roomId()
    const uid = userId()
    if (!rid || !uid || pending.length === 0) return

    const created = await createProjectedClips({
      roomId: rid,
      userId: uid,
      items: pending,
      createMany: async (items) => await convexClient.mutation(convexApi.clips.createMany, { items }),
      insertLocalClip,
      audioBufferCache,
      grantClipWrites,
      grantScope: { roomId: rid, userId: uid },
    })

    for (const item of created) {
      pushClipCreateHistory({
        historyPush,
        roomId: rid,
        trackId: item.trackId,
        trackRef: getTrackHistoryRef(tsSnapshot.find((entry) => entry.id === item.trackId)),
        clipId: item.clipId,
        clip: item.clip,
      })
    }

    const nextSelection = buildCreatedClipSelection(created)
    if (nextSelection) {
      selection.selectClipGroup(nextSelection)
    }
  }

  const performDeleteTrack = async (trackId: Track['id']) => {
    const uid = userId()
    if (!uid) return

    const snapshot = tracks()
    const track = snapshot.find(entry => entry.id === trackId)
    if (!track) return

    let historyEntry: ReturnType<typeof buildTrackDeleteHistoryEntry> | null = null
    try {
      const rid = roomId()
      if (rid && typeof historyPush === 'function') {
        historyEntry = buildTrackDeleteHistoryEntry({
          roomId: rid,
          track,
          tracks: snapshot,
          effects: await loadTrackDeleteEffects(trackId),
        })
      }
    } catch {}

    const result = await convexClient.mutation(
      convexApi.tracks.remove,
      buildTrackDeleteMutationInput({ trackId, userId: uid }),
    )
    if (result?.status !== 'deleted') {
      showTrackDeleteFailure(result)
      return
    }

    if (historyEntry && typeof historyPush === 'function') {
      historyPush(historyEntry)
    }

    removeLocalTrack(trackId)

    const next = snapshot.filter(entry => entry.id !== trackId)
    batch(() => {
      if (next.length > 0) {
        selection.selectTrackTarget(next[0].id, { clearClipSelection: true })
      } else {
        selection.selectMasterTarget()
      }
    })
  }

  const requestDeleteSelectedTrack = () => {
    const id = selectedTrackId()
    if (!id) return
    const track = tracks().find(entry => entry.id === id)
    if (!track) return

    if (track.clips.length > 0) {
      setPendingDeleteTrackId(id)
      setConfirmOpen(true)
      return
    }

    void performDeleteTrack(id)
  }

  const handleKeyboardAction = () => {
    if (selectedClipIds().size > 0) {
      void deleteSelectedClips()
      return
    }
    requestDeleteSelectedTrack()
  }

  return {
    onClipPointerUp,
    duplicateSelectedClips,
    performDeleteTrack,
    handleKeyboardAction,
  }
}
