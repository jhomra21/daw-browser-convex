import { minimumWaveformThicknessCssPx } from '@daw-browser/waveforms/draw-waveform-signal'
import type { WaveformDrawStyle } from '@daw-browser/waveforms/types'

export const resolveWaveformPaintStyle = (input: {
  readonly color: string
  readonly backingScaleY: number
  readonly pointRadius?: number
}): WaveformDrawStyle => ({
  fillStyle: input.color,
  maxHeightFraction: 0.9,
  minimumThicknessCssPx: minimumWaveformThicknessCssPx(input.backingScaleY),
  backingScaleY: input.backingScaleY,
  pointRadius: input.pointRadius,
})
