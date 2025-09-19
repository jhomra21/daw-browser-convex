import { type Component } from 'solid-js'
import type { Clip } from '~/types/timeline'
import { PPS, LANE_HEIGHT } from '~/lib/timeline-utils'

type ClipComponentProps = {
  clip: Clip
  trackId: string
  isSelected: boolean
  onMouseDown: (trackId: string, clipId: string, e: MouseEvent) => void
  onClick: (trackId: string, clipId: string, e: MouseEvent) => void
}

const ClipComponent: Component<ClipComponentProps> = (props) => {
  return (
    <div
      class={`absolute top-2 rounded border ${props.isSelected ? 'border-blue-400 bg-blue-500/25' : 'border-green-500/60 bg-green-500/20'} hover:bg-green-500/25 cursor-grab select-none`}
      style={{ 
        left: `${props.clip.startSec * PPS}px`, 
        width: `${Math.max(20, props.clip.duration * PPS)}px`, 
        height: `${LANE_HEIGHT - 16}px` 
      }}
      onMouseDown={(e) => props.onMouseDown(props.trackId, props.clip.id, e)}
      onClick={(e) => props.onClick(props.trackId, props.clip.id, e)}
      title={`${props.clip.name} (${props.clip.duration.toFixed(2)}s)`}
    >
      <div class="px-2 py-1 text-xs truncate">{props.clip.name}</div>
      <div class="absolute bottom-1 right-2 text-[10px] text-neutral-300">
        {props.clip.duration.toFixed(2)}s
      </div>
    </div>
  )
}

export default ClipComponent