import type { ExportRange } from '@daw-browser/audio-engine/export-mixdown'
import type { ExportAudioFormat } from '@daw-browser/shared'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { TimelineRangeSelection } from '~/lib/timeline-range-selection'

export type ExportSampleRate = 44100 | 48000 | 96000

export type ExportRenderSettings = {
  sampleRate: ExportSampleRate
  numberOfChannels: 1 | 2
  normalize: boolean
}

export type ExportEncodingSettings = {
  bitrateByFormat: Partial<Record<'mp3' | 'ogg-opus', number>>
}

export const getExportRenderOptions = (settings: ExportRenderSettings) => ({
  sampleRate: settings.sampleRate,
  numberOfChannels: settings.numberOfChannels,
})

export const createCustomExportRange = (startSec: number, lengthSec: number): ExportRange => {
  const start = Math.max(0, Number.isFinite(startSec) ? startSec : 0)
  const length = Math.max(0.001, Number.isFinite(lengthSec) ? lengthSec : 0.001)
  return { mode: 'custom', startSec: start, endSec: start + length }
}

export const getExportRangeBounds = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
): { startSec: number; endSec: number } => {
  if (range.mode !== 'whole') {
    const startSec = Math.max(0, range.startSec)
    return {
      startSec,
      endSec: Math.max(startSec + 0.001, range.endSec),
    }
  }
  let endSec = 0.001
  for (const track of tracks) {
    for (const clip of track.clips) endSec = Math.max(endSec, clip.startSec + clip.duration)
  }
  return { startSec: 0, endSec }
}

export const getExportRangeDuration = (
  tracks: readonly RuntimeTrack[],
  range: ExportRange,
): number => {
  const bounds = getExportRangeBounds(tracks, range)
  return bounds.endSec - bounds.startSec
}

export const isRenderableExportTrack = (track: RuntimeTrack): boolean => (
  (track.channelRole ?? 'track') === 'track' && track.clips.length > 0
)

export const deriveSelectedExportTrackIds = (input: {
  tracks: readonly RuntimeTrack[]
  rangeSelection: TimelineRangeSelection | null
  selectedClipIds: ReadonlySet<string>
  primaryTrackId?: string
}): string[] => {
  let candidateIds: readonly string[]
  if (input.rangeSelection?.trackIds.length) {
    candidateIds = input.rangeSelection.trackIds
  } else if (input.selectedClipIds.size > 0) {
    const selectedTrackIds = new Set<string>()
    for (const track of input.tracks) {
      if (track.clips.some((clip) => input.selectedClipIds.has(clip.id))) selectedTrackIds.add(track.id)
    }
    candidateIds = [...selectedTrackIds]
  } else {
    candidateIds = input.primaryTrackId ? [input.primaryTrackId] : []
  }

  const candidates = new Set(candidateIds)
  return input.tracks
    .filter((track) => candidates.has(track.id) && isRenderableExportTrack(track))
    .map((track) => track.id)
}

export const getEncodingBitrate = (
  settings: ExportEncodingSettings,
  format: ExportAudioFormat,
): number | undefined => format === 'mp3' || format === 'ogg-opus'
  ? settings.bitrateByFormat[format]
  : undefined
