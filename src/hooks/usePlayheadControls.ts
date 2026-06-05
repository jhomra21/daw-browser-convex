import { type Accessor, onCleanup } from 'solid-js'

import { clientXToSec } from '~/lib/timeline-utils'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import { useTimelinePlayback } from './useTimelinePlayback'

type Options = {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
}

export function usePlayheadControls({ audioEngine, tracks, ensureClipBuffer, loopEnabled, loopStartSec, loopEndSec }: Options) {
  const playback = useTimelinePlayback(audioEngine, {
    loopEnabled,
    loopStartSec,
    loopEndSec,
    getTracks: tracks,
  })

  let scrollEl: HTMLDivElement | undefined
  let scrubbing = false
  let scrubListenersActive = false

  const setScrollElement = (el?: HTMLDivElement) => {
    scrollEl = el
  }

  const stopScrub = () => {
    if (!scrubbing) return
    scrubbing = false
    scrubListenersActive = false
    window.removeEventListener('pointermove', onScrubMove)
    window.removeEventListener('pointerup', onScrubEnd)
    window.removeEventListener('pointercancel', onScrubEnd)
  }

  const onScrubMove = (event: PointerEvent) => {
    moveScrub(event.clientX)
  }

  const moveScrub = (clientX: number) => {
    if (!scrubbing || !scrollEl) return
    const sec = clientXToSec(clientX, scrollEl)
    playback.setPlayhead(sec, tracks())
  }

  const onScrubEnd = () => {
    stopScrub()
  }

  const startScrub = (clientX: number, options?: { listen?: boolean }) => {
    if (!scrollEl) return
    const sec = clientXToSec(clientX, scrollEl)
    playback.setPlayhead(sec, tracks())
    scrubbing = true
    if (options?.listen === false || scrubListenersActive) return
    scrubListenersActive = true
    window.addEventListener('pointermove', onScrubMove)
    window.addEventListener('pointerup', onScrubEnd)
    window.addEventListener('pointercancel', onScrubEnd)
  }

  const requestPlay = async () => {
    const initialTracks = tracks()
    const pendingBuffers: Promise<void>[] = []
    for (const track of initialTracks) {
      for (const clip of track.clips) {
        if (!clip.buffer) {
          pendingBuffers.push(ensureClipBuffer(clip.id, clip.sampleUrl))
        }
      }
    }
    if (pendingBuffers.length) {
      await Promise.all(pendingBuffers)
    }
    const readyTracks = tracks()
    await playback.handlePlay(readyTracks)
  }

  onCleanup(() => {
    stopScrub()
  })

  return {
    ...playback,
    requestPlay,
    startScrub,
    moveScrub,
    stopScrub,
    setScrollElement,
  }
}
