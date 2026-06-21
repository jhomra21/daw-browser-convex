import { createSignal } from 'solid-js'
import { useDrag } from '~/hooks/useDrag'
import { cn } from '~/lib/utils'

type KnobProps = {
  value: number
  min: number
  max: number
  step?: number
  size?: number
  label?: string
  unit?: string
  disabled?: boolean
  onValueChange: (value: number) => void
  logarithmic?: boolean
  bipolar?: boolean
  showValue?: boolean
}

export default function Knob(props: KnobProps) {
  const [dragValue, setDragValue] = createSignal<number | null>(null)
  let startY = 0
  let startValue = 0
  let lastEmittedValue = props.value
  
  const size = () => props.size ?? 36
  const step = () => props.step || 0.1
  const bipolar = () => props.bipolar || false
  const visualValue = () => dragValue() ?? props.value
  
  // Calculate angle based on value (180 degrees range, -90 to +90)
  const getAngle = () => {
    const value = visualValue()
    const normalizedValue = (value - props.min) / (props.max - props.min)
    const angle = normalizedValue * 180 - 90
    return Math.max(-90, Math.min(90, angle))
  }

  const arcRadiusPx = () => (size() / 100) * 35
  
  // Pointer geometry: keep the stick safely inside the arc
  const indicatorLength = () => Math.max(6, arcRadiusPx() - 10)
  // Arc center in the viewBox is at y=75 → in pixels: 6px padding + 0.75 * size()
  const pointerTop = () => 6 + size() * 0.75 - indicatorLength()

  // Directly from value range for a 0..1 fraction
  const arcFraction = () => {
    const value = visualValue()
    if (props.max === props.min) return 0
    return Math.max(0, Math.min(1, (value - props.min) / (props.max - props.min)))
  }
  
  // With pathLength="100", dasharray can use percentages
  const arcDashArray = () => {
    const fraction = arcFraction()
    const visible = Math.max(0, Math.min(100, fraction * 100))
    const hidden = 100 - visible
    return `${visible} ${hidden}`
  }


  // Format display value
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
        // Logarithmic scaling for frequency
        const normalizedStart = (startValue - props.min) / (props.max - props.min)
        const logMin = Math.log10(props.min)
        const logMax = Math.log10(props.max)
        const logStart = logMin + normalizedStart * (logMax - logMin)
        const logNew = logStart + (deltaY * sensitivity * 0.005)
        newValue = Math.pow(10, Math.max(logMin, Math.min(logMax, logNew)))
      } else {
        // Linear scaling
        const range = props.max - props.min
        const deltaValue = (deltaY * sensitivity * range) / 150
        newValue = startValue + deltaValue
      }
      
      // Clamp and round
      newValue = Math.max(props.min, Math.min(props.max, newValue))
      const stepped = Math.round(newValue / step()) * step()
      const finalValue = Math.max(props.min, Math.min(props.max, stepped))
      
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
    
    // Reset to center for bipolar, to min for unipolar
    const resetValue = bipolar() ? (props.min + props.max) / 2 : props.min
    lastEmittedValue = props.value
    setDragValue(resetValue)
    emitValue(resetValue)
    queueMicrotask(() => setDragValue(null))
  }

  return (
    <div class="flex flex-col items-center gap-1">
      {/* Label */}
      {props.label && (
        <div class="text-xs text-gray-400 font-medium">
          {props.label}
        </div>
      )}
      
      {/* Knob Container - Larger click area */}
      <div
        class={cn(
          'relative select-none transition-transform duration-100',
          props.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        )}
        style={{ 
          width: `${size() + 12}px`, 
          height: `${size() + 12}px`,
          padding: '6px',
          'user-select': 'none',
          '-webkit-user-select': 'none',
          'touch-action': 'none'
        }}
        onPointerDown={drag.onPointerDown}
        onDblClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        {/* Value Track (Background) */}
        <svg 
          class="absolute inset-1.5 w-full h-full"
          style={{ width: `${size()}px`, height: `${size()}px` }}
          viewBox="0 0 100 100"
        >
          {/* Background Arc */}
          <path
            d="M 15 75 A 35 35 0 1 1 85 75"
            fill="none"
            stroke="#1f2937"
            stroke-width="4"
          />
          
          {/* Value Arc */}
          <path
            d="M 15 75 A 35 35 0 1 1 85 75"
            fill="none"
            stroke={drag.isDragging() ? '#60a5fa' : '#38bdf8'}
            stroke-width="4"
            pathLength="100"
            stroke-dasharray={arcDashArray()}
            stroke-dashoffset={0}
          />
        </svg>
        
        {/* Center Indicator */}
        <div
          class={cn(
            'absolute w-0.5 -translate-x-1/2 transform origin-bottom',
            drag.isDragging() ? 'bg-sky-100' : 'bg-gray-200',
          )}
          style={{ 
            left: '50%',
            top: `${pointerTop()}px`,
            height: `${indicatorLength()}px`,
            transform: `translateX(-50%) rotate(${getAngle()}deg)`,
            'transform-origin': `center ${indicatorLength()}px`
          }}
        />
      </div>
      
      {/* Value Display */}
      {props.showValue !== false && (
        <div
          class={cn(
            'min-w-12 text-center font-mono text-xs transition-colors duration-150',
            drag.isDragging() ? 'text-gray-200' : 'text-gray-400',
          )}
        >
          {formatValue()}
        </div>
      )}
    </div>
  )
}
