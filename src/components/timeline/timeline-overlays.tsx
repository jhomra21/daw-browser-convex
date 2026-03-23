import { type Accessor, type Component, Show, Suspense, createMemo, lazy } from 'solid-js'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'
import type { Clip, Track } from '~/types/timeline'

const RecordingPreview = lazy(() => import('~/components/timeline/RecordingPreview'))
const GridOverlay = lazy(() => import('~/components/timeline/GridOverlay'))
const MidiEditorCard = lazy(() => import('~/components/midi/MidiEditorCard'))

type Bounds = { x: number; y: number; w: number; h: number }
type MarqueeRect = { x: number; y: number; width: number; height: number } | null

type TimelineOverlayState = {
  tracks: Accessor<Track[]>
  durationSec: Accessor<number>
  bpm: Accessor<number>
  gridDenominator: Accessor<number>
  gridEnabled: Accessor<boolean>
  loopEnabled: Accessor<boolean>
  loopStartSec: Accessor<number>
  loopEndSec: Accessor<number>
  playheadSec: Accessor<number>
  dropAtNewTrack: Accessor<boolean>
  isRecording: Accessor<boolean>
  previewStartSec: Accessor<number | null>
  previewPoints: Accessor<Array<{ offset: number; amplitude: number }>>
  recordingTrackId: Accessor<string | null>
  marqueeRect: Accessor<MarqueeRect>
  midiEditorClipId: Accessor<string | null>
  midiCard: Accessor<Bounds>
}

type TimelineOverlaySession = {
  userId: Accessor<string | undefined>
  roomId: Accessor<string | undefined>
}

type TimelineOverlayActions = {
  closeMidiEditor: () => void
  changeMidiCardBounds: (next: Bounds) => void
  auditionNote: (pitch: number, velocity?: number, durSec?: number) => void
  startLiveNote: (pitch: number, velocity?: number) => void
  stopLiveNote: (pitch: number) => void
}

type TimelineOverlaysProps = {
  state: TimelineOverlayState
  session: TimelineOverlaySession
  actions: TimelineOverlayActions
}

const TimelineOverlays: Component<TimelineOverlaysProps> = (props) => {
  const trackIndexById = createMemo(() => {
    const next = new Map<string, number>()
    const tracks = props.state.tracks()
    for (let index = 0; index < tracks.length; index++) {
      next.set(tracks[index].id, index)
    }
    return next
  })

  const midiClip = createMemo<Clip | undefined>(() => {
    const id = props.state.midiEditorClipId()
    if (!id) return undefined
    for (const track of props.state.tracks()) {
      const clip = track.clips.find((item) => item.id === id)
      if (clip) return clip
    }
    return undefined
  })

  const recordingPreview = createMemo(() => {
    const start = props.state.previewStartSec()
    const points = props.state.previewPoints()
    const trackId = props.state.recordingTrackId()
    if (!props.state.isRecording() || start == null || points.length === 0 || !trackId) return null
    const trackIndex = trackIndexById().get(trackId)
    if (trackIndex == null) return null
    return {
      start,
      points,
      topPx: trackIndex * LANE_HEIGHT,
    }
  })

  const marqueeRect = createMemo(() => props.state.marqueeRect())
  const midiClipId = createMemo(() => props.state.midiEditorClipId())
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
      {props.state.dropAtNewTrack() && (
        <div
          class="absolute left-0 right-0 border-t border-green-500/40 bg-green-500/10 pointer-events-none"
          style={{ top: `${props.state.tracks().length * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
        />
      )}
      <Suspense fallback={null}>
        <GridOverlay
          durationSec={props.state.durationSec()}
          heightPx={(props.state.tracks().length + (props.state.dropAtNewTrack() ? 1 : 0)) * LANE_HEIGHT}
          bpm={props.state.bpm()}
          denom={props.state.gridDenominator()}
          enabled={props.state.gridEnabled()}
        />
      </Suspense>
      {props.state.loopEnabled() && props.state.loopEndSec() - props.state.loopStartSec() > 0.05 && (
        <>
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-30"
            style={{ left: `${props.state.loopStartSec() * PPS}px` }}
          />
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-30"
            style={{ left: `${props.state.loopEndSec() * PPS}px` }}
          />
        </>
      )}
      <Show when={marqueeRect()}>
        {(rect) => (
          <div
            class="absolute z-50 border border-blue-400 bg-blue-400/10 pointer-events-none"
            style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().width}px`, height: `${rect().height}px` }}
          />
        )}
      </Show>
      <div class="absolute top-0 bottom-0 z-30 w-px bg-red-500 pointer-events-none" style={{ left: `${props.state.playheadSec() * PPS}px` }} />
      <Show when={midiClipId()}>
        <div
          class="absolute inset-0 z-40 bg-transparent"
          style={{ 'touch-action': 'none' }}
          onPointerDown={stopOverlayEvent}
          onPointerMove={stopOverlayEvent}
          onPointerUp={stopOverlayEvent}
          onMouseDown={stopOverlayEvent}
          onClick={stopOverlayEvent}
          onWheel={stopOverlayEvent}
          onContextMenu={stopOverlayEvent}
        />
        <Suspense fallback={null}>
          <Show when={midiClip()}>
            {(clip) => {
              const card = props.state.midiCard()
              return (
              <MidiEditorCard
                clipId={midiClipId()!}
                bpm={props.state.bpm()}
                gridDenominator={props.state.gridDenominator()}
                clipDurationSec={clip().duration}
                x={card.x}
                y={card.y}
                w={card.w}
                h={card.h}
                onClose={props.actions.closeMidiEditor}
                onChangeBounds={props.actions.changeMidiCardBounds}
                midi={clip().midi}
                userId={props.session.userId()}
                roomId={props.session.roomId()}
                onAuditionNote={props.actions.auditionNote}
                onStartLiveNote={props.actions.startLiveNote}
                onStopLiveNote={props.actions.stopLiveNote}
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
