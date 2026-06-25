import { getExportAudioFormatMetadata } from '@daw-browser/shared'

import { formatBytes } from '~/lib/format-bytes'
import type { ExportProgress } from '~/lib/export/run-export-job'

type ExportProgressJob = {
  name: string
  progress?: ExportProgress
}

export const formatExportProgressLabel = (job: ExportProgressJob): string => {
  const progress = job.progress
  const formatLabel = progress?.currentFormat ? ` ${getExportAudioFormatMetadata(progress.currentFormat).label}` : ''
  const formatCount = progress?.totalFormats && progress.totalFormats > 1
    ? ` (${progress.completedFormats ?? 0}/${progress.totalFormats})`
    : ''
  if (progress?.currentStemName) {
    return `${job.name}: ${progress.currentStemName}${formatLabel}${formatCount} (${progress.completedStems ?? 0}/${progress.totalStems ?? 0})`
  }
  if (progress?.phase === 'rendering') return `${job.name}: Rendering...`
  if (progress?.phase === 'saving') return `${job.name}: Saving${formatLabel}${formatCount}...`
  if (progress?.phase === 'encoding' && progress.sizeBytes !== undefined) {
    return `${job.name}: Encoding${formatLabel}${formatCount}... ${formatBytes(progress.sizeBytes)} written`
  }
  if (progress?.phase === 'encoding') return `${job.name}: Encoding${formatLabel}${formatCount}...`
  return `${job.name}: Preparing...`
}
