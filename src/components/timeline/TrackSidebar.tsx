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
        class="bg-neutral-900 border-l border-neutral-800 p-0 overflow-y-auto" 
        style={{ width: `${props.sidebarWidth}px`, 'min-width': '220px' }}
      >
        <div class="flex items-center justify-end p-1 -mb-[1.5px]">
          <button class="text-base text-neutral-400 hover:text-neutral-300 pr-2
           cursor-pointer active:scale-97 transition-transform ease-out" onClick={props.onAddTrack}>Add Track</button>
        </div>

        <For each={props.tracks}>
          {(track) => (
            <div 
              class={`${props.selectedTrackId === track.id ? 'bg-neutral-800' : 'bg-neutral-900 border-t border-neutral-800'}`} 
              style={{ height: '96px' }}
              onClick={() => props.onTrackClick(track.id)}
            >
              <div class="flex items-center gap-3 h-full px-3 py-2">
                {/* Track name */}
                <div class="font-semibold text-sm flex-1">{track.name}</div>
                
                {/* Vertical volume slider */}
                <div class="flex flex-col items-center gap-1">
                  <div class="text-xs text-neutral-400">Vol</div>
                  <div class="relative h-16 w-6">
                    {/* Custom slider track */}
                    <div class="absolute inset-0 w-1 bg-neutral-700 rounded-full left-1/2 transform -translate-x-1/2">
                      <div 
                        class="w-full bg-green-500 rounded-full transition-all duration-150"
                        style={{ 
                          height: `${track.volume * 100}%`,
                          position: 'absolute',
                          bottom: 0
                        }}
                      />
                    </div>
                    {/* Slider handle */}
                    <div 
                      class="absolute w-4 h-4 bg-neutral-300 border-2 border-neutral-500 rounded-full left-1/2 transform -translate-x-1/2 transition-all duration-150 cursor-pointer"
                      style={{ bottom: `${track.volume * 100}%` }}
                    />
                    {/* Invisible vertical slider input */}
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
                      onMouseDown={(e) => {
                        e.preventDefault()
                        const rect = e.currentTarget.getBoundingClientRect()
                        const handleMouseMove = (moveEvent: MouseEvent) => {
                          const y = moveEvent.clientY - rect.top
                          const height = rect.height
                          const volume = Math.max(0, Math.min(1, 1 - (y / height)))
                          props.onVolumeChange(track.id, volume)
                        }
                        const handleMouseUp = () => {
                          document.removeEventListener('mousemove', handleMouseMove)
                          document.removeEventListener('mouseup', handleMouseUp)
                        }
                        document.addEventListener('mousemove', handleMouseMove)
                        document.addEventListener('mouseup', handleMouseUp)
                      }}
                      class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>
    </>
  )
}

export default TrackSidebar