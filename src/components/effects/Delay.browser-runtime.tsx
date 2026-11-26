import { createSignal } from 'solid-js'
import { render } from '@solidjs/web'
import { createDefaultDelayParams, type DelayParams } from '@daw-browser/shared'

import '~/index.css'
import Delay from '~/components/effects/Delay'

const scenarios: Record<string, boolean> = {}
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const settle = async () => { await nextFrame(); await nextFrame() }

const run = async () => {
  const changes: Partial<DelayParams>[] = []
  const overrides: string[] = []
  const [params, setParams] = createSignal(createDefaultDelayParams())
  const [ranges, setRanges] = createSignal<ReadonlyMap<string, { min: number; max: number }> | undefined>(undefined)
  const host = document.createElement('div')
  host.style.cssText = 'width:640px;height:300px;display:flex'
  document.body.append(host)
  render(() => (
    <Delay
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
  const key = (element: HTMLElement | null | undefined, name: string) => element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  const stripTexts = () => [...host.querySelectorAll('section[aria-label="Filter"] .bg-orange-400')].map((strip) => strip.textContent)

  // A chooser is a Kobalte menu: a pointer press opens it, its items live in a portal and a pointer release selects one.
  const choose = async (chooser: string, choice: string) => {
    named(chooser)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === choice)
    item?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
  }

  // The panel and everything in it stays inside the 640 px by 300 px device, and no text is wider than its box.
  const shell = panel instanceof HTMLElement ? panel.getBoundingClientRect() : undefined

  const outside = [...host.querySelectorAll('button, [role="slider"], section, h3, span, div')].filter((element) => {
    const box = element.getBoundingClientRect()

    return shell !== undefined && box.width > 0 && (box.right > shell.right + 0.5 || box.bottom > shell.bottom + 0.5 || box.left < shell.left - 0.5 || box.top < shell.top - 0.5)
  })

  // A graph handle parked at the end of its range is centred on the graph edge, which clips half of it by design.
  const clipped = [...host.querySelectorAll<HTMLElement>('*:not(.touch-none)')].filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth)

  scenarios['the-panel-stays-640-px-wide'] = shell?.width === 640
  scenarios['every-control-sits-inside-the-300-px-device'] = shell !== undefined && outside.length === 0
  scenarios['no-label-or-value-is-wider-than-its-box'] = clipped.length === 0

  scenarios['the-defaults-read-as-the-device-defaults'] = pressed('Left Sync') === 'true' && pressed('Right Sync') === 'true' && pressed('Left 1/8') === 'true'
    && pressed('Right 1/8') === 'true' && pressed('Link channels') === 'true' && pressed('Repitch') === 'true' && pressed('Fade') === 'false'
    && pressed('Freeze') === 'false' && pressed('Ping Pong') === 'false' && pressed('Filter on') === 'false'
  scenarios['the-knobs-read-their-values-in-units'] = valueText('Feedback') === '25%' && valueText('Dry/Wet') === '20%'
    && valueText('Left Offset') === '0 %' && valueText('Right Offset') === '0 %'
  scenarios['the-filter-reads-its-frequency-and-width'] = JSON.stringify(stripTexts()) === JSON.stringify(['1.00 kHz', '5.00'])
  scenarios['every-control-has-an-accessible-name'] = [...host.querySelectorAll<HTMLElement>('button, [role="slider"]')]
    .every((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() !== '')

  // Link makes the right channel follow the left one, so its controls are off until Link is.
  scenarios['link-disables-the-right-channel'] = disabled('Right Sync') === true && disabled('Right 1/8') === true && disabled('Left Sync') === false
  named('Link channels')?.click()
  await settle()
  scenarios['link-off-enables-the-right-channel'] = lastChange()?.link === false && pressed('Link channels') === 'false' && disabled('Right Sync') === false && disabled('Right 1/4') === false

  named('Left 1/4')?.click()
  named('Right 1/2')?.click()
  await settle()
  scenarios['each-channel-writes-its-own-division'] = changes.some((change) => change.divisionLeft === '1/4') && lastChange()?.divisionRight === '1/2'
    && pressed('Left 1/4') === 'true' && pressed('Right 1/2') === 'true'
  await choose('Left Feel', 'Dotted')
  await choose('Right Feel', 'Triplet')
  scenarios['the-feel-choosers-write-their-channel'] = changes.some((change) => change.feelLeft === 'dotted') && lastChange()?.feelRight === 'triplet'
    && named('Left Feel')?.textContent?.trim() === 'Dotted' && named('Right Feel')?.textContent?.trim() === 'Triplet'

  // Time mode swaps the division grid for a Time knob in milliseconds.
  scenarios['sync-mode-has-no-time-knob'] = slider('Left Time knob') === null && slider('Right Time knob') === null
  named('Left Time')?.click()
  named('Right Time')?.click()
  await settle()
  scenarios['time-mode-shows-the-time-knobs'] = changes.some((change) => change.syncLeft === false) && lastChange()?.syncRight === false
    && valueText('Left Time knob') === '250 ms' && valueText('Right Time knob') === '250 ms' && named('Left 1/4') === undefined
  key(slider('Left Time knob'), 'ArrowUp')
  scenarios['a-time-knob-writes-its-time-and-reports-a-manual-override'] = lastChange()?.timeLeftMs === 251 && overrides.at(-1) === 'delay.timeMs'
  scenarios['the-offset-is-off-in-time-mode'] = slider('Left Offset')?.getAttribute('aria-disabled') === 'true'
  named('Left Sync')?.click()
  named('Right Sync')?.click()
  await settle()
  key(slider('Left Offset'), 'ArrowUp')
  await settle()
  scenarios['the-offset-knob-writes-the-offset-percent'] = lastChange()?.offsetLeftPercent === 1 && overrides.at(-1) === 'delay.offsetLeftPercent' && valueText('Left Offset') === '1 %'

  for (const choice of ['Fade', 'Jump', 'Repitch']) named(choice)?.click()
  await settle()
  scenarios['the-smoothing-buttons-write-the-mode-and-exclude-each-other'] = changes.some((change) => change.smoothing === 'fade') && changes.some((change) => change.smoothing === 'jump')
    && lastChange()?.smoothing === 'repitch' && pressed('Repitch') === 'true' && pressed('Fade') === 'false' && pressed('Jump') === 'false'

  named('Freeze')?.click()
  named('Ping Pong')?.click()
  await settle()
  scenarios['freeze-and-ping-pong-write-their-params'] = changes.some((change) => change.freeze === true) && lastChange()?.pingPong === true
    && pressed('Freeze') === 'true' && pressed('Ping Pong') === 'true'

  key(slider('Feedback'), 'ArrowUp')
  scenarios['an-automatable-knob-reports-a-manual-override'] = lastChange()?.feedback === 0.26 && overrides.at(-1) === 'delay.feedback'

  // The band-pass starts off, switches on with its button and moves with its handle; off, the handle stays but dims.
  const handle = named('Filter frequency and width')
  scenarios['the-filter-handle-is-dimmed-until-the-filter-is-on'] = handle?.classList.contains('opacity-40') === true
  named('Filter on')?.click()
  await settle()
  scenarios['filter-on-writes-the-flag-and-undims-the-handle'] = lastChange()?.filterEnabled === true && pressed('Filter on') === 'true' && named('Filter frequency and width')?.classList.contains('opacity-40') === false
  key(named('Filter frequency and width'), 'ArrowRight')
  scenarios['the-handle-moves-the-frequency-and-reports-a-manual-override'] = lastChange()?.filterHz === 1050 && overrides.at(-1) === 'delay.filterHz'
  key(named('Filter frequency and width'), 'ArrowDown')
  scenarios['the-handle-moves-the-width'] = lastChange()?.filterWidth !== undefined && Math.abs((lastChange()?.filterWidth ?? 0) - 4.9) < 1e-9
  await settle()
  scenarios['the-strips-follow-the-filter'] = JSON.stringify(stripTexts()) === JSON.stringify(['1.05 kHz', '4.90'])

  // The curve is a band-pass: it peaks at the frequency and falls to both sides.
  const curveYs = (host.querySelector('section[aria-label="Filter"] svg > path')?.getAttribute('d') ?? '').split(/[ML] /).filter(Boolean).map((point) => Number(point.split(' ')[1]))
  scenarios['the-curve-peaks-at-the-filter-frequency-and-falls-either-side'] = curveYs.length === 49 && Math.min(...curveYs) < 1 && curveYs[0] > 10 && curveYs[48] > 10

  // Every continuous control shows the automation state of its parameter: the dot on a knob whose parameter has an envelope.
  const automatable: [string, string][] = [
    ['Left Time knob', 'timeMs'], ['Left Offset', 'offsetLeftPercent'], ['Right Offset', 'offsetRightPercent'], ['Feedback', 'feedback'], ['Dry/Wet', 'dryWet'],
  ]

  const dotted = () => automatable.flatMap(([name]) => slider(name)?.querySelector('.bg-red-500') ? [name] : [])
  scenarios['no-knob-shows-automation-without-an-envelope'] = dotted().length === 0
  named('Left Time')?.click()
  await settle()
  setRanges(new Map(automatable.map(([, field]) => [`delay.${field}`, { min: 0, max: 1 }])))
  await settle()
  scenarios['every-automatable-knob-shows-its-automation'] = dotted().length === automatable.length

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
