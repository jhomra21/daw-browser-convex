import { Show } from 'solid-js'
import { useSteppedValueControl } from '~/hooks/useSteppedValueControl'
import { cn } from '~/lib/utils'

type KnobProps = {
  value: number
  min: number
  max: number
  step?: number
  size?: number
  label?: string
  visibleLabel?: string
  ariaLabel?: string
  valueLabel?: string
  resetValue?: number
  unit?: string
  disabled?: boolean
  onValueChange: (value: number) => void
  logarithmic?: boolean
  zeroAwareLogarithmic?: boolean
  bipolar?: boolean
  automationRange?: { min: number; max: number }
  automated?: boolean
  onAutomationSelect?: () => void
  showValue?: boolean
  class?: string
}

const KNOB_ARC_PATH = 'M 23 75 A 35 35 0 1 1 77 75'
const KNOB_ARC_SWEEP_DEGREES = 260
const KNOB_ARC_START_DEGREES = -130
const KNOB_POINTER_END_Y = 18
const KNOB_CENTER_VALUE = 0
const DEFAULT_DRAG_TRAVERSAL_PIXELS = 240
const FINE_DRAG_MULTIPLIER = 0.1
const ZERO_AWARE_LOG_FRACTION = 0.08

const clampFraction = (value: number) => Math.max(0, Math.min(1, value))

function zeroAwareLogFraction(value: number, max: number, zeroFloor: number): number {
  if (value <= 0) return 0
  if (value <= zeroFloor) return value / zeroFloor * ZERO_AWARE_LOG_FRACTION
  return ZERO_AWARE_LOG_FRACTION + (
    (Math.log(value) - Math.log(zeroFloor)) / (Math.log(max) - Math.log(zeroFloor))
  ) * (1 - ZERO_AWARE_LOG_FRACTION)
}

function zeroAwareLogValue(fraction: number, max: number, zeroFloor: number): number {
  if (fraction <= ZERO_AWARE_LOG_FRACTION) return fraction / ZERO_AWARE_LOG_FRACTION * zeroFloor
  return Math.exp(
    Math.log(zeroFloor)
    + (fraction - ZERO_AWARE_LOG_FRACTION) / (1 - ZERO_AWARE_LOG_FRACTION)
      * (Math.log(max) - Math.log(zeroFloor)),
  )
}

export function valueToKnobFraction(
  value: number,
  min: number,
  max: number,
  logarithmic: boolean,
  zeroAwareLogarithmic = false,
  zeroFloor = 0.001,
) {
  if (max === min) return 0
  if (logarithmic && zeroAwareLogarithmic && min === 0 && max > zeroFloor) {
    return clampFraction(zeroAwareLogFraction(value, max, zeroFloor))
  }
  if (logarithmic && min > 0 && max > 0 && value > 0) {
    const logMin = Math.log(min)
    const logMax = Math.log(max)
    return clampFraction((Math.log(value) - logMin) / (logMax - logMin))
  }
  return clampFraction((value - min) / (max - min))
}

export function knobValueFromDrag(
  startValue: number,
  deltaY: number,
  min: number,
  max: number,
  logarithmic: boolean,
  fine: boolean,
  zeroAwareLogarithmic = false,
  zeroFloor = 0.001,
) {
  const deltaFraction = deltaY / DEFAULT_DRAG_TRAVERSAL_PIXELS * (fine ? FINE_DRAG_MULTIPLIER : 1)
  if (logarithmic && zeroAwareLogarithmic && min === 0 && max > zeroFloor) {
    const startFraction = valueToKnobFraction(startValue, min, max, true, true, zeroFloor)
    return zeroAwareLogValue(clampFraction(startFraction + deltaFraction), max, zeroFloor)
  }
  if (logarithmic && min > 0 && max > 0 && startValue > 0) {
    const startFraction = valueToKnobFraction(startValue, min, max, true)
    const fraction = clampFraction(startFraction + deltaFraction)
    return Math.exp(Math.log(min) + fraction * (Math.log(max) - Math.log(min)))
  }
  return startValue + deltaFraction * (max - min)
}

export default function Knob(props: KnobProps) {
  const size = () => props.size ?? 36
  const step = () => props.step ?? 0.1
  const bipolar = () => props.bipolar ?? false
  const control = useSteppedValueControl({
    value: () => props.value,
    min: () => props.min,
    max: () => props.max,
    step,
    disabled: () => props.disabled ?? false,
    onValueChange: (value) => props.onValueChange(value),
    valueFromDrag: ({ startValue, startPosition, currentPosition, fine }) => {
      const deltaY = startPosition.y - currentPosition.y
      return knobValueFromDrag(
        startValue,
        deltaY,
        props.min,
        props.max,
        props.logarithmic ?? false,
        fine,
        props.zeroAwareLogarithmic ?? false,
      )
    },
  })
  const visualValue = control.visualValue
  const displayValue = () => props.valueLabel ?? formatValue()
  
  const getAngle = () => {
    return valueToArcFraction(visualValue()) * KNOB_ARC_SWEEP_DEGREES + KNOB_ARC_START_DEGREES
  }

  const valueToArcFraction = (value: number) => {
    return valueToKnobFraction(
      value,
      props.min,
      props.max,
      props.logarithmic ?? false,
      props.zeroAwareLogarithmic ?? false,
    )
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
  const automationArcDashArray = () => {
    const range = props.automationRange
    if (!range) return '0 100'
    const start = valueToArcFraction(Math.min(range.min, range.max)) * 100
    const end = valueToArcFraction(Math.max(range.min, range.max)) * 100
    const visible = Math.max(0, end - start)
    return `${visible} ${100 - visible}`
  }
  const automationArcDashOffset = () => {
    const range = props.automationRange
    if (!range) return '0'
    return `${-valueToArcFraction(Math.min(range.min, range.max)) * 100}`
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

  const handleDoubleClick = () => {
    if (props.disabled) return
    
    control.setVisualValue(props.resetValue ?? (bipolar() ? (props.min + props.max) / 2 : props.min))
  }

  return (
    <div class={cn('flex flex-col items-center gap-0.5', props.class)}>
      <Show when={props.label}>
        <div class="text-xs font-medium leading-none text-muted-foreground">{props.visibleLabel ?? props.label}</div>
      </Show>
      
      <div
        role="slider"
        tabIndex={props.disabled ? undefined : 0}
        aria-label={props.ariaLabel ?? props.label ?? 'Knob'}
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
        onPointerDown={(event) => {
          if (props.disabled) return
          props.onAutomationSelect?.()
          control.onPointerDown(event)
        }}
        onKeyDown={control.handleKeyDown}
        onWheel={control.handleWheel}
        onDblClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        <Show when={props.automated}>
          <span class="absolute right-0 top-0 z-10 h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.75)]" />
        </Show>
        <svg
          class="absolute inset-1.5 h-full w-full"
          style={{ width: `${size()}px`, height: `${size()}px` }}
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <path
            class="stroke-border"
            d={KNOB_ARC_PATH}
            fill="none"
            stroke-width="4"
            stroke-linecap="round"
            pathLength="100"
          />
          <Show when={props.automationRange}>
            <path
              class="stroke-red-500"
              d={KNOB_ARC_PATH}
              fill="none"
              stroke-width="7"
              stroke-linecap="round"
              pathLength="100"
              stroke-dasharray={automationArcDashArray()}
              stroke-dashoffset={automationArcDashOffset()}
            />
          </Show>
          
          <path
            classList={{
              'stroke-sky-300': control.isDragging(),
              'stroke-cyan-400': !control.isDragging(),
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
              'stroke-sky-100': control.isDragging(),
              'stroke-foreground': !control.isDragging(),
            }}
            stroke-width="5"
            stroke-linecap="round"
            transform={`rotate(${getAngle()} 50 50)`}
          />
        </svg>
      </div>
      
      {props.showValue !== false && (
        <div
          class="max-w-full w-full whitespace-nowrap text-center font-mono leading-none text-foreground transition-colors duration-150"
          classList={{
            'text-[11px]': displayValue().length > 6,
            'text-xs': displayValue().length <= 6,
          }}
          style={{ 'word-spacing': '-0.18em' }}
        >
          {displayValue()}
        </div>
      )}
    </div>
  )
}
