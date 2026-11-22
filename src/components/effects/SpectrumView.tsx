import { For, Show, createEffect, onSettled, untrack } from 'solid-js'
import type { SpectrumView as SpectrumViewMode } from '@daw-browser/shared'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { DeviceToggleButton } from '~/components/ui/device-control'
import { createSpectrogramHistory, drawSpectrumCurve } from '~/lib/spectrum-render'

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
  paint: (context: CanvasRenderingContext2D, width: number, height: number, canvas: HTMLCanvasElement) => void
  label: string
}

// Repaints only when the frame changes or the canvas is resized; frame delivery owns the schedule.
function SpectrumCanvas(props: SpectrumCanvasProps) {
  let frame: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined

  const paint = () => {
    const context = canvas?.getContext('2d')

    if (!canvas || !context || canvas.width === 0 || canvas.height === 0) return
    props.paint(context, canvas.width, canvas.height, canvas)
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
    () => props.frame,
    () => {
      untrack(paint)
    },
  )

  return (
    <div ref={(element) => (frame = element)} class="relative min-h-0 flex-1" data-spectrum-canvas>
      <canvas ref={(element) => (canvas = element)} role="img" aria-label={props.label} class="absolute inset-0 size-full bg-device-graph-background" />
    </div>
  )
}

export default function SpectrumView(props: { frame: SpectrumFrame | null; view: SpectrumViewMode }) {
  const history = createSpectrogramHistory()
  // One column per delivered frame; a null frame means the analysed target changed or stopped.
  createEffect(
    () => props.frame,
    (frame) => {
      if (frame) history.push(frame)
      else history.clear()
    },
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
          label="Spectrum"
          paint={(context, width, height, canvas) => drawSpectrumCurve(context, props.frame, width, height, curveColors(canvas))}
        />
      </Show>
      <Show when={props.view !== 'spectrum'}>
        <SpectrumCanvas frame={props.frame} label="Spectrogram" paint={(context, width, height) => history.paint(context, width, height)} />
      </Show>
    </div>
  )
}
