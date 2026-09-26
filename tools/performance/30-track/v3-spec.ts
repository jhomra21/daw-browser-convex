import { planThirtyTrackMixedRateSources } from './spec'

const pitches = [60, 64, 67, 71, 72, 67] as const

// Separate from the committed v2 archive. The v3 plan has exactly 30 total tracks.
export const planThirtyTrackV3 = () => ({
  version: '30-track-v3' as const,
  audio: planThirtyTrackMixedRateSources().slice(0, 24),
  instruments: Array.from({ length: 6 }, (_, instrumentIndex) => ({
    index: instrumentIndex + 24,
    notes: Array.from({ length: 16 }, (_, beat) => ({
      beat,
      length: 0.75,
      pitch: pitches[(beat + instrumentIndex) % pitches.length]!,
      velocity: 0.5,
    })),
  })),
})
