import { createSignal } from 'solid-js'
import { render } from '@solidjs/web'
import { createDefaultReverbParams, type ReverbParams } from '@daw-browser/shared'

import '~/index.css'
import Reverb from '~/components/effects/Reverb'

const scenarios: Record<string, boolean> = {}
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => { await nextFrame(); await nextFrame() }

const run = async () => {
  const changes: Partial<ReverbParams>[] = []
  const overrides: string[] = []
  const [params, setParams] = createSignal(createDefaultReverbParams())
  const [ranges, setRanges] = createSignal<ReadonlyMap<string, { min: number; max: number }> | undefined>(undefined)
  const host = document.createElement('div')
  host.style.cssText = 'width:760px;height:300px;display:flex'
  document.body.append(host)
  render(() => (
    <Reverb
      params={params()}
      onChange={(updates) => { changes.push(updates); setParams((previous) => ({ ...previous, ...updates })) }}
      automationRangesByParameterId={ranges()}
      onManualAutomationOverride={(parameterId) => overrides.push(parameterId)}
    />
  ), host)
  await settle()

  const panel = host.firstElementChild
  const lastChange = () => changes.at(-1)
  const named = (name: string) => [...host.querySelectorAll<HTMLElement>('button, [role="slider"]')].find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  const slider = (name: string) => host.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`)
  const valueText = (name: string) => slider(name)?.getAttribute('aria-valuetext')
  const pressed = (name: string) => named(name)?.getAttribute('aria-pressed')
  const disabled = (name: string) => named(name) instanceof HTMLButtonElement && named(name)?.hasAttribute('disabled')
  const stripTexts = (section: string) => [...host.querySelectorAll(`section[aria-label="${section}"] .bg-orange-400`)].map((strip) => strip.textContent)
  const curveYs = (section: string) => (host.querySelector(`section[aria-label="${section}"] svg > path`)?.getAttribute('d') ?? '').split(/[ML] /).filter(Boolean).map((point) => Number(point.split(' ')[1]))
  const key = (element: HTMLElement | null | undefined, name: string) => element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))

  // A chooser is a Kobalte menu: a pointer press opens it, its items live in a portal and a pointer release selects one.
  const choose = async (chooser: string, choice: string) => {
    named(chooser)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === choice)
    item?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
  }

  // The panel and everything in it stays inside the 720 px by 300 px device, and no text is wider than its box.
  const shell = panel instanceof HTMLElement ? panel.getBoundingClientRect() : undefined

  const outside = [...host.querySelectorAll('button, [role="slider"], section, h3, span, div')].filter((element) => {
    const box = element.getBoundingClientRect()

    return shell !== undefined && box.width > 0 && (box.right > shell.right + 0.5 || box.bottom > shell.bottom + 0.5 || box.left < shell.left - 0.5 || box.top < shell.top - 0.5)
  })

  const clipped = [...host.querySelectorAll<HTMLElement>('*')].filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth)

  scenarios['the-panel-stays-720-px-wide'] = shell?.width === 720
  scenarios['every-control-sits-inside-the-300-px-device'] = shell !== undefined && outside.length === 0
  scenarios['no-label-or-value-is-wider-than-its-box'] = clipped.length === 0

  const knobs: [string, string][] = [
    ['Early Reflections Amount', '17.5 ms'], ['Early Reflections Rate', '0.30 Hz'], ['Shape', '50%'], ['Diffusion', '75%'],
    ['Chorus Amount', '0.60 ms'], ['Chorus Rate', '0.60 Hz'], ['Predelay', '20 ms'], ['Size', '65%'], ['Decay', '2.20 s'],
    ['Stereo', '100°'], ['Reflect', '25%'], ['Diffuse', '70%'], ['Dry/Wet', '25%'],
  ]

  scenarios['every-knob-has-its-name-and-reads-its-value-in-units'] = knobs.every(([name, value]) => valueText(name) === value)
  scenarios['every-knob-shows-its-visible-label'] = knobs.every(([name]) => {
    const visible = name.replace(/^(Early Reflections|Chorus) /, '')

    return [...(slider(name)?.parentElement?.children ?? [])].some((child) => child.textContent === visible)
  })
  scenarios['the-sections-read-their-values'] = JSON.stringify([stripTexts('Input Filter'), stripTexts('Diffusion Network')])
    === JSON.stringify([['20 Hz', '20.00 kHz'], ['5.00 kHz', '0.0 dB', '200 Hz', '0.0 dB']])
  scenarios['the-toggles-and-choosers-read-their-state'] = pressed('Lo Cut') === 'false' && pressed('Hi Cut') === 'false'
    && pressed('Spin') === 'true' && pressed('High shelf') === 'true' && pressed('Low shelf') === 'true' && pressed('Chorus on') === 'true'
    && pressed('Freeze') === 'false' && named('Smooth')?.textContent?.trim() === 'Fast' && named('Density')?.textContent?.trim() === 'High'
  scenarios['every-control-has-an-accessible-name'] = [...host.querySelectorAll<HTMLElement>('button, [role="slider"]')]
    .every((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() !== '')

  // Freeze is the gate for Flat and Cut, and it shows on the panel.
  scenarios['flat-and-cut-are-disabled-until-freeze-is-on'] = disabled('Freeze Flat') === true && disabled('Freeze Cut') === true
  named('Freeze')?.click()
  await settle()
  const globalSection = host.querySelector('section[aria-label="Global"]')
  scenarios['freeze-enables-flat-and-cut-and-marks-the-panel'] = lastChange()?.freeze === true && disabled('Freeze Flat') === false && disabled('Freeze Cut') === false
    && globalSection?.getAttribute('data-frozen') === 'true' && host.textContent?.includes('Frozen') === true
  named('Freeze Flat')?.click()
  named('Freeze Cut')?.click()
  await settle()
  scenarios['flat-and-cut-write-their-params-once-frozen'] = changes.some((change) => change.flat === true) && lastChange()?.cut === true
  named('Freeze')?.click()
  await settle()
  scenarios['freeze-off-disables-flat-and-cut-again'] = disabled('Freeze Flat') === true && disabled('Freeze Cut') === true

  await choose('Smooth', 'Slow')
  scenarios['the-smooth-chooser-writes-smooth'] = lastChange()?.smooth === 'slow' && named('Smooth')?.textContent?.trim() === 'Slow'
  await choose('Density', 'Sparse')
  scenarios['the-density-chooser-writes-density'] = lastChange()?.density === 'sparse' && named('Density')?.textContent?.trim() === 'Sparse'

  // A knob writes its param, and an automatable one says a hand moved it.
  key(slider('Decay'), 'ArrowUp')
  scenarios['a-knob-change-writes-its-param'] = lastChange()?.decaySec === 2.25
  key(slider('Dry/Wet'), 'ArrowUp')
  scenarios['an-automatable-knob-reports-a-manual-override'] = lastChange()?.wet === 0.26 && overrides.join() === 'reverb.decaySec,reverb.wet'

  // Every continuous control shows the automation state of its parameter: the dot on a knob whose parameter has an envelope.
  const automatable: [string, string][] = [
    ['Early Reflections Amount', 'reflectionModAmountMs'], ['Early Reflections Rate', 'reflectionModRateHz'], ['Shape', 'reflectionShape'],
    ['Diffusion', 'diffusion'], ['Chorus Amount', 'chorusAmountMs'], ['Chorus Rate', 'chorusRateHz'], ['Predelay', 'preDelayMs'],
    ['Size', 'size'], ['Decay', 'decaySec'], ['Stereo', 'stereoWidth'], ['Reflect', 'reflections'], ['Diffuse', 'diffuse'], ['Dry/Wet', 'wet'],
  ]

  const dotted = () => automatable.flatMap(([name]) => slider(name)?.querySelector('.bg-red-500') ? [name] : [])
  scenarios['no-knob-shows-automation-without-an-envelope'] = dotted().length === 0
  setRanges(new Map(automatable.map(([, field]) => [`reverb.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = dotted().length === automatable.length
  setRanges(new Map([['reverb.decaySec', { min: 0.05, max: 12 }]]))
  await settle()
  scenarios['only-the-knob-with-an-envelope-shows-automation'] = dotted().join() === 'Decay'

  // The cuts switch on at a start frequency and then move with their handles.
  scenarios['the-cut-handles-are-absent-until-the-cut-is-on'] = named('Lo Cut frequency') === undefined
  named('Lo Cut')?.click()
  await settle()
  scenarios['lo-cut-switches-on-at-830-hz'] = lastChange()?.lowCutHz === 830 && pressed('Lo Cut') === 'true'
  key(named('Lo Cut frequency'), 'ArrowRight')
  scenarios['the-lo-cut-handle-moves-the-frequency'] = lastChange()?.lowCutHz === 872
  scenarios['a-dragged-handle-reports-a-manual-override'] = overrides.at(-1) === 'reverb.lowCutHz'
  named('Hi Cut')?.click()
  await settle()
  scenarios['hi-cut-switches-on-at-6-khz'] = lastChange()?.highCutHz === 6000 && named('Hi Cut frequency') !== undefined

  // The graphs draw the kernel's curves: a flat decay curve with flat shelves, and a cut that rolls the input off.
  const flatDecay = curveYs('Diffusion Network')
  setParams((previous) => ({ ...previous, highShelfDb: -12 }))
  await settle()
  const shelvedDecay = curveYs('Diffusion Network')
  scenarios['the-decay-curve-is-flat-with-flat-shelves-and-falls-with-a-high-shelf-cut'] = flatDecay.length === 49 && new Set(flatDecay).size === 1
    && shelvedDecay.at(-1) !== undefined && shelvedDecay[0] !== undefined && shelvedDecay.at(-1)! > shelvedDecay[0] + 5
  const inputYs = curveYs('Input Filter')
  scenarios['the-input-curve-rolls-off-below-the-lo-cut-and-above-the-hi-cut'] = inputYs[0] > inputYs[24] + 5 && inputYs[48] > inputYs[24] + 5

  // Every enabled control shows a focus ring when it takes focus.
  const unringed = [...host.querySelectorAll<HTMLElement>('button:not([disabled]), [role="slider"]:not([aria-disabled="true"])')].filter((element) => {
    element.focus()
    const style = getComputedStyle(element)

    return document.activeElement !== element || style.outlineStyle === 'none' || style.outlineWidth === '0px'
  })

  scenarios['every-enabled-control-shows-a-focus-ring'] = unringed.length === 0

  Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
}

void run().catch((error) => { Object.assign(window, { __browserFixtureError: String(error) }) })
