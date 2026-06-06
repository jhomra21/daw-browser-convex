import { type Component, Show, Suspense, createMemo, lazy } from 'solid-js'
import type { TimelineTrackIndex } from '@daw-browser/timeline-core/track-index'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip, RuntimeTrack } from '~/lib/timeline-runtime-types'

const RecordingPreview = lazy(() => import('~/components/timeline/RecordingPreview'))
const GridOverlay = lazy(() => import('~/components/timeline/GridOverlay'))
const MidiEditorCard = lazy(() => import('~/components/midi/MidiEditorCard'))

export type TimelineMidiBounds = { x: number; y: number; w: number; h: number }
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
    startLiveNote: (pitch: number, velocity?: number) => void
    stopLiveNote: (pitch: number) => void
    onLocalMidiSaved: (clipId: string, midi: Clip['midi']) => void
  }
}

const TimelineOverlays: Component<TimelineOverlaysProps> = (props) => {
  const midiClip = createMemo<RuntimeClip | undefined>(() => {
    const id = props.midi.clipId
    if (!id) return undefined
    return props.timeline.trackLookup.clipById.get(id)
  })

  const recordingPreview = createMemo(() => {
    const start = props.recording.previewStartSec
    const points = props.recording.previewPoints
    const trackId = props.recording.recordingTrackId
    if (!props.recording.isRecording || start == null || points.length === 0 || !trackId) return null
    const trackIndexValue = props.timeline.trackLookup.trackIndexById.get(trackId)
    if (trackIndexValue == null) return null
    return {
      start,
      points,
      topPx: trackIndexValue * LANE_HEIGHT,
    }
  })

  const stopOverlayEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <>
      <Show when={recordingPreview()}>
        {(preview) => (
          <div
            class="absolute left-0 right-0 pointer-events-none"
            style={{ top: `${preview().topPx}px`, height: `${LANE_HEIGHT}px` }}
          >
            <Suspense fallback={null}>
              <RecordingPreview startSec={preview().start} points={preview().points} />
            </Suspense>
          </div>
        )}
      </Show>
      {props.timeline.dropAtNewTrack && (
        <div
          class="absolute left-0 right-0 border-t border-green-500/40 bg-green-500/10 pointer-events-none"
          style={{ top: `${props.timeline.tracks.length * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
        />
      )}
      <Suspense fallback={null}>
        <GridOverlay
          durationSec={props.timeline.durationSec}
          bpm={props.timeline.bpm}
          denom={props.timeline.gridDenominator}
          enabled={props.timeline.gridEnabled}
        />
      </Suspense>
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
      <Show when={props.midi.clipId}>
        <div
          class="absolute inset-0 z-40 bg-transparent"
          style={{ 'touch-action': 'none' }}
          onPointerDown={stopOverlayEvent}
          onPointerMove={stopOverlayEvent}
          onPointerUp={stopOverlayEvent}
          onClick={stopOverlayEvent}
          onWheel={stopOverlayEvent}
          onContextMenu={stopOverlayEvent}
        />
        <Suspense fallback={null}>
          <Show when={midiClip()}>
            {(clip) => {
              const card = props.midi.card
              return (
                <MidiEditorCard
                  clipId={clip().id}
                  bpm={props.timeline.bpm}
                  gridDenominator={props.timeline.gridDenominator}
                  clipDurationSec={clip().duration}
                  x={card.x}
                  y={card.y}
                  w={card.w}
                  h={card.h}
                  onClose={props.midi.close}
                  onChangeBounds={props.midi.changeBounds}
                  midi={clip().midi}
                  userId={props.midi.userId}
                  projectId={props.midi.projectId}
                  onAuditionNote={props.midi.auditionNote}
                  onStartLiveNote={props.midi.startLiveNote}
                  onStopLiveNote={props.midi.stopLiveNote}
                  onLocalMidiSaved={props.midi.onLocalMidiSaved}
                />
              )
            }}
          </Show>
        </Suspense>
      </Show>
    </>
  )
}

export default TimelineOverlays
