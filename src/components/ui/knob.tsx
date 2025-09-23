import { createSignal, onMount, onCleanup } from 'solid-js'

export type KnobProps = {
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
  const [isDragging, setIsDragging] = createSignal(false)
  const [startY, setStartY] = createSignal(0)
  const [startValue, setStartValue] = createSignal(0)
  
  let knobRef: HTMLDivElement | undefined

  const size = () => props.size || 48
  const step = () => props.step || 0.1
  const bipolar = () => props.bipolar || false
  
  // Calculate angle based on value (270 degrees range, -135 to +135)
  const getAngle = () => {
    const { min, max, value } = props
    const normalizedValue = (value - min) / (max - min)
    const angle = normalizedValue * 270 - 135
    return Math.max(-135, Math.min(135, angle))
  }

  // Calculate value from angle
  const getValueFromAngle = (angle: number) => {
    const { min, max } = props
    const normalizedAngle = (angle + 135) / 270
    let value = min + normalizedAngle * (max - min)
    
    if (props.logarithmic) {
      // For frequency knobs - logarithmic scaling
      const logMin = Math.log10(min)
      const logMax = Math.log10(max)
      value = Math.pow(10, logMin + normalizedAngle * (logMax - logMin))
    }
    
    // Round to step
    const stepped = Math.round(value / step()) * step()
    return Math.max(min, Math.min(max, stepped))
  }

  // Format display value
  const formatValue = () => {
    const { value, unit = '' } = props
    
    if (props.logarithmic && value >= 1000) {
      return `${(value / 1000).toFixed(1)}k${unit}`
    }
    
    if (bipolar() && value > 0) {
      return `+${value.toFixed(1)}${unit}`
    }
    
    return `${value.toFixed(1)}${unit}`
  }

  const handleMouseDown = (event: MouseEvent) => {
    if (props.disabled) return
    
    event.preventDefault()
    event.stopPropagation()
    
    setIsDragging(true)
    setStartY(event.clientY)
    setStartValue(props.value)
    
    const handleMouseMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault()
      const deltaY = startY() - moveEvent.clientY
      const sensitivity = props.logarithmic ? 1.0 : 1.5
      
      let newValue: number
      
      if (props.logarithmic) {
        // Logarithmic scaling for frequency
        const normalizedStart = (startValue() - props.min) / (props.max - props.min)
        const logMin = Math.log10(props.min)
        const logMax = Math.log10(props.max)
        const logStart = logMin + normalizedStart * (logMax - logMin)
        const logNew = logStart + (deltaY * sensitivity * 0.005)
        newValue = Math.pow(10, Math.max(logMin, Math.min(logMax, logNew)))
      } else {
        // Linear scaling
        const range = props.max - props.min
        const deltaValue = (deltaY * sensitivity * range) / 150
        newValue = startValue() + deltaValue
      }
      
      // Clamp and round
      newValue = Math.max(props.min, Math.min(props.max, newValue))
      const stepped = Math.round(newValue / step()) * step()
      const finalValue = Math.max(props.min, Math.min(props.max, stepped))
      
      props.onValueChange(finalValue)
    }
    
    const handleMouseUp = (upEvent: MouseEvent) => {
      upEvent.preventDefault()
      setIsDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
    
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  // Cleanup on component unmount
  onCleanup(() => {
    setIsDragging(false)
  })

  const handleDoubleClick = () => {
    if (props.disabled) return
    
    // Reset to center for bipolar, to min for unipolar
    const resetValue = bipolar() ? (props.min + props.max) / 2 : props.min
    props.onValueChange(resetValue)
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
        ref={knobRef}
        class={`relative select-none ${props.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:scale-105'} transition-transform duration-100`}
        style={{ 
          width: `${size() + 12}px`, 
          height: `${size() + 12}px`,
          padding: '6px',
          'user-select': 'none',
          '-webkit-user-select': 'none',
          'touch-action': 'none'
        }}
        onMouseDown={handleMouseDown}
        onDblClick={handleDoubleClick}
        onContextMenu={(e) => e.preventDefault()}
        onDragStart={(e) => e.preventDefault()}
      >
        {/* Knob Background */}
        <div 
          class={`absolute inset-1.5 rounded-full border ${
            isDragging() 
              ? 'border-gray-300 bg-gray-700' 
              : 'border-gray-600 bg-gray-800'
          } transition-all duration-150`}
        />
        
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
            stroke="#374151"
            stroke-width="3"
            stroke-linecap="round"
          />
          
          {/* Value Arc */}
          <path
            d="M 15 75 A 35 35 0 1 1 85 75"
            fill="none"
            stroke={isDragging() ? "#d1d5db" : "#9ca3af"}
            stroke-width="3"
            stroke-linecap="round"
            stroke-dasharray="188.5"
            stroke-dashoffset={188.5 - Math.max(0, (getAngle() + 135) / 270) * 188.5}
            class="transition-all duration-75"
          />
        </svg>
        
        {/* Center Indicator */}
        <div 
          class={`absolute w-0.5 h-3 rounded-full transform -translate-x-1/2 origin-bottom transition-colors duration-150 ${
            isDragging() ? 'bg-gray-200' : 'bg-gray-400'
          }`}
          style={{ 
            top: '8px',
            left: '50%',
            transform: `translateX(-50%) rotate(${getAngle()}deg)`,
            'transform-origin': `50% ${size() / 2 + 1}px`
          }}
        />
        
        {/* Center Dot */}
        <div 
          class={`absolute top-1/2 left-1/2 w-1.5 h-1.5 rounded-full transform -translate-x-1/2 -translate-y-1/2 ${
            isDragging() ? 'bg-gray-200' : 'bg-gray-500'
          } transition-colors duration-150`}
        />
      </div>
      
      {/* Value Display */}
      {props.showValue !== false && (
        <div class={`text-xs font-mono text-center min-w-[3rem] ${
          isDragging() ? 'text-gray-200' : 'text-gray-400'
        } transition-colors duration-150`}>
          {formatValue()}
        </div>
      )}
    </div>
  )
}
