import { createSignal, flush } from 'solid-js'
import { render } from '@solidjs/web'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'

import SpectrumView from '~/components/effects/SpectrumView'

const scenarios: Record<string, boolean> = {}
const SAMPLE_RATE = 48000
const BINS = 1024

// A single 1 kHz partial: normalised level 1 at its bin, falling off two bins either side.
const toneFrame = (hz: number): SpectrumFrame => {
  const center = (hz / (SAMPLE_RATE / 2)) * (BINS - 1)

  return { data: Float32Array.from({ length: BINS }, (_, bin) => Math.max(0, 1 - Math.abs(bin - center) / 2)), sampleRate: SAMPLE_RATE }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const run = async () => {
  const [frame, setFrame] = createSignal<SpectrumFrame | null>(null)
  const host = document.createElement('div')
  host.style.cssText = 'width:640px;height:420px;display:flex;flex-direction:column;'
    + '--device-graph-background:#0b0b10;--device-graph-grid:#2a2a33;--device-graph-accent:#3fd0f0'
  document.body.append(host)
  render(() => <SpectrumView frame={frame()} view="both" maxHold={false} />, host)
  // Tailwind is not loaded here, so give the view the flex layout its classes describe.
  const view = host.querySelector<HTMLElement>('[data-spectrum-view]')

  if (view) view.style.cssText = 'display:flex;flex-direction:column;height:100%;gap:4px'

  for (const frame of host.querySelectorAll<HTMLElement>('[data-spectrum-canvas]')) frame.style.cssText = 'position:relative;flex:1 1 0;min-height:0'

  for (const canvas of host.querySelectorAll('canvas')) canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%'
  await nextFrame()

  const canvases = () => [...host.querySelectorAll('canvas')]
  scenarios['both-views-render-a-curve-and-a-spectrogram-canvas'] =
    canvases().map((canvas) => canvas.getAttribute('aria-label')).join() === 'Spectrum,Spectrogram'

  // More frames than the ring holds: it must scroll, not grow. Each frame is its own delivery, so each is flushed to the view.
  for (let index = 0; index < 400; index++) {
    setFrame(toneFrame(1000))
    flush()
  }

  await nextFrame()

  const spectrogram = canvases()[1]
  const context = spectrogram.getContext('2d')

  if (!context) throw new Error('No spectrogram context')

  const brightness = (x: number, y: number) => {
    const [r, g, b] = context.getImageData(x, y, 1, 1).data

    return r + g + b
  }

  const brightestRow = (x: number) => {
    let best = 0

    for (let y = 0; y < spectrogram.height; y++) if (brightness(x, y) > brightness(x, best)) best = y

    return best
  }

  const expectedRow = spectrogram.height * (1 - Math.log(1000 / 20) / Math.log(1000))
  const tolerance = spectrogram.height * 0.05
  scenarios['a-1khz-tone-lands-on-its-log-frequency-row-at-the-newest-column'] =
    Math.abs(brightestRow(spectrogram.width - 2) - expectedRow) < tolerance
  scenarios['the-ring-is-full-so-the-oldest-column-shows-the-tone-too'] =
    Math.abs(brightestRow(1) - expectedRow) < tolerance

  setFrame(toneFrame(100))
  flush()
  setFrame(toneFrame(100))
  flush()
  await nextFrame()
  const lowRow = spectrogram.height * (1 - Math.log(100 / 20) / Math.log(1000))
  scenarios['a-new-tone-scrolls-in-on-the-right-while-the-old-one-stays-left'] =
    Math.abs(brightestRow(spectrogram.width - 2) - lowRow) < tolerance
    && Math.abs(brightestRow(1) - expectedRow) < tolerance

  const curve = canvases()[0].getContext('2d')

  if (!curve) throw new Error('No curve context')

  const accentPixels = () => {
    const { data } = curve.getImageData(0, 0, canvases()[0].width, canvases()[0].height)
    let count = 0

    for (let index = 0; index < data.length; index += 4) if (data[index + 2] > 200 && data[index] < 120) count++

    return count
  }

  scenarios['the-curve-draws-the-latest-frame'] = accentPixels() > 0

  const screenshotReady = host.querySelectorAll('canvas').length
  setFrame(null)
  await nextFrame()
  scenarios['a-null-frame-clears-the-history'] = brightness(spectrogram.width - 2, Math.round(lowRow)) < 60
    && brightness(1, Math.round(expectedRow)) < 60 && accentPixels() === 0
  setFrame(toneFrame(1000))
  flush()

  for (let index = 0; index < 150; index++) {
    setFrame(toneFrame(3000 + index * 20))
    flush()
  }

  await nextFrame()
  scenarios['a-screenshot-scene-was-rendered'] = screenshotReady === 2

  Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
