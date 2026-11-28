import { createSignal } from 'solid-js'
import { render } from '@solidjs/web'
import type { JSX } from '@solidjs/web'

import '~/index.css'

type AutomationRanges = ReadonlyMap<string, { min: number; max: number }>

export type ModulationPanelState<Params> = {
  params: () => Params
  onChange: (updates: Partial<Params>) => void
  ranges: () => AutomationRanges | undefined
  onOverride: (parameterId: string) => void
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export const settle = async () => { await nextFrame(); await nextFrame() }

// Mounts one modulation panel in a 300 px tall device slot and returns the probes its fixture scenarios share.
export const mountModulationPanel = async <Params extends object>(initial: Params, width: number, view: (state: ModulationPanelState<Params>) => JSX.Element) => {
  const changes: Partial<Params>[] = []
  const overrides: string[] = []
  const [current, setCurrent] = createSignal({ params: initial })
  const [ranges, setRanges] = createSignal<AutomationRanges | undefined>(undefined)
  const host = document.createElement('div')
  host.style.cssText = `width:${width}px;height:300px;display:flex`
  document.body.append(host)
  render(() => view({
    params: () => current().params,
    onChange: (updates) => { changes.push(updates); setCurrent((previous) => ({ params: { ...previous.params, ...updates } })) },
    ranges,
    onOverride: (parameterId) => overrides.push(parameterId),
  }), host)
  await settle()

  const controls = () => [...host.querySelectorAll<HTMLElement>('button, [role="slider"]')]
  const named = (name: string) => controls().find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
  const slider = (name: string) => host.querySelector<HTMLElement>(`[role="slider"][aria-label="${name}"]`)
  const sliderNames = () => [...host.querySelectorAll('[role="slider"]')].map((element) => element.getAttribute('aria-label'))

  // A chooser is a Kobalte menu: a pointer press opens it, its items live in a portal and a pointer release selects one.
  const choose = async (chooser: string, choice: string) => {
    named(chooser)?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.trim() === choice)
    item?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
    await settle()
  }

  const overlap = (first: DOMRect, second: DOMRect) => Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1

  return {
    host,
    changes,
    overrides,
    setRanges,
    lastChange: () => changes.at(-1),
    named,
    slider,
    sliderNames,
    valueText: (name: string) => slider(name)?.getAttribute('aria-valuetext'),
    pressed: (name: string) => named(name)?.getAttribute('aria-pressed'),
    choose,
    key: (element: HTMLElement | null | undefined, name: string) => element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })),
    // The panel is the exact width, fits the 300 px device, keeps every box inside itself and no text wider than its box or on another's.
    layout: () => {
      const panel = host.firstElementChild
      const shell = panel instanceof HTMLElement ? panel.getBoundingClientRect() : undefined

      const outside = [...host.querySelectorAll('button, [role="slider"], section, span, div')].filter((element) => {
        const box = element.getBoundingClientRect()

        return shell !== undefined && box.width > 0 && (box.right > shell.right + 0.5 || box.bottom > shell.bottom + 0.5 || box.left < shell.left - 0.5 || box.top < shell.top - 0.5)
      })

      const clipped = [...host.querySelectorAll<HTMLElement>('*')].filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
      const texts = [...host.querySelectorAll<HTMLElement>('*')].flatMap((element) => element.childElementCount === 0 && (element.textContent ?? '').trim() !== '' ? [element.getBoundingClientRect()] : [])
      const boxes = controls().map((element) => element.getBoundingClientRect())
      const crowded = boxes.some((box, index) => boxes.slice(index + 1).some((other) => overlap(box, other))) || texts.some((box, index) => texts.slice(index + 1).some((other) => overlap(box, other)))

      return { width: shell?.width, fits: shell !== undefined && shell.height <= 300 && outside.length === 0, clipped: clipped.length === 0, crowded: !crowded }
    },
    everyControlIsNamed: () => controls().every((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() !== ''),
    // Every enabled control shows a focus ring when it takes focus.
    everyEnabledControlShowsAFocusRing: () => controls().filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true').every((element) => {
      element.focus()
      const style = getComputedStyle(element)

      return document.activeElement === element && style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
    }),
    // The dot on a knob whose parameter has an envelope.
    dotted: () => [...host.querySelectorAll('[role="slider"]')].flatMap((element) => element.querySelector('.bg-red-500') ? [element.getAttribute('aria-label')] : []),
  }
}

export const publishScenarios = (scenarios: Record<string, boolean>) => {
  Object.defineProperty(window, '__browserFixtureResults', { value: scenarios })
}
