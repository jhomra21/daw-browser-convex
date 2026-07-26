import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { useMidiAccess } from '~/context/midi-access'
import {
  createMidiTrackRecordingController,
  type MidiTrackRecordingControllerOptions,
} from '~/lib/midi/midi-recording-controller'
import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { Track } from '@daw-browser/timeline-core/types'
import type { HistoryEntry } from '~/lib/undo/types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

type Options = Omit<
  MidiTrackRecordingControllerOptions,
  'isRecording' | 'setIsRecording' | 'recordingTrackId' | 'setRecordingTrackId'
> & {
  audioEngine: Pick<AudioEngine, 'midiEventTimes'>
  tracks: Accessor<Track[]>
  selection: TimelineSelectionController
  historyPush: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
}

export const useMidiTrackRecording = (options: Options) => {
  const midiAccess = useMidiAccess()
  const [isRecording, setIsRecording] = createSignal(false)
  const [recordingTrackId, setRecordingTrackId] = createSignal<string | null>(null)
  const controller = createMidiTrackRecordingController({
    ...options,
    isRecording,
    setIsRecording,
    recordingTrackId,
    setRecordingTrackId,
  }, midiAccess)

  onCleanup(() => { void controller.stopRecording() })

  return controller
}
