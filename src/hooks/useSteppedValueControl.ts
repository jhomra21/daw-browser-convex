import { createSignal } from 'solid-js'
import { useDrag } from '~/hooks/useDrag'

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
  onInteractionStart?: (value: number) => void
  onInteractionEnd?: (value: number) => void
  onInteractionCancel?: (value: number) => void
}

export function quantizeSteppedValue(value: number, min: number, max: number, step: number) {
  const clamped = Math.max(min, Math.min(max, value))
  const stepped = min + Math.round((clamped - min) / step) * step
  return Math.max(min, Math.min(max, Number(stepped.toFixed(6))))
}

export function useSteppedValueControl(options: UseSteppedValueControlOptions) {
  const [dragValue, setDragValue] = createSignal<number | null>(null)
  let startPosition: Point = { x: 0, y: 0 }
  let startValue = options.value()
  let fineDrag = false
  let lastEmittedValue = options.value()
  const visualValue = () => dragValue() ?? options.value()
  const normalizeValue = (value: number) => quantizeSteppedValue(value, options.min(), options.max(), options.step())
  const emitValue = (value: number) => {
    if (value === lastEmittedValue) return
    lastEmittedValue = value
    options.onValueChange(value)
  }
  const setVisualValue = (value: number) => {
    lastEmittedValue = options.value()
    const finalValue = normalizeValue(value)
    setDragValue(finalValue)
    emitValue(finalValue)
    queueMicrotask(() => setDragValue(null))
  }
  const drag = useDrag({
    disabled: options.disabled,
    onDragStart: (position, event) => {
      event.stopPropagation()
      startPosition = position
      startValue = visualValue()
      fineDrag = event.shiftKey
      lastEmittedValue = startValue
      setDragValue(startValue)
      options.onInteractionStart?.(startValue)
    },
    onDragMove: (currentPosition, event) => {
      event.preventDefault()
      if (event.shiftKey !== fineDrag) {
        startPosition = currentPosition
        startValue = visualValue()
        fineDrag = event.shiftKey
      }
      const finalValue = normalizeValue(options.valueFromDrag({
        startValue,
        startPosition,
        currentPosition,
        fine: fineDrag,
      }))
      setDragValue(finalValue)
      emitValue(finalValue)
    },
    onDragEnd: (_position, event) => {
      event.preventDefault()
      options.onInteractionEnd?.(visualValue())
      setDragValue(null)
    },
    onDragCancel: (_position, _event) => {
      options.onInteractionCancel?.(visualValue())
      setDragValue(null)
    },
  })
  const handleKeyDown = (event: KeyboardEvent) => {
    if (options.disabled()) return
    const largeStep = options.step() * 10
    let nextValue: number | undefined

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        nextValue = visualValue() + options.step()
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        nextValue = visualValue() - options.step()
        break
      case 'PageUp':
        nextValue = visualValue() + largeStep
        break
      case 'PageDown':
        nextValue = visualValue() - largeStep
        break
      case 'Home':
        nextValue = options.min()
        break
      case 'End':
        nextValue = options.max()
        break
      default:
        return
    }

    event.preventDefault()
    setVisualValue(nextValue)
  }
  const handleWheel = (event: WheelEvent) => {
    if (options.disabled() || event.deltaY === 0) return
    event.preventDefault()
    setVisualValue(visualValue() + (event.deltaY < 0 ? options.step() : -options.step()))
  }

  return {
    handleWheel,
    isDragging: drag.isDragging,
    handleKeyDown,
    onPointerDown: drag.onPointerDown,
    setVisualValue,
    visualValue,
  }
}
