import { type Component, For } from 'solid-js'
import { PPS, RULER_HEIGHT } from '~/lib/timeline-utils'

type TimelineRulerProps = {
  durationSec: number
  onMouseDown: (e: MouseEvent) => void
}

const TimelineRuler: Component<TimelineRulerProps> = (props) => {
  return (
    <div class="absolute left-0 right-0 top-0 h-8 border-b border-neutral-800 bg-neutral-900" onMouseDown={props.onMouseDown}>
      <For each={Array.from({ length: Math.ceil(props.durationSec) + 1 }, (_, i) => i)}>
        {(i) => (
          <div class="absolute top-0 bottom-0" style={{ left: `${i * PPS}px` }}>
            <div class={i % 5 === 0 ? 'w-[2px] h-full bg-neutral-700' : 'w-px h-full bg-neutral-800'} />
            <div class="absolute -top-6 text-xs text-neutral-400">{i}s</div>
          </div>
        )}
      </For>
    </div>
  )
}

export default TimelineRuler