import { type Component, For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { canTrackReceiveAudioClip, getTrackChannelRole } from '~/lib/track-routing'
import { cn } from '~/lib/utils'
import type { Track } from '~/types/timeline'

type TrackSidebarProps = {
  tracks: Track[]
  selectedTrackId: string
  sidebarWidth: number
  onTrackClick: (trackId: string) => void
  onAddTrack: () => void
  onAddReturnTrack?: () => void
  onAddGroupTrack?: () => void
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
  isPlaying: boolean
  getTrackLevel: (trackId: string) => number
  getTrackLevels?: (trackId: string) => [number, number]
  bottomOffsetPx?: number
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

  const [meters, setMeters] = createSignal<Record<string, { L: number; R: number }>>({})
  let rafId: number | null = null
  let lastTs: number | null = null
  const releasePerSec = 3.0

  const scheduleTick = () => {
    if (rafId == null) rafId = requestAnimationFrame(tick)
  }

  const tick = () => {
    rafId = null
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) as number
    const dt = lastTs == null ? 0 : Math.max(0, (now - lastTs) / 1000)
    lastTs = now
    const prev = meters()
    const next: Record<string, { L: number; R: number }> = {}
    const playing = !!props.isPlaying

    try {
      for (const track of props.tracks) {
        let srcL = 0
        let srcR = 0
        if (playing) {
          const stereo = props.getTrackLevels?.(track.id)
          if (Array.isArray(stereo) && stereo.length === 2) {
            srcL = stereo[0] ?? 0
            srcR = stereo[1] ?? 0
          } else {
            const mono = props.getTrackLevel?.(track.id) ?? 0
            srcL = mono
            srcR = mono
          }
        }
        const previous = prev[track.id] || { L: 0, R: 0 }
        const decay = releasePerSec * dt
        const left = srcL >= previous.L ? srcL : Math.max(srcL, previous.L - decay)
        const right = srcR >= previous.R ? srcR : Math.max(srcR, previous.R - decay)
        next[track.id] = {
          L: Math.max(0, Math.min(1, left)),
          R: Math.max(0, Math.min(1, right)),
        }
      }
    } catch {}

    setMeters(next)
    const anyActive = Object.values(next).some((value) => value.L > 0.003 || value.R > 0.003)
    if (playing || anyActive) scheduleTick()
  }

  createEffect(() => {
    if (props.isPlaying) {
      scheduleTick()
      return
    }
    if (rafId == null) scheduleTick()
    lastTs = null
  })

  onCleanup(() => {
    if (rafId != null) cancelAnimationFrame(rafId)
  })

  return (
    <>
      <div class="w-1 cursor-col-resize bg-neutral-800 hover:bg-neutral-700" onMouseDown={props.onSidebarMouseDown} />

      <div
        class="overflow-y-auto border-l border-neutral-800 bg-neutral-900 p-0"
        style={{ width: `${props.sidebarWidth}px`, 'min-width': '220px', 'padding-bottom': `${props.bottomOffsetPx ?? 0}px` }}
      >
        <div class="flex items-center justify-between p-1">
          <div>
            <button
              class={cn(
                'rounded-md p-0.5 text-xs font-medium transition-transform ease-out active:scale-97',
                props.syncMix
                  ? 'bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/30'
                  : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-300',
              )}
              onClick={props.onToggleSyncMix}
              title="Toggle syncing mute/solo across users"
            >
              Sync Mix
            </button>
          </div>
          <div class="flex items-center gap-2 pr-2">
            <button class="cursor-pointer text-base text-neutral-400 transition-transform ease-out active:scale-97 hover:text-neutral-300" onClick={props.onAddTrack}>Add Track</button>
            <button class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700" onClick={() => props.onAddReturnTrack?.()} title="Add return track">+ Return</button>
            <button class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700" onClick={() => props.onAddGroupTrack?.()} title="Add group bus">+ Group</button>
            <button class="cursor-pointer rounded border border-neutral-700 bg-neutral-800 px-2 py-1 text-xs text-neutral-300 transition-transform ease-out active:scale-97 hover:bg-neutral-700" onClick={() => props.onAddInstrumentTrack?.()} title="Add instrument track (for MIDI clips)">+ Instrument</button>
          </div>
        </div>
        <For each={props.tracks}>
          {(track) => {
            const lockedByOther = !!track.lockedBy && track.lockedBy !== props.currentUserId
            const isRecordArmed = props.recordArmTrackId === track.id
            const channelRole = getTrackChannelRole(track)
            const isReturnTrack = channelRole === 'return'
            const isGroupTrack = channelRole === 'group'
            const muteDisabled = lockedByOther
            const soloDisabled = lockedByOther
            const volumeDisabled = lockedByOther
            const recordDisabled = lockedByOther || !canTrackReceiveAudioClip(track)
            const volume = () => track.volume ?? 0.8
            const muted = () => !!track.muted
            const soloed = () => !!track.soloed

            return (
              <div
                class={cn(
                  props.selectedTrackId === track.id
                    ? 'bg-neutral-800'
                    : 'border-t border-neutral-800 bg-neutral-900',
                )}
                style={{ height: '96px' }}
                onClick={() => props.onTrackClick(track.id)}
              >
                <div class="flex h-full items-center gap-3 px-3 py-2">
                  <button
                    class={cn(
                      'flex-1 rounded px-2 py-1 text-left text-sm font-semibold transition-colors',
                      muteDisabled
                        ? 'cursor-not-allowed bg-neutral-800/60 text-neutral-500'
                        : muted()
                          ? 'bg-amber-500 text-black ring-1 ring-amber-300'
                          : 'hover:bg-neutral-800',
                    )}
                    disabled={muteDisabled}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (muteDisabled) return
                      props.onToggleMute(track.id)
                    }}
                    title={lockedByOther ? 'Track locked by another user' : muted() ? 'Unmute track' : 'Mute track'}
                  >
                    <span class="flex items-center gap-2">
                      <span>{track.name}</span>
                      <Show when={isReturnTrack}>
                        <span class="rounded bg-neutral-700 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-300">Return</span>
                      </Show>
                      <Show when={isGroupTrack}>
                        <span class="rounded bg-neutral-700 px-1.5 py-0.5 text-xs uppercase tracking-wide text-neutral-300">Group</span>
                      </Show>
                    </span>
                  </button>

                  <button
                    class={cn(
                      'flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold transition-colors',
                      recordDisabled
                        ? 'cursor-not-allowed border-red-900 bg-neutral-800 text-red-900'
                        : isRecordArmed
                          ? 'border-red-400 bg-red-500 text-black shadow-inner'
                          : 'border-red-500 text-red-400 hover:bg-red-500/20',
                    )}
                    title={lockedByOther ? 'Track locked by another user' : isReturnTrack ? 'Return tracks cannot be armed for recording' : isGroupTrack ? 'Group tracks cannot be armed for recording' : track.kind === 'instrument' ? 'Instrument tracks cannot be armed for audio recording' : isRecordArmed ? 'Disarm recording' : 'Arm for recording'}
                    disabled={recordDisabled}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (recordDisabled) return
                      props.onToggleRecordArm(track.id)
                    }}
                  >
                    R
                  </button>

                  <button
                    class={cn(
                      'rounded px-2 py-1 text-xs font-semibold',
                      soloDisabled
                        ? 'cursor-not-allowed bg-neutral-700/40 text-neutral-500'
                        : soloed()
                          ? 'bg-blue-500/90 text-black ring-1 ring-blue-300'
                          : 'bg-neutral-700 text-neutral-200 hover:bg-neutral-600',
                    )}
                    disabled={soloDisabled}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (soloDisabled) return
                      props.onToggleSolo(track.id)
                    }}
                    title={lockedByOther ? 'Track locked by another user' : soloed() ? 'Unsolo' : 'Solo'}
                  >
                    S
                  </button>

                  <div class="flex flex-col items-center gap-1">
                    <div class="text-xs text-neutral-400">Vol</div>
                    <div class={cn('relative h-16 w-6', volumeDisabled && 'opacity-60')}>
                      <div class="absolute inset-0 flex items-end justify-center gap-1">
                        {(() => {
                          const meter = props.isPlaying ? meters()[track.id] : undefined
                          const left = Math.max(0, Math.min(1, meter?.L ?? 0))
                          const right = Math.max(0, Math.min(1, meter?.R ?? 0))
                          const leftColor = left >= 0.98 ? 'bg-red-500' : 'bg-green-500'
                          const rightColor = right >= 0.98 ? 'bg-red-500' : 'bg-green-500'
                          return (
                            <>
                              <div class="relative h-full w-1 overflow-hidden rounded-full bg-neutral-800/70">
                                <div class={cn('absolute bottom-0 w-full rounded-full transition-all duration-75', leftColor)} style={{ height: `${left * 100}%` }} />
                              </div>
                              <div class="relative h-full w-1 overflow-hidden rounded-full bg-neutral-800/70">
                                <div class={cn('absolute bottom-0 w-full rounded-full transition-all duration-75', rightColor)} style={{ height: `${right * 100}%` }} />
                              </div>
                            </>
                          )
                        })()}
                      </div>
                      <div class="absolute left-0 right-0" style={{ bottom: `${volume() * 100}%` }}>
                        <div class="absolute left-1/2 w-3 -translate-x-1/2">
                          <span class="absolute -left-2 select-none text-xs leading-none text-neutral-200">&lt;</span>
                          <span class="absolute -right-2 select-none text-xs leading-none text-neutral-200">&gt;</span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={volume()}
                        disabled={volumeDisabled}
                        onInput={(event) => {
                          if (volumeDisabled) return
                          const nextVolume = parseFloat((event.currentTarget as HTMLInputElement).value)
                          props.onVolumeChange(track.id, nextVolume)
                        }}
                        onMouseDown={(event) => {
                          if (volumeDisabled) {
                            event.preventDefault()
                            return
                          }
                          event.preventDefault()
                          const rect = event.currentTarget.getBoundingClientRect()
                          detachDragListeners()
                          const handleMouseMove = (moveEvent: MouseEvent) => {
                            const y = moveEvent.clientY - rect.top
                            const height = rect.height
                            const nextVolume = Math.max(0, Math.min(1, 1 - y / height))
                            props.onVolumeChange(track.id, nextVolume)
                          }
                          const handleMouseUp = () => {
                            detachDragListeners()
                          }
                          activeMove = handleMouseMove
                          activeUp = handleMouseUp
                          document.addEventListener('mousemove', handleMouseMove)
                          document.addEventListener('mouseup', handleMouseUp)
                        }}
                        class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
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
