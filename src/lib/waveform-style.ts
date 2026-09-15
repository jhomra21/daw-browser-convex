import type { WaveformDrawStyle } from '@daw-browser/waveforms/types'

export const resolveWaveformPaintStyle = (input: {
  readonly color: string
  readonly backingScaleY: number
  readonly pointRadius?: number
}): WaveformDrawStyle => ({
  fillStyle: input.color,
  maxHeightFraction: 0.9,
  minimumThicknessCssPx: 1 / Math.max(1, input.backingScaleY),
  backingScaleY: input.backingScaleY,
  pointRadius: input.pointRadius,
})
