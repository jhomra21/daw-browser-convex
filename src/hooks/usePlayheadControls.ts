import { type Accessor, onCleanup } from 'solid-js'

import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import { useTimelinePlayback } from './useTimelinePlayback'
import type { LivePlaybackCompileContext, LivePlaybackSnapshotCompilation, LivePlaybackTransport } from '~/lib/live-playback-snapshot'
import type { AudioPcmSourceResolver } from '~/lib/audio-pcm-source-resolver'
import type { SampledInstrumentRegionBudget } from '~/lib/sampled-instrument-region-budget'
import type { NativeInstrumentPreparation } from '~/lib/desktop/native-instrument-budget-policy'
import type { NativePlaybackFault } from '~/lib/desktop/native-playback-controller'

type Options = {
  audioEngine: AudioEngine
  tracks: Accessor<RuntimeTrack[]>
  bpm?: Accessor<number>
  ensureClipBuffer: (clipId: string, sampleUrl?: string) => Promise<void>
  resolveAudioSource?: AudioPcmSourceResolver
  loopEnabled?: Accessor<boolean>
  loopStartSec?: Accessor<number>
  loopEndSec?: Accessor<number>
  pixelsPerSecond: Accessor<number>
  visibleStartSec?: Accessor<number>
  preflightPlayback?: () => Promise<boolean>
  requiresNativeAudio?: boolean
  nativePlayback?: {
    enabled: Accessor<boolean>
    projectId?: Accessor<string>
    projectGeneration?: Accessor<number>
    keepLatencyNodeIds?: Accessor<ReadonlySet<string>>
    playbackInputs?: Accessor<object>
    getDesiredProcessorState?: NonNullable<Parameters<typeof useTimelinePlayback>[2]>["getDesiredProcessorState"]
    getProcessorTarget?: NonNullable<Parameters<typeof useTimelinePlayback>[2]>["getProcessorTarget"]
    compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
    captureNativeVstStates?: (capture: { projectId: string; instanceIds: readonly string[] }) => Promise<void>
    reportFault?: (fault: NativePlaybackFault, options?: { retainPlayback: true }) => void
    instrumentBudget?: SampledInstrumentRegionBudget
    onInstrumentPreparation?: (trackIds: readonly string[], status: NativeInstrumentPreparation) => void
  }
  portableBrowserPlayback?: {
    projectGeneration?: Accessor<number>
    compileSnapshot: (transport: LivePlaybackTransport, context?: LivePlaybackCompileContext) => Promise<LivePlaybackSnapshotCompilation>
    reportFault?: (message: string) => void
  }
}

export function usePlayheadControls({ audioEngine, tracks, bpm, ensureClipBuffer, resolveAudioSource, loopEnabled, loopStartSec, loopEndSec, pixelsPerSecond, visibleStartSec, preflightPlayback, requiresNativeAudio, nativePlayback, portableBrowserPlayback }: Options) {
  const playback = useTimelinePlayback(audioEngine, {
    bpm,
    loopEnabled,
    loopStartSec,
    loopEndSec,
    getTracks: tracks,
    preflightPlayback,
    hydrateLegacyAudio: async () => {
      const pendingBuffers: Promise<void>[] = []
      for (const track of tracks()) {
        for (const clip of track.clips) {
          if (!clip.buffer && !(clip.audioWarp?.enabled === true && clip.audioWarp.mode === 'stretch')) {
            pendingBuffers.push(ensureClipBuffer(clip.id, clip.sampleUrl))
          }
        }
      }
      await Promise.all(pendingBuffers)
    },
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
    const rect = scrollEl.getBoundingClientRect()
    const sec = Math.max(0, (visibleStartSec?.() ?? 0) + (clientX - rect.left) / pixelsPerSecond())
    playback.setPlayhead(sec, tracks())
  }

  const onScrubEnd = () => {
    stopScrub()
  }

  const startScrub = (clientX: number, options?: { listen?: boolean }) => {
    if (!scrollEl) return
    const rect = scrollEl.getBoundingClientRect()
    const sec = Math.max(0, (visibleStartSec?.() ?? 0) + (clientX - rect.left) / pixelsPerSecond())
    playback.setPlayhead(sec, tracks())
    scrubbing = true
    if (options?.listen === false || scrubListenersActive) return
    scrubListenersActive = true
    window.addEventListener('pointermove', onScrubMove)
    window.addEventListener('pointerup', onScrubEnd)
    window.addEventListener('pointercancel', onScrubEnd)
  }

  const requestPlay = async () => {
    await playback.handlePlay(tracks())
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
