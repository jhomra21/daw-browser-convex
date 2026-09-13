import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'

import { useTimelineViewport } from './useTimelineViewport'

class TestElement {}

class TestTimelineElement extends TestElement {
  clientWidth = 1_000
  private currentScrollLeft = 0
  private scrollListener: (() => void) | undefined
  scrollWrites = 0

  get scrollLeft() {
    return this.currentScrollLeft
  }

  set scrollLeft(value: number) {
    this.scrollWrites += 1
    this.currentScrollLeft = value
  }

  addEventListener(type: 'scroll', listener: () => void) {
    if (type === 'scroll') this.scrollListener = listener
  }

  removeEventListener(type: 'scroll', listener: () => void) {
    if (type === 'scroll' && this.scrollListener === listener) {
      this.scrollListener = undefined
    }
  }

  dispatchScroll() {
    this.scrollListener?.()
  }

  getBoundingClientRect() {
    return { left: 100 }
  }
}

class TestResizeObserver {
  static current: TestResizeObserver | undefined
  private readonly callback: (entries: ResizeObserverEntry[]) => void

  constructor(callback: (entries: ResizeObserverEntry[]) => void) {
    this.callback = callback
    TestResizeObserver.current = this
  }

  observe(_target: Element) {}

  disconnect() {
    if (TestResizeObserver.current === this) TestResizeObserver.current = undefined
  }

  dispatchResize() {
    this.callback([])
  }
}

const flushEffects = async () => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe('useTimelineViewport physical anchor maintenance', () => {
  test('keeps wheel previews logical while lifecycle and scroll paths recenter', async () => {
    const previousElement = globalThis.Element
    const previousResizeObserver = globalThis.ResizeObserver
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
    const rafCallbacks: FrameRequestCallback[] = []
    Reflect.set(globalThis, 'Element', TestElement)
    Reflect.set(globalThis, 'ResizeObserver', TestResizeObserver)
    Reflect.set(globalThis, 'requestAnimationFrame', (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    Reflect.set(globalThis, 'cancelAnimationFrame', () => {})

    try {
      await new Promise<void>((resolve, reject) => createRoot((dispose) => {
        const [scope] = createSignal('project-1')
        const [pixelsPerSecond, setPixelsPerSecond] = createSignal(100)
        const element = new TestTimelineElement()
        const viewport = useTimelineViewport({
          persistenceScope: scope,
          pixelsPerSecond,
          previewPixelsPerSecond: setPixelsPerSecond,
          commitPixelsPerSecond: setPixelsPerSecond,
          durationSec: () => 60,
          canZoom: () => true,
        })
        viewport.bind(element)

        void (async () => {
          await flushEffects()
          const writesAfterBind = element.scrollWrites
          expect(writesAfterBind).toBeGreaterThan(0)
          expect(viewport.usableWidth()).toBe(1_000)

          const rangeBeforeWheel = viewport.visibleRange()
          viewport.onWheel({
            ctrlKey: true,
            metaKey: false,
            deltaY: -100,
            deltaMode: 0,
            clientX: 400,
            preventDefault: () => {},
          })
          const callback = rafCallbacks.shift()
          callback?.(0)
          await flushEffects()

          expect(viewport.visibleRange()).not.toEqual(rangeBeforeWheel)
          expect(element.scrollWrites).toBe(writesAfterBind)

          element.clientWidth = 800
          TestResizeObserver.current?.dispatchResize()
          expect(viewport.usableWidth()).toBe(800)
          expect(element.scrollWrites).toBeGreaterThan(writesAfterBind)
          const writesAfterResize = element.scrollWrites

          const rangeBeforeScroll = viewport.visibleRange()
          element.scrollLeft += 100
          element.dispatchScroll()
          expect(viewport.visibleRange()).not.toEqual(rangeBeforeScroll)
          expect(element.scrollWrites).toBeGreaterThan(writesAfterResize)

          dispose()
          resolve()
        })().catch((error) => {
          dispose()
          reject(error)
        })
      }))
    } finally {
      Reflect.set(globalThis, 'Element', previousElement)
      Reflect.set(globalThis, 'ResizeObserver', previousResizeObserver)
      Reflect.set(globalThis, 'requestAnimationFrame', previousRequestAnimationFrame)
      Reflect.set(globalThis, 'cancelAnimationFrame', previousCancelAnimationFrame)
    }
  })
})
