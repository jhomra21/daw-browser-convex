import { batch, type Accessor, type Setter } from 'solid-js'

import { buildClipCreateSnapshot, createManyClips, pushClipCreateHistory, type BatchClipCreateItem } from '~/lib/clip-create'
import { isClipCompatibleWithTrack } from '~/lib/track-routing'
import { appendClipToSelection, selectClipGroup, selectMasterTarget, selectPrimaryClip, selectTrackTarget } from '~/lib/timeline-selection'
import { calcNonOverlapStart, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import { buildClipDeleteHistoryEntry, buildTrackDeleteHistoryEntry } from '~/lib/undo/builders'
import { getTrackHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'
import type { Clip, SelectedClip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type TimelineClipActionsOptions = {
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  canWriteClip: (clipId: string) => boolean
  selectedTrackId: Accessor<string>
  setSelectedTrackId: Setter<string>
  selectedClipIds: Accessor<Set<string>>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedClip: Setter<SelectedClip>
  setSelectedFXTarget: Setter<string>
  setPendingDeleteTrackId: Setter<string | null>
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
  grantClipWrites?: (clipIds: Iterable<string>) => void
}

type TimelineClipActionsHandlers = {
  onClipClick: (trackId: string, clipId: string, event: MouseEvent) => void
  deleteSelectedClips: () => Promise<void>
  duplicateSelectedClips: () => Promise<void>
  performDeleteTrack: (trackId: string) => Promise<void>
  requestDeleteSelectedTrack: () => void
  handleKeyboardAction: () => void
}

export function useTimelineClipActions(options: TimelineClipActionsOptions): TimelineClipActionsHandlers {
  const {
    tracks,
    setTracks,
    canWriteClip,
    selectedTrackId,
    setSelectedTrackId,
    selectedClipIds,
    setSelectedClipIds,
    setSelectedClip,
    setSelectedFXTarget,
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

  const selectionSetters = {
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
  }

  const onClipClick = (trackId: string, clipId: string, event: MouseEvent) => {
    event.stopPropagation()
    if (!event.shiftKey) {
      selectPrimaryClip(selectionSetters, { trackId, clipId })
      return
    }
    appendClipToSelection(selectionSetters, { trackId, clipId })
  }

  const getWritableSelectedClipIds = (selectedIds: Set<string>) => new Set(
    Array.from(selectedIds).filter((clipId) => canWriteClip(clipId)),
  )

  const showTrackDeleteFailure = (result: any) => {
    if (result?.status === 'conflict') {
      switch (result.reason) {
        case 'foreign-clips':
          window.alert('This track cannot be deleted yet because it still contains clips owned by another collaborator.')
          return
        case 'not-empty':
          window.alert('This track cannot be deleted while it still contains clips.')
          return
      }
    }
    window.alert('This track could not be deleted.')
  }

  const deleteSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const uid = userId()
    if (!uid) return

    const snapshot = tracks()
    const result = await convexClient.mutation((convexApi as any).clips.removeMany, {
      clipIds: Array.from(writableSelectedIds) as any,
      userId: uid as any,
    }) as any
    const removedIds = new Set<string>(
      Array.isArray(result?.removedClipIds)
        ? result.removedClipIds.map((clipId: unknown) => String(clipId))
        : [],
    )
    if (removedIds.size === 0) return

    const remainingSelectedIds = new Set(Array.from(selectedIds).filter((clipId) => !removedIds.has(clipId)))
    const nextPrimary = (() => {
      if (remainingSelectedIds.size === 0) return null
      for (const track of snapshot) {
        const clip = track.clips.find((entry) => remainingSelectedIds.has(entry.id))
        if (clip) return { trackId: track.id, clipId: clip.id } as SelectedClip
      }
      return null
    })()

    try {
      const rid = roomId() as any
      if (rid && typeof historyPush === 'function') {
        const entry = buildClipDeleteHistoryEntry({ roomId: rid, tracks: snapshot, clipIds: removedIds })
        if (entry.data.items.length > 0) historyPush(entry)
      }
    } catch {}

    setTracks(ts => ts.map(track => ({
      ...track,
      clips: track.clips.filter(clip => !removedIds.has(clip.id)),
    })))

    batch(() => {
      setSelectedClip(nextPrimary)
      setSelectedClipIds(remainingSelectedIds)
      if (nextPrimary) {
        setSelectedTrackId(nextPrimary.trackId)
        setSelectedFXTarget(nextPrimary.trackId)
      }
    })
  }

  const duplicateSelectedClips = async () => {
    const selectedIds = selectedClipIds()
    if (selectedIds.size === 0) return
    const writableSelectedIds = getWritableSelectedClipIds(selectedIds)
    if (writableSelectedIds.size === 0) return

    const tsSnapshot = tracks()
    const byTrack = new Map<string, Clip[]>()
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
          buffer: clip.buffer ?? null,
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

    const created = await createManyClips({
      roomId: rid,
      userId: uid,
      items: pending,
      createMany: async (items) => await convexClient.mutation((convexApi as any).clips.createMany, { items }) as any as string[],
      audioBufferCache,
      grantClipWrites,
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

    const last = created[created.length - 1]
    if (last) {
      selectClipGroup(selectionSetters, {
        trackId: last.trackId,
        clipIds: created.map(item => item.clipId),
        primaryClipId: last.clipId,
      })
    }
  }

  const performDeleteTrack = async (trackId: string) => {
    const uid = userId()
    if (!uid) return

    const snapshot = tracks()
    const track = snapshot.find(entry => entry.id === trackId)
    if (!track) return

    let historyEntry: ReturnType<typeof buildTrackDeleteHistoryEntry> | null = null
    try {
      const rid = roomId() as any
      if (rid && typeof historyPush === 'function') {
        let eqRow: any = null
        let rvRow: any = null
        let synthRow: any = null
        let arpRow: any = null
        try { eqRow = await convexClient.query((convexApi as any).effects.getEqForTrack, { trackId: trackId as any } as any) } catch {}
        try { rvRow = await convexClient.query((convexApi as any).effects.getReverbForTrack, { trackId: trackId as any } as any) } catch {}
        try { synthRow = await convexClient.query((convexApi as any).effects.getSynthForTrack, { trackId: trackId as any } as any) } catch {}
        try { arpRow = await convexClient.query((convexApi as any).effects.getArpeggiatorForTrack, { trackId: trackId as any } as any) } catch {}
        historyEntry = buildTrackDeleteHistoryEntry({
          roomId: rid,
          track,
          tracks: snapshot,
          effects: { eq: eqRow?.params, reverb: rvRow?.params, synth: synthRow?.params, arp: arpRow?.params },
        })
      }
    } catch {}

    const result = await convexClient.mutation(convexApi.tracks.remove, { trackId: trackId as any, userId: uid as any }) as any
    if (result?.status !== 'deleted') {
      showTrackDeleteFailure(result)
      return
    }

    if (historyEntry && typeof historyPush === 'function') {
      historyPush(historyEntry)
    }

    setTracks(current => current
      .filter(entry => entry.id !== trackId)
      .map(entry => ({
        ...entry,
        outputTargetId: entry.outputTargetId === trackId ? undefined : entry.outputTargetId,
        sends: entry.sends?.filter(send => send.targetId !== trackId),
      })))

    const next = snapshot.filter(entry => entry.id !== trackId)
    batch(() => {
      if (next.length > 0) {
        selectTrackTarget(selectionSetters, next[0].id, { clearClipSelection: true })
      } else {
        selectMasterTarget(selectionSetters)
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
    onClipClick,
    deleteSelectedClips,
    duplicateSelectedClips,
    performDeleteTrack,
    requestDeleteSelectedTrack,
    handleKeyboardAction,
  }
}
