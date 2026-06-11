import { Show, type Component } from 'solid-js'
import { Button } from '~/components/ui/button'
import { useExportContext } from '~/context/export'
import { formatBytes } from '~/lib/format-bytes'
import { getExportAudioFormatMetadata } from '@daw-browser/shared'

const ExportProgressOverlay: Component = () => {
  const exports = useExportContext()
  const label = (job: NonNullable<ReturnType<typeof exports.activeJob>>) => {
    const progress = job.progress
    const formatLabel = progress?.currentFormat ? ` ${getExportAudioFormatMetadata(progress.currentFormat).label}` : ''
    const formatCount = progress?.totalFormats && progress.totalFormats > 1
      ? ` (${progress.completedFormats ?? 0}/${progress.totalFormats})`
      : ''
    if (progress?.currentStemName) {
      return `${job.name}: ${progress.currentStemName}${formatLabel}${formatCount} (${progress.completedStems ?? 0}/${progress.totalStems ?? 0})`
    }
    if (progress?.phase === 'rendering') return `${job.name}: Rendering…`
    if (progress?.phase === 'saving') return `${job.name}: Saving${formatLabel}${formatCount}…`
    if (progress?.phase === 'encoding' && progress.sizeBytes !== undefined) {
      return `${job.name}: Encoding${formatLabel}${formatCount}… ${formatBytes(progress.sizeBytes)} written`
    }
    if (progress?.phase === 'encoding') return `${job.name}: Encoding${formatLabel}${formatCount}…`
    return `${job.name}: Preparing…`
  }

  return (
    <Show when={exports.activeJob()}>
      {(job) => (
        <div class="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-100 shadow-xl">
          <div class="min-w-0 flex-1 truncate">{label(job())}</div>
          <Show when={job().progress?.phase !== 'rendering'}>
            <Button variant="outline" size="sm" onClick={() => exports.cancelExport(job().id)}>
              Cancel
            </Button>
          </Show>
        </div>
      )}
    </Show>
  )
}

export default ExportProgressOverlay
