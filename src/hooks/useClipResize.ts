import { batch, type Accessor, type Setter } from 'solid-js'

import { PPS, quantizeSecToGrid } from '~/lib/timeline-utils'
import type { Track, SelectedClip } from '~/types/timeline'
import type { AudioEngine } from '~/lib/audio-engine'

const MIN_CLIP_SEC = 0.05

type ResizeState = {
  trackId: string
  clipId: string
  edge: 'left' | 'right'
}

type ClipResizeOptions = {
  tracks: Accessor<Track[]>
  setTracks: Setter<Track[]>
  setSelectedTrackId: Setter<string>
  setSelectedClip: Setter<SelectedClip>
  setSelectedClipIds: Setter<Set<string>>
  setSelectedFXTarget: Setter<string>
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  getScrollElement: () => HTMLDivElement | undefined
  // snapping
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  audioEngine: AudioEngine
  isPlaying: Accessor<boolean>
  playheadSec: Accessor<number>
  loopEnabled?: Accessor<boolean>
  loopEndSec?: Accessor<number>
  roomId?: Accessor<string | undefined>
  // optional history push
  historyPush?: (entry: import('~/lib/undo/types').HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
}

export type ClipResizeHandlers = {
  onClipResizeStart: (trackId: string, clipId: string, edge: 'left' | 'right', event: MouseEvent) => void
  onResizeMouseMove: (event: MouseEvent) => void
  onResizeMouseUp: () => void
}

export function useClipResize(options: ClipResizeOptions): ClipResizeHandlers {
  const {
    tracks,
    setTracks,
    setSelectedTrackId,
    setSelectedClip,
    setSelectedClipIds,
    setSelectedFXTarget,
    convexClient,
    convexApi,
    getScrollElement,
    audioEngine,
    isPlaying,
    playheadSec,
  } = options

  let clipResizing = false
  let resizing: ResizeState | null = null
  let resizeOrigStart = 0
  let resizeOrigDuration = 0
  let resizeOrigPad = 0
  let resizeAudioStart = 0
  let resizeFixedLeft = 0
  let resizeFixedRight = 0
  let resizeOrigBufferOffset = 0
  let resizeOrigMidiOffsetBeats = 0

  const onClipResizeStart = (trackId: string, clipId: string, edge: 'left' | 'right', event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const track = tracks().find(t => t.id === trackId)
    const clip = track?.clips.find(c => c.id === clipId)
    if (!track || !clip) return

    clipResizing = true
    resizing = { trackId, clipId, edge }
    resizeOrigStart = clip.startSec
    resizeOrigDuration = clip.duration
    resizeOrigPad = clip.leftPadSec ?? 0
    resizeAudioStart = resizeOrigStart + resizeOrigPad
    resizeFixedLeft = clip.startSec
    resizeFixedRight = clip.startSec + clip.duration
    resizeOrigBufferOffset = (clip as any).bufferOffsetSec ?? 0
    resizeOrigMidiOffsetBeats = (clip as any).midiOffsetBeats ?? 0

    batch(() => {
      setSelectedTrackId(trackId)
      setSelectedClip({ trackId, clipId })
      setSelectedClipIds(new Set([clipId]))
      setSelectedFXTarget(trackId)
    })

    window.addEventListener('mousemove', onResizeMouseMove)
    window.addEventListener('mouseup', onResizeMouseUp)
  }

  const onResizeMouseMove = (event: MouseEvent) => {
    if (!clipResizing || !resizing) return
    const scroll = getScrollElement()
    if (!scroll) return

    const track = tracks().find(t => t.id === resizing!.trackId)
    if (!track) return
    const clip = track.clips.find(c => c.id === resizing!.clipId)
    if (!clip) return

    const others = track.clips.filter(c => c.id !== clip.id)

    const rect = scroll.getBoundingClientRect()
    const x = event.clientX - rect.left + (scroll.scrollLeft || 0)
    const pointerSec = Math.max(0, x / PPS)

    if (resizing.edge === 'left') {
      const right = resizeFixedRight
      const maxStartByLen = right - MIN_CLIP_SEC
      let neighborEnd = 0
      for (const other of others) {
        const end = other.startSec + other.duration
        if (end <= resizeOrigStart && end > neighborEnd) neighborEnd = end
      }
      const minStartBound = Math.max(0, neighborEnd + 0.0001)
      const maxStartBound = maxStartByLen

      let newStart: number
      if (options.gridEnabled()) {
        // Quantize distance from right edge so duration becomes an integer multiple of grid step
        const dist = Math.max(0, right - pointerSec)
        let snapped = quantizeSecToGrid(dist, options.bpm(), options.gridDenominator(), 'round')
        // ensure at least MIN_CLIP_SEC
        if (snapped < MIN_CLIP_SEC) snapped = MIN_CLIP_SEC
        newStart = right - snapped
        // Respect bounds; if out of range, adjust to nearest valid multiple not exceeding bounds
        if (newStart < minStartBound) {
          const maxDist = Math.max(0, right - minStartBound)
          const maxSnapped = quantizeSecToGrid(maxDist, options.bpm(), options.gridDenominator(), 'floor')
          newStart = right - Math.max(MIN_CLIP_SEC, maxSnapped)
        }
        if (newStart > maxStartBound) {
          const minDist = Math.max(0, right - maxStartBound)
          const minSnapped = quantizeSecToGrid(minDist, options.bpm(), options.gridDenominator(), 'ceil')
          newStart = right - Math.max(MIN_CLIP_SEC, minSnapped)
        }
        // If we're within one grid step of the left neighbor's end, snap flush to its edge
        const step = (60 / Math.max(1e-6, options.bpm() || 0)) * (4 / Math.max(1, options.gridDenominator() || 4))
        if (Number.isFinite(neighborEnd) && newStart > (neighborEnd as number)) {
          const delta = newStart - (neighborEnd as number)
          if (delta <= step + 1e-7) newStart = neighborEnd as number
        }
      } else {
        newStart = Math.max(minStartBound, Math.min(pointerSec, maxStartBound))
      }

      const newDuration = Math.max(MIN_CLIP_SEC, right - newStart)
      // Compute pad/offset updates for audio and MIDI
      const isMidi = !!(clip as any).midi
      if (isMidi) {
        const spb = 60 / Math.max(1, options.bpm() || 120)
        const deltaSec = newStart - resizeOrigStart
        const deltaBeats = deltaSec / spb
        const base = Math.max(0, resizeOrigMidiOffsetBeats)
        const nextMidiOffset = Math.max(0, base + deltaBeats)
        setTracks(ts => ts.map(t => t.id !== track.id ? t : ({
          ...t,
          clips: t.clips.map(c => c.id !== clip.id ? c : ({ ...c, startSec: newStart, duration: newDuration, midiOffsetBeats: nextMidiOffset }))
        })))
      } else {
        const windowDuration = resizeFixedRight - resizeFixedLeft
        const fallbackBufferDur = Math.max(0, windowDuration - resizeOrigPad)
        const bufferDur = clip.buffer?.duration ?? fallbackBufferDur
        const delta = newStart - resizeOrigStart
        let nextLeftPad = resizeOrigPad
        let nextBufOffset = Math.max(0, resizeOrigBufferOffset)
        if (delta >= 0) {
          const consumePad = Math.min(nextLeftPad, delta)
          nextLeftPad = Math.max(0, nextLeftPad - consumePad)
          const remaining = delta - consumePad
          nextBufOffset = Math.max(0, Math.min(bufferDur, nextBufOffset + Math.max(0, remaining)))
        } else {
          const supply = -delta
          const reduceBuf = Math.min(nextBufOffset, supply)
          nextBufOffset = Math.max(0, nextBufOffset - reduceBuf)
          const leftover = supply - reduceBuf
          nextLeftPad = Math.max(0, nextLeftPad + Math.max(0, leftover))
        }
        setTracks(ts => ts.map(t => t.id !== track.id ? t : ({
          ...t,
          clips: t.clips.map(c => c.id !== clip.id ? c : ({ ...c, startSec: newStart, duration: newDuration, leftPadSec: nextLeftPad, bufferOffsetSec: nextBufOffset }))
        })))
      }
    } else {
      const left = resizeFixedLeft
      const minRightByLen = left + MIN_CLIP_SEC
      let neighborStart = Number.POSITIVE_INFINITY
      for (const other of others) {
        if (other.startSec >= resizeOrigStart && other.startSec < neighborStart) neighborStart = other.startSec
      }

      let newRight: number
      if (options.gridEnabled()) {
        const dist = Math.max(0, pointerSec - left)
        let snapped = quantizeSecToGrid(dist, options.bpm(), options.gridDenominator(), 'round')
        if (snapped < MIN_CLIP_SEC) snapped = MIN_CLIP_SEC
        newRight = left + snapped
        // Apply neighbor clamp using snapped multiples
        const maxRight = Number.isFinite(neighborStart) ? Math.min(neighborStart - 0.0001, Infinity) : Infinity
        if (newRight > maxRight) {
          const maxDist = Math.max(0, maxRight - left)
          const maxSnapped = quantizeSecToGrid(maxDist, options.bpm(), options.gridDenominator(), 'floor')
          newRight = left + Math.max(MIN_CLIP_SEC, maxSnapped)
        }
        if (newRight < minRightByLen) {
          const minDist = Math.max(0, minRightByLen - left)
          const minSnapped = quantizeSecToGrid(minDist, options.bpm(), options.gridDenominator(), 'ceil')
          newRight = left + Math.max(MIN_CLIP_SEC, minSnapped)
        }
        // If we're within one grid step of the right neighbor's start, snap flush to its edge
        if (Number.isFinite(neighborStart) && newRight < (neighborStart as number)) {
          const step = (60 / Math.max(1e-6, options.bpm() || 0)) * (4 / Math.max(1, options.gridDenominator() || 4))
          const delta = (neighborStart as number) - newRight
          if (delta <= step + 1e-7) newRight = neighborStart as number
        }
      } else {
        newRight = Math.max(pointerSec, minRightByLen)
        if (Number.isFinite(neighborStart)) newRight = Math.min(newRight, neighborStart - 0.0001)
      }

      const newDuration = Math.max(MIN_CLIP_SEC, newRight - left)

      setTracks(ts => ts.map(t => t.id !== track.id ? t : ({
        ...t,
        clips: t.clips.map(c => c.id !== clip.id ? c : ({ ...c, duration: newDuration }))
      })))
    }
  }

  const onResizeMouseUp = () => {
    if (!clipResizing || !resizing) {
      clipResizing = false
      resizing = null
      window.removeEventListener('mousemove', onResizeMouseMove)
      window.removeEventListener('mouseup', onResizeMouseUp)
      return
    }

    const track = tracks().find(t => t.id === resizing!.trackId)
    const clip = track?.clips.find(c => c.id === resizing!.clipId)

    clipResizing = false
    const active = resizing
    resizing = null
    window.removeEventListener('mousemove', onResizeMouseMove)
    window.removeEventListener('mouseup', onResizeMouseUp)

    if (track && clip && active) {
      void convexClient.mutation((convexApi as any).clips.setTiming, {
        clipId: clip.id as any,
        startSec: clip.startSec,
        duration: clip.duration,
        leftPadSec: clip.leftPadSec ?? 0,
        bufferOffsetSec: (clip as any).bufferOffsetSec ?? 0,
        midiOffsetBeats: (clip as any).midiOffsetBeats ?? 0,
      })
      try {
        const rid = (options as any).roomId?.() as string | undefined
        if (rid && typeof options.historyPush === 'function') {
          const from = {
            startSec: resizeOrigStart,
            duration: resizeOrigDuration,
            leftPadSec: resizeOrigPad,
            bufferOffsetSec: resizeOrigBufferOffset,
            midiOffsetBeats: resizeOrigMidiOffsetBeats,
          }
          const to = {
            startSec: clip.startSec,
            duration: clip.duration,
            leftPadSec: clip.leftPadSec,
            bufferOffsetSec: (clip as any).bufferOffsetSec,
            midiOffsetBeats: (clip as any).midiOffsetBeats,
          }
          const sameTiming =
            Math.abs((from.startSec ?? 0) - (to.startSec ?? 0)) < 1e-6 &&
            Math.abs((from.duration ?? 0) - (to.duration ?? 0)) < 1e-6 &&
            Math.abs((from.leftPadSec ?? 0) - (to.leftPadSec ?? 0)) < 1e-6 &&
            Math.abs((from.bufferOffsetSec ?? 0) - (to.bufferOffsetSec ?? 0)) < 1e-6 &&
            Math.abs((from.midiOffsetBeats ?? 0) - (to.midiOffsetBeats ?? 0)) < 1e-6
          if (!sameTiming) {
            options.historyPush({ type: 'clip-timing', roomId: rid, data: { clipId: clip.id, from, to } })
          }
        }
      } catch {}
      if (isPlaying() && audioEngine) {
        queueMicrotask(() => {
          try {
            const enabled = options.loopEnabled?.() ?? false
            const end = options.loopEndSec?.()
            const lenOk = enabled && typeof end === 'number'
            audioEngine.rescheduleClipsAtPlayhead(tracks(), playheadSec(), [clip.id], lenOk ? { endLimitSec: end } : undefined)
          } catch {}
        })
      }
    }
  }

  return {
    onClipResizeStart,
    onResizeMouseMove,
    onResizeMouseUp,
  }
}
