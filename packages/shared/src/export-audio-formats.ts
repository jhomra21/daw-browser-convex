export type ExportAudioFormat = 'wav' | 'mp3' | 'ogg-opus' | 'flac'

type ExportAudioFormatMetadata = {
  id: ExportAudioFormat
  label: string
  fileExtension: string
  mimeType: string
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
  },
  'ogg-opus': {
    id: 'ogg-opus',
    label: 'Ogg Opus',
    fileExtension: '.ogg',
    mimeType: 'audio/ogg',
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

export const formatExportFileTimestamp = (date: Date): string => (
  date.toISOString().replace(/[-:TZ.]/g, '')
)

export const isExportAudioFormat = (value: string): value is ExportAudioFormat => (
  exportAudioFormats.some((format) => format === value)
)
