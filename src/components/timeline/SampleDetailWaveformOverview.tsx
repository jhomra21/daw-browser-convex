import { createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js'

import { drawWaveformPeaks } from '@daw-browser/waveforms/render-waveform'
import type { Clip } from '@daw-browser/timeline-core/types'
import { useAppPreferences } from '~/context/app-preferences'
import { useSampleDetailWaveformOverview } from '~/hooks/useSampleDetailWaveformOverview'
import {
  fitSampleDetailWaveformViewport,
  sampleDetailWaveformTimeAtX,
  type SampleDetailWaveformViewport,
} from '~/lib/sample-detail-waveform-viewport'
import {
  getSampleDetailWaveformOverviewGrabOffset,
  getSampleDetailWaveformOverviewViewportRect,
  moveSampleDetailWaveformOverviewViewport,
} from '~/lib/sample-detail-waveform-overview'

const OVERVIEW_HEIGHT_PX = 40
const DEFAULT_OVERVIEW_WIDTH_PX = 960
const MINIMUM_VIEWPORT_HANDLE_PX = 2

type SampleDetailWaveformOverviewProps = {
  clip: Clip<AudioBuffer>
  projectBpm: number
  viewport: SampleDetailWaveformViewport
  onViewportChange: (viewport: SampleDetailWaveformViewport) => void
}

const SampleDetailWaveformOverview: Component<SampleDetailWaveformOverviewProps> = (props) => {
  const appPreferences = useAppPreferences()
  let canvasRef: HTMLCanvasElement | undefined
  let overviewRef: HTMLButtonElement | undefined
  const [widthPx, setWidthPx] = createSignal(DEFAULT_OVERVIEW_WIDTH_PX)
  const [grabOffsetSec, setGrabOffsetSec] = createSignal<number>()
  const sourceSampleRate = createMemo(() => props.clip.buffer?.sampleRate ?? props.clip.sourceSampleRate ?? 0)
  const fullViewport = createMemo(() => fitSampleDetailWaveformViewport(props.clip.duration))
  const overview = useSampleDetailWaveformOverview({
    clip: () => props.clip,
    cssWidthPx: widthPx,
    projectBpm: () => props.projectBpm,
  })
  const viewportRect = createMemo(() => getSampleDetailWaveformOverviewViewportRect({
    viewport: props.viewport,
    clipDurationSec: props.clip.duration,
    widthPx: widthPx(),
  }))
  const viewportHandle = createMemo(() => {
    const width = widthPx()
    const rect = viewportRect()
    const handleWidthPx = Math.min(width, Math.max(MINIMUM_VIEWPORT_HANDLE_PX, rect.widthPx))
    return {
      leftPx: Math.max(0, Math.min(width - handleWidthPx, rect.leftPx)),
      widthPx: handleWidthPx,
    }
  })

  onMount(() => {
    const measure = () => {
      const bounds = overviewRef?.getBoundingClientRect()
      if (!bounds) return
      const nextWidthPx = Math.max(1, Math.floor(bounds.width))
      setWidthPx((current) => current === nextWidthPx ? current : nextWidthPx)
    }
    measure()
    const resizeObserver = new ResizeObserver(measure)
    if (overviewRef) resizeObserver.observe(overviewRef)
    onCleanup(() => resizeObserver.disconnect())
  })

  onCleanup(() => setGrabOffsetSec(undefined))

  const clipTimeFromPointer = (event: Pick<PointerEvent, 'clientX'>) => {
    const element = overviewRef
    if (!element) return 0
    const bounds = element.getBoundingClientRect()
    const xPx = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
    return sampleDetailWaveformTimeAtX({
      viewport: fullViewport(),
      xPx,
      widthPx: bounds.width,
    })
  }

  const moveViewportToPointer = (event: Pick<PointerEvent, 'clientX'>) => {
    const offset = grabOffsetSec()
    if (offset === undefined || sourceSampleRate() <= 0) return
    props.onViewportChange(moveSampleDetailWaveformOverviewViewport({
      viewport: props.viewport,
      clipDurationSec: props.clip.duration,
      sampleRate: sourceSampleRate(),
      pointerSec: clipTimeFromPointer(event),
      grabOffsetSec: offset,
    }))
  }

  const draw = () => {
    const canvas = canvasRef
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const width = widthPx()
    const pxWidth = Math.floor(width * dpr)
    const pxHeight = Math.floor(OVERVIEW_HEIGHT_PX * dpr)
    if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
      canvas.width = pxWidth
      canvas.height = pxHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, OVERVIEW_HEIGHT_PX)

    const colors = appPreferences.appearance.themeTokens()
    const timelineBackground = colors['timeline-background']
    const timelineGridMajor = colors['timeline-grid-major']
    const clipAudio = colors['clip-audio']
    ctx.fillStyle = timelineBackground
    ctx.fillRect(0, 0, width, OVERVIEW_HEIGHT_PX)

    const segments = overview.renderSegments()
    const firstSegment = segments.find((segment) => segment.peaks.channels.length > 0)
    const channelCount = firstSegment?.peaks.channels.length
      ?? Math.max(1, props.clip.buffer?.numberOfChannels ?? props.clip.sourceChannelCount ?? 1)
    const contentTop = 3
    const contentHeight = OVERVIEW_HEIGHT_PX - 6
    const channelHeight = contentHeight / channelCount

    for (const segment of segments) {
      for (let channel = 0; channel < segment.peaks.channels.length; channel += 1) {
        const peaks = segment.peaks.channels[channel]
        if (!peaks) continue
        drawWaveformPeaks({
          ctx,
          peaks,
          drawCols: segment.peaks.columns,
          padPx: segment.drawStartPx,
          topY: contentTop + channel * channelHeight,
          contentH: channelHeight,
          cssW: width,
          cssH: OVERVIEW_HEIGHT_PX,
          fillStyle: clipAudio,
          boundaryStyle: timelineGridMajor,
          drawBoundary: false,
        })
      }
    }

    ctx.strokeStyle = timelineGridMajor
    ctx.lineWidth = 1
    for (let channel = 0; channel < channelCount; channel += 1) {
      const centerY = contentTop + channel * channelHeight + channelHeight / 2
      ctx.beginPath()
      ctx.moveTo(0, Math.floor(centerY) + 0.5)
      ctx.lineTo(width, Math.floor(centerY) + 0.5)
      ctx.stroke()
    }
  }

  createEffect(() => draw())

  return (
    <button
      ref={(element) => { overviewRef = element || undefined }}
      type="button"
      aria-label="Waveform overview; drag to pan"
      class="relative h-10 w-full shrink-0 cursor-grab overflow-hidden border border-border bg-timeline-background p-0 active:cursor-grabbing"
      onPointerDown={(event) => {
        if (sourceSampleRate() <= 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        const pointerSec = clipTimeFromPointer(event)
        const offset = getSampleDetailWaveformOverviewGrabOffset(props.viewport, pointerSec)
        setGrabOffsetSec(offset)
        props.onViewportChange(moveSampleDetailWaveformOverviewViewport({
          viewport: props.viewport,
          clipDurationSec: props.clip.duration,
          sampleRate: sourceSampleRate(),
          pointerSec,
          grabOffsetSec: offset,
        }))
      }}
      onPointerMove={(event) => {
        if (grabOffsetSec() === undefined) return
        event.preventDefault()
        moveViewportToPointer(event)
      }}
      onPointerUp={(event) => {
        if (grabOffsetSec() === undefined) return
        moveViewportToPointer(event)
        setGrabOffsetSec(undefined)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        setGrabOffsetSec(undefined)
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={() => setGrabOffsetSec(undefined)}
      onKeyDown={(event) => {
        if (sourceSampleRate() <= 0) return
        if (event.key === 'Home') {
          event.preventDefault()
          props.onViewportChange(fullViewport())
          return
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const durationSec = props.viewport.endSec - props.viewport.startSec
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        props.onViewportChange(moveSampleDetailWaveformOverviewViewport({
          viewport: props.viewport,
          clipDurationSec: props.clip.duration,
          sampleRate: sourceSampleRate(),
          pointerSec: props.viewport.startSec + durationSec / 2 + direction * durationSec * 0.1,
          grabOffsetSec: durationSec / 2,
        }))
      }}
    >
      <canvas
        ref={(element) => { canvasRef = element || undefined }}
        class="pointer-events-none h-full w-full"
      />
      <span
        class="pointer-events-none absolute inset-y-0 border border-foreground/70 bg-foreground/10"
        style={{
          left: `${viewportHandle().leftPx}px`,
          width: `${viewportHandle().widthPx}px`,
        }}
      />
    </button>
  )
}

export default SampleDetailWaveformOverview
