import { type Component, onMount, onCleanup, createEffect } from 'solid-js'
import type { Clip } from '~/types/timeline'
import { PPS, LANE_HEIGHT } from '~/lib/timeline-utils'
import { computePeaks } from '~/lib/waveform'

type ClipComponentProps = {
  clip: Clip
  trackId: string
  isSelected: boolean
  onMouseDown: (trackId: string, clipId: string, e: MouseEvent) => void
  onClick: (trackId: string, clipId: string, e: MouseEvent) => void
  onResizeStart: (trackId: string, clipId: string, edge: 'left' | 'right', e: MouseEvent) => void
  onDblClick?: (trackId: string, clipId: string, e: MouseEvent) => void
}

const MIN_CLIP_PX = 6 // allow trimming to fine grids like 1/16 while keeping handles usable

const ClipComponent: Component<ClipComponentProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined

  function drawWaveform() {
    const canvas = canvasRef
    if (!canvas) return

    // Compute CSS size from known clip layout to avoid timing/measurement issues
    const cssW = Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS))
    const cssH = Math.max(1, Math.floor(LANE_HEIGHT - 1))
    if (cssW === 0 || cssH === 0) return

    const dpr = (window.devicePixelRatio || 1)
    const pxW = Math.floor(cssW * dpr)
    const pxH = Math.floor(cssH * dpr)
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Reset and scale to device pixels
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)

    // Clear
    ctx.clearRect(0, 0, cssW, cssH)

    // Reserve some space for title (top) and duration label (bottom)
    const padTop = 12
    const padBottom = 10
    const innerH = Math.max(1, cssH - padTop - padBottom)
    // Compute midline within inner area
    const midY = padTop + innerH / 2

    const buffer = props.clip.buffer
    if (!buffer) {
      // Placeholder stripes if buffer not yet loaded
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      for (let x = 0; x < cssW; x += 6) {
        ctx.beginPath()
        ctx.moveTo(x, cssH)
        ctx.lineTo(x + 6, 0)
        ctx.stroke()
      }
      return
    }

    // Fix waveform horizontal scale to real time based on buffer length (no stretch with clip resize)
    const bufferPxW = Math.max(1, Math.floor(buffer.duration * PPS))
    const bins = bufferPxW
    const peaks = computePeaks(buffer, bins)
    const padPx = Math.max(0, Math.floor((props.clip.leftPadSec ?? 0) * PPS))
    const drawCols = Math.max(0, Math.min(cssW - padPx, bins))
    const color = props.isSelected ? 'rgba(59,130,246,0.9)' : 'rgba(34,197,94,0.85)'

    // Auto-gain normalization so waveform nearly fills inner area
    let peak = 0
    for (let i = 0; i < bins; i++) {
      const min = peaks[i * 2]
      const max = peaks[i * 2 + 1]
      const a = Math.max(Math.abs(min), Math.abs(max))
      if (a > peak) peak = a
    }
    const amp = innerH / 2
    const gain = Math.min(0.98 / (peak || 1), 4.0) // cap gain to avoid extreme zoom

    // Draw mirrored filled bars per pixel column with high-contrast fill
    for (let i = 0; i < drawCols; i++) {
      const min = peaks[i * 2]
      const max = peaks[i * 2 + 1]
      const a = Math.max(Math.abs(min), Math.abs(max))
      const h = Math.min(a * amp * gain, innerH / 2)
      if (h <= 0.5) continue
      // top half (bright)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillRect(padPx + i, midY - h, 1, h)
      // bottom half (bright)
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillRect(padPx + i, midY, 1, h)
    }

    // Optional outlines (top and bottom) for clarity
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i < drawCols; i++) {
      const min = peaks[i * 2]
      const max = peaks[i * 2 + 1]
      const a = Math.max(Math.abs(min), Math.abs(max))
      const x = padPx + i + 0.5
      const yTop = midY - Math.min(a * amp * gain, innerH / 2)
      if (i === 0) ctx.moveTo(x, yTop); else ctx.lineTo(x, yTop)
    }
    ctx.stroke()
    ctx.beginPath()
    for (let i = 0; i < drawCols; i++) {
      const min = peaks[i * 2]
      const max = peaks[i * 2 + 1]
      const a = Math.max(Math.abs(min), Math.abs(max))
      const x = padPx + i + 0.5
      const yBottom = midY + Math.min(a * amp * gain, innerH / 2)
      if (i === 0) ctx.moveTo(x, yBottom); else ctx.lineTo(x, yBottom)
    }
    ctx.stroke()

    // Midline on top (thicker for clarity)
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, Math.floor(midY) + 0.5)
    ctx.lineTo(cssW, Math.floor(midY) + 0.5)
    ctx.stroke()

    // Mark end of audio if clip extends beyond buffer (account for left padding)
    const audioEndX = padPx + bufferPxW
    if (cssW > audioEndX && audioEndX >= 0) {
      const x = Math.min(cssW, audioEndX)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, cssH)
      ctx.stroke()
    }
  }

  onMount(() => {
    const handle = () => drawWaveform()
    handle()
    window.addEventListener('resize', handle)
    onCleanup(() => window.removeEventListener('resize', handle))
  })

  // Redraw when buffer, selection (color), or duration (width) changes
  createEffect(() => {
    void props.clip.buffer
    void props.clip.duration
    void props.isSelected
    drawWaveform()
  })

  // Dynamic handle width: keep resize handles narrow on tiny clips so dragging is easy
  const clipWidthPx = () => Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS))
  const handleWidthPx = () => (clipWidthPx() < 18 ? 2 : clipWidthPx() < 28 ? 3 : 6)

  return (
    <div
      class={`group absolute border ${props.isSelected ? 'border-blue-400 bg-blue-500/25' : 'border-green-500/60 bg-green-500/20'} hover:bg-green-500/25 cursor-grab select-none overflow-hidden`}
      style={{ 
        top: '0px',
        left: `${props.clip.startSec * PPS}px`, 
        width: `${Math.max(MIN_CLIP_PX, props.clip.duration * PPS)}px`, 
        height: `${LANE_HEIGHT - 1}px` 
      }}
      onMouseDown={(e) => {
        // If this is the second click (detail >= 2), treat as dblclick BEFORE starting drag
        if ((e as MouseEvent).detail >= 2) {
          e.stopPropagation()
          props.onDblClick?.(props.trackId, props.clip.id, e)
          return
        }
        props.onMouseDown(props.trackId, props.clip.id, e)
      }}
      onClick={(e) => props.onClick(props.trackId, props.clip.id, e)}
      onDblClick={(e) => props.onDblClick?.(props.trackId, props.clip.id, e)}
      title={`${props.clip.name} (${props.clip.duration.toFixed(2)}s)`}
    >
      {/* Left resize handle */}
      <div
        class="absolute inset-y-0 left-0 cursor-ew-resize z-20 flex items-center justify-center text-[11px] text-neutral-200/80 select-none"
        style={{ width: `${handleWidthPx()}px` }}
        onMouseDown={(e) => { e.stopPropagation(); props.onResizeStart(props.trackId, props.clip.id, 'left', e) }}
        onDblClick={(e) => { e.stopPropagation(); props.onDblClick?.(props.trackId, props.clip.id, e) }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">[</span>
      </div>
      {/* Right resize handle */}
      <div
        class="absolute inset-y-0 right-0 cursor-ew-resize z-20 flex items-center justify-center text-[11px] text-neutral-200/80 select-none"
        style={{ width: `${handleWidthPx()}px` }}
        onMouseDown={(e) => { e.stopPropagation(); props.onResizeStart(props.trackId, props.clip.id, 'right', e) }}
        onDblClick={(e) => { e.stopPropagation(); props.onDblClick?.(props.trackId, props.clip.id, e) }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">]</span>
      </div>

      <canvas ref={(el) => (canvasRef = el || undefined)} class="absolute inset-0 pointer-events-none z-0" />
      <div class="px-2 py-1 text-xs truncate relative z-10">{props.clip.name}</div>
      <div class="absolute bottom-1 right-2 text-[10px] text-neutral-300 relative z-10">
        {props.clip.duration.toFixed(2)}s
      </div>
    </div>
  )
}

export default ClipComponent