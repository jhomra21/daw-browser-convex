import { onCleanup, type Accessor } from 'solid-js'

import { persistClipTiming, persistClipTimingAndAudioWarp } from '~/lib/clip-mutations'
import { calculateAudioLeftResizeTiming } from '~/lib/audio-left-resize-timing'
import { audioWarpEqual, isLocalId } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import { buildClipTimingHistoryEntry } from '~/lib/undo/builders'
import { PPS, quantizeSecToGrid } from '~/lib/timeline-utils'
import type { Track } from '@daw-browser/timeline-core/types'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'

import type { TimelineSelectionController } from './useTimelineSelectionState'

const MIN_CLIP_SEC = 0.05

type ResizeState = {
  trackId: Track['id']
  clipId: string
  edge: 'left' | 'right'
}

type ClipResizeOptions = {
  tracks: Accessor<RuntimeTrack[]>
  setDraftClipTiming: (clipId: string, patch: { startSec?: number; duration?: number; leftPadSec?: number; bufferOffsetSec?: number; audioWarp?: RuntimeTrack['clips'][number]['audioWarp']; midiOffsetBeats?: number } | null) => void
  commitClipTiming: (clipId: string, patch: { startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; audioWarp?: RuntimeTrack['clips'][number]['audioWarp']; midiOffsetBeats?: number }) => void
  canWriteClip: (clipId: string) => boolean
  selection: TimelineSelectionController
  convexClient: typeof import('~/lib/convex').convexClient
  convexApi: typeof import('~/lib/convex').convexApi
  userId: Accessor<string | undefined>
  getScrollElement: () => HTMLDivElement | undefined
  bpm: Accessor<number>
  gridEnabled: Accessor<boolean>
  gridDenominator: Accessor<number>
  rescheduleChangedClips: (clipIds: string[]) => void
  projectId: Accessor<string | undefined>
  historyPush: (entry: import('~/lib/undo/types').HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
}

type ClipResizeHandlers = {
  onClipResizeStart: (trackId: Track['id'], clipId: string, edge: 'left' | 'right', event: PointerEvent) => void
}

export function useClipResize(options: ClipResizeOptions): ClipResizeHandlers {
  const {
    tracks,
    setDraftClipTiming,
    commitClipTiming,
    canWriteClip,
    selection,
    convexClient,
    convexApi,
    userId,
    getScrollElement,
  } = options

  let clipResizing = false
  let resizing: ResizeState | null = null
  let resizeOrigStart = 0
  let resizeOrigDuration = 0
  let resizeOrigPad = 0
  let resizeFixedLeft = 0
  let resizeFixedRight = 0
  let resizeOrigBufferOffset = 0
  let resizeOrigAudioWarp: RuntimeTrack['clips'][number]['audioWarp']
  let resizeOrigMidiOffsetBeats = 0
  let resizeBaselineAudioClip: RuntimeTrack['clips'][number] | null = null
  let activeResizePointerId: number | null = null
  let activeResizeCaptureTarget: HTMLElement | null = null

  const removeResizeListeners = () => {
    window.removeEventListener('pointermove', onResizePointerMove)
    window.removeEventListener('pointerup', onResizePointerUp, { capture: true })
    window.removeEventListener('pointercancel', onResizePointerUp, { capture: true })
    window.removeEventListener('blur', onResizePointerUp)
    if (activeResizeCaptureTarget && activeResizePointerId !== null) {
      try {
        if (activeResizeCaptureTarget.hasPointerCapture(activeResizePointerId)) {
          activeResizeCaptureTarget.releasePointerCapture(activeResizePointerId)
        }
      } catch {}
    }
    activeResizePointerId = null
    activeResizeCaptureTarget = null
  }

  const onClipResizeStart = (trackId: Track['id'], clipId: string, edge: 'left' | 'right', event: PointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const track = tracks().find(t => t.id === trackId)
    const clip = track?.clips.find(c => c.id === clipId)
    if (!track || !clip) return
    if (!canWriteClip(clipId)) return

    clipResizing = true
    resizing = { trackId, clipId, edge }
    resizeOrigStart = clip.startSec
    resizeOrigDuration = clip.duration
    resizeOrigPad = clip.leftPadSec ?? 0
    resizeFixedLeft = clip.startSec
    resizeFixedRight = clip.startSec + clip.duration
    resizeOrigBufferOffset = clip.bufferOffsetSec ?? 0
    resizeOrigAudioWarp = clip.audioWarp
    resizeOrigMidiOffsetBeats = clip.midiOffsetBeats ?? 0
    resizeBaselineAudioClip = { ...clip }

    selection.selectPrimaryClip({ trackId, clipId })

    if (event.currentTarget instanceof HTMLElement) {
      activeResizePointerId = event.pointerId
      activeResizeCaptureTarget = event.currentTarget
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {}
    }
    window.addEventListener('pointermove', onResizePointerMove)
    window.addEventListener('pointerup', onResizePointerUp, { capture: true })
    window.addEventListener('pointercancel', onResizePointerUp, { capture: true })
    window.addEventListener('blur', onResizePointerUp)
  }

  const onResizePointerMove = (event: PointerEvent) => {
    if (!clipResizing || !resizing) return
    const scroll = getScrollElement()
    if (!scroll) return

    const activeResize = resizing
    const track = tracks().find(t => t.id === activeResize.trackId)
    if (!track) return
    const clip = track.clips.find(c => c.id === activeResize.clipId)
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
        const dist = Math.max(0, right - pointerSec)
        let snapped = quantizeSecToGrid(dist, options.bpm(), options.gridDenominator(), 'round')
        if (snapped < MIN_CLIP_SEC) snapped = MIN_CLIP_SEC
        newStart = right - snapped
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
        const step = (60 / Math.max(1e-6, options.bpm() || 0)) * (4 / Math.max(1, options.gridDenominator() || 4))
        if (Number.isFinite(neighborEnd) && newStart > neighborEnd) {
          const delta = newStart - neighborEnd
          if (delta <= step + 1e-7) newStart = neighborEnd
        }
      } else {
        newStart = Math.max(minStartBound, Math.min(pointerSec, maxStartBound))
      }

      const newDuration = Math.max(MIN_CLIP_SEC, right - newStart)
      const isMidi = !!clip.midi
      if (isMidi) {
        const spb = 60 / Math.max(1, options.bpm() || 120)
        const deltaSec = newStart - resizeOrigStart
        const deltaBeats = deltaSec / spb
        const base = Math.max(0, resizeOrigMidiOffsetBeats)
        const nextMidiOffset = Math.max(0, base + deltaBeats)
        setDraftClipTiming(clip.id, {
          startSec: newStart,
          duration: newDuration,
          midiOffsetBeats: nextMidiOffset,
        })
      } else {
        const windowDuration = resizeFixedRight - resizeFixedLeft
        const fallbackBufferDur = Math.max(0, windowDuration - resizeOrigPad)
        const bufferDur = clip.buffer?.duration ?? fallbackBufferDur
        const timing = calculateAudioLeftResizeTiming({
          baselineClip: resizeBaselineAudioClip ?? clip,
          fixedRightSec: resizeFixedRight,
          newStartSec: newStart,
          bufferDurationSec: bufferDur,
          projectBpm: options.bpm(),
        })
        setDraftClipTiming(clip.id, {
          startSec: timing.startSec,
          duration: newDuration,
          leftPadSec: timing.leftPadSec,
          bufferOffsetSec: timing.bufferOffsetSec,
          audioWarp: timing.audioWarp,
        })
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
        if (Number.isFinite(neighborStart) && newRight < neighborStart) {
          const step = (60 / Math.max(1e-6, options.bpm() || 0)) * (4 / Math.max(1, options.gridDenominator() || 4))
          const delta = neighborStart - newRight
          if (delta <= step + 1e-7) newRight = neighborStart
        }
      } else {
        newRight = Math.max(pointerSec, minRightByLen)
        if (Number.isFinite(neighborStart)) newRight = Math.min(newRight, neighborStart - 0.0001)
      }

      const newDuration = Math.max(MIN_CLIP_SEC, newRight - left)

      setDraftClipTiming(clip.id, { duration: newDuration })
    }
  }

  const onResizePointerUp = (event?: PointerEvent | FocusEvent) => {
    if (event instanceof PointerEvent && activeResizePointerId !== null && event.pointerId !== activeResizePointerId) return
    if (!clipResizing || !resizing) {
      clipResizing = false
      resizing = null
      removeResizeListeners()
      return
    }

    const active = resizing
    const track = tracks().find(t => t.id === active.trackId)
    const clip = track?.clips.find(c => c.id === active.clipId)

    clipResizing = false
    resizing = null
    resizeBaselineAudioClip = null
    removeResizeListeners()

    if (clip) {
      setDraftClipTiming(clip.id, null)
      commitClipTiming(clip.id, {
        startSec: clip.startSec,
        duration: clip.duration,
        leftPadSec: clip.leftPadSec,
        bufferOffsetSec: clip.bufferOffsetSec,
        audioWarp: clip.audioWarp,
        midiOffsetBeats: clip.midiOffsetBeats,
      })
      const rid = options.projectId()
      const from = {
        startSec: resizeOrigStart,
        duration: resizeOrigDuration,
        leftPadSec: resizeOrigPad,
        bufferOffsetSec: resizeOrigBufferOffset,
        audioWarp: resizeOrigAudioWarp,
        midiOffsetBeats: resizeOrigMidiOffsetBeats,
      }
      const to = {
        startSec: clip.startSec,
        duration: clip.duration,
        leftPadSec: clip.leftPadSec,
        bufferOffsetSec: clip.bufferOffsetSec,
        audioWarp: clip.audioWarp,
        midiOffsetBeats: clip.midiOffsetBeats,
      }
      const timingEpsilon = 1e-6
      const timingMatches = (target: typeof to, current: typeof to) => (
        Math.abs((target.startSec ?? 0) - (current.startSec ?? 0)) < timingEpsilon &&
        Math.abs((target.duration ?? 0) - (current.duration ?? 0)) < timingEpsilon &&
        Math.abs((target.leftPadSec ?? 0) - (current.leftPadSec ?? 0)) < timingEpsilon &&
        Math.abs((target.bufferOffsetSec ?? 0) - (current.bufferOffsetSec ?? 0)) < timingEpsilon &&
        audioWarpEqual(target.audioWarp, current.audioWarp) &&
        Math.abs((target.midiOffsetBeats ?? 0) - (current.midiOffsetBeats ?? 0)) < timingEpsilon
      )
      const sameTiming = timingMatches(from, to)
      const pushHistory = () => {
        if (rid) {
          options.historyPush(buildClipTimingHistoryEntry({ projectId: rid, clip, from, to }))
        }
      }
      const rollbackTiming = () => {
        const currentClip = tracks()
          .flatMap((track) => track.clips)
          .find((current) => current.id === clip.id)
        if (
          options.projectId() !== rid ||
          !currentClip ||
          !timingMatches(to, {
            startSec: currentClip.startSec,
            duration: currentClip.duration,
            leftPadSec: currentClip.leftPadSec,
            bufferOffsetSec: currentClip.bufferOffsetSec,
            audioWarp: currentClip.audioWarp,
            midiOffsetBeats: currentClip.midiOffsetBeats,
          })
        ) {
          return
        }
        commitClipTiming(clip.id, {
          startSec: from.startSec,
          duration: from.duration,
          leftPadSec: from.leftPadSec,
          bufferOffsetSec: from.bufferOffsetSec,
          audioWarp: from.audioWarp,
          midiOffsetBeats: from.midiOffsetBeats,
        })
        queueMicrotask(() => options.rescheduleChangedClips([clip.id]))
      }
      if (sameTiming) {
        return
      }
      if (rid && isLocalId('project', rid)) {
        void createLocalTimelineRepository(rid).updateClip({
          clipId: clip.id,
          startSec: clip.startSec,
          duration: clip.duration,
          leftPadSec: clip.leftPadSec ?? 0,
          bufferOffsetSec: clip.bufferOffsetSec ?? 0,
          audioWarp: clip.audioWarp,
          midiOffsetBeats: clip.midiOffsetBeats ?? 0,
        }).then(pushHistory).catch(rollbackTiming)
      } else {
        const uid = userId()
        if (uid) {
          void persistClipTimingAndAudioWarp(convexClient, convexApi, {
            clipId: clip.id,
            startSec: clip.startSec,
            duration: clip.duration,
            leftPadSec: clip.leftPadSec ?? 0,
            bufferOffsetSec: clip.bufferOffsetSec ?? 0,
            midiOffsetBeats: clip.midiOffsetBeats ?? 0,
            audioWarp: clip.audioWarp,
          }).then((applied) => {
            if (applied) {
              pushHistory()
              return
            }
            rollbackTiming()
          }).catch(rollbackTiming)
        } else {
          rollbackTiming()
        }
      }
      queueMicrotask(() => options.rescheduleChangedClips([clip.id]))
    }
  }

  onCleanup(() => {
    clipResizing = false
    resizing = null
    resizeBaselineAudioClip = null
    removeResizeListeners()
  })

  return {
    onClipResizeStart,
  }
}