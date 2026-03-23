import { type Component, For } from 'solid-js'
import type { Track } from '~/types/timeline'
import { LANE_HEIGHT } from '~/lib/timeline-utils'
import ClipComponent from './ClipComponent'

type TrackLaneProps = {
  track: Track
  index: number
  selectedClipIds: Set<string>
  onClipPointerDown: (trackId: string, clipId: string, e: PointerEvent) => void
  onClipClick: (trackId: string, clipId: string, e: MouseEvent) => void
  onClipResizeStart: (trackId: string, clipId: string, edge: 'left' | 'right', e: MouseEvent) => void
  isDropTarget?: boolean
  onClipDblClick?: (trackId: string, clipId: string, e: MouseEvent) => void
  bpm: number
}

const TrackLane: Component<TrackLaneProps> = (props) => {
  return (
    <div 
      class={`absolute left-0 right-0 ${props.isDropTarget ? 'bg-green-500/10' : 'bg-neutral-950'}`} 
      style={{ top: `${props.index * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}
    >
      <div class="absolute left-0 right-0 bottom-0 h-px bg-neutral-800" />
      <For each={props.track.clips}>
        {(clip) => (
          <ClipComponent
            clip={clip}
            trackId={props.track.id}
            isSelected={props.selectedClipIds.has(clip.id)}
            onPointerDown={props.onClipPointerDown}
            onClick={props.onClipClick}
            onResizeStart={props.onClipResizeStart}
            onDblClick={props.onClipDblClick}
            bpm={props.bpm}
          />
        )}
      </For>
    </div>
  )
}

export default TrackLane
