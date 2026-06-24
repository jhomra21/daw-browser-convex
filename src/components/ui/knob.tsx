import { Show, createSignal } from 'solid-js'
import { useDrag } from '~/hooks/useDrag'
import { cn } from '~/lib/utils'

type KnobProps = {
  value: number
  min: number
  max: number
  step?: number
  size?: number
  label?: string
  valueLabel?: string
  resetValue?: number
  unit?: string
  disabled?: boolean
  onValueChange: (value: number) => void
  logarithmic?: boolean
  bipolar?: boolean
  showValue?: boolean
  class?: string
}

const KNOB_ARC_PATH = 'M 23 75 A 35 35 0 1 1 77 75'
const KNOB_ARC_SWEEP_DEGREES = 260
const KNOB_ARC_START_DEGREES = -130
const KNOB_POINTER_END_Y = 18
const KNOB_CENTER_VALUE = 0

export default function Knob(props: KnobProps) {
  const [dragValue, setDragValue] = createSignal<number | null>(null)
  let startY = 0
  let startValue = 0
  let lastEmittedValue = props.value
  
  const size = () => props.size ?? 36
  const step = () => props.step ?? 0.1
  const bipolar = () => props.bipolar ?? false
  const visualValue = () => dragValue() ?? props.value
  const displayValue = () => props.valueLabel ?? formatValue()
  
  const getAngle = () => {
    return valueToArcFraction(visualValue()) * KNOB_ARC_SWEEP_DEGREES + KNOB_ARC_START_DEGREES
  }

  const valueToArcFraction = (value: number) => {
    if (props.max === props.min) return 0
    return Math.max(0, Math.min(1, (value - props.min) / (props.max - props.min)))
  }
  const centerArcFraction = () => bipolar() ? valueToArcFraction(KNOB_CENTER_VALUE) : 0
  const fillArcFraction = () => valueToArcFraction(visualValue())
  const arcDashArray = () => {
    if (bipolar()) {
      const visible = Math.abs(fillArcFraction() - centerArcFraction()) * 100
      return `${visible} ${100 - visible}`
    }

    const visible = Math.max(0, Math.min(100, fillArcFraction() * 100))
    return `${visible} ${100 - visible}`
  }
  const arcDashOffset = () => {
    if (!bipolar()) return undefined
    const center = centerArcFraction() * 100
    const fill = fillArcFraction() * 100
    return `${fill < center ? -fill : -center}`
  }
  const normalizeValue = (value: number) => {
    const clamped = Math.max(props.min, Math.min(props.max, value))
    const stepped = Math.round(clamped / step()) * step()
    return Math.max(props.min, Math.min(props.max, Number(stepped.toFixed(6))))
  }

  const formatValue = () => {
    const unit = props.unit ?? ''
    const value = visualValue()
    
    if (props.logarithmic && value >= 1000) {
      return `${(value / 1000).toFixed(1)}k${unit}`
    }
    
    if (bipolar() && value > 0) {
      return `+${value.toFixed(1)}${unit}`
    }
    
    return `${value.toFixed(1)}${unit}`
  }

  const emitValue = (value: number) => {
    if (value === lastEmittedValue) return
    lastEmittedValue = value
    props.onValueChange(value)
  }

  const drag = useDrag({
    disabled: () => props.disabled ?? false,
    onDragStart: (pos, event) => {
      event.stopPropagation()
      startY = pos.y
      startValue = props.value
      lastEmittedValue = props.value
      setDragValue(props.value)
    },
    onDragMove: (pos, event) => {
      event.preventDefault()
      const deltaY = startY - pos.y
      const sensitivity = props.logarithmic ? 1.0 : 1.5
      
      let newValue: number
      
      if (props.logarithmic) {
        const normalizedStart = (startValue - props.min) / (props.max - props.min)
        const logMin = Math.log10(props.min)
        const logMax = Math.log10(props.max)
        const logStart = logMin + normalizedStart * (logMax - logMin)
        const logNew = logStart + (deltaY * sensitivity * 0.005)
        newValue = Math.pow(10, Math.max(logMin, Math.min(logMax, logNew)))
      } else {
        const range = props.max - props.min
        const deltaValue = (deltaY * sensitivity * range) / 150
        newValue = startValue + deltaValue
      }
      
      const finalValue = normalizeValue(newValue)
      
      setDragValue(finalValue)
      emitValue(finalValue)
    },
    onDragEnd: (_pos, event) => {
      event.preventDefault()
      setDragValue(null)
    },
  })

  const handleDoubleClick = () => {
    if (props.disabled) return
    
    const resetValue = normalizeValue(props.resetValue ?? (bipolar() ? (props.min + props.max) / 2 : props.min))
    lastEmittedValue = props.value
    setDragValue(resetValue)
    emitValue(resetValue)
    queueMicrotask(() => setDragValue(null))
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (props.disabled) return
    const currentValue = visualValue()
    const largeStep = step() * 10
    let nextValue: number | undefined

    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        nextValue = currentValue + step()
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        nextValue = currentValue - step()
        break
      case 'PageUp':
        nextValue = currentValue + largeStep
        break
      case 'PageDown':
        nextValue = currentValue - largeStep
        break
      case 'Home':
        nextValue = props.min
        break
      case 'End':
        nextValue = props.max
        break
      default:
        return
    }

    event.preventDefault()
    lastEmittedValue = props.value
    const finalValue = normalizeValue(nextValue)
    setDragValue(finalValue)
    emitValue(finalValue)
    queueMicrotask(() => setDragValue(null))
  }

  return (
    <div class={cn('flex flex-col items-center gap-0.5', props.class)}>
      <Show when={props.label}>
        <div class="text-xs font-medium leading-none text-neutral-400">{props.label}</div>
      </Show>
      
      <div
        role="slider"
        tabIndex={props.disabled ? undefined : 0}
        aria-label={props.label ?? 'Knob'}
        aria-disabled={props.disabled}
        aria-valuemin={props.min}
        aria-valuemax={props.max}
        aria-valuenow={visualValue()}
        aria-valuetext={displayValue()}
        class="relative select-none transition-transform duration-100"
        classList={{
          'cursor-not-allowed opacity-50': props.disabled,
          'cursor-pointer': !props.disabled,
        }}
        style={{ 
          width: `${size() + 12}px`, 
          height: `${size() + 12}px`,
          padding: '6px',
          'user-select': 'none',
          '-webkit-user-select': 'none',
          'touch-action': 'none',
        }}
        onPointerDown={drag.onPointerDown}
        onKeyDown={handleKeyDown}
        onDblClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        <svg
          class="absolute inset-1.5 h-full w-full"
          style={{ width: `${size()}px`, height: `${size()}px` }}
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <path
            class="stroke-neutral-700"
            d={KNOB_ARC_PATH}
            fill="none"
            stroke-width="4"
            stroke-linecap="round"
            pathLength="100"
          />
          
          <path
            classList={{
              'stroke-sky-300': drag.isDragging(),
              'stroke-cyan-400': !drag.isDragging(),
            }}
            d={KNOB_ARC_PATH}
            fill="none"
            stroke-width="4"
            stroke-linecap="round"
            pathLength="100"
            stroke-dasharray={arcDashArray()}
            stroke-dashoffset={arcDashOffset()}
          />
          <line
            x1="50"
            y1="50"
            x2="50"
            y2={KNOB_POINTER_END_Y}
            classList={{
              'stroke-sky-100': drag.isDragging(),
              'stroke-neutral-100': !drag.isDragging(),
            }}
            stroke-width="5"
            stroke-linecap="round"
            transform={`rotate(${getAngle()} 50 50)`}
          />
        </svg>
      </div>
      
      {props.showValue !== false && (
        <div
          class="max-w-full w-full whitespace-nowrap text-center font-mono leading-none transition-colors duration-150"
          classList={{
            'text-[11px]': displayValue().length > 6,
            'text-xs': displayValue().length <= 6,
            'text-neutral-50': drag.isDragging(),
            'text-neutral-200': !drag.isDragging(),
          }}
          style={{ 'word-spacing': '-0.18em' }}
        >
          {displayValue()}
        </div>
      )}
    </div>
  )
}
