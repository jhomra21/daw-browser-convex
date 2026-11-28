import { createEffect, onCleanup, type Accessor } from 'solid-js'

import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import { resetAudioEngine } from '~/lib/audio-engine-singleton'
import { flushLocalTimelineWrites } from '~/lib/timeline-repository/local-timeline-repository'
import type { Track } from '@daw-browser/timeline-core/types'

export function useTimelineAudioLifecycle(input: {
  audioEngine: AudioEngine
  tracks: Accessor<Track[]>
  bpm: Accessor<number>
  metronomeEnabled: Accessor<boolean>
  projectId: Accessor<string>
  clearClipBufferCaches: () => void
}) {
  createEffect(
    () => input.tracks(),
    (tracks) => {
      input.audioEngine.updateTrackGains(tracks)
    },
  )

  createEffect(
    () => input.bpm(),
    (bpm) => {
      input.audioEngine.setBpm(bpm)
    },
  )

  createEffect(
    () => input.metronomeEnabled(),
    (enabled) => {
      input.audioEngine.setMetronomeEnabled(enabled)
    },
  )

  createEffect(
    () => input.projectId(),
    () => () => {
      input.clearClipBufferCaches()
      void flushLocalTimelineWrites()
    },
  )

  onCleanup(() => {
    input.audioEngine.close()
    resetAudioEngine()
    input.clearClipBufferCaches()
  })
}
