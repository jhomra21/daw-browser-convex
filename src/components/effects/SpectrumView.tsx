import { For, Show, createEffect, createSignal, onSettled, untrack } from 'solid-js'
import type { JSX } from '@solidjs/web'
import type { SpectrumView as SpectrumViewMode } from '@daw-browser/shared'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { DeviceToggleButton } from '~/components/ui/device-control'
import { createSpectrogramHistory, createSpectrumMaxHold, drawSpectrumCurve } from '~/lib/spectrum-render'
import { formatReadout, readoutAt } from '~/lib/spectrum-readout'

const VIEW_OPTIONS: readonly { value: SpectrumViewMode; label: string }[] = [
  { value: 'spectrum', label: 'Spectrum' },
  { value: 'spectrogram', label: 'Spectrogram' },
  { value: 'both', label: 'Both' },
]

export function SpectrumViewToggle(props: { view: SpectrumViewMode; disabled?: boolean; onChange: (view: SpectrumViewMode) => void }) {
  return (
    <div class="grid grid-cols-3 gap-1">
      <For each={VIEW_OPTIONS}>
        {(option) => (
          <DeviceToggleButton label={option.label} active={props.view === option.value} disabled={props.disabled} onClick={() => props.onChange(option.value)} />
        )}
      </For>
    </div>
  )
}

type SpectrumCanvasProps = {
  frame: SpectrumFrame | null
  // Changes whenever something other than the frame means the canvas must be drawn again.
  revision?: number
  paint: (context: CanvasRenderingContext2D, width: number, height: number, canvas: HTMLCanvasElement, frame: SpectrumFrame | null) => void
  label: string
  children?: JSX.Element
  onPointerMove?: (event: PointerEvent, bounds: DOMRect) => void
  onPointerLeave?: () => void
  onClick?: () => void
}

// Repaints only when the frame changes or the canvas is resized; frame delivery owns the schedule.
function SpectrumCanvas(props: SpectrumCanvasProps) {
  let frame: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  // The frame is carried from the effect that observes it: reading a lazy prop getter from an effect callback would create a memo there.
  let latestFrame = untrack(() => props.frame)

  const paint = () => {
    const context = canvas?.getContext('2d')

    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) return
    props.paint(context, canvas.width, canvas.height, canvas, latestFrame)
  }

  onSettled(() => {
    // The canvas is out of flow so resizing its bitmap never changes the size being observed.
    const observer = new ResizeObserver(() => {
      if (!frame || !canvas) return
      canvas.width = Math.max(1, Math.round(frame.clientWidth * devicePixelRatio))
      canvas.height = Math.max(1, Math.round(frame.clientHeight * devicePixelRatio))
      paint()
    })

    if (frame) observer.observe(frame)

    return () => observer.disconnect()
  })
  createEffect(
    () => ({ frame: props.frame, revision: props.revision }),
    ({ frame: nextFrame }) => {
      latestFrame = nextFrame
      untrack(paint)
    },
  )

  return (
    <div
      ref={(element) => (frame = element)}
      class="relative min-h-0 flex-1"
      data-spectrum-canvas
      onPointerMove={(event) => frame && props.onPointerMove?.(event, frame.getBoundingClientRect())}
      onPointerLeave={() => props.onPointerLeave?.()}
      onClick={() => props.onClick?.()}
    >
      <canvas ref={(element) => (canvas = element)} role="img" aria-label={props.label} class="absolute inset-0 size-full bg-device-graph-background" />
      {props.children}
    </div>
  )
}

export default function SpectrumView(props: { frame: SpectrumFrame | null; view: SpectrumViewMode; maxHold: boolean }) {
  const history = createSpectrogramHistory()
  const hold = createSpectrumMaxHold()
  const [revision, setRevision] = createSignal(0)
  const [readout, setReadout] = createSignal<string | null>(null)
  // One column per delivered frame; a null frame means the analysed target changed or stopped.
  createEffect(
    () => props.frame,
    (frame) => {
      if (frame) history.push(frame)
      else history.clear()
    },
  )
  createEffect(
    () => props.maxHold,
    () => { setRevision((count) => count + 1) },
  )

  const curveColors = (canvas: HTMLCanvasElement) => {
    const style = getComputedStyle(canvas)

    return {
      background: style.getPropertyValue('--device-graph-background'),
      grid: style.getPropertyValue('--device-graph-grid'),
      line: style.getPropertyValue('--device-graph-accent'),
    }
  }

  return (
    <div class="flex h-full min-h-0 w-full flex-col gap-1" data-spectrum-view>
      <Show when={props.view !== 'spectrogram'}>
        <SpectrumCanvas
          frame={props.frame}
          revision={revision()}
          label="Spectrum"
          paint={(context, width, height, canvas, frame) => {
            // Taking the maximum is idempotent, so a repaint of the same frame changes nothing; a null frame or Max off starts it over.
            if (frame && props.maxHold) hold.push(frame)
            else hold.reset()
            drawSpectrumCurve(context, frame, hold.held(), width, height, curveColors(canvas))
          }}
          onPointerMove={(event, bounds) => {
            const frame = props.frame
            setReadout(frame ? formatReadout(readoutAt(frame, (event.clientX - bounds.left) / bounds.width)) : null)
          }}
          onPointerLeave={() => setReadout(null)}
          // Clicking the display starts the maximum over, as in Live.
          onClick={() => {
            hold.reset()
            setRevision((count) => count + 1)
          }}
        >
          <Show when={readout()}>
            {(text) => <div class="pointer-events-none absolute left-1 top-1 bg-black/60 px-1 py-0.5 font-mono text-2xs text-foreground" data-spectrum-readout>{text()}</div>}
          </Show>
        </SpectrumCanvas>
      </Show>
      <Show when={props.view !== 'spectrum'}>
        <SpectrumCanvas frame={props.frame} label="Spectrogram" paint={(context, width, height) => history.paint(context, width, height)} />
      </Show>
    </div>
  )
}
