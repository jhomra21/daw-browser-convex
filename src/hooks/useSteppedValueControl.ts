import { createSignal } from 'solid-js'
import { useDrag } from '~/hooks/useDrag'
import { useParameterGesture } from '~/components/effects/effect-parameter-interaction'
import { WHEEL_IDLE_MS } from '~/lib/wheel-idle'

type Point = { x: number, y: number }

type DragValueContext = {
  startValue: number
  startPosition: Point
  currentPosition: Point
  fine: boolean
}

type UseSteppedValueControlOptions = {
  value: () => number
  min: () => number
  max: () => number
  step: () => number
  disabled: () => boolean
  onValueChange: (value: number) => void
  valueFromDrag: (context: DragValueContext) => number
}

export function quantizeSteppedValue(value: number, min: number, max: number, step: number) {
  const clamped = Math.max(min, Math.min(max, value))
  const stepped = min + Math.round((clamped - min) / step) * step
  return Math.max(min, Math.min(max, Number(stepped.toFixed(6))))
}

const isValueKey = (key: string) => (
  key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft'
  || key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End'
)

// Maps pointer, key and wheel input onto gesture verbs. Whether a gesture is open is the owner's to say;
// this control only shows the value it is moving and restores it when the gesture is cancelled.
export function useSteppedValueControl(options: UseSteppedValueControlOptions) {
  const [dragValue, setDragValue] = createSignal<number | null>(null)
  let startPosition: Point = { x: 0, y: 0 }
  let startValue = options.value()
  let gestureStartValue = startValue
  // startValue rebases when Shift toggles precision; cancel restores the value from before the gesture.
  let fineDrag = false
  // Registered before useDrag so a dispose cancels a live drag before this gesture ends (cleanups run last-in first).
  const gesture = useParameterGesture({
    onClosed: () => {
      drag.cancelDrag()
      setDragValue(null)
    },
  })
  // The wheel is a separate holder: it never ends a drag or key hold that is open at the same time.
  const wheelGesture = useParameterGesture({ idleMs: WHEEL_IDLE_MS })
  const visualValue = () => dragValue() ?? options.value()
  const normalizeValue = (value: number) => quantizeSteppedValue(value, options.min(), options.max(), options.step())
  // Drag and key hold show their own value until the gesture ends, so the control never lags the pointer.
  const show = (value: number) => {
    const finalValue = normalizeValue(value)
    setDragValue(finalValue)
    gesture.tick(() => options.onValueChange(finalValue))
  }
  const endGesture = () => {
    gesture.end()
    setDragValue(null)
  }
  const cancelGesture = (restore = true) => {
    gesture.cancel()
    // Without an owner nothing restores the value for us.
    if (restore && !gesture.owned) options.onValueChange(gestureStartValue)
    setDragValue(null)
  }
  const drag = useDrag({
    disabled: options.disabled,
    onDragStart: (position, event) => {
      event.stopPropagation()
      startPosition = position
      startValue = visualValue()
      gestureStartValue = startValue
      fineDrag = event.shiftKey
      setDragValue(startValue)
      gesture.open()
    },
    onDragMove: (currentPosition, event) => {
      event.preventDefault()
      if (event.shiftKey !== fineDrag) {
        startPosition = currentPosition
        startValue = visualValue()
        fineDrag = event.shiftKey
      }
      show(options.valueFromDrag({ startValue, startPosition, currentPosition, fine: fineDrag }))
    },
    onDragEnd: (_position, event) => {
      event.preventDefault()
      endGesture()
    },
    onDragCancel: (reason) => cancelGesture(reason === 'cancel'),
  })
  const handleKeyDown = (event: KeyboardEvent) => {
    if (options.disabled()) return
    // macOS can swallow keyup while Cmd is held, which would leave a keyboard hold open.
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Escape abandons whatever this control holds open, whichever input source opened it.
    if (event.key === 'Escape' && (gesture.isOpen() || wheelGesture.isOpen()) && !drag.isDragging()) {
      event.preventDefault()
      event.stopPropagation()
      wheelGesture.cancel()
      cancelGesture()
      return
    }
    if (!isValueKey(event.key)) return
    // Auto-repeat only continues a hold: after Escape or an owner close it must not open a new gesture.
    if (event.repeat && !gesture.isOpen()) {
      event.preventDefault()
      return
    }
    const largeStep = options.step() * 10
    const nextValue = {
      ArrowUp: visualValue() + options.step(),
      ArrowRight: visualValue() + options.step(),
      ArrowDown: visualValue() - options.step(),
      ArrowLeft: visualValue() - options.step(),
      PageUp: visualValue() + largeStep,
      PageDown: visualValue() - largeStep,
      Home: options.min(),
      End: options.max(),
    }[event.key]
    if (nextValue === undefined) return
    event.preventDefault()
    if (!gesture.isOpen()) {
      gestureStartValue = visualValue()
      gesture.open()
    }
    show(nextValue)
  }
  const handleKeyUp = (event: KeyboardEvent) => {
    if (isValueKey(event.key) && !drag.isDragging()) endGesture()
  }
  const handleBlur = () => {
    wheelGesture.end()
    if (!drag.isDragging()) endGesture()
  }
  const handleWheel = (event: WheelEvent) => {
    if (options.disabled() || event.deltaY === 0) return
    event.preventDefault()
    wheelGesture.open()
    const next = normalizeValue(visualValue() + (event.deltaY < 0 ? options.step() : -options.step()))
    wheelGesture.tick(() => options.onValueChange(next))
  }
  // Reset and typed entry are one edit: open, move, close.
  const commitValue = (value: number) => {
    gesture.once(() => options.onValueChange(normalizeValue(value)))
  }

  return {
    commitValue,
    handleBlur,
    handleKeyDown,
    handleKeyUp,
    handleWheel,
    isDragging: drag.isDragging,
    onPointerDown: drag.onPointerDown,
    visualValue,
  }
}
