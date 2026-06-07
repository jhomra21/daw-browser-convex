import { Show, type Component } from 'solid-js'
import { Button } from '~/components/ui/button'
import { useExportContext } from '~/context/export'
import { formatBytes } from '~/lib/format-bytes'

const ExportProgressOverlay: Component = () => {
  const exports = useExportContext()
  const label = () => {
    const job = exports.activeJob()
    if (!job) return ''
    const progress = job.progress
    if (progress?.currentStemName) {
      return `${job.name}: ${progress.currentStemName} (${progress.completedStems ?? 0}/${progress.totalStems ?? 0})`
    }
    if (progress?.phase === 'rendering') return `${job.name}: Rendering…`
    if (progress?.phase === 'saving') return `${job.name}: Saving…`
    if (progress?.phase === 'encoding' && progress.sizeBytes !== undefined) {
      return `${job.name}: Encoding… ${formatBytes(progress.sizeBytes)} written`
    }
    if (progress?.phase === 'encoding') return `${job.name}: Encoding…`
    return `${job.name}: Preparing…`
  }

  return (
    <Show when={exports.activeJob()}>
      {(job) => (
        <div class="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-100 shadow-xl">
          <div class="min-w-0 flex-1 truncate">{label()}</div>
          <Button variant="outline" size="sm" onClick={() => exports.cancelExport(job().id)}>
            Cancel
          </Button>
        </div>
      )}
    </Show>
  )
}

export default ExportProgressOverlay
