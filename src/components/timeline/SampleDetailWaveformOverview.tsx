import { createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js'

import { drawWaveformSignal } from '@daw-browser/waveforms/draw-waveform-signal'
import type { Clip } from '@daw-browser/timeline-core/types'
import type { AudioPcmSourceDescriptor } from '@daw-browser/audio-engine/media-pages'
import { useAppPreferences } from '~/context/app-preferences'
import { resolveClipColor } from '~/lib/clip-color'
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
import { useDevicePixelRatio } from '~/lib/device-pixel-ratio'
import { resolveWaveformPaintStyle } from '~/lib/waveform-style'
import { waveformCanvasSize } from '~/lib/waveform-canvas'

const OVERVIEW_HEIGHT_PX = 40
const DEFAULT_OVERVIEW_WIDTH_PX = 960
const MINIMUM_VIEWPORT_HANDLE_PX = 2

type SampleDetailWaveformOverviewProps = {
  clip: Clip<AudioBuffer>
  projectBpm: number
  source: () => AudioPcmSourceDescriptor | null
  viewport: SampleDetailWaveformViewport
  onViewportChange: (viewport: SampleDetailWaveformViewport) => void
}

const SampleDetailWaveformOverview: Component<SampleDetailWaveformOverviewProps> = (props) => {
  const appPreferences = useAppPreferences()
  const devicePixelRatio = useDevicePixelRatio()
  let canvasRef: HTMLCanvasElement | undefined
  let overviewRef: HTMLButtonElement | undefined
  let capturedPointerId: number | undefined
  const [widthPx, setWidthPx] = createSignal(DEFAULT_OVERVIEW_WIDTH_PX)
  const [grabOffsetSec, setGrabOffsetSec] = createSignal<number>()
  const sourceSampleRate = createMemo(() => props.clip.buffer?.sampleRate ?? props.clip.sourceSampleRate ?? 0)
  const fullViewport = createMemo(() => fitSampleDetailWaveformViewport(props.clip.duration))
  const overview = useSampleDetailWaveformOverview({
    clip: () => props.clip,
    cssWidthPx: widthPx,
    projectBpm: () => props.projectBpm,
    source: () => props.source(),
    backingPixelsPerCssPixel: () => waveformCanvasSize({
      cssWidthPx: widthPx(),
      cssHeightPx: OVERVIEW_HEIGHT_PX,
      devicePixelRatio: devicePixelRatio(),
    }).contextScaleX,
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

  onCleanup(() => {
    setGrabOffsetSec(undefined)
    if (overviewRef && capturedPointerId !== undefined && overviewRef.hasPointerCapture(capturedPointerId)) {
      overviewRef.releasePointerCapture(capturedPointerId)
    }
    capturedPointerId = undefined
  })

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
    const width = widthPx()
    const canvasSize = waveformCanvasSize({
      cssWidthPx: width,
      cssHeightPx: OVERVIEW_HEIGHT_PX,
      devicePixelRatio: devicePixelRatio(),
    })
    const pxWidth = canvasSize.backingWidthPx
    const pxHeight = canvasSize.backingHeightPx
    if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
      canvas.width = pxWidth
      canvas.height = pxHeight
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(canvasSize.contextScaleX, 0, 0, canvasSize.contextScaleY, 0, 0)
    ctx.clearRect(0, 0, canvasSize.cssWidthPx, canvasSize.cssHeightPx)

    const colors = appPreferences.appearance.themeTokens()
    const timelineBackground = colors['timeline-background']
    const timelineGridMajor = colors['timeline-grid-major']
    const waveformColor = resolveClipColor(props.clip.color, colors)
    ctx.fillStyle = timelineBackground
    ctx.fillRect(0, 0, canvasSize.cssWidthPx, canvasSize.cssHeightPx)

    const segments = overview.renderSegments()
    const firstSegment = segments.find((segment) => segment.data.channels.length > 0)
    const channelCount = firstSegment?.data.channels.length
      ?? Math.max(1, props.clip.buffer?.numberOfChannels ?? props.clip.sourceChannelCount ?? 1)
    const contentTop = 3
    const contentHeight = OVERVIEW_HEIGHT_PX - 6
    const channelHeight = contentHeight / channelCount

    for (const segment of segments) {
      const segmentWidthPx = Math.max(0, segment.drawCols)
      drawWaveformSignal(ctx, {
        data: segment.data,
        sourceStartFrame: segment.sourceStartFrame,
        sourceEndFrame: segment.sourceEndFrame,
        startPx: segment.drawStartPx,
        endPx: segment.drawStartPx + segmentWidthPx,
        topY: contentTop,
        contentH: contentHeight,
        channelCount,
        style: resolveWaveformPaintStyle({
          color: waveformColor,
          backingScaleY: canvasSize.contextScaleY,
        }),
      })
    }

    ctx.strokeStyle = timelineGridMajor
    ctx.lineWidth = 1
    for (let channel = 0; channel < channelCount; channel += 1) {
      const centerY = contentTop + channel * channelHeight + channelHeight / 2
      ctx.beginPath()
      ctx.moveTo(0, Math.floor(centerY) + 0.5)
      ctx.lineTo(canvasSize.cssWidthPx, Math.floor(centerY) + 0.5)
      ctx.stroke()
    }
  }

  createEffect(() => draw())

  return (
    <button
      ref={(element) => { overviewRef = element || undefined }}
      type="button"
      aria-label="Waveform overview; drag to pan"
      class="relative h-10 w-full shrink-0 cursor-grab touch-none overflow-hidden border border-border bg-timeline-background p-0 active:cursor-grabbing"
      onPointerDown={(event) => {
        if (sourceSampleRate() <= 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        capturedPointerId = event.pointerId
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
        capturedPointerId = undefined
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onPointerCancel={(event) => {
        setGrabOffsetSec(undefined)
        capturedPointerId = undefined
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
      }}
      onLostPointerCapture={() => {
        setGrabOffsetSec(undefined)
        capturedPointerId = undefined
      }}
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
