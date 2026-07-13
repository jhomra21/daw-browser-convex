import { describe, expect, test } from 'bun:test'
import { createRoot } from 'solid-js'
import { knobValueFromDrag } from '~/components/ui/knob'
import { useSteppedValueControl } from './useSteppedValueControl'

type ListenerEntry = {
  listener: (...args: never[]) => unknown
  capture: boolean
}

class CapturedPointerWindow {
  private readonly listeners = new Map<string, ListenerEntry[]>()

  addEventListener(type: string, listener: (...args: never[]) => unknown | null, options?: boolean | AddEventListenerOptions) {
    if (!listener) return
    const entries = this.listeners.get(type) ?? []
    entries.push({
      listener,
      capture: typeof options === 'boolean' ? options : options?.capture === true,
    })
    this.listeners.set(type, entries)
  }

  removeEventListener(type: string, listener: (...args: never[]) => unknown | null, options?: boolean | EventListenerOptions) {
    if (!listener) return
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const entries = this.listeners.get(type) ?? []
    this.listeners.set(type, entries.filter((entry) => entry.listener !== listener || entry.capture !== capture))
  }

  dispatch(type: string, event: object) {
    for (const entry of this.listeners.get(type) ?? []) {
      Reflect.apply(entry.listener, undefined, [event])
    }
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.length ?? 0
  }
}

const pointerEvent = (clientY: number, shiftKey = false) => ({
  pointerId: 1,
  clientX: 0,
  clientY,
  currentTarget: { setPointerCapture: () => undefined },
  shiftKey,
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
})

describe('useSteppedValueControl pointer lifecycle', () => {
  test('keeps a drag alive across owner replacement and cleans up on pointerup', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const capturedWindow = new CapturedPointerWindow()
    const bodyClasses = new Set<string>()
    Reflect.set(globalThis, 'window', capturedWindow)
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
        let disposeControl: (() => void) | undefined
        let control: ReturnType<typeof useSteppedValueControl> | undefined
        const values: number[] = []
        let replaceControl: (state: { bitDepth: number }) => void

        replaceControl = (state) => {
          disposeControl?.()
          let nextControl: ReturnType<typeof useSteppedValueControl> | undefined
          disposeControl = createRoot((dispose) => {
            nextControl = useSteppedValueControl({
              value: () => state.bitDepth,
              min: () => 2,
              max: () => 24,
              step: () => 1,
              disabled: () => false,
              onValueChange: (value) => {
                values.push(value)
                replaceControl({ bitDepth: value })
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
            return dispose
          })
          control = nextControl
        }
        replaceControl({ bitDepth: 12 })

        const initialControl = control
        if (!initialControl) throw new Error('Expected the initial control owner.')

        Reflect.apply(initialControl.onPointerDown, undefined, [pointerEvent(240)])
        capturedWindow.dispatch('pointermove', pointerEvent(192))

        expect(values).toEqual([16])
        expect(control).not.toBe(initialControl)
        expect(capturedWindow.listenerCount('pointermove')).toBe(1)
        expect(capturedWindow.listenerCount('pointerup')).toBe(1)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(1)
        expect(bodyClasses.has('select-none')).toBe(true)

        capturedWindow.dispatch('pointermove', pointerEvent(144))
        capturedWindow.dispatch('pointerup', pointerEvent(144))

        expect(values).toEqual([16, 21])
        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(capturedWindow.listenerCount('pointerup')).toBe(0)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(0)
        expect(bodyClasses.has('select-none')).toBe(false)

        capturedWindow.dispatch('pointermove', pointerEvent(96))
        expect(values).toEqual([16, 21])

        disposeControl?.()
        disposeParent()
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
    }
  })
  test('cleans up listeners and body state on pointercancel after owner replacement', () => {
    const previousWindow = globalThis.window
    const previousDocument = globalThis.document
    const capturedWindow = new CapturedPointerWindow()
    const bodyClasses = new Set<string>()
    Reflect.set(globalThis, 'window', capturedWindow)
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
        let disposeControl: (() => void) | undefined
        let control: ReturnType<typeof useSteppedValueControl> | undefined
        const values: number[] = []
        let replaceControl: (state: { bitDepth: number }) => void

        replaceControl = (state) => {
          disposeControl?.()
          let nextControl: ReturnType<typeof useSteppedValueControl> | undefined
          disposeControl = createRoot((dispose) => {
            nextControl = useSteppedValueControl({
              value: () => state.bitDepth,
              min: () => 2,
              max: () => 24,
              step: () => 1,
              disabled: () => false,
              onValueChange: (value) => {
                values.push(value)
                replaceControl({ bitDepth: value })
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
            return dispose
          })
          control = nextControl
        }
        replaceControl({ bitDepth: 12 })

        const initialControl = control
        if (!initialControl) throw new Error('Expected the initial control owner.')

        Reflect.apply(initialControl.onPointerDown, undefined, [pointerEvent(240)])
        capturedWindow.dispatch('pointermove', pointerEvent(192))
        capturedWindow.dispatch('pointercancel', pointerEvent(192))

        expect(values).toEqual([16])
        expect(capturedWindow.listenerCount('pointermove')).toBe(0)
        expect(capturedWindow.listenerCount('pointerup')).toBe(0)
        expect(capturedWindow.listenerCount('pointercancel')).toBe(0)
        expect(bodyClasses.has('select-none')).toBe(false)

        disposeControl?.()
        disposeParent()
      })
    } finally {
      Reflect.set(globalThis, 'window', previousWindow)
      Reflect.set(globalThis, 'document', previousDocument)
    }
  })
})