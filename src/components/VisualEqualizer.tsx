import { Show, createSignal, createMemo, createEffect, onMount, onCleanup } from 'solid-js'
import { Button } from '~/components/ui/button'
import Knob from '~/components/ui/knob'

// EQ band configuration types
export type EQBand = {
  id: string
  frequency: number
  gain: number
  type: BiquadFilterType
  color: string
  enabled: boolean
  Q: number
}

// Default EQ band configuration (8 bands max)
export const createDefaultEQBands = (): EQBand[] => [
  { id: 'band-1', frequency: 20, gain: 0, type: 'lowshelf', color: '#ef4444', enabled: true, Q: 0.7 },
  { id: 'band-2', frequency: 60, gain: 0, type: 'peaking', color: '#f97316', enabled: true, Q: 1.0 },
  { id: 'band-3', frequency: 200, gain: 0, type: 'peaking', color: '#eab308', enabled: true, Q: 1.0 },
  { id: 'band-4', frequency: 500, gain: 0, type: 'peaking', color: '#84cc16', enabled: true, Q: 1.0 },
  { id: 'band-5', frequency: 1000, gain: 0, type: 'peaking', color: '#22c55e', enabled: true, Q: 1.0 },
  { id: 'band-6', frequency: 3000, gain: 0, type: 'peaking', color: '#06b6d4', enabled: true, Q: 1.0 },
  { id: 'band-7', frequency: 8000, gain: 0, type: 'peaking', color: '#3b82f6', enabled: true, Q: 1.0 },
  { id: 'band-8', frequency: 20000, gain: 0, type: 'highshelf', color: '#8b5cf6', enabled: true, Q: 0.7 }
]

// Available colors for bands
export const BAND_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#84cc16',
  '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6'
]

// Available filter types
export const FILTER_TYPES: { value: BiquadFilterType; label: string }[] = [
  { value: 'lowshelf', label: 'Low Shelf' },
  { value: 'peaking', label: 'Peaking' },
  { value: 'highshelf', label: 'High Shelf' },
  { value: 'lowpass', label: 'Low Pass' },
  { value: 'highpass', label: 'High Pass' },
  { value: 'bandpass', label: 'Band Pass' },
  { value: 'notch', label: 'Notch' }
]

export type EQProps = {
  bands: EQBand[]
  onBandChange: (bandId: string, updates: Partial<EQBand>) => void
  onBandToggle: (bandId: string) => void
  onReset: () => void
  enabled: boolean
  spectrumData?: Float32Array | null
  isPlaying?: boolean
}

export default function VisualEqualizer(props: EQProps) {
  const [draggedBand, setDraggedBand] = createSignal<string | null>(null)
  const [canvasSize, setCanvasSize] = createSignal({ width: 600, height: 300 })
  const [selectedBand, setSelectedBand] = createSignal<string | null>(props.bands[0]?.id || null)
  const [showDetails, setShowDetails] = createSignal(false)

  // Asymmetric horizontal padding: small left, larger right (avoid clipping at 20k)
  const L_PAD = 8  // px
  const R_PAD = 8 // px

  // Get the currently selected band
  const currentBand = createMemo(() => {
    const bandId = selectedBand()
    return bandId ? props.bands.find(band => band.id === bandId) : null
  })

  let canvasRef: HTMLCanvasElement | undefined
  let containerRef: HTMLDivElement | undefined
  let graphContainerRef: HTMLDivElement | undefined

  onMount(() => {
    // Set initial canvas size
    if (graphContainerRef) {
      const rect = graphContainerRef.getBoundingClientRect()
      setCanvasSize({
        width: Math.max(400, Math.floor(rect.width)),
        height: 300
      })

      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry) {
          setCanvasSize({
            width: Math.max(400, Math.floor(entry.contentRect.width)),
            height: 300
          })
        }
      })

      resizeObserver.observe(graphContainerRef)

      onCleanup(() => resizeObserver.disconnect())
    }

    // Initial draw with a small delay to ensure canvas is ready
    setTimeout(() => {
      drawEQCurve()
    }, 100)
  })

  // Convert frequency to x-coordinate
  const freqToX = (freq: number) => {
    const minFreq = Math.log10(20)
    const maxFreq = Math.log10(20000)
    const logFreq = Math.log10(freq)
    const { width } = canvasSize()
    const inner = Math.max(0, width - (L_PAD + R_PAD))
    return L_PAD + ((logFreq - minFreq) / (maxFreq - minFreq)) * inner
  }

  // Convert gain to y-coordinate  
  const gainToY = (gain: number) => {
    const maxGain = 50
    const minGain = -50
    return ((maxGain - gain) / (maxGain - minGain)) * canvasSize().height
  }

  // Convert y-coordinate back to gain
  const yToGain = (y: number) => {
    const maxGain = 50
    const minGain = -50
    return maxGain - (y / canvasSize().height) * (maxGain - minGain)
  }

  // Convert x-coordinate back to frequency
  const xToFreq = (x: number) => {
    const { width } = canvasSize()
    const inner = Math.max(1, width - (L_PAD + R_PAD))
    const minFreq = Math.log10(20)
    const maxFreq = Math.log10(20000)
    // Clamp to padded graph area
    const clampedX = Math.min(Math.max(x, L_PAD), width - R_PAD)
    const t = (clampedX - L_PAD) / inner
    const logFreq = minFreq + t * (maxFreq - minFreq)
    return Math.pow(10, logFreq)
  }

  // Draw the EQ frequency response curve
  const drawEQCurve = () => {
    if (!canvasRef) return

    const ctx = canvasRef.getContext('2d')
    if (!ctx) return

    const { width, height } = canvasSize()

    // Ensure canvas dimensions are properly set
    if (canvasRef.width !== width || canvasRef.height !== height) {
      canvasRef.width = width
      canvasRef.height = height
    }

    // Clear canvas with dark background
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, width, height)

    // Draw grid
    ctx.strokeStyle = '#333333'
    ctx.lineWidth = 1

    // Horizontal grid lines (gain levels)
    for (let gain = -50; gain <= 50; gain += 10) {
      const y = gainToY(gain)
      ctx.beginPath()
      ctx.moveTo(L_PAD, y)
      ctx.lineTo(width - R_PAD, y)
      ctx.stroke()

      // Add gain labels
      ctx.fillStyle = '#666666'
      ctx.font = '10px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`${gain > 0 ? '+' : ''}${gain}dB`, L_PAD + 5, y - 2)
    }

    // Vertical grid lines (frequency markers)
    const freqMarkers = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
    freqMarkers.forEach(freq => {
      const x = freqToX(freq)
      // Only draw grid lines that are within the padded canvas bounds
      if (x >= L_PAD && x <= width - R_PAD) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, height)
        ctx.stroke()

        // Add frequency labels
        ctx.fillStyle = '#666666'
        ctx.font = '10px monospace'
        ctx.textAlign = 'center'
        const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`
        ctx.fillText(label, x, height - 5)
      }
    })

    // Draw zero line more prominently
    ctx.strokeStyle = '#555555'
    ctx.lineWidth = 2
    const zeroY = gainToY(0)
    ctx.beginPath()
    ctx.moveTo(L_PAD, zeroY)
    ctx.lineTo(width - R_PAD, zeroY)
    ctx.stroke()

    // Draw real-time spectrum analysis behind EQ curve (Ableton-style)
    if (props.spectrumData && props.isPlaying) {
      const spectrum = props.spectrumData

      // Create horizontal gradient that spans inner width
      const spectrumGradient = ctx.createLinearGradient(L_PAD, 0, width - R_PAD, 0)
      spectrumGradient.addColorStop(0, '#22c55e') // Green for bass
      spectrumGradient.addColorStop(0.2, '#84cc16') // Light green
      spectrumGradient.addColorStop(0.4, '#eab308') // Yellow for mids
      spectrumGradient.addColorStop(0.6, '#f97316') // Orange
      spectrumGradient.addColorStop(0.8, '#ef4444') // Red for highs
      spectrumGradient.addColorStop(1, '#dc2626') // Dark red

      // Draw smooth spectrum fill using logarithmic frequency mapping
      ctx.beginPath()
      ctx.moveTo(L_PAD, height) // Start at bottom-left (padded)

      // Sample spectrum data with logarithmic spacing for better frequency representation
      for (let x = L_PAD; x <= width - R_PAD; x += 2) {
        // Map x position to logarithmic frequency (20Hz to 20kHz)
        const inner = Math.max(1, width - (L_PAD + R_PAD))
        const freqRatio = (x - L_PAD) / inner
        const minFreq = 20
        const maxFreq = 20000
        const logFreq = minFreq * Math.pow(maxFreq / minFreq, freqRatio)

        // Map frequency to spectrum bin
        const nyquist = 22050 // Assuming 44.1kHz sample rate
        const binIndex = Math.floor((logFreq / nyquist) * spectrum.length)
        const safeIndex = Math.min(binIndex, spectrum.length - 1)

        // Get magnitude and smooth it
        let magnitude = spectrum[safeIndex] || 0

        // Apply some smoothing by averaging nearby bins
        if (safeIndex > 0 && safeIndex < spectrum.length - 1) {
          magnitude = (spectrum[safeIndex - 1] + spectrum[safeIndex] + spectrum[safeIndex + 1]) / 3
        }

        // Scale magnitude and create smooth curve
        const scaledMagnitude = Math.pow(magnitude, 0.7) // Gentle compression for better visibility
        const y = height - (scaledMagnitude * height * 0.5) // Use 50% of height

        ctx.lineTo(x, y)
      }

      // Complete the path to create a filled area
      ctx.lineTo(width - R_PAD, height) // Bottom-right (padded)
      ctx.closePath()

      // Fill with gradient and low opacity for subtle effect
      ctx.globalAlpha = 0.3
      ctx.fillStyle = spectrumGradient
      ctx.fill()

      // Add a subtle top line
      ctx.globalAlpha = 0.6
      ctx.strokeStyle = spectrumGradient
      ctx.lineWidth = 1
      ctx.stroke()

      // Reset alpha
      ctx.globalAlpha = 1
    }

    // Draw EQ response curve
    if (props.enabled) {
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 3
      ctx.beginPath()

      // Sample points along frequency spectrum
      for (let x = L_PAD; x <= width - R_PAD; x += 2) {
        const inner = Math.max(1, width - (L_PAD + R_PAD))
        const ratio = (x - L_PAD) / inner
        const freq = 20 * Math.pow(1000, ratio) // Log scale from 20Hz to 20kHz
        let totalGain = 0

        // Calculate combined effect of all enabled EQ bands at this frequency
        props.bands.forEach((band) => {
          if (band.enabled && Math.abs(band.gain) > 0.1) {
            // Simplified frequency response calculation
            const freqRatio = freq / band.frequency
            let response = 0

            if (band.type === 'lowshelf') {
              response = freq <= band.frequency ? band.gain : band.gain * Math.exp(-Math.pow(Math.log(freqRatio), 2))
            } else if (band.type === 'highshelf') {
              response = freq >= band.frequency ? band.gain : band.gain * Math.exp(-Math.pow(Math.log(freqRatio), 2))
            } else { // peaking
              response = band.gain * Math.exp(-Math.pow(Math.log(freqRatio) * band.Q, 2))
            }

            totalGain += response
          }
        })

        const y = gainToY(totalGain)

        if (x === L_PAD) {
          ctx.moveTo(x, y)
        } else {
          ctx.lineTo(x, y)
        }
      }

      ctx.stroke()
    }

    // Draw EQ band control points
    props.bands.forEach((band) => {
      if (!band.enabled) return // Skip disabled bands

      const x = freqToX(band.frequency)
      const y = gainToY(band.gain)
      const isDragging = draggedBand() === band.id

      // Draw band influence area (subtle)
      if (props.enabled && Math.abs(band.gain) > 0.1) {
        ctx.fillStyle = band.color + (isDragging ? '40' : '20')
        ctx.beginPath()
        const radius = isDragging ? 50 : 40
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      // Draw control point
      const isSelected = selectedBand() === band.id
      ctx.fillStyle = props.enabled ? (isSelected ? '#3b82f6' : band.color) : '#666666'
      ctx.strokeStyle = isDragging ? '#ffff00' : isSelected ? '#1d4ed8' : '#ffffff'
      ctx.lineWidth = isDragging ? 3 : isSelected ? 2 : 1
      ctx.beginPath()
      const radius = isDragging ? 8 : isSelected ? 7 : 6
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      // Draw gain value for selected band only
      if (isSelected && Math.abs(band.gain) > 0.1) {
        ctx.fillStyle = '#ffffff'
        ctx.font = '10px monospace'
        ctx.textAlign = 'center'
        const gainText = `${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)}`
        ctx.fillText(gainText, x, y - 12)
      }

      // Draw frequency label for selected band only
      if (isSelected) {
        ctx.fillStyle = '#cccccc'
        ctx.font = '9px monospace'
        ctx.textAlign = 'center'
        const freqLabel = band.frequency >= 1000 ? `${(band.frequency / 1000).toFixed(1)}k` : `${band.frequency}`
        ctx.fillText(freqLabel, x, y + 18)
      }
    })
  }

  // Handle mouse interactions on canvas
  const handleCanvasMouseDown = (event: MouseEvent) => {
    if (!props.enabled) return

    const rect = canvasRef!.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    // Find closest enabled band
    let closestBandId: string | null = null
    let minDistance = Infinity

    props.bands.forEach((band) => {
      if (!band.enabled) return

      const bandX = freqToX(band.frequency)
      const bandY = gainToY(band.gain)
      const distance = Math.sqrt(Math.pow(x - bandX, 2) + Math.pow(y - bandY, 2))

      if (distance < 30 && distance < minDistance) {
        minDistance = distance
        closestBandId = band.id
      }
    })

    if (closestBandId) {
      setSelectedBand(closestBandId)
      setDraggedBand(closestBandId)
      // Start with both gain and frequency adjustments on mouse down
      const newGain = Math.max(-50, Math.min(50, yToGain(y)))
      const newFreq = Math.max(20, Math.min(20000, xToFreq(x)))

      props.onBandChange(closestBandId, {
        gain: parseFloat(newGain.toFixed(1)),
        frequency: Math.round(newFreq)
      })
    }
  }

  const handleCanvasMouseMove = (event: MouseEvent) => {
    if (draggedBand() === null || !props.enabled) return

    const rect = canvasRef!.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    // Update both gain and frequency simultaneously
    const newGain = Math.max(-50, Math.min(50, yToGain(y)))
    const newFreq = Math.max(20, Math.min(20000, xToFreq(x)))

    props.onBandChange(draggedBand()!, {
      gain: parseFloat(newGain.toFixed(1)),
      frequency: Math.round(newFreq)
    })
  }

  const handleCanvasMouseUp = () => {
    setDraggedBand(null)
  }

  // Redraw when bands change
  createEffect(() => {
    props.bands // Track changes
    if (canvasRef) {
      drawEQCurve()
    }
  })

  // Redraw when dragged band changes (for visual feedback)
  createEffect(() => {
    draggedBand() // Track dragged band changes
    if (canvasRef) {
      drawEQCurve()
    }
  })

  // Redraw when canvas size changes
  createEffect(() => {
    canvasSize() // Track size changes
    if (canvasRef) {
      // Small delay to ensure canvas has updated its dimensions
      setTimeout(() => drawEQCurve(), 10)
    }
  })

  // Effect to handle initial render and enabled state changes
  createEffect(() => {
    if (props.enabled && canvasRef) {
      // Ensure canvas is drawn when enabled
      setTimeout(() => drawEQCurve(), 100)
    }
  })

  // Effect to redraw when spectrum data changes (real-time updates)
  createEffect(() => {
    props.spectrumData // Track spectrum data changes
    props.isPlaying // Track playing state changes
    if (canvasRef && props.enabled) {
      drawEQCurve()
    }
  })

  return (
    <div ref={containerRef} class="border rounded-lg p-4 bg-[#1a1a1a] text-white">
      <div class="flex items-center justify-between mb-4">
        <div class="flex flex-col gap-1">
          <h4 class="font-semibold text-sm flex items-center gap-2">
            🎛️ Visual Equalizer
            <Show when={!props.enabled}>
              <span class="text-xs text-gray-400">(Disabled)</span>
            </Show>
            <Show when={props.enabled && props.isPlaying && props.spectrumData}>
              <span class="text-xs text-green-400 animate-pulse">● Live Spectrum</span>
            </Show>
          </h4>
          <Show when={props.enabled}>
            <div class="text-xs text-gray-400">
              Click any node to select, drag to adjust frequency and gain
            </div>
          </Show>
        </div>

        <div class="flex gap-2">
          <Button
            onClick={() => setShowDetails(!showDetails())}
            variant="outline"
            size="sm"
            disabled={!props.enabled}
          >
            {showDetails() ? 'Hide Details' : 'More Details'}
          </Button>
          <Button onClick={props.onReset} variant="outline" size="sm" disabled={!props.enabled}>
            Reset
          </Button>
        </div>
      </div>

      {/* EQ Canvas with Left Controls */}
      <div class="flex gap-2 mb-4">
        {/* Left Side - Selected Band Controls */}
        <Show when={props.enabled}>
          <div class="flex-shrink-0 flex flex-col items-center space-y-3 pt-2 w-16">
            {/* Filter Type Selector */}
            <div class="w-full">
              <select
                value={currentBand()?.type || 'peaking'}
                onChange={(e) => currentBand() && props.onBandChange(currentBand()!.id, { type: e.target.value as BiquadFilterType })}
                disabled={!currentBand()?.enabled}
                class="w-full text-xs bg-gray-900 border border-gray-600 rounded px-1 py-1 text-gray-200 disabled:opacity-50 text-center focus:border-gray-500 focus:outline-none"
              >
                {FILTER_TYPES.map((filterType) => (
                  <option value={filterType.value}>
                    {filterType.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Main Control Knobs */}
            <div class="space-y-3">
              {/* Frequency Knob */}
              <div class="flex flex-col items-center space-y-1">
                <div class="text-xs text-gray-400">FREQ</div>
                <Knob
                  value={currentBand()?.frequency || 1000}
                  min={20}
                  max={20000}
                  step={1}
                  size={36}
                  label=""
                  unit="Hz"
                  disabled={!currentBand()?.enabled}
                  logarithmic={true}
                  onValueChange={(value) => currentBand() && props.onBandChange(currentBand()!.id, { frequency: Math.round(value) })}
                />
              </div>

              {/* Gain Knob */}
              <div class="flex flex-col items-center space-y-1">
                <div class="text-xs text-gray-400">GAIN</div>
                <Knob
                  value={currentBand()?.gain || 0}
                  min={-50}
                  max={50}
                  step={0.1}
                  size={36}
                  label=""
                  unit="dB"
                  disabled={!currentBand()?.enabled}
                  bipolar={true}
                  onValueChange={(value) => currentBand() && props.onBandChange(currentBand()!.id, { gain: parseFloat(value.toFixed(1)) })}
                />
              </div>

              {/* Q Knob */}
              <div class="flex flex-col items-center space-y-1">
                <div class="text-xs text-gray-400">Q</div>
                <Knob
                  value={currentBand()?.Q || 1.0}
                  min={0.1}
                  max={30}
                  step={0.1}
                  size={36}
                  label=""
                  disabled={!currentBand()?.enabled}
                  onValueChange={(value) => currentBand() && props.onBandChange(currentBand()!.id, { Q: parseFloat(value.toFixed(1)) })}
                />
              </div>
            </div>

            {/* Band Enable Toggle */}
            <div class="flex items-center justify-center">
              <button
                onClick={() => currentBand() && props.onBandToggle(currentBand()!.id)}
                class={`w-4 h-4 rounded border transition-all duration-200 ${currentBand()?.enabled
                  ? 'border-gray-400 bg-gray-400'
                  : 'border-gray-600 bg-transparent hover:border-gray-500'
                  }`}
                title={currentBand()?.enabled ? 'Disable band' : 'Enable band'}
              >
                {currentBand()?.enabled && (
                  <div class="w-full h-full flex items-center justify-center text-black text-xs font-bold">✓</div>
                )}
              </button>
            </div>
          </div>
        </Show>

        {/* EQ Canvas */}
        <div ref={graphContainerRef} class="relative flex-1 overflow-hidden rounded">
          <canvas
            ref={(el) => {
              canvasRef = el
              // Draw immediately when canvas is mounted and EQ is enabled
              if (el && props.enabled) {
                // Use requestAnimationFrame for better timing
                requestAnimationFrame(() => {
                  setTimeout(() => drawEQCurve(), 10)
                })
              }
            }}
            width={canvasSize().width}
            height={canvasSize().height}
            class={`!rounded-lg ${props.enabled ? 'cursor-crosshair' : 'cursor-not-allowed opacity-50'}`}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          />

          <Show when={!props.enabled}>
            <div class="absolute inset-0 flex items-center justify-center bg-black/50 rounded">
              <span class="text-white text-sm">Enable EQ to interact</span>
            </div>
          </Show>
        </div>
      </div>

      {/* Preset Buttons */}
      <Show when={props.enabled}>
        <div class="space-y-4">
          <div class="text-xs text-gray-400">Quick Presets:</div>
          <div class="flex gap-2 flex-wrap">
            <Button
              onClick={() => {
                const bassBoost = [4, 2, 1, 0, 0, 0, 0, 0]
                props.bands.forEach((band, i) => {
                  if (i < bassBoost.length) {
                    props.onBandChange(band.id, { gain: bassBoost[i] })
                  }
                })
              }}
              variant="outline"
              size="sm"
              disabled={!props.enabled}
              class="bg-gray-800/50 border-gray-600/50 hover:bg-gray-700/50 text-gray-300"
            >
              Bass Boost
            </Button>
            <Button
              onClick={() => {
                const vocal = [-1, 0, 2, 3, 2, 1, -1, -2]
                props.bands.forEach((band, i) => {
                  if (i < vocal.length) {
                    props.onBandChange(band.id, { gain: vocal[i] })
                  }
                })
              }}
              variant="outline"
              size="sm"
              disabled={!props.enabled}
              class="bg-gray-800/50 border-gray-600/50 hover:bg-gray-700/50 text-gray-300"
            >
              Vocal Enhance
            </Button>
            <Button
              onClick={() => {
                const treble = [0, 0, 0, 0, 1, 2, 3, 2]
                props.bands.forEach((band, i) => {
                  if (i < treble.length) {
                    props.onBandChange(band.id, { gain: treble[i] })
                  }
                })
              }}
              variant="outline"
              size="sm"
              disabled={!props.enabled}
              class="bg-gray-800/50 border-gray-600/50 hover:bg-gray-700/50 text-gray-300"
            >
              Bright
            </Button>
            <Button
              onClick={() => {
                const warm = [1, 1, 0, 0, -1, -1, 0, 0]
                props.bands.forEach((band, i) => {
                  if (i < warm.length) {
                    props.onBandChange(band.id, { gain: warm[i] })
                  }
                })
              }}
              variant="outline"
              size="sm"
              disabled={!props.enabled}
              class="bg-gray-800/50 border-gray-600/50 hover:bg-gray-700/50 text-gray-300"
            >
              Warm
            </Button>
          </div>
        </div>
      </Show>

      {/* Detailed View - Ableton Style Vertical Bands */}
      <Show when={showDetails() && props.enabled}>
        <div class="mt-6 pt-4 border-t border-gray-600">
          <div class="text-xs text-gray-400 mb-4 text-center">
            All Band Controls
          </div>

          {/* Vertical Band Layout like Ableton EQ Eight */}
          <div class="grid grid-cols-8 gap-2">
            {props.bands.map((band, index) => (
              <div class="flex flex-col items-center space-y-2">
                {/* Band Number */}
                <div class={`w-6 h-6 rounded text-xs flex items-center justify-center font-bold ${band.enabled ? 'bg-blue-500 text-white' : 'bg-gray-600 text-gray-300'
                  }`}>
                  {index + 1}
                </div>

                {/* Frequency Control */}
                <div class="flex flex-col items-center space-y-1">
                  <div class="text-xs text-gray-400">Freq</div>
                  <Knob
                    value={band.frequency}
                    min={20}
                    max={20000}
                    step={1}
                    size={50}
                    label=""
                    unit="Hz"
                    disabled={!band.enabled}
                    logarithmic={true}
                    onValueChange={(value) => props.onBandChange(band.id, { frequency: Math.round(value) })}
                  />
                  <div class="text-xs text-gray-300 text-center">
                    {band.frequency < 1000 ? `${band.frequency} Hz` : `${(band.frequency / 1000).toFixed(1)} kHz`}
                  </div>
                </div>

                {/* Gain Control */}
                <div class="flex flex-col items-center space-y-1">
                  <div class="text-xs text-gray-400">Gain</div>
                  <Knob
                    value={band.gain}
                    min={-50}
                    max={50}
                    step={0.1}
                    size={50}
                    label=""
                    unit="dB"
                    disabled={!band.enabled}
                    bipolar={true}
                    onValueChange={(value) => props.onBandChange(band.id, { gain: parseFloat(value.toFixed(1)) })}
                  />
                  <div class="text-xs text-gray-300 text-center">
                    {band.gain >= 0 ? '+' : ''}{band.gain.toFixed(1)} dB
                  </div>
                </div>

                {/* Q Control */}
                <div class="flex flex-col items-center space-y-1">
                  <div class="text-xs text-gray-400">Q</div>
                  <Knob
                    value={band.Q}
                    min={0.1}
                    max={30}
                    step={0.1}
                    size={50}
                    label=""
                    disabled={!band.enabled}
                    onValueChange={(value) => props.onBandChange(band.id, { Q: parseFloat(value.toFixed(1)) })}
                  />
                  <div class="text-xs text-gray-300 text-center">
                    {band.Q.toFixed(1)}
                  </div>
                </div>

                {/* Band Controls Row */}
                <div class="flex space-x-1">
                  {/* Enable Toggle */}
                  <button
                    onClick={() => props.onBandToggle(band.id)}
                    class={`w-4 h-4 rounded border transition-all duration-200 ${band.enabled
                      ? 'border-gray-400 bg-gray-400'
                      : 'border-gray-600 bg-transparent hover:border-gray-500'
                      }`}
                    title={band.enabled ? 'Disable band' : 'Enable band'}
                  >
                    {band.enabled && (
                      <div class="w-full h-full flex items-center justify-center text-black text-xs font-bold">✓</div>
                    )}
                  </button>

                  {/* Filter Type Icon */}
                  <div class="w-4 h-4 flex items-center justify-center text-xs text-gray-400">
                    {band.type === 'lowshelf' ? 'L' :
                      band.type === 'highshelf' ? 'H' :
                        band.type === 'peaking' ? 'P' : '?'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Show>
    </div>
  )
}
