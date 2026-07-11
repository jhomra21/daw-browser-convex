import type { ExportRange } from '@daw-browser/audio-engine/export-range'
import {
  normalizeExportNormalization,
  normalizeExportTailPolicy,
  normalizeWavEncodingSettings,
  type ExportNormalization,
  type ExportTailPolicy,
  type WavEncodingSettings,
} from '@daw-browser/audio-engine/export-fidelity'
import type { LossyExportAudioFormat } from '@daw-browser/shared'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { TimelineRangeSelection } from '~/lib/timeline-range-selection'

export type ExportSampleRate = 44100 | 48000 | 96000

export type ExportRenderSettings = {
  sampleRate: ExportSampleRate
  numberOfChannels: 1 | 2
  normalization: ExportNormalization
  tail: ExportTailPolicy
}

export type ExportEncodingSettings = {
  bitrateByFormat: Partial<Record<LossyExportAudioFormat, number>>
  wav: WavEncodingSettings
}

type PersistedExportSettings = {
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
}

const defaultExportSettings: PersistedExportSettings = {
  render: {
    sampleRate: 44100,
    numberOfChannels: 2,
    normalization: { mode: 'none' },
    tail: { mode: 'none' },
  },
  encoding: {
    bitrateByFormat: {},
    wav: { codec: 'pcm-s16', dither: 'none' },
  },
}

const normalizePersistedExportSettings = (value: unknown): PersistedExportSettings => {
  if (!value || typeof value !== 'object') return defaultExportSettings
  const render = Reflect.get(value, 'render')
  const encoding = Reflect.get(value, 'encoding')
  const legacyNormalize = render && typeof render === 'object' && Reflect.get(render, 'normalize') === true
  const sampleRate = render && typeof render === 'object' ? Reflect.get(render, 'sampleRate') : undefined
  const numberOfChannels = render && typeof render === 'object' ? Reflect.get(render, 'numberOfChannels') : undefined
  const bitrateByFormat = encoding && typeof encoding === 'object' ? Reflect.get(encoding, 'bitrateByFormat') : undefined
  return {
    render: {
      sampleRate: sampleRate === 48000 || sampleRate === 96000 ? sampleRate : 44100,
      numberOfChannels: numberOfChannels === 1 ? 1 : 2,
      normalization: legacyNormalize
        ? { mode: 'sample-peak', targetDbfs: 0 }
        : normalizeExportNormalization(render && typeof render === 'object' ? Reflect.get(render, 'normalization') : undefined),
      tail: normalizeExportTailPolicy(render && typeof render === 'object' ? Reflect.get(render, 'tail') : undefined),
    },
    encoding: {
      bitrateByFormat: bitrateByFormat && typeof bitrateByFormat === 'object' ? bitrateByFormat : {},
      wav: normalizeWavEncodingSettings(encoding && typeof encoding === 'object' ? Reflect.get(encoding, 'wav') : undefined),
    },
  }
}

const EXPORT_SETTINGS_STORAGE_KEY = 'daw:export-settings:v2'

export const loadPersistedExportSettings = (): PersistedExportSettings => {
  if (typeof localStorage === 'undefined') return defaultExportSettings
  try {
    const raw = localStorage.getItem(EXPORT_SETTINGS_STORAGE_KEY)
    return raw ? normalizePersistedExportSettings(JSON.parse(raw)) : defaultExportSettings
  } catch {
    return defaultExportSettings
  }
}

export const savePersistedExportSettings = (settings: PersistedExportSettings): void => {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

export const createCustomExportRange = (startSec: number, lengthSec: number): ExportRange => {
  const start = Math.max(0, Number.isFinite(startSec) ? startSec : 0)
  const length = Math.max(0.001, Number.isFinite(lengthSec) ? lengthSec : 0.001)
  return { mode: 'custom', startSec: start, endSec: start + length }
}

export const isRenderableExportTrack = (track: RuntimeTrack): boolean => (
  (track.channelRole ?? 'track') === 'track' && track.clips.length > 0
)

export const deriveSelectedExportTrackIds = (input: {
  tracks: readonly RuntimeTrack[]
  clipTrackIdById: ReadonlyMap<string, string>
  rangeSelection: TimelineRangeSelection | null
  selectedClipIds: ReadonlySet<string>
  primaryTrackId?: string
}): string[] => {
  let candidateIds: readonly string[]
  if (input.rangeSelection?.trackIds.length) {
    candidateIds = input.rangeSelection.trackIds
  } else if (input.selectedClipIds.size > 0) {
    candidateIds = [...input.selectedClipIds]
      .map((clipId) => input.clipTrackIdById.get(clipId))
      .filter((trackId): trackId is string => trackId !== undefined)
  } else {
    candidateIds = input.primaryTrackId ? [input.primaryTrackId] : []
  }

  const candidates = new Set(candidateIds)
  return input.tracks
    .filter((track) => candidates.has(track.id) && isRenderableExportTrack(track))
    .map((track) => track.id)
}