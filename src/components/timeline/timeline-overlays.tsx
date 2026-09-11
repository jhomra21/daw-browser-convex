import { type Component, For, Show, createMemo } from 'solid-js'
import type { TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { LANE_HEIGHT } from '~/lib/timeline-utils'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { TimelineMidiBounds } from '~/lib/timeline-midi-bounds'
import type { TimelineRangeSelection } from '~/lib/timeline-range-selection'
import type { TimelineTrackLayoutRow } from '~/lib/timeline-track-layout'
import type { AutomationTargetDeviceInstance } from '@daw-browser/shared'
import RecordingPreview, { clipRecordingPreviewToViewport } from '~/components/timeline/RecordingPreview'
import GridOverlay from '~/components/timeline/GridOverlay'
import MidiEditorCard from '~/components/midi/MidiEditorCard'
import {
  intersectTimelineRangeWithViewport,
  projectTimelineTimeToViewport,
} from '~/lib/timeline-viewport-geometry'

type MarqueeRect = { x: number; y: number; width: number; height: number } | null

type TimelineOverlaysProps = {
  timeline: {
    tracks: RuntimeTrack[]
    trackLookup: TimelineTrackIndex<AudioBuffer>
    durationSec: number
    pixelsPerSecond: number
    visibleStartSec: number
    viewportWidthPx: number
    bpm: number
    gridDenominator: number
    gridEnabled: boolean
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    playheadSec: number
    dropAtNewTrack: boolean
    marqueeRect: MarqueeRect
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
    canWrite: boolean
    close: () => void
    changeBounds: (next: TimelineMidiBounds) => void
    auditionNote: (trackId: string, pitch: number, velocity?: number, durSec?: number) => void
    keyboard: {
      isActive: (pitch: number) => boolean
    }
    onLocalMidiSaved: (clipId: string, midi: Clip['midi']) => void
  }
  effectInstancesByOwnerKey: Record<string, AutomationTargetDeviceInstance[]>
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
  const midiTrackId = createMemo(() => {
    const clip = midiClip()
    return clip ? props.timeline.trackLookup.clipEntryById.get(clip.id)?.track.id : undefined
  })

  const recordingPreview = createMemo(() => {
    const start = props.recording.previewStartSec
    const points = props.recording.previewPoints
    const trackId = props.recording.recordingTrackId
    if (!props.recording.isRecording || start == null || points.length === 0 || !trackId) return null
    const row = layoutByTrackId().get(trackId)
    if (!row) return null
    const clipped = clipRecordingPreviewToViewport({
      startSec: start,
      points,
      visibleStartSec: props.timeline.visibleStartSec,
      visibleEndSec: props.timeline.visibleStartSec
        + props.timeline.viewportWidthPx / props.timeline.pixelsPerSecond,
      pixelsPerSecond: props.timeline.pixelsPerSecond,
    })
    if (!clipped) return null
    return {
      ...clipped,
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
  const rangeProjection = createMemo(() => {
    const range = props.timeline.range
    return range
      ? intersectTimelineRangeWithViewport({
        range,
        visibleStartSec: props.timeline.visibleStartSec,
        viewportWidthPx: props.timeline.viewportWidthPx,
        pixelsPerSecond: props.timeline.pixelsPerSecond,
      })
      : null
  })
  const loopProjection = createMemo(() => {
    if (!props.timeline.loopEnabled) return null
    return intersectTimelineRangeWithViewport({
      range: {
        startSec: props.timeline.loopStartSec,
        endSec: props.timeline.loopEndSec,
      },
      visibleStartSec: props.timeline.visibleStartSec,
      viewportWidthPx: props.timeline.viewportWidthPx,
      pixelsPerSecond: props.timeline.pixelsPerSecond,
    })
  })
  const playheadProjection = createMemo(() => projectTimelineTimeToViewport({
    visibleStartSec: props.timeline.visibleStartSec,
    viewportWidthPx: props.timeline.viewportWidthPx,
    pixelsPerSecond: props.timeline.pixelsPerSecond,
    durationSec: props.timeline.durationSec,
  }, props.timeline.playheadSec))

  return (
    <>
      <Show when={recordingPreview()}>
        {(preview) => (
          <div
            class="absolute left-0 right-0 pointer-events-none"
            style={{ top: `${preview().topPx}px`, height: `${preview().heightPx}px` }}
          >
            <RecordingPreview
              leftPx={preview().leftPx}
              widthPx={preview().widthPx}
              points={preview().points}
              heightPx={preview().heightPx}
              pixelsPerSecond={props.timeline.pixelsPerSecond}
            />
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
        pixelsPerSecond={props.timeline.pixelsPerSecond}
        visibleStartSec={props.timeline.visibleStartSec}
        viewportWidthPx={props.timeline.viewportWidthPx}
        bpm={props.timeline.bpm}
        denom={props.timeline.gridDenominator}
        enabled={props.timeline.gridEnabled}
      />
      <Show when={rangeProjection()}>
        {(projection) => (
          <For each={rangeOverlayRows()}>
            {(row) => (
              <div
                class="absolute z-10 pointer-events-none bg-blue-400/12 border-x border-blue-300/30"
                style={{
                  left: `${projection().leftPx}px`,
                  width: `${projection().widthPx}px`,
                  top: `${row.topPx}px`,
                  height: `${row.heightPx}px`,
                }}
              />
            )}
          </For>
        )}
      </Show>
      <Show when={loopProjection()}>
        {(projection) => (
          <div
            class="absolute top-0 bottom-0 bg-green-400/10 border-y border-green-400/40 pointer-events-none z-[25]"
            style={{
              left: `${projection().leftPx}px`,
              width: `${projection().widthPx}px`,
            }}
          />
        )}
      </Show>
      <Show when={props.timeline.marqueeRect}>
        {(rect) => (
          <div
            class="absolute z-50 border border-blue-400 bg-blue-400/10 pointer-events-none"
            style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().width}px`, height: `${rect().height}px` }}
          />
        )}
      </Show>
      <Show when={playheadProjection() !== null}>
        <div
          class="absolute top-0 bottom-0 z-[25] w-px bg-red-500 pointer-events-none"
          style={{ left: `${playheadProjection() ?? 0}px` }}
        />
      </Show>
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
            canWrite={props.midi.canWrite}
            onAuditionNote={props.midi.auditionNote}
            midiKeyboard={props.midi.keyboard}
            onLocalMidiSaved={props.midi.onLocalMidiSaved}
            trackId={midiTrackId()}
            effectInstances={midiTrackId() ? props.effectInstancesByOwnerKey[midiTrackId() ?? ''] : undefined}
          />
        )}
      </Show>
    </>
  )
}

export default TimelineOverlays
