import { type Accessor, onCleanup } from 'solid-js'

import { clientXToSec } from '~/lib/timeline-utils'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { useTimelinePlayback } from './useTimelinePlayback'
import type { LivePlaybackCompileContext, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'

type Options = {
  audioEngine: AudioEngine
  tracks: Accessor<RuntimeTrack[]>
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  resolveAudioSource?: AudioPcmSourceResolver
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  pixelsPerSecond: Accessor<number>
  preflightPlayback?: () => Promise<boolean>
  requiresNativeAudio?: boolean
  nativePlayback?: {
    enabled: Accessor<boolean>
    projectId?: Accessor<string>
    projectGeneration?: Accessor<number>
    compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
    captureNativeVstStates?: (capture: { projectId: string; instanceIds: readonly string[] }) => Promise<void>
    reportFault?: (message: string) => void
  }
  portableBrowserPlayback?: {
    projectGeneration?: Accessor<number>
    compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
    reportFault?: (message: string) => void
  }
}

export function usePlayheadControls({ audioEngine, tracks, ensureClipBuffer, resolveAudioSource, loopEnabled, loopStartSec, loopEndSec, pixelsPerSecond, preflightPlayback, requiresNativeAudio, nativePlayback, portableBrowserPlayback }: Options) {
  const playback = useTimelinePlayback(audioEngine, {
    loopEnabled,
    loopStartSec,
    loopEndSec,
    getTracks: tracks,
  }, nativePlayback ? { ...nativePlayback, requiresNativeAudio, resolveAudioSource } : undefined, portableBrowserPlayback ? { ...portableBrowserPlayback, resolveAudioSource } : undefined)

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
    const sec = clientXToSec(clientX, scrollEl, pixelsPerSecond())
    playback.setPlayhead(sec, tracks())
  }

  const onScrubEnd = () => {
    stopScrub()
  }

  const startScrub = (clientX: number, options?: { listen?: boolean }) => {
    if (!scrollEl) return
    const sec = clientXToSec(clientX, scrollEl, pixelsPerSecond())
    playback.setPlayhead(sec, tracks())
    scrubbing = true
    if (options?.listen === false || scrubListenersActive) return
    scrubListenersActive = true
    window.addEventListener('pointermove', onScrubMove)
    window.addEventListener('pointerup', onScrubEnd)
    window.addEventListener('pointercancel', onScrubEnd)
  }

  const requestPlay = async () => {
    if (preflightPlayback && !await preflightPlayback()) return
    const initialTracks = tracks()
    const pendingBuffers: Promise<void>[] = []
    for (const track of initialTracks) {
      for (const clip of track.clips) {
        if (!clip.buffer && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')) {
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
