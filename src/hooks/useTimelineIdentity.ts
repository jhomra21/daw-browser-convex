import type { FunctionReturnType } from 'convex/server'
import { createEffect, createSignal, on, type Accessor } from 'solid-js'

import { convexApi } from '~/lib/convex'
import type { Track } from '@daw-browser/timeline-core/types'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>

type UseTimelineIdentityOptions = {
  projectId: Accessor<string>
  serverData: Accessor<FullTimelineView | undefined>
}

type UseTimelineIdentityReturn = {
  trackHistoryRefsById: Accessor<Map<Track['id'], string>>
  trackNamesByHistoryRef: Accessor<Map<string, string>>
  clipHistoryRefsById: Accessor<Map<string, string>>
  rememberTrackProjection: (track: Pick<Track, 'id' | 'historyRef' | 'name'> | null | undefined) => void
  rememberClipHistoryRef: (clip: Pick<Track['clips'][number], 'id' | 'historyRef'> | null | undefined) => void
}

export function useTimelineIdentity(
  options: UseTimelineIdentityOptions,
): UseTimelineIdentityReturn {
  const [trackHistoryRefsById, setTrackHistoryRefsById] = createSignal<Map<Track['id'], string>>(new Map())
  const [trackNamesByHistoryRef, setTrackNamesByHistoryRef] = createSignal<Map<string, string>>(new Map())
  const [clipHistoryRefsById, setClipHistoryRefsById] = createSignal<Map<string, string>>(new Map())

  const rememberTrackHistoryRef = (track: Pick<Track, 'id' | 'historyRef'> | null | undefined) => {
    const trackId = track?.id
    const historyRef = track?.historyRef
    if (!trackId || !historyRef) return
    setTrackHistoryRefsById((current) => {
      if (current.get(trackId) === historyRef) return current
      const next = new Map(current)
      next.set(trackId, historyRef)
      return next
    })
  }

  const rememberTrackName = (track: Pick<Track, 'historyRef' | 'name'> | null | undefined) => {
    const historyRef = track?.historyRef
    const name = track?.name
    if (!historyRef || !name) return
    setTrackNamesByHistoryRef((current) => {
      if (current.get(historyRef) === name) return current
      const next = new Map(current)
      next.set(historyRef, name)
      return next
    })
  }

  const rememberTrackProjection = (track: Pick<Track, 'id' | 'historyRef' | 'name'> | null | undefined) => {
    rememberTrackHistoryRef(track)
    rememberTrackName(track)
  }

  const rememberClipHistoryRef = (clip: Pick<Track['clips'][number], 'id' | 'historyRef'> | null | undefined) => {
    const clipId = clip?.id
    const historyRef = clip?.historyRef
    if (!clipId || !historyRef) return
    setClipHistoryRefsById((current) => {
      if (current.get(clipId) === historyRef) return current
      const next = new Map(current)
      next.set(clipId, historyRef)
      return next
    })
  }

  createEffect(on(options.projectId, () => {
    setTrackHistoryRefsById(new Map())
    setTrackNamesByHistoryRef(new Map<string, string>())
    setClipHistoryRefsById(new Map<string, string>())
  }))

  createEffect(() => {
    const data = options.serverData()
    if (!data) return

    setTrackHistoryRefsById((current) => {
      let next: Map<Track['id'], string> | null = null
      for (const track of data.tracks) {
        const trackId = track._id
        if (current.has(trackId)) continue
        if (!next) next = new Map(current)
        next.set(trackId, trackId)
      }
      return next ?? current
    })

    setTrackNamesByHistoryRef((current) => {
      let next: Map<string, string> | null = null
      for (let index = 0; index < data.tracks.length; index++) {
        const trackId = data.tracks[index]._id
        const historyRef = trackHistoryRefsById().get(trackId) ?? trackId
        if (current.has(historyRef)) continue
        if (!next) next = new Map(current)
        next.set(historyRef, `Track ${index + 1}`)
      }
      return next ?? current
    })

    setClipHistoryRefsById((current) => {
      let next: Map<string, string> | null = null
      for (const clip of data.clips) {
        const clipId = String(clip._id)
        if (current.has(clipId)) continue
        if (!next) next = new Map(current)
        next.set(clipId, clipId)
      }
      return next ?? current
    })
  })

  return {
    trackHistoryRefsById,
    trackNamesByHistoryRef,
    clipHistoryRefsById,
    rememberTrackProjection,
    rememberClipHistoryRef,
  }
}
