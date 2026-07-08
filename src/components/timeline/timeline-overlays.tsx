import { type Component, For, Show, createMemo } from 'solid-js'
import type { TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { TimelineMidiBounds } from '~/lib/timeline-midi-bounds'
import type { TimelineRangeSelection } from '~/lib/timeline-range-selection'
import type { TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import RecordingPreview from '~/components/timeline/RecordingPreview'
import GridOverlay from '~/components/timeline/GridOverlay'
import MidiEditorCard from '~/components/midi/MidiEditorCard'

type MarqueeRect = { x: number; y: number; width: number; height: number } | null

type TimelineOverlaysProps = {
  timeline: {
    tracks: RuntimeTrack[]
    trackLookup: TimelineTrackIndex<AudioBuffer>
    durationSec: number
    bpm: number
    gridDenominator: number
    gridEnabled: boolean
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    playheadSec: number
    dropAtNewTrack: boolean
    marqueeRect: MarqueeRect
    rowTops: number[]
    rowLayouts: TimelineTrackLayoutRow[]
    trackAreaHeight: number
    range: TimelineRangeSelection | null
  }
  recording: {
    isRecording: boolean
    previewStartSec: number | null
    previewPoints: Array<{ offset: number; amplitude: number }>
    recordingTrackId: Track['id'] | null
  }
  midi: {
    clipId: string | null
    card: TimelineMidiBounds
    userId?: string
    projectId?: string
    close: () => void
    changeBounds: (next: TimelineMidiBounds) => void
    auditionNote: (pitch: number, velocity?: number, durSec?: number) => void
    keyboard: {
      isActive: (pitch: number) => boolean
    }
    onLocalMidiSaved: (clipId: string, midi: Clip['midi']) => void
  }
}

const TimelineOverlays: Component<TimelineOverlaysProps> = (props) => {
  const midiClip = createMemo<RuntimeClip | undefined>(() => {
    const id = props.midi.clipId
    if (!id) return undefined
    return props.timeline.trackLookup.clipById.get(id)
  })
  const layoutByTrackId = createMemo(() => new Map(
    props.timeline.rowLayouts.map((row) => [row.trackId, row]),
  ))

  const recordingPreview = createMemo(() => {
    const start = props.recording.previewStartSec
    const points = props.recording.previewPoints
    const trackId = props.recording.recordingTrackId
    if (!props.recording.isRecording || start == null || points.length === 0 || !trackId) return null
    const row = layoutByTrackId().get(trackId)
    if (!row) return null
    return {
      start,
      points,
      topPx: row.topPx,
      heightPx: row.clipLaneHeightPx,
    }
  })

  const rangeOverlayRows = createMemo(() => {
    const range = props.timeline.range
    if (!range) return []
    const selectedTrackIds = new Set(range.trackIds)
    return props.timeline.rowLayouts.filter((row) => selectedTrackIds.has(row.trackId))
  })

  return (
    <>
      <Show when={recordingPreview()}>
        {(preview) => (
          <div
            class="absolute left-0 right-0 pointer-events-none"
            style={{ top: `${preview().topPx}px`, height: `${preview().heightPx}px` }}
          >
            <RecordingPreview startSec={preview().start} points={preview().points} />
          </div>
        )}
      </Show>
      {props.timeline.dropAtNewTrack && (
        <div
          class="absolute left-0 right-0 border-t border-green-500/40 bg-green-500/10 pointer-events-none"
          style={{ top: `${props.timeline.trackAreaHeight - LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
        />
      )}
      <GridOverlay
        durationSec={props.timeline.durationSec}
        bpm={props.timeline.bpm}
        denom={props.timeline.gridDenominator}
        enabled={props.timeline.gridEnabled}
      />
      <Show when={props.timeline.range}>
        {(range) => (
          <For each={rangeOverlayRows()}>
            {(row) => (
              <div
                class="absolute z-10 pointer-events-none bg-blue-400/12 border-x border-blue-300/30"
                style={{
                  left: `${range().startSec * PPS}px`,
                  top: `${row.topPx}px`,
                  width: `${(range().endSec - range().startSec) * PPS}px`,
                  height: `${row.heightPx}px`,
                }}
              />
            )}
          </For>
        )}
      </Show>
      {props.timeline.loopEnabled && props.timeline.loopEndSec - props.timeline.loopStartSec > 0.05 && (
        <>
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-[25]"
            style={{ left: `${props.timeline.loopStartSec * PPS}px` }}
          />
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-[25]"
            style={{ left: `${props.timeline.loopEndSec * PPS}px` }}
          />
        </>
      )}
      <Show when={props.timeline.marqueeRect}>
        {(rect) => (
          <div
            class="absolute z-50 border border-blue-400 bg-blue-400/10 pointer-events-none"
            style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().width}px`, height: `${rect().height}px` }}
          />
        )}
      </Show>
      <div class="absolute top-0 bottom-0 z-[25] w-px bg-red-500 pointer-events-none" style={{ left: `${props.timeline.playheadSec * PPS}px` }} />
      <Show when={midiClip()}>
        {(clip) => (
          <MidiEditorCard
            clipId={clip().id}
            bpm={props.timeline.bpm}
            gridDenominator={props.timeline.gridDenominator}
            clipDurationSec={clip().duration}
            bounds={props.midi.card}
            onClose={props.midi.close}
            onChangeBounds={props.midi.changeBounds}
            midi={clip().midi}
            userId={props.midi.userId}
            projectId={props.midi.projectId}
            onAuditionNote={props.midi.auditionNote}
            midiKeyboard={props.midi.keyboard}
            onLocalMidiSaved={props.midi.onLocalMidiSaved}
          />
        )}
      </Show>
    </>
  )
}

export default TimelineOverlays
