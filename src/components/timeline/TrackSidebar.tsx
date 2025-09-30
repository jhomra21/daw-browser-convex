import { type Component, For, onCleanup, createEffect, createSignal } from 'solid-js'
import type { Track } from '~/types/timeline'

type TrackSidebarProps = {
  tracks: Track[]
  selectedTrackId: string
  sidebarWidth: number
  onTrackClick: (trackId: string) => void
  onAddTrack: () => void
  onAddInstrumentTrack?: () => void
  onVolumeChange: (trackId: string, volume: number) => void
  onSidebarMouseDown: (e: MouseEvent) => void
  onToggleMute: (trackId: string) => void
  onToggleSolo: (trackId: string) => void
  syncMix: boolean
  onToggleSyncMix: () => void
  recordArmTrackId: string | null
  onToggleRecordArm: (trackId: string) => void
  currentUserId?: string
  // Realtime meter support
  isPlaying: boolean
  getTrackLevel: (trackId: string) => number
}

const TrackSidebar: Component<TrackSidebarProps> = (props) => {
  let activeMove: ((event: MouseEvent) => void) | null = null
  let activeUp: (() => void) | null = null

  const detachDragListeners = () => {
    if (activeMove) {
      document.removeEventListener('mousemove', activeMove)
      activeMove = null
    }
    if (activeUp) {
      document.removeEventListener('mouseup', activeUp)
      activeUp = null
    }
  }

  onCleanup(() => {
    detachDragListeners()
  })

  // --- Realtime level polling ---
  const [levels, setLevels] = createSignal<Record<string, number>>({})
  let rafId: number | null = null

  const scheduleTick = () => {
    if (rafId == null) rafId = requestAnimationFrame(tick)
  }

  const tick = () => {
    rafId = null
    const next: Record<string, number> = {}
    try {
      for (const t of props.tracks) {
        next[t.id] = props.getTrackLevel?.(t.id) ?? 0
      }
    } catch {}
    setLevels(next)
    if (props.isPlaying) scheduleTick()
  }
  createEffect(() => {
    if (props.isPlaying) {
      scheduleTick()
    } else {
      if (rafId != null) { cancelAnimationFrame(rafId); rafId = null }
      setLevels({})
    }
  })
  onCleanup(() => { if (rafId != null) cancelAnimationFrame(rafId) })

  return (
    <>
      {/* Resizer handle */}
      <div class="w-1 cursor-col-resize bg-neutral-800 hover:bg-neutral-700" onMouseDown={props.onSidebarMouseDown} />

      {/* Track list */}
      <div 
        class="bg-neutral-900 border-l border-neutral-800 p-0 overflow-y-auto" 
        style={{ width: `${props.sidebarWidth}px`, 'min-width': '220px' }}
      >
        <div class="flex items-center justify-between p-1">
          <div>
            <button
              class={`text-xs font-medium p-0.5 rounded-md active:scale-97 transition-transform ease-out
                ${props.syncMix ? 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/30' : 'text-neutral-400 hover:text-neutral-300 hover:bg-neutral-800'}
              `}
              onClick={() => props.onToggleSyncMix()}
              title="Toggle syncing mute/solo across users"
            >
              Sync Mix
            </button>
          </div>
          <div class="flex items-center gap-2 pr-2">
            <button class="text-base text-neutral-400 hover:text-neutral-300
             cursor-pointer active:scale-97 transition-transform ease-out" onClick={props.onAddTrack}>Add Track</button>
            <button class="text-xs text-neutral-300 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-1
             cursor-pointer active:scale-97 transition-transform ease-out" onClick={() => props.onAddInstrumentTrack?.()} title="Add instrument track (for MIDI clips)">+ Instrument</button>
          </div>
        </div>
        <For each={props.tracks}>
          {(track) => {
            const lockedByOther = !!track.lockedBy && track.lockedBy !== props.currentUserId
            const isRecordArmed = props.recordArmTrackId === track.id
            const muteDisabled = lockedByOther
            const soloDisabled = lockedByOther
            const volumeDisabled = lockedByOther
            return (
              <div
                class={`${props.selectedTrackId === track.id ? 'bg-neutral-800' : 'bg-neutral-900 border-t border-neutral-800'}`}
                style={{ height: '96px' }}
                onClick={() => props.onTrackClick(track.id)}
              >
                <div class="flex items-center gap-3 h-full px-3 py-2">
                  <button
                    class={`font-semibold text-sm flex-1 text-left px-2 py-1 rounded cursor-pointer transition-colors
                      ${muteDisabled
                        ? 'bg-neutral-800/60 text-neutral-500 cursor-not-allowed'
                        : track.muted
                          ? 'bg-amber-500 text-black ring-1 ring-amber-300'
                          : 'hover:bg-neutral-800'
                      }
                    `}
                    disabled={muteDisabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (muteDisabled) return
                      props.onToggleMute(track.id)
                    }}
                    title={lockedByOther ? 'Track locked by another user' : track.muted ? 'Unmute track' : 'Mute track'}
                  >
                    {track.name}
                  </button>

                  {/* Move both Record and Solo to the right of the track name; Record to the left of Solo */}
                  <button
                    class={`w-6 h-6 flex items-center justify-center rounded-full border transition-colors text-xs font-bold
                      ${lockedByOther ? 'cursor-not-allowed border-red-900 text-red-900 bg-neutral-800' : isRecordArmed ? 'bg-red-500 text-black border-red-400 shadow-inner' : 'border-red-500 text-red-400 hover:bg-red-500/20'}
                    `}
                    title={lockedByOther ? 'Track locked by another user' : isRecordArmed ? 'Disarm recording' : 'Arm for recording'}
                    disabled={lockedByOther}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (lockedByOther) return
                      props.onToggleRecordArm(track.id)
                    }}
                  >
                    R
                  </button>

                  <button
                    class={`px-2 py-1 text-xs font-semibold rounded
                      ${soloDisabled
                        ? 'bg-neutral-700/40 text-neutral-500 cursor-not-allowed'
                        : track.soloed
                          ? 'bg-blue-500/90 text-black ring-1 ring-blue-300'
                          : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600'
                      }
                    `}
                    disabled={soloDisabled}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (soloDisabled) return
                      props.onToggleSolo(track.id)
                    }}
                    title={lockedByOther ? 'Track locked by another user' : track.soloed ? 'Unsolo' : 'Solo'}
                  >
                    S
                  </button>

                  <div class="flex flex-col items-center gap-1">
                    <div class="text-xs text-neutral-400">Vol</div>
                    <div class={`relative h-16 w-6 ${volumeDisabled ? 'opacity-60' : ''}`}>
                      <div class="absolute inset-0 flex flex-col items-center">
                        <div class="relative h-full w-1 rounded-full bg-neutral-800/70">
                          {(() => {
                            const level = props.isPlaying ? (levels()[track.id] ?? 0) : 0
                            return (
                              <div
                                class="absolute bottom-0 w-full rounded-full bg-green-500 transition-all duration-75"
                                style={{ height: `${Math.max(0, Math.min(1, level)) * 100}%` }}
                              />
                            )
                          })()}
                        </div>
                      </div>
                      {/* Volume handle indicators: one on each side of the meter line */}
                      <div class="absolute left-0 right-0" style={{ bottom: `${track.volume * 100}%` }}>
                        <div class="absolute left-1/2 -translate-x-1/2">
                          <span class="absolute -left-2 text-[10px] leading-none select-none text-neutral-200">&lt;</span>
                          <span class="absolute left-2 text-[10px] leading-none select-none text-neutral-200">&gt;</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={track.volume}
                        disabled={volumeDisabled}
                        onInput={(e) => {
                          if (volumeDisabled) return
                          const v = parseFloat((e.currentTarget as HTMLInputElement).value)
                          props.onVolumeChange(track.id, v)
                        }}
                        onMouseDown={(e) => {
                          if (volumeDisabled) {
                            e.preventDefault()
                            return
                          }
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          detachDragListeners()
                          const handleMouseMove = (moveEvent: MouseEvent) => {
                            const y = moveEvent.clientY - rect.top
                            const height = rect.height
                            const volume = Math.max(0, Math.min(1, 1 - (y / height)))
                            props.onVolumeChange(track.id, volume)
                          }
                          const handleMouseUp = () => {
                            detachDragListeners()
                          }
                          activeMove = handleMouseMove
                          activeUp = handleMouseUp
                          document.addEventListener('mousemove', handleMouseMove)
                          document.addEventListener('mouseup', handleMouseUp)
                        }}
                        class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </>
  )
}

export default TrackSidebar