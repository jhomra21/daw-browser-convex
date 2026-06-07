import { getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'

type ExportPreset = {
  id: string
  name: string
  format: ExportAudioFormat
}

export const exportPresets: readonly ExportPreset[] = [
  { id: 'wav-mixdown', name: `${getExportAudioFormatMetadata('wav').label} Mixdown`, format: 'wav' },
  { id: 'mp3-mixdown', name: `${getExportAudioFormatMetadata('mp3').label} Mixdown`, format: 'mp3' },
]
