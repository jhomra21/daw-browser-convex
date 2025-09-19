import { type Component, For } from 'solid-js'
import type { Track } from '~/types/timeline'
import { Button } from '~/components/ui/button'

type TrackSidebarProps = {
  tracks: Track[]
  selectedTrackId: string
  sidebarWidth: number
  onTrackClick: (trackId: string) => void
  onAddTrack: () => void
  onVolumeChange: (trackId: string, volume: number) => void
  onSidebarMouseDown: (e: MouseEvent) => void
}

const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  return (
    <>
      {/* Resizer handle */}
      <div class="w-1 cursor-col-resize bg-neutral-800 hover:bg-neutral-700" onMouseDown={props.onSidebarMouseDown} />

      {/* Track list */}
      <div 
        class="bg-neutral-900 border-l border-neutral-800 p-3 overflow-y-auto" 
        style={{ width: `${props.sidebarWidth}px`, 'min-width': '220px' }}
      >
        <div class="flex items-center justify-between mb-3">
          <div class="font-semibold">Tracks</div>
          <Button size="sm" variant="outline" onClick={props.onAddTrack}>Add Track</Button>
        </div>

        <For each={props.tracks}>
          {(track) => (
            <div 
              class={`mb-4 rounded p-2 ${props.selectedTrackId === track.id ? 'bg-neutral-800' : 'bg-neutral-900 border border-neutral-800'}`} 
              onClick={() => props.onTrackClick(track.id)}
            >
              <div class="font-semibold mb-2">{track.name}</div>
              <label class="flex items-center gap-2 text-sm text-neutral-300">
                Volume
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={track.volume}
                  onInput={(e) => {
                    const v = parseFloat((e.currentTarget as HTMLInputElement).value)
                    props.onVolumeChange(track.id, v)
                  }}
                  class="w-full accent-green-500"
                />
              </label>
            </div>
          )}
        </For>
      </div>
    </>
  )
}

export default TrackSidebar