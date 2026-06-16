import { describe, expect, test } from 'bun:test'

import {
  getAudioWaveformLayout,
  getSourceBeatOffsetAnchorX,
  getSourceBeatOffsetFromAnchorX,
} from '~/lib/audio-waveform-layout'
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

describe('source beat offset marker helpers', () => {
  test('maps beat offsets to the sample detail beat grid pixels', () => {
    expect(getSourceBeatOffsetAnchorX({
      sourceBeatOffset: 1,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
    })).toBe(120)
  })

  test('inverts sample detail beat grid pixels back to beat offsets', () => {
    expect(getSourceBeatOffsetFromAnchorX({
      anchorX: 120,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
      snap: true,
    })).toBe(1)
  })

  test('accounts for left padding when mapping marker position', () => {
    const x = getSourceBeatOffsetAnchorX({
      sourceBeatOffset: 1,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
      leftPadSec: 0.5,
    })

    expect(x).toBe(240)
    expect(getSourceBeatOffsetFromAnchorX({
      anchorX: x,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
      leftPadSec: 0.5,
      snap: true,
    })).toBe(1)
  })

  test('snaps before clamping and rounds drag offsets', () => {
    const readOffset = (beatOffset, snap) => getSourceBeatOffsetFromAnchorX({
      anchorX: beatOffset * 120,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
      snap,
    })

    expect(readOffset(1.13, true)).toBe(1.25)
    expect(readOffset(1.2345, false)).toBe(1.235)
    expect(readOffset(18.2, true)).toBe(16)
    expect(readOffset(-18.2, true)).toBe(-16)
  })

  test('uses project BPM for source beat offsets to match playback timing', () => {
    expect(getSourceBeatOffsetAnchorX({
      sourceBeatOffset: 1,
      clipDurationSec: 4,
      cssWidthPx: 960,
      projectBpm: 120,
    })).toBe(120)
  })
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

  test('scales draw bounds from css width instead of global timeline pixels', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          leftPadSec: 0.5,
          bufferOffsetSec: 1.25,
          duration: 2.5,
          sourceDurationSec: 5,
        }),
        1000,
      ),
    ).toEqual({
      sourceDurationSec: 5,
      padPx: 200,
      drawCols: 800,
      audioStartPx: 200,
      audioEndPx: 1000,
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
      padPx: 22,
      drawCols: 157,
      audioStartPx: 22,
      audioEndPx: 179,
      sourceStartSec: 1,
      sourceEndSec: 4.488888889,
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

  test('changes waveform density for warped clips', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          duration: 4,
          sourceDurationSec: 8,
          audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120 },
        }),
        400,
        undefined,
        60,
      ),
    ).toEqual({
      sourceDurationSec: 8,
      padPx: 0,
      drawCols: 4 * PPS,
      audioStartPx: 0,
      audioEndPx: 4 * PPS,
      sourceStartSec: 0,
      sourceEndSec: 2,
    })
  })

  test('aligns waveform to positive beat offset leading silence', () => {
    expect(
      getAudioWaveformLayout(
        createClip({
          duration: 4,
          sourceDurationSec: 8,
          audioWarp: { enabled: true, mode: 'repitch', sourceBpm: 120, sourceBeatOffset: 1 },
        }),
        400,
        undefined,
        120,
      ),
    ).toEqual({
      sourceDurationSec: 8,
      padPx: 0.5 * PPS,
      drawCols: 3.5 * PPS,
      audioStartPx: 0.5 * PPS,
      audioEndPx: 4 * PPS,
      sourceStartSec: 0,
      sourceEndSec: 3.5,
    })
  })

  test('segments marker warped waveforms by timeline marker density', () => {
    const layout = getAudioWaveformLayout(
      createClip({
        duration: 4,
        sourceDurationSec: 2,
        audioWarp: {
          enabled: true,
          mode: 'stretch',
          sourceBpm: 120,
          markers: [
            { id: 'a', sourceBeat: 0, timelineBeat: 0 },
            { id: 'b', sourceBeat: 1, timelineBeat: 4 },
            { id: 'c', sourceBeat: 4, timelineBeat: 8 },
          ],
        },
      }),
      400,
      undefined,
      120,
    )

    expect(layout.segments).toEqual([
      { drawCols: 200, sourceStartSec: 0, sourceEndSec: 0.5 },
      { drawCols: 200, sourceStartSec: 0.5, sourceEndSec: 2 },
    ])
  })
})
