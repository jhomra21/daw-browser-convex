import { type Component, Show, For, createEffect, createSignal, onCleanup, onMount, batch } from 'solid-js'
import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'
import type { Track, Clip, SelectedClip } from '~/types/timeline'
import { AudioEngine } from '~/lib/audio-engine'
import { timelineDurationSec, clientXToSec, yToLaneIndex, willOverlap, calcNonOverlapStart, PPS, RULER_HEIGHT, LANE_HEIGHT } from '~/lib/timeline-utils'
import { useTimelineKeyboard } from '~/hooks/useTimelineKeyboard'
import { useTimelinePlayback } from '~/hooks/useTimelinePlayback'
import TransportControls from './timeline/TransportControls'
import TimelineRuler from './timeline/TimelineRuler'
import TrackLane from './timeline/TrackLane'
import TrackSidebar from './timeline/TrackSidebar'
import EffectsPanel from './timeline/EffectsPanel'
import { Button } from './ui/button'
const Timeline: Component = () => {
  // State
  const [tracks, setTracks] = createSignal<Track[]>([
    { id: 't1', name: 'Track 1', volume: 0.8, clips: [] },
  ])
  const [selectedTrackId, setSelectedTrackId] = createSignal('t1')
  const [selectedClip, setSelectedClip] = createSignal<SelectedClip>(null)
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [sidebarWidth, setSidebarWidth] = createSignal(260)
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<string | null>(null)

  // Audio engine
  const audioEngine = new AudioEngine()
  
  // Playback hook
  const { isPlaying, playheadSec, handlePlay, handlePause, handleStop, setPlayhead } = useTimelinePlayback(audioEngine)

  // DOM refs
  let scrollRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  
  // Sidebar resize state
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  // Scrubbing helpers
  let scrubbing = false

  function startScrub(clientX: number) {
    const sec = clientXToSec(clientX, scrollRef!)
    setPlayhead(sec, tracks())
    scrubbing = true
    window.addEventListener('mousemove', onScrubMove)
    window.addEventListener('mouseup', onScrubEnd)
  }

  function onScrubMove(e: MouseEvent) {
    if (!scrubbing) return
    const sec = clientXToSec(e.clientX, scrollRef!)
    setPlayhead(sec, tracks())
  }

  function onScrubEnd() {
    if (!scrubbing) return
    scrubbing = false
    window.removeEventListener('mousemove', onScrubMove)
    window.removeEventListener('mouseup', onScrubEnd)
  }

  // Keep audio engine synced with tracks
  createEffect(() => {
    audioEngine.updateTrackGains(tracks())
  })

  onCleanup(() => {
    try { window.removeEventListener('mousemove', onScrubMove) } catch {}
    try { window.removeEventListener('mouseup', onScrubEnd) } catch {}
    try { window.removeEventListener('mousemove', onWindowMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onWindowMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onSidebarMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onSidebarMouseUp) } catch {}
    audioEngine.close()
  })

  // Drag & drop
  function onDragOver(e: DragEvent) {
    e.preventDefault()
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (!file || !file.type.startsWith('audio')) return

    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)

    const desiredStart = clientXToSec(e.clientX, scrollRef!)
    let laneIdx = yToLaneIndex(e.clientY, scrollRef!)

    const ts0 = tracks()
    let targetTrackId: string
    
    if (laneIdx >= ts0.length) {
      targetTrackId = `t${ts0.length + 1}`
      const newClip: Clip = {
        id: String(Date.now()),
        name: file.name,
        buffer: decoded,
        startSec: desiredStart,
        duration: decoded.duration,
        color: '#22c55e',
      }
      setTracks(ts => [...ts, { id: targetTrackId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [newClip] }])
      batch(() => {
        setSelectedTrackId(targetTrackId)
        setSelectedClip({ trackId: targetTrackId, clipId: newClip.id })
        setSelectedFXTarget(targetTrackId)
      })
    } else {
      laneIdx = Math.max(0, Math.min(laneIdx, ts0.length - 1))
      const targetTrack = ts0[laneIdx]
      let startSec = desiredStart
      if (willOverlap(targetTrack.clips, null, startSec, decoded.duration)) {
        startSec = calcNonOverlapStart(targetTrack.clips, null, startSec, decoded.duration)
      }
      const newClip: Clip = {
        id: String(Date.now()),
        name: file.name,
        buffer: decoded,
        startSec,
        duration: decoded.duration,
        color: '#22c55e',
      }
      targetTrackId = targetTrack.id
      setTracks(ts => ts.map((t, i) => i !== laneIdx ? t : { ...t, clips: [...t.clips, newClip] }))
      batch(() => {
        setSelectedTrackId(targetTrackId)
        setSelectedClip({ trackId: targetTrackId, clipId: newClip.id })
        setSelectedFXTarget(targetTrackId)
      })
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    
    const ab = await file.arrayBuffer()
    const decoded = await audioEngine.decodeAudioData(ab)
    const targetTrackId = selectedTrackId()
    const ts0 = tracks()
    const tIdx = ts0.findIndex(t => t.id === targetTrackId)
    let startSec = Math.max(0, playheadSec())
    
    if (tIdx >= 0) {
      const tgt = ts0[tIdx]
      if (willOverlap(tgt.clips, null, startSec, decoded.duration)) {
        startSec = calcNonOverlapStart(tgt.clips, null, startSec, decoded.duration)
      }
    }
    
    const newClip: Clip = {
      id: String(Date.now()),
      name: file.name,
      buffer: decoded,
      startSec,
      duration: decoded.duration,
      color: '#22c55e',
    }
    
    setTracks(ts => ts.map(t => t.id === targetTrackId ? { ...t, clips: [...t.clips, newClip] } : t))
    batch(() => {
      setSelectedClip({ trackId: targetTrackId, clipId: newClip.id })
      setSelectedFXTarget(targetTrackId)
    })
  }

  async function onFileInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    await handleFiles(input.files)
    input.value = ''
  }

  // Drag a clip (allow vertical track reassign)
  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let addedTrackDuringDrag: string | null = null

  function onClipMouseDown(trackId: string, clipId: string, e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const t = tracks().find(t => t.id === trackId)
    const c = t?.clips.find(c => c.id === clipId)
    if (!t || !c) return
    
    dragging = true
    draggingIds = { trackId, clipId }
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
    })
    addedTrackDuringDrag = null

    const rect = scrollRef!.getBoundingClientRect()
    const leftPx = c.startSec * PPS - (scrollRef?.scrollLeft || 0)
    dragDeltaX = e.clientX - (rect.left + leftPx)

    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowMouseUp)
  }

  function onWindowMouseMove(e: MouseEvent) {
    if (!dragging || !draggingIds) return
    
    const rect = scrollRef!.getBoundingClientRect()
    const x = e.clientX - rect.left - dragDeltaX + (scrollRef?.scrollLeft || 0)
    const desiredStart = Math.max(0, x / PPS)
    let laneIdx = yToLaneIndex(e.clientY, scrollRef!)

    // Add a new track if dragging below last lane
    if (laneIdx >= tracks().length) {
      if (!addedTrackDuringDrag) {
        const newId = `t${tracks().length + 1}`
        setTracks(ts => [...ts, { id: newId, name: `Track ${ts.length + 1}`, volume: 0.8, clips: [] }])
        addedTrackDuringDrag = newId
      }
      laneIdx = Math.max(0, tracks().length - 1)
    }
    laneIdx = Math.max(0, Math.min(laneIdx, tracks().length - 1))

    const tsNow = tracks()
    const targetTrack = tsNow[laneIdx]
    if (!targetTrack) return

    // Locate moving clip and its source track
    let srcIdx = tsNow.findIndex(t => t.clips.some(c => c.id === draggingIds!.clipId))
    if (srcIdx < 0) return
    const movingClip = tsNow[srcIdx].clips.find(c => c.id === draggingIds!.clipId)!
    const duration = movingClip.duration

    if (targetTrack.id === tsNow[srcIdx].id) {
      // Same track: prevent overlap
      const overlap = willOverlap(targetTrack.clips, movingClip.id, desiredStart, duration)
      const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, movingClip.id, desiredStart, duration) : desiredStart
      setTracks(ts => ts.map((t, i) => i !== srcIdx ? t : ({
        ...t,
        clips: t.clips.map(c => c.id === movingClip.id ? { ...c, startSec: newStart } : c)
      })))
    } else {
      // Different track: move clip
      const overlap = willOverlap(targetTrack.clips, null, desiredStart, duration)
      const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, null, desiredStart, duration) : desiredStart
      const targetId = targetTrack.id
      const clipId = movingClip.id
      setTracks(ts => ts.map((t, i) => {
        if (i === srcIdx) return { ...t, clips: t.clips.filter(c => c.id !== clipId) }
        if (t.id === targetId) return { ...t, clips: [...t.clips, { ...movingClip, startSec: newStart }] }
        return t
      }))
      draggingIds = { trackId: targetId, clipId }
      batch(() => {
        setSelectedTrackId(targetId)
        setSelectedFXTarget(targetId)
        setSelectedClip({ trackId: targetId, clipId })
      })
    }
  }

  function onWindowMouseUp() {
    dragging = false
    addedTrackDuringDrag = null
    draggingIds = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  function onRulerMouseDown(e: MouseEvent) {
    e.preventDefault()
    startScrub(e.clientX)
  }

  function onLaneMouseDown(e: MouseEvent) {
    e.preventDefault()
    let trackIdx = yToLaneIndex(e.clientY, scrollRef!)
    trackIdx = Math.max(0, Math.min(trackIdx, tracks().length - 1))
    const id = tracks()[trackIdx]?.id
    if (id) {
      batch(() => {
        setSelectedTrackId(id)
        setSelectedFXTarget(id)
        setSelectedClip(null)
      })
    }
    startScrub(e.clientX)
  }

  function onClipClick(trackId: string, clipId: string, e: MouseEvent) {
    e.stopPropagation()
    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
    })
  }

  function deleteSelectedClip() {
    const sel = selectedClip()
    if (!sel) return
    setTracks(ts => ts.map(t => t.id !== sel.trackId ? t : ({
      ...t,
      clips: t.clips.filter(c => c.id !== sel.clipId)
    })))
    setSelectedClip(null)
  }

  function performDeleteTrack(id: string) {
    setTracks(ts => {
      const next = ts.filter(t => t.id !== id)
      batch(() => {
        setSelectedClip(null)
        if (next.length > 0) {
          setSelectedTrackId(next[0].id)
          setSelectedFXTarget(next[0].id)
        } else {
          setSelectedTrackId('')
          setSelectedFXTarget('master')
        }
      })
      return next
    })
  }

  function requestDeleteSelectedTrack() {
    const id = selectedTrackId()
    if (!id) return
    const t = tracks().find(tt => tt.id === id)
    if (!t) return
    if (t.clips.length > 0) {
      setPendingDeleteTrackId(id)
      setConfirmOpen(true)
    } else {
      performDeleteTrack(id)
    }
  }

  function handleKeyboardAction() {
    const hasClip = !!selectedClip()
    if (hasClip) {
      deleteSelectedClip()
    } else {
      requestDeleteSelectedTrack()
    }
  }

  useTimelineKeyboard({
    onSpace: () => isPlaying() ? handlePause() : handlePlay(tracks()),
    onDelete: handleKeyboardAction
  })

  // Sidebar resizer
  function onSidebarMouseDown(e: MouseEvent) {
    e.preventDefault()
    resizing = true
    resizeStartX = e.clientX
    resizeStartWidth = sidebarWidth()
    window.addEventListener('mousemove', onSidebarMouseMove)
    window.addEventListener('mouseup', onSidebarMouseUp)
  }

  function onSidebarMouseMove(e: MouseEvent) {
    if (!resizing) return
    const containerW = containerRef?.clientWidth ?? 0
    const delta = resizeStartX - e.clientX // dragging left increases width
    const minW = 220
    const maxW = Math.max(minW, Math.floor(containerW * 0.7))
    const next = Math.max(minW, Math.min(maxW, resizeStartWidth + delta))
    setSidebarWidth(next)
  }

  function onSidebarMouseUp() {
    resizing = false
    window.removeEventListener('mousemove', onSidebarMouseMove)
    window.removeEventListener('mouseup', onSidebarMouseUp)
  }

  const duration = () => timelineDurationSec(tracks())

  return (
    <div class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200" onDragOver={onDragOver} onDrop={onDrop}>
      <input ref={el => (fileInputRef = el!)} type="file" accept="audio/*" class="hidden" onChange={onFileInput} />
      
      <TransportControls
        isPlaying={isPlaying()}
        playheadSec={playheadSec()}
        onPlay={() => handlePlay(tracks())}
        onPause={handlePause}
        onStop={handleStop}
        onAddAudio={() => fileInputRef?.click()}
        onMasterFX={() => { setSelectedFXTarget('master'); setBottomFXOpen(true) }}
      />

      <div class="flex-1 flex min-h-0" ref={el => (containerRef = el!)}>
        <div class="flex-1 relative overflow-x-auto" ref={el => (scrollRef = el!)}>
          <div 
            class="relative select-none" 
            style={{ width: `${duration() * PPS}px`, height: `${RULER_HEIGHT + tracks().length * LANE_HEIGHT}px` }} 
            onMouseDown={onLaneMouseDown}
          >
            <TimelineRuler durationSec={duration()} onMouseDown={onRulerMouseDown} />
            
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${tracks().length * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(track, i) => (
                  <TrackLane
                    track={track}
                    index={i()}
                    selectedClip={selectedClip()}
                    onClipMouseDown={onClipMouseDown}
                    onClipClick={onClipClick}
                  />
                )}
              </For>
              
              {/* Playhead */}
              <div class="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none" style={{ left: `${playheadSec() * PPS}px` }} />
            </div>
          </div>
        </div>

        <TrackSidebar
          tracks={tracks()}
          selectedTrackId={selectedTrackId()}
          sidebarWidth={sidebarWidth()}
          onTrackClick={(id) => {
            batch(() => {
              setSelectedTrackId(id)
              setSelectedFXTarget(id)
              setSelectedClip(null)
              setBottomFXOpen(true)
            })
          }}
          onAddTrack={() => {
            const idx = tracks().length + 1
            const id = `t${idx}`
            setTracks(ts => [...ts, { id, name: `Track ${idx}`, volume: 0.8, clips: [] }])
            batch(() => {
              setSelectedTrackId(id)
              setSelectedFXTarget(id)
            })
          }}
          onVolumeChange={(trackId, volume) => {
            setTracks(ts => ts.map(t => t.id === trackId ? { ...t, volume } : t))
          }}
          onSidebarMouseDown={onSidebarMouseDown}
        />
      </div>

      <EffectsPanel
        isOpen={bottomFXOpen()}
        selectedFXTarget={selectedFXTarget()}
        tracks={tracks()}
        onClose={() => setBottomFXOpen(false)}
        onOpen={() => setBottomFXOpen(true)}
      />

      <Dialog open={confirmOpen()} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this track?</DialogTitle>
            <DialogDescription>
              {(() => {
                const id = pendingDeleteTrackId()
                const t = tracks().find(tt => tt.id === id)
                const count = t?.clips.length ?? 0
                return count > 0
                  ? `This track contains ${count} audio clip${count === 1 ? '' : 's'}. Deleting the track will remove them. This action cannot be undone.`
                  : `This track has no audio clips. Deleting it cannot be undone.`
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConfirmOpen(false); setPendingDeleteTrackId(null) }}>Cancel</Button>
            <Button variant="destructive" onClick={() => { 
              const id = pendingDeleteTrackId()
              if (id) performDeleteTrack(id)
              setPendingDeleteTrackId(null)
              setConfirmOpen(false)
            }}>Delete Track</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Timeline
