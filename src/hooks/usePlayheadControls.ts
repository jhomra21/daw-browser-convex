import { type Accessor, onCleanup } from 'solid-js'

import { clientXToSec } from '~/lib/timeline-utils'
import type { AudioEngine } from '~/lib/audio-engine'
import type { Track } from '~/types/timeline'
import { useTimelinePlayback } from './useTimelinePlayback'

type Options = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
}

export function usePlayheadControls({ audioEngine, tracks, ensureClipBuffer }: Options) {
  const playback = useTimelinePlayback(audioEngine)

  let scrollEl: HTMLDivElement | undefined
  let scrubbing = false

  const setScrollElement = (el?: HTMLDivElement) => {
    scrollEl = el
  }

  const stopScrub = () => {
    if (!scrubbing) return
    scrubbing = false
    window.removeEventListener('mousemove', onScrubMove)
    window.removeEventListener('mouseup', onScrubEnd)
  }

  const onScrubMove = (event: MouseEvent) => {
    if (!scrubbing || !scrollEl) return
    const sec = clientXToSec(event.clientX, scrollEl)
    playback.setPlayhead(sec, tracks())
  }

  const onScrubEnd = () => {
    stopScrub()
  }

  const startScrub = (clientX: number) => {
    if (!scrollEl) return
    const sec = clientXToSec(clientX, scrollEl)
    playback.setPlayhead(sec, tracks())
    if (!scrubbing) {
      scrubbing = true
      window.addEventListener('mousemove', onScrubMove)
      window.addEventListener('mouseup', onScrubEnd)
    }
  }

  const requestPlay = async () => {
    const ts = tracks()
    const pendingBuffers: Promise<void>[] = []
    for (const track of ts) {
      for (const clip of track.clips) {
        if (!clip.buffer) {
          pendingBuffers.push(ensureClipBuffer(clip.id, clip.sampleUrl))
        }
      }
    }
    if (pendingBuffers.length) {
      await Promise.all(pendingBuffers)
    }
    await playback.handlePlay(ts)
  }

  onCleanup(() => {
    stopScrub()
  })

  return {
    ...playback,
    requestPlay,
    startScrub,
    stopScrub,
    setScrollElement,
  }
}
