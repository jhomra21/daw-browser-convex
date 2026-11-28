import { type ExportAudioFormat, formatExportFileTimestamp, getExportAudioFormatMetadata } from '@daw-browser/shared'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'
import type { ExportPhase, TimelineExportRequest } from '~/lib/export/export-job-types'

const ENCODING_PROGRESS_STEP_BYTES = 256 * 1024

export const createExportSeed = () => {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)

  return values[0]
}

export const createEncodingProgressReporter = (
  report: (sizeBytes: number) => void,
): ((sizeBytes: number) => void) => {
  let lastReportedBytes = 0

  return (sizeBytes) => {
    if (sizeBytes - lastReportedBytes < ENCODING_PROGRESS_STEP_BYTES) return
    lastReportedBytes = sizeBytes
    report(sizeBytes)
  }
}

export const requireExportFormats = (formats: readonly ExportAudioFormat[]): readonly ExportAudioFormat[] => {
  const uniqueFormats = [...new Set(formats)]

  if (uniqueFormats.length === 0) throw new Error('Select at least one export format.')

  return uniqueFormats
}

export const createMixdownFileName = (date: Date, format: ExportAudioFormat): string => {
  const metadata = getExportAudioFormatMetadata(format)

  return `mixdown_${formatExportFileTimestamp(date)}${metadata.fileExtension}`
}

export const createSaveTypes = (format: ExportAudioFormat): FilePickerAcceptType[] => {
  const metadata = getExportAudioFormatMetadata(format)

  return [{ description: `${metadata.label} audio`, accept: { [metadata.mimeType]: [metadata.fileExtension] } }]
}

export const reportFormatProgress = (
  input: Pick<TimelineExportRequest, 'onProgress'>,
  phase: Extract<ExportPhase, 'quantizing' | 'encoding' | 'saving'>,
  format: ExportAudioFormat,
  completedFormats: number,
  totalFormats: number,
  sizeBytes?: number,
) => {
  input.onProgress?.({ phase, currentFormat: format, completedFormats, totalFormats, sizeBytes })
}

export const reportStemFormatProgress = (
  input: Pick<TimelineExportRequest, 'onProgress'>,
  phase: Extract<ExportPhase, 'encoding' | 'saving'>,
  format: ExportAudioFormat,
  track: RuntimeTrack,
  completedStems: number,
  totalStems: number,
  completedFormats: number,
  totalFormats: number,
  sizeBytes?: number,
) => {
  input.onProgress?.({
    phase,
    sizeBytes,
    currentFormat: format,
    currentStemName: track.name,
    completedStems,
    totalStems,
    completedFormats,
    totalFormats,
  })
}
