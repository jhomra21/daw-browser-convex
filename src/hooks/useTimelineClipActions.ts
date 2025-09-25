import { batch, type Accessor, type Setter } from 'solid-js'

import { calcNonOverlapStart, willOverlap } from '~/lib/timeline-utils'
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

    setTracks(ts => ts.map(t => ({
      ...t,
      clips: t.clips.filter(c => !ids.includes(c.id)),
    })))

    for (const id of ids) {
      void convexClient.mutation(convexApi.clips.remove, { clipId: id as any, userId: userId() as any })
    }

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

    for (const [trackId, clipsToDup] of byTrack.entries()) {
      const t = tsSnapshot.find(tt => tt.id === trackId)
      if (!t) continue

      for (const clip of clipsToDup) {
        let desiredStart = clip.startSec + clip.duration + 0.0001
        let startSec = desiredStart
        if (willOverlap(t.clips, null, startSec, clip.duration)) {
          startSec = calcNonOverlapStart(t.clips, null, startSec, clip.duration)
        }

        const createdClipId = await convexClient.mutation(convexApi.clips.create, {
          roomId: roomId() as any,
          trackId: trackId as any,
          startSec,
          duration: clip.duration,
          userId: userId() as any,
          name: clip.name,
        } as any) as any as string

        if (clip.buffer) audioBufferCache.set(createdClipId, clip.buffer)
        createdIds.push({ trackId, clipId: createdClipId })

        setTracks(ts => ts.map(tr => tr.id !== trackId ? tr : ({
          ...tr,
          clips: [...tr.clips, {
            id: createdClipId,
            name: clip.name,
            buffer: clip.buffer ?? null,
            startSec,
            duration: clip.duration,
            leftPadSec: clip.leftPadSec ?? 0,
            color: clip.color,
            sampleUrl: clip.sampleUrl,
          }],
        })))

        if (clip.sampleUrl) {
          void convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: clip.sampleUrl })
        }

        if (typeof clip.leftPadSec === 'number' && Number.isFinite(clip.leftPadSec)) {
          void convexClient.mutation((convexApi as any).clips.setTiming, {
            clipId: createdClipId as any,
            startSec,
            duration: clip.duration,
            leftPadSec: clip.leftPadSec ?? 0,
          })
        }
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
