import { createSignal, onCleanup } from 'solid-js'

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
  
  const size = () => props.size || 48
  const step = () => props.step || 0.1
  const bipolar = () => props.bipolar || false
  
  // Calculate angle based on value (180 degrees range, -90 to +90)
  const getAngle = () => {
    const { min, max, value } = props
    const normalizedValue = (value - min) / (max - min)
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
    const { min, max, value } = props
    if (max === min) return 0
    return Math.max(0, Math.min(1, (value - min) / (max - min)))
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
        class={`relative select-none ${props.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} transition-transform duration-100`}
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
            stroke-linecap="round"
          />
          
          {/* Value Arc */}
          <path
            d="M 15 75 A 35 35 0 1 1 85 75"
            fill="none"
            stroke={isDragging() ? '#60a5fa' : '#38bdf8'}
            stroke-width="4"
            stroke-linecap="round"
            pathLength="100"
            stroke-dasharray={arcDashArray()}
            stroke-dashoffset={0}
            class="transition-all duration-75"
          />
        </svg>
        
        {/* Center Indicator */}
        <div 
          class={`absolute w-[2px] rounded-full transform -translate-x-1/2 origin-bottom transition-colors duration-150 ${
            isDragging() ? 'bg-sky-100' : 'bg-gray-200'
          }`}
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
        <div class={`text-xs font-mono text-center min-w-[3rem] ${
          isDragging() ? 'text-gray-200' : 'text-gray-400'
        } transition-colors duration-150`}>
          {formatValue()}
        </div>
      )}
    </div>
  )
}
