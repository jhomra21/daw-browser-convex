import { type Component, Show, Suspense, createMemo, lazy } from 'solid-js'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'
import type { Clip, Track } from '~/types/timeline'

const RecordingPreview = lazy(() => import('~/components/timeline/RecordingPreview'))
const GridOverlay = lazy(() => import('~/components/timeline/GridOverlay'))
const MidiEditorCard = lazy(() => import('~/components/midi/MidiEditorCard'))

type Bounds = { x: number; y: number; w: number; h: number }
type MarqueeRect = { x: number; y: number; width: number; height: number } | null

type TimelineOverlaysProps = {
  timeline: {
    tracks: Track[]
    durationSec: number
    bpm: number
    gridDenominator: number
    gridEnabled: boolean
    loopEnabled: boolean
    loopStartSec: number
    loopEndSec: number
    playheadSec: number
    dropAtNewTrack: boolean
    isRecording: boolean
    previewStartSec: number | null
    previewPoints: Array<{ offset: number; amplitude: number }>
    recordingTrackId: string | null
    marqueeRect: MarqueeRect
    midiEditorClipId: string | null
    midiCard: Bounds
    userId?: string
    roomId?: string
    closeMidiEditor: () => void
    changeMidiCardBounds: (next: Bounds) => void
    auditionNote: (pitch: number, velocity?: number, durSec?: number) => void
    startLiveNote: (pitch: number, velocity?: number) => void
    stopLiveNote: (pitch: number) => void
  }
}

const TimelineOverlays: Component<TimelineOverlaysProps> = (props) => {
  const timeline = props.timeline
  const trackIndexById = createMemo(() => {
    const next = new Map<string, number>()
    const tracks = timeline.tracks
    for (let index = 0; index < tracks.length; index++) {
      next.set(tracks[index].id, index)
    }
    return next
  })

  const midiClip = createMemo<Clip | undefined>(() => {
    const id = timeline.midiEditorClipId
    if (!id) return undefined
    for (const track of timeline.tracks) {
      const clip = track.clips.find((item) => item.id === id)
      if (clip) return clip
    }
    return undefined
  })

  const recordingPreview = createMemo(() => {
    const start = timeline.previewStartSec
    const points = timeline.previewPoints
    const trackId = timeline.recordingTrackId
    if (!timeline.isRecording || start == null || points.length === 0 || !trackId) return null
    const trackIndex = trackIndexById().get(trackId)
    if (trackIndex == null) return null
    return {
      start,
      points,
      topPx: trackIndex * LANE_HEIGHT,
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
      {timeline.dropAtNewTrack && (
        <div
          class="absolute left-0 right-0 border-t border-green-500/40 bg-green-500/10 pointer-events-none"
          style={{ top: `${timeline.tracks.length * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
        />
      )}
      <Suspense fallback={null}>
        <GridOverlay
          durationSec={timeline.durationSec}
          heightPx={(timeline.tracks.length + (timeline.dropAtNewTrack ? 1 : 0)) * LANE_HEIGHT}
          bpm={timeline.bpm}
          denom={timeline.gridDenominator}
          enabled={timeline.gridEnabled}
        />
      </Suspense>
      {timeline.loopEnabled && timeline.loopEndSec - timeline.loopStartSec > 0.05 && (
        <>
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-30"
            style={{ left: `${timeline.loopStartSec * PPS}px` }}
          />
          <div
            class="absolute top-0 bottom-0 w-px bg-green-400/70 pointer-events-none z-30"
            style={{ left: `${timeline.loopEndSec * PPS}px` }}
          />
        </>
      )}
      <Show when={timeline.marqueeRect}>
        {(rect) => (
          <div
            class="absolute z-50 border border-blue-400 bg-blue-400/10 pointer-events-none"
            style={{ left: `${rect().x}px`, top: `${rect().y}px`, width: `${rect().width}px`, height: `${rect().height}px` }}
          />
        )}
      </Show>
      <div class="absolute top-0 bottom-0 z-30 w-px bg-red-500 pointer-events-none" style={{ left: `${timeline.playheadSec * PPS}px` }} />
      <Show when={timeline.midiEditorClipId}>
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
              const card = timeline.midiCard
              return (
                <MidiEditorCard
                  clipId={timeline.midiEditorClipId!}
                  bpm={timeline.bpm}
                  gridDenominator={timeline.gridDenominator}
                  clipDurationSec={clip().duration}
                  x={card.x}
                  y={card.y}
                  w={card.w}
                  h={card.h}
                  onClose={timeline.closeMidiEditor}
                  onChangeBounds={timeline.changeMidiCardBounds}
                  midi={clip().midi}
                  userId={timeline.userId}
                  roomId={timeline.roomId}
                  onAuditionNote={timeline.auditionNote}
                  onStartLiveNote={timeline.startLiveNote}
                  onStopLiveNote={timeline.stopLiveNote}
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
