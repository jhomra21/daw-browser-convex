import { describe, expect, test } from 'bun:test'

import { getAudioWaveformLayout } from '~/lib/audio-waveform-layout'
import { PPS } from '~/lib/timeline-utils'

const createClip = (input) => ({
  id: 'clip',
  name: 'clip.wav',
  startSec: 10,
  duration: 4,
  sourceDurationSec: 4,
  color: '#fff',
  ...input,
})

describe('getAudioWaveformLayout', () => {
  test('matches playback timing for untrimmed clips', () => {
    expect(getAudioWaveformLayout(createClip({}), 400)).toEqual({
      sourceDurationSec: 4,
      padPx: 0,
      drawCols: 4 * PPS,
      audioStartPx: 0,
      audioEndPx: 4 * PPS,
      sourceStartSec: 0,
      sourceEndSec: 4,
    })
  })

  test('matches playback timing for left padding and buffer offsets', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          leftPadSec: 0.5,
          bufferOffsetSec: 1.25,
          duration: 2.5,
          sourceDurationSec: 5,
        }),
        250,
      ),
    ).toEqual({
      sourceDurationSec: 5,
      padPx: 0.5 * PPS,
      drawCols: 2 * PPS,
      audioStartPx: 0.5 * PPS,
      audioEndPx: 2.5 * PPS,
      sourceStartSec: 1.25,
      sourceEndSec: 3.25,
    })
  })

  test('clamps draw columns to available css width after left padding', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          duration: 4,
          sourceDurationSec: 5,
          bufferOffsetSec: 1,
          leftPadSec: 0.5,
        }),
        180,
      ),
    ).toEqual({
      sourceDurationSec: 5,
      padPx: 0.5 * PPS,
      drawCols: 130,
      audioStartPx: 0.5 * PPS,
      audioEndPx: 180,
      sourceStartSec: 1,
      sourceEndSec: 2.3,
    })
  })

  test('trims the source window to decoded duration', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          leftPadSec: 0.5,
          bufferOffsetSec: 1.25,
          duration: 2.5,
          sourceDurationSec: 5,
        }),
        250,
        2,
      ),
    ).toEqual({
      sourceDurationSec: 2,
      padPx: 0.5 * PPS,
      drawCols: 75,
      audioStartPx: 0.5 * PPS,
      audioEndPx: 125,
      sourceStartSec: 1.25,
      sourceEndSec: 2,
    })
  })

  test('prefers decoded buffer duration when it differs from metadata', () => {
    const clip = createClip({
      leftPadSec: 0.25,
      bufferOffsetSec: 2,
      duration: 4,
      sourceDurationSec: 10,
    })
    const layout = getAudioWaveformLayout(clip, 400, 3)

    expect(layout.sourceDurationSec).toBe(3)
    expect(layout.sourceStartSec).toBe(2)
    expect(layout.sourceEndSec).toBe(3)
    expect(layout.drawCols).toBe(PPS)
    expect(layout.audioStartPx).toBe(0.25 * PPS)
    expect(layout.audioEndPx).toBe(1.25 * PPS)
  })

  test('returns an empty draw window when playback has no audio', () => {
    const layout = getAudioWaveformLayout(
      createClip({
        leftPadSec: 5,
        duration: 2,
      }),
      200,
    )

    expect(layout.drawCols).toBe(0)
    expect(layout.audioStartPx).toBe(0)
    expect(layout.audioEndPx).toBe(0)
    expect(layout.sourceStartSec).toBe(0)
    expect(layout.sourceEndSec).toBe(0)
  })

  test('marks trailing silence when clip extends beyond source duration', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          duration: 6,
          sourceDurationSec: 4,
        }),
        600,
      ),
    ).toEqual({
      sourceDurationSec: 4,
      padPx: 0,
      drawCols: 4 * PPS,
      audioStartPx: 0,
      audioEndPx: 4 * PPS,
      sourceStartSec: 0,
      sourceEndSec: 4,
    })
  })

  test('marks leading and trailing silence from left padding', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          leftPadSec: 1,
          duration: 6,
          sourceDurationSec: 3,
        }),
        600,
      ),
    ).toEqual({
      sourceDurationSec: 3,
      padPx: PPS,
      drawCols: 3 * PPS,
      audioStartPx: PPS,
      audioEndPx: 4 * PPS,
      sourceStartSec: 0,
      sourceEndSec: 3,
    })
  })
})
