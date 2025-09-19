import { type Component, Show, For, createEffect, createMemo, createSignal, onCleanup, onMount, batch } from 'solid-js'
import { Button } from '~/components/ui/button'

import { Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from '~/components/ui/dialog'

// Simple Ableton-style horizontal timeline with one track
// - Top transport (Play / Pause / Stop)
// - One track with volume control
// - Drag & drop an audio file onto the timeline to create a clip
// - Drag the clip horizontally to move it on the timeline
// - Toggle empty FX rows for track and master
//
// Minimal, intentionally: no waveform drawing, no loop/zoom yet.

// pixels per second for the timeline scale
const PPS = 100
const RULER_HEIGHT = 32 // px, matches h-8
const LANE_HEIGHT = 96 // px per track lane

type Clip = {
  id: string
  name: string
  buffer: AudioBuffer
  startSec: number
  duration: number
  color: string
}

type Track = {
  id: string
  name: string
  volume: number
  clips: Clip[]
}

const Timeline: Component = () => {
  // State
  const [tracks, setTracks] = createSignal<Track[]>([
    { id: 't1', name: 'Track 1', volume: 0.8, clips: [] },
  ])
  const [selectedTrackId, setSelectedTrackId] = createSignal('t1')
  const [selectedClip, setSelectedClip] = createSignal<{ trackId: string; clipId: string } | null>(null)
  const [isPlaying, setIsPlaying] = createSignal(false)
  const [playheadSec, setPlayheadSec] = createSignal(0)
  // Bottom FX tab state
  const [bottomFXOpen, setBottomFXOpen] = createSignal(true)
  // 'master' or a track id
  const [selectedFXTarget, setSelectedFXTarget] = createSignal<string>('master')
  const [sidebarWidth, setSidebarWidth] = createSignal(260)

  // Confirm delete track dialog state
  const [confirmOpen, setConfirmOpen] = createSignal(false)
  const [pendingDeleteTrackId, setPendingDeleteTrackId] = createSignal<string | null>(null)

  // Audio graph (created lazily)
  let audioCtx: AudioContext | null = null
  let masterGain: GainNode | null = null
  const trackGains = new Map<string, GainNode>()
  let activeSources: AudioBufferSourceNode[] = []

  // Playhead tracking
  let rafId = 0
  let startedCtxTime = 0
  let startedPlayheadSec = 0

  // DOM refs
  let scrollRef: HTMLDivElement | undefined
  let fileInputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined
  // Sidebar resize state
  let resizing = false
  let resizeStartX = 0
  let resizeStartWidth = 0

  const timelineDurationSec = () => {
    const ts = tracks()
    let maxEnd = 0
    for (const t of ts) {
      for (const c of t.clips) maxEnd = Math.max(maxEnd, c.startSec + c.duration)
    }
    // Ensure ample space for all clips + some padding; min 30s
    return Math.max(30, maxEnd + 5)
  }

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new AudioContext()
      masterGain = audioCtx.createGain()
      masterGain.gain.value = 1.0
      masterGain.connect(audioCtx.destination)
      // initialize per-track gains
      for (const t of tracks()) {
        if (!trackGains.get(t.id)) {
          const g = audioCtx.createGain()
          g.gain.value = t.volume
          g.connect(masterGain)
          trackGains.set(t.id, g)
        }
      }
    }
  }

  // Scrubbing helpers
  let scrubbing = false
  const clientXToSec = (clientX: number) => {
    const rect = scrollRef!.getBoundingClientRect()
    const x = clientX - rect.left + (scrollRef?.scrollLeft || 0)
    return Math.max(0, x / PPS)
  }

  function startScrub(clientX: number) {
    setPlayheadSec(clientXToSec(clientX))
    scrubbing = true
    window.addEventListener('mousemove', onScrubMove)
    window.addEventListener('mouseup', onScrubEnd)
  }

  function onScrubMove(e: MouseEvent) {
    if (!scrubbing) return
    setPlayheadSec(clientXToSec(e.clientX))
  }

  function onScrubEnd() {
    if (!scrubbing) return
    scrubbing = false
    window.removeEventListener('mousemove', onScrubMove)
    window.removeEventListener('mouseup', onScrubEnd)
    if (isPlaying() && audioCtx) {
      // Reschedule audio from new playhead position
      startedCtxTime = audioCtx.currentTime
      startedPlayheadSec = playheadSec()
      scheduleAllClipsFromCurrentPlayhead()
    }
  }

  // Helpers for drag/drop and overlap logic
  function yToLaneIndex(clientY: number) {
    const rect = scrollRef!.getBoundingClientRect()
    const y = clientY - rect.top
    return Math.floor((y - RULER_HEIGHT) / LANE_HEIGHT)
  }

  function willOverlap(clips: Clip[], excludeId: string | null, start: number, duration: number) {
    const end = start + duration
    for (const c of clips) {
      if (excludeId && c.id === excludeId) continue
      const cEnd = c.startSec + c.duration
      if (end > c.startSec && start < cEnd) return true
    }
    return false
  }

  function calcNonOverlapStart(clips: Clip[], excludeId: string | null, desiredStart: number, duration: number) {
    let start = Math.max(0, desiredStart)
    const sorted = clips.filter(c => !excludeId || c.id !== excludeId).slice().sort((a, b) => a.startSec - b.startSec)
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]
      if (start < c.startSec + c.duration && start + duration > c.startSec) {
        start = c.startSec + c.duration + 0.0001
        i = -1 // restart scan
      }
    }
    return start
  }

  // Keep per-track gains synced to track volumes
  createEffect(() => {
    const ts = tracks()
    if (!audioCtx || !masterGain || ts.length === 0) return
    
    // Add change detection to prevent unnecessary runs
    let hasChanges = false
    
    for (const t of ts) {
      let g = trackGains.get(t.id)
      if (!g) {
        g = audioCtx.createGain()
        g.connect(masterGain)
        trackGains.set(t.id, g)
        hasChanges = true
      }
      if (g.gain.value !== t.volume) {
        g.gain.value = t.volume
        hasChanges = true
      }
    }
    
    // cleanup removed tracks
    for (const [id, g] of Array.from(trackGains.entries())) {
      if (!ts.find(t => t.id === id)) {
        try { g.disconnect() } catch {}
        trackGains.delete(id)
        hasChanges = true
      }
    }
    
    // Only update if tracks actually changed in a meaningful way
    if (!hasChanges) return
  })

  function stopAllSources() {
    for (const s of activeSources) {
      try { s.stop() } catch {}
      try { s.disconnect() } catch {}
    }
    activeSources = []
  }

  function scheduleAllClipsFromCurrentPlayhead() {
    if (!audioCtx) return
    stopAllSources()
    const now = audioCtx.currentTime
    const current = playheadSec()
    for (const t of tracks()) {
      let g = trackGains.get(t.id)
      if (!g) {
        g = audioCtx.createGain()
        g.gain.value = t.volume
        g.connect(masterGain!)
        trackGains.set(t.id, g)
      }
      for (const c of t.clips) {
        const offset = Math.max(0, current - c.startSec)
        const when = Math.max(0, c.startSec - current)
        if (offset >= c.duration) continue
        const s = audioCtx.createBufferSource()
        s.buffer = c.buffer
        s.connect(g)
        s.start(now + when, offset)
        activeSources.push(s)
      }
    }
  }

  function tick() {
    if (!audioCtx || !isPlaying()) return
    const elapsed = audioCtx.currentTime - startedCtxTime
    setPlayheadSec(startedPlayheadSec + elapsed)
    rafId = requestAnimationFrame(tick)
  }

  async function handlePlay() {
    ensureAudio()
    if (!audioCtx) return
    await audioCtx.resume()
    setIsPlaying(true)
    startedCtxTime = audioCtx.currentTime
    startedPlayheadSec = playheadSec()
    scheduleAllClipsFromCurrentPlayhead()
    rafId = requestAnimationFrame(tick)
  }

  function handlePause() {
    if (!isPlaying()) return
    setIsPlaying(false)
    stopAllSources()
    cancelAnimationFrame(rafId)
  }

  function handleStop() {
    handlePause()
    setPlayheadSec(0)
  }

  onCleanup(() => {
    try { cancelAnimationFrame(rafId) } catch {}
    try { window.removeEventListener('mousemove', onScrubMove) } catch {}
    try { window.removeEventListener('mouseup', onScrubEnd) } catch {}
    try { window.removeEventListener('mousemove', onWindowMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onWindowMouseUp) } catch {}
    try { window.removeEventListener('mousemove', onSidebarMouseMove) } catch {}
    try { window.removeEventListener('mouseup', onSidebarMouseUp) } catch {}
    try { window.removeEventListener('keydown', onKeyDown) } catch {}
    stopAllSources()
    if (audioCtx) {
      try { audioCtx.close() } catch {}
    }
  })

  // Drag & drop
  function onDragOver(e: DragEvent) {
    e.preventDefault()
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (!file || !file.type.startsWith('audio')) return

    ensureAudio()

    const ab = await file.arrayBuffer()
    const decoded = await audioCtx!.decodeAudioData(ab)

    // Compute drop position: time X, and determine lane from Y (create track if below)
    const rect = scrollRef!.getBoundingClientRect()
    const x = e.clientX - rect.left + (scrollRef?.scrollLeft || 0)
    const desiredStart = Math.max(0, x / PPS)
    let laneIdx = yToLaneIndex(e.clientY)

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
      return
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

  // Add via button
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const file = Array.from(files).find(f => f.type.startsWith('audio'))
    if (!file) return
    ensureAudio()
    const ab = await file.arrayBuffer()
    const decoded = await audioCtx!.decodeAudioData(ab)
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
    // allow picking the same file again
    input.value = ''
  }

  // Drag a clip (allow vertical track reassign)
  let dragging = false
  let dragDeltaX = 0
  let draggingIds: { trackId: string; clipId: string } | null = null
  let dragTargetTrackIdx = -1
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
    dragTargetTrackIdx = tracks().findIndex(tt => tt.id === trackId)
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
    let laneIdx = yToLaneIndex(e.clientY)

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
    dragTargetTrackIdx = laneIdx

    const tsNow = tracks()
    const targetTrack = tsNow[laneIdx]
    if (!targetTrack) return

    // Locate moving clip and its source track
    let srcIdx = tsNow.findIndex(t => t.clips.some(c => c.id === draggingIds!.clipId))
    if (srcIdx < 0) return
    const movingClip = tsNow[srcIdx].clips.find(c => c.id === draggingIds!.clipId)!
    const duration = movingClip.duration

    if (targetTrack.id === tsNow[srcIdx].id) {
      // Same track: prevent overlap (snap forward to clear slot)
      const overlap = willOverlap(targetTrack.clips, movingClip.id, desiredStart, duration)
      const newStart = overlap ? calcNonOverlapStart(targetTrack.clips, movingClip.id, desiredStart, duration) : desiredStart
      setTracks(ts => ts.map((t, i) => i !== srcIdx ? t : ({
        ...t,
        clips: t.clips.map(c => c.id === movingClip.id ? { ...c, startSec: newStart } : c)
      })))
    } else {
      // Different track: move clip if no overlap (snap if needed)
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
    dragTargetTrackIdx = -1
    addedTrackDuringDrag = null
    draggingIds = null
    window.removeEventListener('mousemove', onWindowMouseMove)
    window.removeEventListener('mouseup', onWindowMouseUp)
  }

  // Start scrubbing from ruler (top grid)
  function onRulerMouseDown(e: MouseEvent) {
    e.preventDefault()
    startScrub(e.clientX)
  }

  // Select track and start scrubbing based on Y position
  function onLaneMouseDown(e: MouseEvent) {
    e.preventDefault()
    const rect = scrollRef!.getBoundingClientRect()
    const y = e.clientY - rect.top
    let trackIdx = Math.floor((y - RULER_HEIGHT) / LANE_HEIGHT)
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

  // Keyboard controls
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
      // Update selection based on remaining tracks
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
    // Reschedule audio if currently playing
    if (isPlaying() && audioCtx) {
      stopAllSources()
      startedCtxTime = audioCtx.currentTime
      startedPlayheadSec = playheadSec()
      scheduleAllClipsFromCurrentPlayhead()
    }
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

  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    if (e.code === 'Space') {
      e.preventDefault()
      isPlaying() ? handlePause() : handlePlay()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const hasClip = !!selectedClip()
      if (hasClip) {
        e.preventDefault()
        deleteSelectedClip()
      } else {
        e.preventDefault()
        requestDeleteSelectedTrack()
      }
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKeyDown)
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

  return (
    <div class="h-full w-full flex flex-col bg-neutral-950 text-neutral-200" onDragOver={onDragOver} onDrop={onDrop}>
      {/* Top Bar with centered transport */}
      <div class="grid grid-cols-3 items-center gap-2 p-3 border-b border-neutral-800 bg-neutral-900">
        {/* Left: Add Audio */}
        <div class="justify-self-start flex items-center gap-2">
          <input ref={el => (fileInputRef = el!)} type="file" accept="audio/*" class="hidden" onChange={onFileInput} />
          <Button variant="outline" onClick={() => fileInputRef?.click()}>Add Audio</Button>
        </div>

        {/* Center: Transport */}
        <div class="justify-self-center flex items-center gap-2">
          <Button onClick={handlePlay} disabled={isPlaying()}>Play</Button>
          <Button onClick={handlePause} variant="outline" disabled={!isPlaying()}>Pause</Button>
          <Button onClick={handleStop} variant="outline">Stop</Button>
        </div>

        {/* Right: Master FX + Playhead */}
        <div class="justify-self-end flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => { setSelectedFXTarget('master'); setBottomFXOpen(true) }}>Master FX</Button>
          <div class="flex items-center gap-2">
            <span class="text-sm text-neutral-400">Playhead</span>
            <span class="text-sm tabular-nums">{playheadSec().toFixed(2)}s</span>
          </div>
        </div>
      </div>

      {/* Main area: left timeline, resizer, right track list (resizable) */}
      <div class="flex-1 flex min-h-0" ref={el => (containerRef = el!)}>
        {/* Timeline (left) */}
        <div class="flex-1 relative overflow-x-auto" ref={el => (scrollRef = el!)}>
          <div class="relative select-none" style={{ width: `${timelineDurationSec() * PPS}px`, height: `${RULER_HEIGHT + tracks().length * LANE_HEIGHT}px` }} onMouseDown={onLaneMouseDown}>
            {/* Ruler */}
            <div class="absolute left-0 right-0 top-0 h-8 border-b border-neutral-800 bg-neutral-900" onMouseDown={onRulerMouseDown}>
              <For each={Array.from({ length: Math.ceil(timelineDurationSec()) + 1 }, (_, i) => i)}>
                {(i) => (
                  <div class="absolute top-0 bottom-0" style={{ left: `${i * PPS}px` }}>
                    <div class={i % 5 === 0 ? 'w-[2px] h-full bg-neutral-700' : 'w-px h-full bg-neutral-800'} />
                    <div class="absolute -top-6 text-xs text-neutral-400">{i}s</div>
                  </div>
                )}
              </For>
            </div>

            {/* Lanes */}
            <div class="absolute left-0 right-0" style={{ top: `${RULER_HEIGHT}px`, height: `${tracks().length * LANE_HEIGHT}px` }}>
              <For each={tracks()}>
                {(t, i) => (
                  <div class="absolute left-0 right-0 bg-neutral-950" style={{ top: `${i() * LANE_HEIGHT}px`, height: `${LANE_HEIGHT}px` }}>
                    <div class="absolute left-0 right-0 bottom-0 h-px bg-neutral-800" />
                    <For each={t.clips}>
                      {(c) => (
                        <div
                          class={`absolute top-2 rounded border ${selectedClip()?.clipId === c.id ? 'border-blue-400 bg-blue-500/25' : 'border-green-500/60 bg-green-500/20'} hover:bg-green-500/25 cursor-grab select-none`}
                          style={{ left: `${c.startSec * PPS}px`, width: `${Math.max(20, c.duration * PPS)}px`, height: `${LANE_HEIGHT - 16}px` }}
                          onMouseDown={(e) => onClipMouseDown(t.id, c.id, e)}
                          title={`${c.name} (${c.duration.toFixed(2)}s)`}
                          onClick={(e) => { 
                            e.stopPropagation()
                            batch(() => {
                              setSelectedTrackId(t.id)
                              setSelectedClip({ trackId: t.id, clipId: c.id })
                            })
                          }}
                        >
                          <div class="px-2 py-1 text-xs truncate">{c.name}</div>
                          <div class="absolute bottom-1 right-2 text-[10px] text-neutral-300">{c.duration.toFixed(2)}s</div>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>

              {/* Playhead */}
              <div class="absolute top-0 bottom-0 w-px bg-red-500 pointer-events-none" style={{ left: `${playheadSec() * PPS}px` }} />
            </div>
          </div>
        </div>

        {/* Resizer handle */}
        <div class="w-1 cursor-col-resize bg-neutral-800 hover:bg-neutral-700" onMouseDown={onSidebarMouseDown} />

        {/* Track list (right sidebar) */}
        <div class="bg-neutral-900 border-l border-neutral-800 p-3 overflow-y-auto" style={{ width: `${sidebarWidth()}px`, 'min-width': '220px' }}>
          <div class="flex items-center justify-between mb-3">
            <div class="font-semibold">Tracks</div>
            <Button size="sm" variant="outline" onClick={() => {
              const idx = tracks().length + 1
              const id = `t${idx}`
              setTracks(ts => [...ts, { id, name: `Track ${idx}`, volume: 0.8, clips: [] }])
              batch(() => {
                setSelectedTrackId(id)
                setSelectedFXTarget(id)
              })
            }}>Add Track</Button>
          </div>

          <For each={tracks()}>
            {(t) => (
              <div class={`mb-4 rounded p-2 ${selectedTrackId() === t.id ? 'bg-neutral-800' : 'bg-neutral-900 border border-neutral-800'}`} onClick={() => { 
                batch(() => {
                  setSelectedTrackId(t.id)
                  setSelectedFXTarget(t.id)
                  setSelectedClip(null)
                  setBottomFXOpen(true)
                })
              }}>
                <div class="font-semibold mb-2">{t.name}</div>
                <label class="flex items-center gap-2 text-sm text-neutral-300">
                  Volume
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={t.volume}
                    onInput={(e) => {
                      const v = parseFloat((e.currentTarget as HTMLInputElement).value)
                      setTracks(ts => ts.map(tt => tt.id === t.id ? { ...tt, volume: v } : tt))
                    }}
                    class="w-full accent-green-500"
                  />
                </label>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Bottom FX tab (collapsible) */}
      <Show when={bottomFXOpen()}>
        <div class="fixed left-0 right-0 bottom-0 border-t border-neutral-800 bg-neutral-900">
          <div class="h-10 px-4 flex items-center justify-between">
            <div class="font-semibold">
              {(() => {
                const id = selectedFXTarget()
                if (id === 'master') return 'Effects — Master'
                const t = tracks().find(t => t.id === id)
                return `Effects — ${t?.name ?? 'Track'}`
              })()}
            </div>
            <div class="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setBottomFXOpen(false)}>Collapse</Button>
            </div>
          </div>
          <div class="px-4 pb-4 text-sm text-neutral-400">
            No effects added yet.
          </div>
        </div>
      </Show>
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
            <Button variant="destructive" onClick={() => { const id = pendingDeleteTrackId(); if (id) performDeleteTrack(id); setPendingDeleteTrackId(null); setConfirmOpen(false) }}>Delete Track</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Show when={!bottomFXOpen()}>
        <button
          class="fixed bottom-4 right-4 bg-neutral-800 text-white rounded-md px-3 py-2 border border-neutral-700 hover:bg-neutral-700"
          onClick={() => setBottomFXOpen(true)}
        >
          Open Effects
        </button>
      </Show>
    </div>
  )
}

export default Timeline
