import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'
import { knobValueFromDrag } from '~/components/ui/knob'
import { useSteppedValueControl } from './useSteppedValueControl'

type ListenerEntry = {
  listener: (event: PointerLifecycleEvent) => void
  capture: boolean
}

type PointerLifecycleEvent = PointerEvent

const capturesEvents = (options?: boolean | EventListenerOptions) => (
  options === true || (options !== false && options?.capture === true)
)

class CapturedPointerWindow {
  private readonly listeners = new Map<string, ListenerEntry[]>()

  addEventListener(type: string, listener: (event: PointerLifecycleEvent) => void, options?: boolean | AddEventListenerOptions) {
    const entries = this.listeners.get(type) ?? []
    entries.push({
      listener,
      capture: capturesEvents(options),
    })
    this.listeners.set(type, entries)
  }

  removeEventListener(type: string, listener: (event: PointerLifecycleEvent) => void, options?: boolean | EventListenerOptions) {
    const capture = capturesEvents(options)
    const entries = this.listeners.get(type) ?? []
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener || entry.capture !== capture))
  }

  dispatch(type: string, event: PointerLifecycleEvent) {
    for (const entry of this.listeners.get(type) ?? []) {
      entry.listener(event)
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.length ?? 0
  }
}

class TestHTMLElement {
  setPointerCapture() {}
}

class TestPointerEvent extends Event {
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly shiftKey: boolean

  constructor(_type: string, init: PointerEventInit) {
    super('pointerdown')
    this.pointerId = init.pointerId ?? 0
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.shiftKey = init.shiftKey ?? false
    Object.defineProperty(this, 'currentTarget', { value: new TestHTMLElement() })
  }
}

const pointerEvent = (clientY: number, shiftKey = false, pointerId = 1) => ({
  clientY,
  shiftKey,
  pointerId,
})

describe('useSteppedValueControl pointer lifecycle', () => {
  test('does not start a disabled control interaction', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousPointerEvent = globalThis.PointerEvent
    const capturedWindow = new CapturedPointerWindow()
    Reflect.set(globalThis, 'window', capturedWindow)
    Reflect.set(globalThis, 'PointerEvent', TestPointerEvent)
    Reflect.set(globalThis, 'document', { body: { classList: { add: () => undefined, remove: () => undefined } } })

    try {
      createRoot((dispose) => {
        const control = useSteppedValueControl({
          value: () => 12,
          min: () => 2,
          max: () => 24,
          step: () => 1,
          disabled: () => true,
          onValueChange: () => undefined,
          valueFromDrag: ({ startValue }) => startValue,
        })
        control.onPointerDown(new PointerEvent('pointerdown', pointerEvent(240)))

        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(capturedWindow.listenerCount('pointerup')).toBe(0)
        dispose()
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
      Reflect.set(globalThis, 'PointerEvent', previousPointerEvent)
    }
  })

  test('continues emitting pointer moves while the parent value updates', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousHTMLElement = globalThis.HTMLElement
    const previousPointerEvent = globalThis.PointerEvent
    const capturedWindow = new CapturedPointerWindow()
    const bodyClasses = new Set<string>()
    Reflect.set(globalThis, 'window', capturedWindow)
    Reflect.set(globalThis, 'HTMLElement', TestHTMLElement)
    Reflect.set(globalThis, 'PointerEvent', TestPointerEvent)
    Reflect.set(globalThis, 'document', {
      body: {
        classList: {
          add: (name: string) => bodyClasses.add(name),
          remove: (name: string) => bodyClasses.delete(name),
        },
      },
    })

    try {
      createRoot((disposeParent) => {
        const values: number[] = []
        let bitDepth = 12
        const control: ReturnType<typeof useSteppedValueControl> | undefined = useSteppedValueControl({
          value: () => bitDepth,
              min: () => 2,
              max: () => 24,
              step: () => 1,
              disabled: () => false,
              onValueChange: (value) => {
                values.push(value)
                bitDepth = value
              },
              valueFromDrag: ({ startValue, startPosition, currentPosition, fine }) => knobValueFromDrag(
                startValue,
                startPosition.y - currentPosition.y,
                2,
                24,
                false,
                fine,
              ),
        })

        const initialControl = control
        if (!initialControl) throw new Error('Expected the initial control owner.')

        initialControl.onPointerDown(new PointerEvent('pointerdown', pointerEvent(240)))
        capturedWindow.dispatch('pointermove', new PointerEvent('pointermove', pointerEvent(192)))

        expect(values).toEqual([16])
        expect(capturedWindow.listenerCount('pointermove')).toBe(1)
        expect(capturedWindow.listenerCount('pointerup')).toBe(1)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(1)
        expect(bodyClasses.has('select-none')).toBe(true)

        capturedWindow.dispatch('pointermove', new PointerEvent('pointermove', pointerEvent(144)))
        capturedWindow.dispatch('pointerup', new PointerEvent('pointerup', pointerEvent(144)))

        expect(values).toEqual([16, 21])
        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(capturedWindow.listenerCount('pointerup')).toBe(0)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(0)
        expect(bodyClasses.has('select-none')).toBe(false)

        capturedWindow.dispatch('pointermove', new PointerEvent('pointermove', pointerEvent(96)))
        expect(values).toEqual([16, 21])

        disposeParent()
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
      Reflect.set(globalThis, 'HTMLElement', previousHTMLElement)
      Reflect.set(globalThis, 'PointerEvent', previousPointerEvent)
    }
  })
  test('cleans up listeners and body state when disposed during an active drag', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousHTMLElement = globalThis.HTMLElement
    const previousPointerEvent = globalThis.PointerEvent
    const capturedWindow = new CapturedPointerWindow()
    const bodyClasses = new Set<string>()
    Reflect.set(globalThis, 'window', capturedWindow)
    Reflect.set(globalThis, 'HTMLElement', TestHTMLElement)
    Reflect.set(globalThis, 'PointerEvent', TestPointerEvent)
    Reflect.set(globalThis, 'document', {
      body: {
        classList: {
          add: (name: string) => bodyClasses.add(name),
          remove: (name: string) => bodyClasses.delete(name),
        },
      },
    })

    try {
      createRoot((disposeParent) => {
        const values: number[] = []
        let bitDepth = 12
        const control: ReturnType<typeof useSteppedValueControl> | undefined = useSteppedValueControl({
          value: () => bitDepth,
              min: () => 2,
              max: () => 24,
              step: () => 1,
              disabled: () => false,
              onValueChange: (value) => {
                values.push(value)
                bitDepth = value
              },
              valueFromDrag: ({ startValue, startPosition, currentPosition, fine }) => knobValueFromDrag(
                startValue,
                startPosition.y - currentPosition.y,
                2,
                24,
                false,
                fine,
              ),
        })

        const initialControl = control
        if (!initialControl) throw new Error('Expected the initial control owner.')

        initialControl.onPointerDown(new PointerEvent('pointerdown', pointerEvent(240)))
        capturedWindow.dispatch('pointermove', new PointerEvent('pointermove', pointerEvent(192)))
        disposeParent()

        expect(values).toEqual([16])
        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(capturedWindow.listenerCount('pointerup')).toBe(0)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(0)
        expect(bodyClasses.has('select-none')).toBe(false)
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
      Reflect.set(globalThis, 'HTMLElement', previousHTMLElement)
      Reflect.set(globalThis, 'PointerEvent', previousPointerEvent)
    }
  })

  test('ignores unrelated pointer completion events during an active drag', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const previousHTMLElement = globalThis.HTMLElement
    const previousPointerEvent = globalThis.PointerEvent
    const capturedWindow = new CapturedPointerWindow()
    const bodyClasses = new Set<string>()
    Reflect.set(globalThis, 'window', capturedWindow)
    Reflect.set(globalThis, 'HTMLElement', TestHTMLElement)
    Reflect.set(globalThis, 'PointerEvent', TestPointerEvent)
    Reflect.set(globalThis, 'document', {
      body: {
        classList: {
          add: (name: string) => bodyClasses.add(name),
          remove: (name: string) => bodyClasses.delete(name),
        },
      },
    })

    try {
      createRoot((dispose) => {
        const control = useSteppedValueControl({
          value: () => 12,
          min: () => 2,
          max: () => 24,
          step: () => 1,
          disabled: () => false,
          onValueChange: () => undefined,
          valueFromDrag: ({ startValue }) => startValue,
        })

        control.onPointerDown(new PointerEvent('pointerdown', pointerEvent(240)))
        capturedWindow.dispatch('pointerup', new PointerEvent('pointerup', pointerEvent(240, false, 2)))
        capturedWindow.dispatch('pointercancel', new PointerEvent('pointercancel', pointerEvent(240, false, 3)))

        expect(capturedWindow.listenerCount('pointermove')).toBe(1)
        expect(bodyClasses.has('select-none')).toBe(true)

        capturedWindow.dispatch('pointerup', new PointerEvent('pointerup', pointerEvent(240)))
        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(bodyClasses.has('select-none')).toBe(false)
        dispose()
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
      Reflect.set(globalThis, 'HTMLElement', previousHTMLElement)
      Reflect.set(globalThis, 'PointerEvent', previousPointerEvent)
    }
  })
})