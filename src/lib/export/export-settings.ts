import type { ExportRange } from '@daw-browser/audio-engine/export-range'
import {
  normalizeExportNormalization,
  normalizeExportTailPolicy,
  normalizeWavEncodingSettings,
  type ExportNormalization,
  type ExportTailPolicy,
  type WavEncodingSettings,
} from '@daw-browser/audio-engine/export-fidelity'
import { isExportAudioFormat, isJsonBoolean, isJsonNumber, isJsonObject, type JsonValue, type LossyExportAudioFormat } from '@daw-browser/shared'
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

const normalizePersistedExportSettings = (value: JsonValue): PersistedExportSettings => {
  if (!isJsonObject(value)) return defaultExportSettings
  const render = isJsonObject(value.render) ? value.render : undefined
  const encoding = isJsonObject(value.encoding) ? value.encoding : undefined
  const legacyNormalize = render !== undefined && isJsonBoolean(render.normalize) && render.normalize
  const sampleRate = render?.sampleRate
  const numberOfChannels = render?.numberOfChannels
  const bitrateByFormat: Partial<Record<LossyExportAudioFormat, number>> = {}
  if (isJsonObject(encoding?.bitrateByFormat)) {
    for (const [format, bitrate] of Object.entries(encoding.bitrateByFormat)) {
      if (
        isExportAudioFormat(format)
        && (format === 'mp3' || format === 'ogg-opus')
        && isJsonNumber(bitrate)
        && Number.isFinite(bitrate)
      ) {
        bitrateByFormat[format] = bitrate
      }
    }
  }
  return {
    render: {
      sampleRate: sampleRate === 48000 || sampleRate === 96000 ? sampleRate : 44100,
      numberOfChannels: numberOfChannels === 1 ? 1 : 2,
      normalization: legacyNormalize
        ? { mode: 'sample-peak', targetDbfs: 0 }
        : normalizeExportNormalization(render?.normalization),
      tail: normalizeExportTailPolicy(render?.tail),
    },
    encoding: {
      bitrateByFormat,
      wav: normalizeWavEncodingSettings(encoding?.wav),
    },
  }
}

const EXPORT_SETTINGS_STORAGE_KEY = 'daw:export-settings:v2'

export const loadPersistedExportSettings = (): PersistedExportSettings => {
  if (!globalThis.localStorage) return defaultExportSettings
  try {
    const raw = globalThis.localStorage.getItem(EXPORT_SETTINGS_STORAGE_KEY)
    return raw ? normalizePersistedExportSettings(JSON.parse(raw)) : defaultExportSettings
  } catch {
    return defaultExportSettings
  }
}

export const savePersistedExportSettings = (settings: PersistedExportSettings): void => {
  if (!globalThis.localStorage) return
  globalThis.localStorage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
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