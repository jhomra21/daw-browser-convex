import { createSignal } from 'solid-js'
import { render } from '@solidjs/web'
import { computeCompressorStaticCurveDb, createDefaultCompressorParams, type CompressorParams } from '@daw-browser/shared'

import '~/index.css'
import { formatDeviceDb } from '~/lib/device-value-format'
import Compressor from '~/components/effects/Compressor'

const scenarios: Record<string, boolean> = {}
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const run = async () => {
  const compressing: CompressorParams = { ...createDefaultCompressorParams(), thresholdDb: -30, ratio: 4 }
  const [params, setParams] = createSignal(compressing)
  const host = document.createElement('div')
  host.style.cssText = 'width:760px;height:300px;display:flex'
  document.body.append(host)
  render(() => <Compressor params={params()} onChange={(updates) => setParams((previous) => ({ ...previous, ...updates }))} />, host)
  await nextFrame()
  await nextFrame()

  const clippedLabels = () => [...host.querySelectorAll('button')].flatMap((button) => button.scrollWidth > button.clientWidth ? [button.textContent] : [])
  const makeupLabel = () => host.querySelector('[role="slider"][aria-label="Makeup"]')?.getAttribute('aria-valuetext')
  const panel = host.firstElementChild

  scenarios['the-panel-stays-700-px-wide'] = panel instanceof HTMLElement && panel.getBoundingClientRect().width === 700
  scenarios['no-button-label-is-clipped'] = host.querySelectorAll('button').length > 0 && clippedLabels().length === 0
  scenarios['the-makeup-knob-shows-its-own-value-while-auto-makeup-is-off'] = makeupLabel() === formatDeviceDb(0, 1, true)

  setParams((previous) => ({ ...previous, autoMakeup: true }))
  await nextFrame()
  const applied = -computeCompressorStaticCurveDb(0, compressing)
  scenarios['the-makeup-knob-shows-the-applied-makeup-while-auto-makeup-is-on'] = applied > 0 && makeupLabel() === formatDeviceDb(applied, 1, true)

  Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
