import { batch, type Accessor, type Setter } from 'solid-js'

import { calcNonOverlapStart, calcNonOverlapStartGridAligned } from '~/lib/timeline-utils'
import type { Clip, SelectedClip, Track } from '~/types/timeline'

type ConvexClientType = typeof import('~/lib/convex').convexClient

type ConvexApiType = typeof import('~/lib/convex').convexApi

type TimelineClipActionsOptions = {
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
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
  // snapping
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
}

type TimelineClipActionsHandlers = {
  onClipClick: (trackId: string, clipId: string, event: MouseEvent) => void
  deleteSelectedClips: () => void
  duplicateSelectedClips: () => Promise<void>
  performDeleteTrack: (trackId: string) => void
  requestDeleteSelectedTrack: () => void
  handleKeyboardAction: () => void
}

export function useTimelineClipActions(options: TimelineClipActionsOptions): TimelineClipActionsHandlers {
  const {
    tracks,
    setTracks,
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
  } = options

  const onClipClick = (trackId: string, clipId: string, event: MouseEvent) => {
    event.stopPropagation()
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      if (event.shiftKey) {
        setSelectedClipIds(prev => {
          const next = new Set(prev)
          next.add(clipId)
          return next
        })
      } else {
        setSelectedClipIds(new Set([clipId]))
      }
      setSelectedFXTarget(trackId)
    })
  }
  const deleteSelectedClips = () => {
    const ids = Array.from(selectedClipIds())
    if (ids.length === 0) return

    // Optimistically remove from local tracks
    setTracks(ts => ts.map(t => ({
      ...t,
      clips: t.clips.filter(c => !ids.includes(c.id)),
    })))

    // Bulk remove to avoid staggered server updates
    void convexClient.mutation((convexApi as any).clips.removeMany, { clipIds: ids as any, userId: userId() as any })

    batch(() => {
      setSelectedClip(null)
      setSelectedClipIds(new Set<string>())
    })
  }

  const duplicateSelectedClips = async () => {
    const ids = Array.from(selectedClipIds())
    if (ids.length === 0) return

    const tsSnapshot = tracks()
    const byTrack = new Map<string, Clip[]>()
    for (const t of tsSnapshot) {
      const sels = t.clips.filter(c => ids.includes(c.id))
      if (sels.length > 0) byTrack.set(t.id, sels)
    }

    const createdIds: { trackId: string; clipId: string }[] = []

    type PendingCreate = {
      trackId: string
      name?: string
      duration: number
      startSec: number
      buffer: AudioBuffer | null
      color: string
      sampleUrl?: string
      midi?: any
      leftPadSec?: number
      bufferOffsetSec?: number
      midiOffsetBeats?: number
    }
    const pending: PendingCreate[] = []

    for (const [trackId, clipsToDup] of byTrack.entries()) {
      const t = tsSnapshot.find(tt => tt.id === trackId)
      if (!t) continue
      const sorted = clipsToDup.slice().sort((a, b) => a.startSec - b.startSec)
      const groupStart = Math.min(...sorted.map(c => c.startSec))
      const groupEnd = Math.max(...sorted.map(c => c.startSec + c.duration))
      const baseStart = groupEnd + 0.0001
      let simulatedClips = t.clips.map(c => ({ ...c }))

      for (const clip of sorted) {
        const isInstrument = t.kind === 'instrument'
        const isMidi = !!(clip as any).midi
        // Enforce track-type gating: skip invalid duplicates
        if ((isInstrument && !isMidi) || (!isInstrument && isMidi)) {
          continue
        }
        const offset = clip.startSec - groupStart
        const desiredStart = baseStart + offset
        const safeStart = gridEnabled()
          ? calcNonOverlapStartGridAligned(simulatedClips, null, desiredStart, clip.duration, bpm(), gridDenominator())
          : calcNonOverlapStart(simulatedClips, null, desiredStart, clip.duration)
        pending.push({
          trackId,
          name: clip.name,
          duration: clip.duration,
          startSec: safeStart,
          buffer: clip.buffer ?? null,
          color: clip.color,
          sampleUrl: clip.sampleUrl,
          midi: (clip as any).midi,
          leftPadSec: clip.leftPadSec,
          bufferOffsetSec: (clip as any).bufferOffsetSec,
          midiOffsetBeats: (clip as any).midiOffsetBeats,
        })
        simulatedClips = [...simulatedClips, { ...clip, startSec: safeStart }]
      }
    }

    const rid = roomId() as any
    const uid = userId() as any
    const idsCreated = await convexClient.mutation((convexApi as any).clips.createMany, {
      items: pending.map(p => ({
        roomId: rid,
        trackId: p.trackId as any,
        startSec: p.startSec,
        duration: p.duration,
        userId: uid,
        name: p.name,
        ...(p.midi ? { midi: p.midi } : {}),
        leftPadSec: p.leftPadSec,
        bufferOffsetSec: p.bufferOffsetSec,
        midiOffsetBeats: p.midiOffsetBeats,
      }))
    }) as any as string[]

    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]
      const newId = idsCreated[i]
      if (!newId) continue
      if (p.buffer) audioBufferCache.set(newId, p.buffer)
      createdIds.push({ trackId: p.trackId, clipId: newId })
      if (p.sampleUrl) {
        void convexClient.mutation((convexApi as any).clips.setSampleUrl, { clipId: newId as any, sampleUrl: p.sampleUrl })
      }
      if (p.midi) {
        try {
          await convexClient.mutation((convexApi as any).clips.setMidi, { clipId: newId as any, midi: p.midi, userId: uid })
        } catch {}
      }
      if (
        (typeof p.leftPadSec === 'number' && Number.isFinite(p.leftPadSec)) ||
        (typeof p.bufferOffsetSec === 'number' && Number.isFinite(p.bufferOffsetSec)) ||
        (typeof p.midiOffsetBeats === 'number' && Number.isFinite(p.midiOffsetBeats))
      ) {
        void convexClient.mutation((convexApi as any).clips.setTiming, { clipId: newId as any, startSec: p.startSec, duration: p.duration, leftPadSec: p.leftPadSec ?? 0, bufferOffsetSec: p.bufferOffsetSec ?? 0, midiOffsetBeats: p.midiOffsetBeats ?? 0 })
      }
    }

    const last = createdIds[createdIds.length - 1]
    if (last) {
      batch(() => {
        setSelectedTrackId(last.trackId)
        setSelectedClip({ trackId: last.trackId, clipId: last.clipId })
        setSelectedFXTarget(last.trackId)
        setSelectedClipIds(new Set<string>(createdIds.map(item => item.clipId)))
      })
    }
  }

  const performDeleteTrack = (trackId: string) => {
    void convexClient.mutation(convexApi.tracks.remove, { trackId: trackId as any, userId: userId() as any })

    const next = tracks().filter(t => t.id !== trackId)
    batch(() => {
      setSelectedClip(null)
      if (next.length > 0) {
        setSelectedTrackId(next[0].id)
        setSelectedFXTarget(next[0].id)
      } else {
        setSelectedTrackId('')
        setSelectedFXTarget('master')
      }
    })
  }

  const requestDeleteSelectedTrack = () => {
    const id = selectedTrackId()
    if (!id) return
    const track = tracks().find(t => t.id === id)
    if (!track) return

    if (track.clips.length > 0) {
      setPendingDeleteTrackId(id)
      setConfirmOpen(true)
    } else {
      performDeleteTrack(id)
    }
  }

  const handleKeyboardAction = () => {
    if (selectedClipIds().size > 0) {
      deleteSelectedClips()
    } else {
      requestDeleteSelectedTrack()
    }
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
