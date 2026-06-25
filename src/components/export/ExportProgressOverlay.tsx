import { Show, type Component } from 'solid-js'

import ExportProgressStatus from '~/components/export/ExportProgressStatus'
import { useExportContext } from '~/context/export'

const ExportProgressOverlay: Component = () => {
  const exports = useExportContext()

  return (
    <Show when={exports.activeJob()}>
      {(job) => (
        <div class="fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-3 border border-neutral-700 bg-neutral-900 px-4 py-3 text-sm text-neutral-100 shadow-xl">
          <ExportProgressStatus job={job()} onCancel={exports.cancelExport} />
        </div>
      )}
    </Show>
  )
}

export default ExportProgressOverlay
