import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import type { SpectrumFrame } from '@daw-browser/audio-engine/audio-engine'
import { createDefaultSpectrumParams, type SpectrumParams } from '@daw-browser/shared'

import Spectrum from '~/components/effects/Spectrum'

const scenarios: Record<string, boolean> = {}
const SAMPLE_RATE = 48000
const BINS = 1024

const toneFrame = (hz: number): SpectrumFrame => {
  const center = (hz / (SAMPLE_RATE / 2)) * (BINS - 1)
  return { data: Float32Array.from({ length: BINS }, (_, bin) => Math.max(0, 1 - Math.abs(bin - center) / 2)), sampleRate: SAMPLE_RATE }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const run = async () => {
  const [frame, setFrame] = createSignal<SpectrumFrame | null>(null)
  const [params, setParams] = createSignal<SpectrumParams>(createDefaultSpectrumParams())
  const host = document.createElement('div')
  host.style.cssText = 'width:480px;height:360px;display:flex;flex-direction:column;'
    + '--device-graph-background:#0b0b10;--device-graph-grid:#2a2a33;--device-graph-accent:#3fd0f0'
  // Tailwind is not loaded here, so state the layout the component's classes describe before it renders.
  const style = document.createElement('style')
  style.textContent = '[data-spectrum-view]{display:flex;flex-direction:column;height:240px;gap:4px}'
    + '[data-spectrum-canvas]{position:relative;flex:1 1 0;min-height:0}canvas{position:absolute;inset:0;width:100%;height:100%}'
  document.head.append(style)
  document.body.append(host)
  render(() => (
    <Spectrum
      params={params()}
      frame={frame()}
      onChange={(updates) => setParams((previous) => ({ ...previous, ...updates }))}
      onToggleEnabled={(enabled) => setParams((previous) => ({ ...previous, enabled }))}
      onReset={() => setParams(createDefaultSpectrumParams())}
    />
  ), host)
  const layout = async () => {
    await nextFrame()
    await nextFrame()
  }
  await layout()
  const labels = () => [...host.querySelectorAll('canvas')].map((canvas) => canvas.getAttribute('aria-label')).join()
  const press = (label: string) => {
    const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
    if (!button) throw new Error(`No ${label} button`)
    button.click()
  }

  scenarios['the-device-defaults-to-the-curve-and-the-spectrogram'] = labels() === 'Spectrum,Spectrogram'

  for (let index = 0; index < 60; index++) setFrame(toneFrame(500 + index * 40))
  await nextFrame()
  const spectrogram = host.querySelectorAll('canvas')[1]
  const lit = (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No canvas context')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let count = 0
    for (let index = 0; index < data.length; index += 4) if (data[index] + data[index + 1] + data[index + 2] > 90) count++
    return count
  }
  scenarios['frames-fed-to-the-device-paint-spectrogram-columns'] = lit(spectrogram) > 0

  press('Spectrogram')
  await layout()
  scenarios['the-spectrogram-view-shows-only-the-spectrogram'] = labels() === 'Spectrogram'
  press('Spectrum')
  await layout()
  scenarios['the-spectrum-view-shows-only-the-curve'] = labels() === 'Spectrum'
  press('Both')
  await layout()

  setParams((previous) => ({ ...previous, enabled: false }))
  await nextFrame()
  const cleared = host.querySelectorAll('canvas')[1]
  scenarios['a-bypassed-device-shows-nothing'] = lit(cleared) === 0
  setParams((previous) => ({ ...previous, enabled: true }))
  for (let index = 0; index < 120; index++) setFrame(toneFrame(200 + index * 60))
  await nextFrame()
  scenarios['re-enabling-the-device-resumes-the-spectrogram'] = lit(host.querySelectorAll('canvas')[1]) > 0

  Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
