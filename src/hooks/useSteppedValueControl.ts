import { createSignal } from 'solid-js'
import { useDrag } from '~/hooks/useDrag'

type Point = { x: number, y: number }

type DragValueContext = {
  startValue: number
  startPosition: Point
  currentPosition: Point
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

export function useSteppedValueControl(options: UseSteppedValueControlOptions) {
  const [dragValue, setDragValue] = createSignal<number | null>(null)
  let startPosition: Point = { x: 0, y: 0 }
  let startValue = options.value()
  let lastEmittedValue = options.value()
  const visualValue = () => dragValue() ?? options.value()
  const normalizeValue = (value: number) => {
    const clamped = Math.max(options.min(), Math.min(options.max(), value))
    const stepped = Math.round(clamped / options.step()) * options.step()
    return Math.max(options.min(), Math.min(options.max(), Number(stepped.toFixed(6))))
  }
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
      startValue = options.value()
      lastEmittedValue = options.value()
      setDragValue(options.value())
    },
    onDragMove: (currentPosition, event) => {
      event.preventDefault()
      const finalValue = normalizeValue(options.valueFromDrag({
        startValue,
        startPosition,
        currentPosition,
      }))
      setDragValue(finalValue)
      emitValue(finalValue)
    },
    onDragEnd: (_position, event) => {
      event.preventDefault()
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

  return {
    isDragging: drag.isDragging,
    handleKeyDown,
    onPointerDown: drag.onPointerDown,
    setVisualValue,
    visualValue,
  }
}
