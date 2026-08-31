import { describe, expect, test } from 'bun:test'

import type { Clip } from '@daw-browser/timeline-core/types'
import { getAudioWaveformLayout } from './audio-waveform-layout'

const clip = (patch: Partial<Clip<AudioBuffer>> = {}): Clip<AudioBuffer> => ({
  id: 'clip-1',
  name: 'Audio',
  startSec: 10,
  duration: 10,
  color: '#888888',
  sourceDurationSec: 10,
  sourceSampleRate: 48_000,
  sourceChannelCount: 2,
  ...patch,
})

describe('getAudioWaveformLayout viewport', () => {
  test('preserves the full-clip layout by default', () => {
    const layout = getAudioWaveformLayout(clip(), 1_000, 10, 120)

    expect(layout.visibleTimelineStartSec).toBe(10)
    expect(layout.visibleTimelineEndSec).toBe(20)
    expect(layout.padPx).toBe(0)
    expect(layout.drawCols).toBe(1_000)
    expect(layout.sourceStartSec).toBe(0)
    expect(layout.sourceEndSec).toBe(10)
  })

  test('maps a visible timeline subrange to the matching source window', () => {
    const layout = getAudioWaveformLayout(
      clip(),
      800,
      10,
      120,
      { startSec: 12, endSec: 16 },
    )

    expect(layout.visibleTimelineStartSec).toBe(12)
    expect(layout.visibleTimelineEndSec).toBe(16)
    expect(layout.padPx).toBe(0)
    expect(layout.drawCols).toBe(800)
    expect(layout.sourceStartSec).toBe(2)
    expect(layout.sourceEndSec).toBe(6)
  })

  test('keeps clip-leading silence positioned inside a partial viewport', () => {
    const layout = getAudioWaveformLayout(
      clip({ leftPadSec: 2 }),
      800,
      10,
      120,
      { startSec: 11, endSec: 13 },
    )

    expect(layout.visibleTimelineStartSec).toBe(11)
    expect(layout.visibleTimelineEndSec).toBe(13)
    expect(layout.padPx).toBe(400)
    expect(layout.drawCols).toBe(400)
    expect(layout.sourceStartSec).toBe(0)
    expect(layout.sourceEndSec).toBe(1)
  })

  test('returns an empty layout for an invalid visible range', () => {
    const layout = getAudioWaveformLayout(
      clip(),
      800,
      10,
      120,
      { startSec: 15, endSec: 15 },
    )

    expect(layout.drawCols).toBe(0)
  })
})
