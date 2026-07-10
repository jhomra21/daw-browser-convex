export type ExportAudioFormat = 'wav' | 'mp3' | 'ogg-opus' | 'flac'

type ExportAudioFormatMetadata = {
  id: ExportAudioFormat
  label: string
  fileExtension: string
  mimeType: string
  bitratePresets?: readonly number[]
  defaultBitrate?: number
}

export const exportAudioFormats: readonly ExportAudioFormat[] = ['wav', 'mp3', 'ogg-opus', 'flac']

const exportAudioFormatMetadata: Record<ExportAudioFormat, ExportAudioFormatMetadata> = {
  wav: {
    id: 'wav',
    label: 'WAV',
    fileExtension: '.wav',
    mimeType: 'audio/wav',
  },
  mp3: {
    id: 'mp3',
    label: 'MP3',
    fileExtension: '.mp3',
    mimeType: 'audio/mpeg',
    bitratePresets: [128000, 192000, 256000, 320000],
    defaultBitrate: 192000,
  },
  'ogg-opus': {
    id: 'ogg-opus',
    label: 'Ogg Opus',
    fileExtension: '.ogg',
    mimeType: 'audio/ogg',
    bitratePresets: [64000, 96000, 128000, 160000, 192000],
    defaultBitrate: 128000,
  },
  flac: {
    id: 'flac',
    label: 'FLAC',
    fileExtension: '.flac',
    mimeType: 'audio/flac',
  },
}

export const getExportAudioFormatMetadata = (format: ExportAudioFormat): ExportAudioFormatMetadata => {
  return exportAudioFormatMetadata[format]
}

export const getExportAudioBitrate = (format: ExportAudioFormat): number | undefined => (
  exportAudioFormatMetadata[format].defaultBitrate
)

export const formatExportFileTimestamp = (date: Date): string => (
  date.toISOString().replace(/[-:TZ.]/g, '')
)

export const isExportAudioFormat = (value: string): value is ExportAudioFormat => (
  exportAudioFormats.some((format) => format === value)
)
