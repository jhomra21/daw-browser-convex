import { type Component, createEffect, createSignal, onCleanup } from 'solid-js'

import { drawWaveformPeaks } from '~/lib/audio-peaks/render-waveform'
import { getWaveformSlice } from '~/lib/audio-peaks/select-waveform-window'
import { LANE_HEIGHT, PPS } from '~/lib/timeline-utils'
import { cn } from '~/lib/utils'
import type { Clip } from '~/types/timeline'

type ClipComponentProps = {
  clip: Clip
  trackId: string
  isSelected: boolean
  onPointerDown: (trackId: string, clipId: string, e: PointerEvent) => void
  onClick: (trackId: string, clipId: string, e: MouseEvent) => void
  onResizeStart: (trackId: string, clipId: string, edge: 'left' | 'right', e: MouseEvent) => void
  onDblClick?: (trackId: string, clipId: string, e: MouseEvent) => void
  bpm: number
}

const MIN_CLIP_PX = 6
const WAVEFORM_PAD_Y = 6
const AUDIO_WAVEFORM_BOX_H = 34
const AUDIO_WAVEFORM_TOP_PX = 28

type AudioWaveformLayout = {
  sourceDurationSec: number
  padPx: number
  drawCols: number
  sourceStartSec: number
  sourceEndSec: number
}

function getAudioWaveformLayout(clip: Clip, cssW: number): AudioWaveformLayout {
  const sourceDurationSec = Math.max(clip.sourceDurationSec ?? 0, 0)
  const padPx = Math.max(0, Math.floor((clip.leftPadSec ?? 0) * PPS))
  const offsetPx = Math.max(0, Math.floor((clip.bufferOffsetSec ?? 0) * PPS))
  const sourcePxW = Math.max(1, Math.floor(sourceDurationSec * PPS))
  const drawCols = Math.max(0, Math.min(cssW - padPx, Math.max(0, sourcePxW - offsetPx)))
  const sourceStartSec = Math.max(0, clip.bufferOffsetSec ?? 0)
  const sourceEndSec = Math.min(sourceDurationSec, sourceStartSec + drawCols / PPS)

  return {
    sourceDurationSec,
    padPx,
    drawCols,
    sourceStartSec,
    sourceEndSec,
  }
}

const ClipComponent: Component<ClipComponentProps> = (props) => {
  let canvasRef: HTMLCanvasElement | undefined
  let waveformRequestId = 0

  const [waveformPeaks, setWaveformPeaks] = createSignal<Uint8Array | null>(null)
  const isGhost = () => props.clip.id.startsWith('__dup_preview:')

  function drawWaveform() {
    const canvas = canvasRef
    if (!canvas) return

    const cssW = Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS))
    const cssH = Math.max(1, Math.floor(LANE_HEIGHT - 1))
    if (cssW === 0 || cssH === 0) return

    const dpr = window.devicePixelRatio || 1
    const pxW = Math.floor(cssW * dpr)
    const pxH = Math.floor(cssH * dpr)
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW
      canvas.height = pxH
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ;(ctx as any).imageSmoothingEnabled = false
    ctx.clearRect(0, 0, cssW, cssH)

    const padTop = WAVEFORM_PAD_Y
    const padBottom = WAVEFORM_PAD_Y
    const innerH = Math.max(1, cssH - padTop - padBottom)

    const midi: any = (props.clip as any).midi
    if (midi && Array.isArray(midi.notes) && midi.notes.length > 0) {
      const spb = 60 / Math.max(1, props.bpm || 120)
      const midiOffsetBeats = Math.max(0, (props.clip as any).midiOffsetBeats ?? 0)
      const color = props.isSelected ? 'rgba(59,130,246,0.95)' : 'rgba(34,197,94,0.95)'
      let minP = Infinity
      let maxP = -Infinity
      for (const note of midi.notes as Array<{ pitch: number }>) {
        if (typeof note.pitch !== 'number') continue
        if (note.pitch < minP) minP = note.pitch
        if (note.pitch > maxP) maxP = note.pitch
      }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
        minP = 60
        maxP = 72
      }
      const range = Math.max(1, maxP - minP)
      const barH = Math.max(2, Math.floor(innerH / Math.min(12, range)))

      ctx.fillStyle = color
      for (const note of midi.notes as Array<{ beat: number; length: number; pitch: number }>) {
        const noteBeat = note.beat || 0
        const trimmedBeats = Math.max(0, midiOffsetBeats - noteBeat)
        const effectiveLength = Math.max(0, (note.length || 0) - trimmedBeats)
        if (effectiveLength <= 0) continue
        const startBeats = Math.max(0, noteBeat - midiOffsetBeats)
        const startSec = startBeats * spb
        const endSec = Math.max(startSec, startSec + effectiveLength * spb)
        const left = Math.max(0, Math.min(cssW, Math.floor((startSec / Math.max(1e-6, props.clip.duration)) * cssW)))
        const right = Math.max(left + 1, Math.min(cssW, Math.floor((endSec / Math.max(1e-6, props.clip.duration)) * cssW)))
        const frac = 1 - ((note.pitch - minP) / range)
        const centerY = padTop + Math.max(0, Math.min(1, frac)) * innerH
        const yTop = Math.max(padTop, Math.floor(centerY - barH / 2))
        ctx.fillRect(left, yTop, Math.max(1, right - left), barH)
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.lineWidth = 1
      const bars = Math.max(1, Math.floor(props.clip.duration / (spb * 4)))
      for (let b = 1; b <= bars; b++) {
        const x = Math.floor((b * spb * 4 / Math.max(1e-6, props.clip.duration)) * cssW) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, padTop)
        ctx.lineTo(x, padTop + innerH)
        ctx.stroke()
      }
      return
    }

    const { padPx, drawCols } = getAudioWaveformLayout(props.clip, cssW)
    const peaks = waveformPeaks()

    if (!peaks || drawCols <= 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      for (let x = 0; x < cssW; x += 6) {
        ctx.beginPath()
        ctx.moveTo(x, cssH)
        ctx.lineTo(x + 6, 0)
        ctx.stroke()
      }
      return
    }

    const waveformBoxH = Math.max(16, Math.min(AUDIO_WAVEFORM_BOX_H, cssH - 16))
    const waveformTop = Math.min(Math.max(WAVEFORM_PAD_Y, AUDIO_WAVEFORM_TOP_PX), Math.max(WAVEFORM_PAD_Y, cssH - waveformBoxH - WAVEFORM_PAD_Y))

    drawWaveformPeaks({
      ctx,
      peaks,
      drawCols,
      padPx,
      topY: waveformTop,
      contentH: waveformBoxH,
      cssW,
      cssH,
    })
  }


  createEffect(() => {
    const midi: any = (props.clip as any).midi
    const buffer = props.clip.buffer ?? null
    const assetKey = props.clip.sourceAssetKey
    const sampleUrl = props.clip.sampleUrl
    const cssW = Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS))
    const { sourceDurationSec, drawCols, sourceStartSec, sourceEndSec } = getAudioWaveformLayout(props.clip, cssW)

    if (midi) {
      setWaveformPeaks(null)
      return
    }
    if (drawCols <= 0 || sourceDurationSec <= 0 || !assetKey || (!buffer && !sampleUrl)) {
      setWaveformPeaks(null)
      return
    }

    const requestId = ++waveformRequestId
    void getWaveformSlice({
      assetKey,
      sampleUrl,
      buffer,
      sourceStartSec,
      sourceEndSec,
      bins: drawCols,
    }).then((next) => {
      if (requestId !== waveformRequestId) return
      setWaveformPeaks(next)
    }).catch(() => {
      if (requestId !== waveformRequestId) return
      setWaveformPeaks(null)
    })
  })

  createEffect(() => {
    void props.clip.duration
    void props.clip.buffer
    void props.clip.sampleUrl
    void props.clip.leftPadSec
    void props.clip.bufferOffsetSec
    void props.clip.sourceDurationSec
    void props.clip.sourceSampleRate
    void props.clip.sourceChannelCount
    void props.isSelected
    const midi: any = (props.clip as any).midi
    const midiSignature = Array.isArray(midi?.notes)
      ? midi.notes.map((note: any) => `${note.pitch ?? ''}/${note.beat ?? ''}/${note.length ?? ''}`).join('|')
      : ''
    void midiSignature
    void props.bpm
    void waveformPeaks()
    drawWaveform()
  })

  onCleanup(() => {
    waveformRequestId += 1
  })

  const clipWidthPx = () => Math.max(MIN_CLIP_PX, Math.floor(props.clip.duration * PPS))
  const handleWidthPx = () => (clipWidthPx() < 18 ? 2 : clipWidthPx() < 28 ? 3 : 6)

  return (
    <div
      class={cn(
        'group absolute overflow-hidden border z-20 select-none',
        isGhost()
          ? 'border-green-400/60 border-dashed bg-green-500/20 opacity-60 pointer-events-none'
          : props.isSelected
            ? 'border-blue-400 bg-blue-500/25'
            : 'border-green-500/60 bg-green-500/20 hover:bg-green-500/25 cursor-grab',
      )}
      style={{
        top: '0px',
        left: `${props.clip.startSec * PPS}px`,
        width: `${Math.max(MIN_CLIP_PX, props.clip.duration * PPS)}px`,
        height: `${LANE_HEIGHT - 1}px`,
      }}
      onPointerDown={(e) => {
        if (e.detail >= 2) {
          e.stopPropagation()
          props.onDblClick?.(props.trackId, props.clip.id, e)
          return
        }
        props.onPointerDown(props.trackId, props.clip.id, e)
      }}
      onClick={(e) => props.onClick(props.trackId, props.clip.id, e)}
      title={`${props.clip.name}`}
    >
      <div
        class="absolute inset-y-0 left-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-neutral-200/80"
        style={{ width: `${handleWidthPx()}px` }}
        onMouseDown={(e) => { e.stopPropagation(); props.onResizeStart(props.trackId, props.clip.id, 'left', e) }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">[</span>
      </div>
      <div
        class="absolute inset-y-0 right-0 z-20 flex cursor-ew-resize items-center justify-center select-none text-xs text-neutral-200/80"
        style={{ width: `${handleWidthPx()}px` }}
        onMouseDown={(e) => { e.stopPropagation(); props.onResizeStart(props.trackId, props.clip.id, 'right', e) }}
      >
        <span class="opacity-0 group-hover:opacity-100 pointer-events-none">]</span>
      </div>

      <canvas ref={(el) => (canvasRef = el || undefined)} class="absolute inset-0 pointer-events-none z-0" />
      <div
        class={cn(
          'absolute left-1.5 right-1.5 top-1 z-10 rounded-sm px-1 py-px pointer-events-none',
          isGhost() ? 'bg-black/10' : 'bg-black/20',
        )}
      >
        <div class="truncate text-xs leading-none text-white" style={{ 'text-shadow': '0 1px 2px rgba(0,0,0,0.75)' }}>{props.clip.name}</div>
      </div>
    </div>
  )
}

export default ClipComponent
