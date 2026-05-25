import type { FunctionReturnType } from 'convex/server'
import { batch, type Accessor, type Setter } from 'solid-js'

import { buildClipCreateSnapshot, buildCreatedClipSelection, createProjectedClips, createProjectedLocalClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import { buildClipRemoveManyMutationInput } from '~/lib/clip-mutation-args'
import { getTrackDeleteConflictMessage } from '~/lib/delete-conflict-messages'
import { buildTrackEffectQueryArgs } from '~/lib/effect-track-args'
import { getLocalEffect } from '~/lib/local-effects'
import { isLocalId } from '~/lib/local-ids'
import type { OptimisticGrantScope } from '~/lib/optimistic-grant-scope'
import { isClipCompatibleWithTrack } from '~/lib/track-routing'
import { buildTrackDeleteMutationInput } from '~/lib/track-mutation-args'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { calcNonOverlapStart, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { buildClipDeleteHistoryEntry, buildTrackDeleteHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry, TrackEffectSnapshot } from '~/lib/undo/types'
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
  projectId: Accessor<string | undefined>
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
    projectId,
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
    const rid = projectId()
    const uid = userId()
    if (!rid || !uid) {
      return {
        eq: undefined,
        reverb: undefined,
        synth: undefined,
        arp: undefined,
      }
    }
    const args = buildTrackEffectQueryArgs({ projectId: rid, userId: uid, trackId })
    const [eqRow, rvRow, synthRow, arpRow] = await Promise.all([
      queryTrackEffect(() => convexClient.query(convexApi.effects.getEqForTrack, args)),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getReverbForTrack, args)),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getSynthForTrack, args)),
      queryTrackEffect(() => convexClient.query(convexApi.effects.getArpeggiatorForTrack, args)),
    ])

    return {
      eq: eqRow?.params,
      reverb: rvRow?.params,
      synth: synthRow?.params,
      arp: arpRow?.params,
    }
  }

  const loadLocalTrackDeleteEffects = async (projectId: string, trackId: Track['id']): Promise<TrackEffectSnapshot> => {
    const [eqRow, rvRow, synthRow, arpRow] = await Promise.all([
      getLocalEffect<TrackEffectSnapshot['eq']>(projectId, trackId, 'eq'),
      getLocalEffect<TrackEffectSnapshot['reverb']>(projectId, trackId, 'reverb'),
      getLocalEffect<TrackEffectSnapshot['synth']>(projectId, trackId, 'synth'),
      getLocalEffect<TrackEffectSnapshot['arp']>(projectId, trackId, 'arp'),
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

    const rid = projectId()
    const snapshot = tracks()
    const reconcileSelectionAfterDelete = (removedIds: Set<string>) => {
      const remainingSelectedIds = new Set(Array.from(selectedIds).filter((clipId) => !removedIds.has(clipId)))
      const nextPrimary: SelectedClip = (() => {
        if (remainingSelectedIds.size === 0) return null
        for (const track of snapshot) {
          const clip = track.clips.find((entry) => remainingSelectedIds.has(entry.id))
          if (clip) return { trackId: track.id, clipId: clip.id }
        }
        return null
      })()

      batch(() => {
        selection.setSelectedClip(nextPrimary)
        selection.setSelectedClipIds(remainingSelectedIds)
        if (nextPrimary) {
          selection.setSelectedTrackId(nextPrimary.trackId)
          selection.setSelectedFXTarget(nextPrimary.trackId)
        }
      })
    }

    if (rid && isLocalId('project', rid)) {
      const repository = createLocalTimelineRepository(rid)
      await repository.deleteClips(Array.from(writableSelectedIds))
      try {
        if (typeof historyPush === 'function') {
          const entry = buildClipDeleteHistoryEntry({ projectId: rid, tracks: snapshot, clipIds: writableSelectedIds })
          if (entry.data.items.length > 0) historyPush(entry)
        }
      } catch {}

      removeLocalClips(writableSelectedIds)
      reconcileSelectionAfterDelete(writableSelectedIds)
      return
    }

    const uid = userId()
    if (!uid) return

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

    try {
      const rid = projectId()
      if (rid && typeof historyPush === 'function') {
        const entry = buildClipDeleteHistoryEntry({ projectId: rid, tracks: snapshot, clipIds: removedIds })
        if (entry.data.items.length > 0) historyPush(entry)
      }
    } catch {}

    removeLocalClips(removedIds)
    reconcileSelectionAfterDelete(removedIds)
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

    const rid = projectId()
    if (rid && isLocalId('project', rid) && pending.length > 0) {
      const created = await createProjectedLocalClips({
        projectId: rid,
        items: pending,
        insertLocalClip,
        removeLocalClips,
        audioBufferCache,
      })
      const nextSelection = buildCreatedClipSelection(created)
      if (nextSelection) {
        selection.selectClipGroup(nextSelection)
      }
      for (const item of created) {
        pushClipCreateHistory({
          historyPush,
          projectId: rid,
          trackId: item.trackId,
          trackRef: getTrackHistoryRef(tsSnapshot.find((entry) => entry.id === item.trackId)),
          clipId: item.clipId,
          clip: item.clip,
        })
      }
      return
    }

    const uid = userId()
    if (!rid || !uid || pending.length === 0) return

    const created = await createProjectedClips({
      projectId: rid,
      userId: uid,
      items: pending,
      createMany: async (items) => await convexClient.mutation(convexApi.clips.createMany, { items }),
      insertLocalClip,
      audioBufferCache,
      grantClipWrites,
      grantScope: { projectId: rid, userId: uid },
    })

    for (const item of created) {
      pushClipCreateHistory({
        historyPush,
        projectId: rid,
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
    const snapshot = tracks()
    const track = snapshot.find(entry => entry.id === trackId)
    if (!track) return
    const rid = projectId()

    if (rid && isLocalId('project', rid)) {
      let historyEntry: ReturnType<typeof buildTrackDeleteHistoryEntry> | null = null
      try {
        if (typeof historyPush === 'function') {
          historyEntry = buildTrackDeleteHistoryEntry({
            projectId: rid,
            track,
            tracks: snapshot,
            effects: await loadLocalTrackDeleteEffects(rid, trackId),
          })
        }
      } catch {}
      await createLocalTimelineRepository(rid).deleteTrack(trackId)
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
      return
    }

    const uid = userId()
    if (!uid) return

    let historyEntry: ReturnType<typeof buildTrackDeleteHistoryEntry> | null = null
    try {
      if (rid && typeof historyPush === 'function') {
        historyEntry = buildTrackDeleteHistoryEntry({
          projectId: rid,
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
