import { createMemo, type Component, For, onCleanup } from 'solid-js'
import type { Track } from '@daw-browser/timeline-core/types'
import type { TimelineRange } from '~/lib/timeline-view'

type ArrangementOverviewProps = {
  durationSec: number
  width: number
  tracks: Track[]
  visibleRange: TimelineRange
  onPreviewVisibleRange: (range: TimelineRange) => void
  onCommitVisibleRange: (range: TimelineRange) => void
}

type DragMode = 'pan' | 'start' | 'end' | null

const ArrangementOverview: Component<ArrangementOverviewProps> = (props) => {
  let root: HTMLDivElement | undefined
  let pointerId: number | undefined
  let dragMode: DragMode = null
  let baseline: TimelineRange | undefined
  let startX = 0
  const rows = createMemo(() => props.tracks.filter((track) => track.channelRole !== 'return'))
  const duration = () => Math.max(1, props.durationSec)
  const rangeX = () => props.visibleRange.startSec / duration() * props.width
  const rangeWidth = () => Math.max(4, (props.visibleRange.endSec - props.visibleRange.startSec) / duration() * props.width)
  const pointToTime = (clientX: number) => {
    const rect = root?.getBoundingClientRect()
    if (!rect || props.width <= 0) return 0
    return Math.min(duration(), Math.max(0, (clientX - rect.left) / props.width * duration()))
  }
  const finish = () => {
    if (root && pointerId !== undefined && root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId)
    pointerId = undefined
    dragMode = null
    baseline = undefined
  }
  const onPointerDown = (event: PointerEvent) => {
    event.stopPropagation()
    if (pointerId !== undefined || event.button !== 0 || !root) return
    const x = event.clientX - root.getBoundingClientRect().left
    const left = rangeX()
    const right = left + rangeWidth()
    const edge = 6
    baseline = props.visibleRange
    startX = x
    pointerId = event.pointerId
    root.setPointerCapture(event.pointerId)
    if (Math.abs(x - left) <= edge) dragMode = 'start'
    else if (Math.abs(x - right) <= edge) dragMode = 'end'
    else if (x > left && x < right) dragMode = 'pan'
    else {
      const visibleDuration = baseline.endSec - baseline.startSec
      const center = pointToTime(event.clientX)
      props.onCommitVisibleRange({ startSec: center - visibleDuration / 2, endSec: center + visibleDuration / 2 })
      finish()
    }
    event.preventDefault()
  }
  const onPointerMove = (event: PointerEvent) => {
    event.stopPropagation()
    if (event.pointerId !== pointerId || !baseline || !dragMode || props.width <= 0) return
    const deltaSec = (event.clientX - (root?.getBoundingClientRect().left ?? 0) - startX) / props.width * duration()
    if (dragMode === 'pan') props.onPreviewVisibleRange({ startSec: baseline.startSec + deltaSec, endSec: baseline.endSec + deltaSec })
    if (dragMode === 'start') props.onPreviewVisibleRange({ startSec: baseline.startSec + deltaSec, endSec: baseline.endSec })
    if (dragMode === 'end') props.onPreviewVisibleRange({ startSec: baseline.startSec, endSec: baseline.endSec + deltaSec })
  }
  const onPointerFinish = (event: PointerEvent) => {
    event.stopPropagation()
    if (event.pointerId !== pointerId) return
    if (baseline) props.onCommitVisibleRange(props.visibleRange)
    finish()
  }
  onCleanup(() => {
    finish()
  })
  return (
    <div ref={(element) => { root = element }} class="sticky top-0 left-0 z-40 shrink-0 border-b border-border bg-timeline-surface" style={{ width: `${props.width}px`, height: '48px' }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerFinish} onPointerCancel={onPointerFinish} onLostPointerCapture={onPointerFinish}>
      <svg class="absolute inset-0 h-full w-full" viewBox="0 0 100 40" preserveAspectRatio="none">
        <For each={rows()}>{(track, index) => (
          <path
            d={track.clips.map((clip) => {
              const y = 2 + index() * 36 / Math.max(1, rows().length)
              const height = Math.max(1, 32 / Math.max(1, rows().length))
              const x = clip.startSec / duration() * 100
              const width = Math.max(0, clip.duration / duration() * 100)
              return `M${x} ${y}h${width}v${height}h-${width}z`
            }).join(' ')}
            fill={track.color ?? 'var(--timeline-clip)'}
            opacity="0.8"
          />
        )}</For>
      </svg>
      <div class="absolute top-0 bottom-0 z-10 border-2 border-neutral-100/80 bg-neutral-100/10" style={{ left: `${rangeX()}px`, width: `${rangeWidth()}px` }} />
    </div>
  )
}

export default ArrangementOverview
