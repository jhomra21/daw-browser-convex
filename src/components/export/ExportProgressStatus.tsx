import { Show, createSignal, onCleanup, type Component } from 'solid-js'

import { Button } from '~/components/ui/button'
import { exportOutputPickerStatus } from '~/lib/export/export-output-picker-status'
import { formatExportProgressLabel } from '~/lib/export/export-progress-label'
import type { ExportProgress } from '~/lib/export/run-export-job'

type ExportProgressStatusProps = {
  job: {
    id: string
    name: string
    progress?: ExportProgress
  }
  onCancel: (jobId: string) => void
}

const ExportProgressStatus: Component<ExportProgressStatusProps> = (props) => {
  const [choosingSaveLocation, setChoosingSaveLocation] = createSignal(
    exportOutputPickerStatus.current(),
  )
  const unsubscribe = exportOutputPickerStatus.subscribe(setChoosingSaveLocation)
  onCleanup(unsubscribe)

  return (
    <>
      <div class="min-w-0 flex-1 truncate">
        {formatExportProgressLabel(props.job, {
          choosingSaveLocation: choosingSaveLocation(),
        })}
      </div>
      <Show when={props.job.progress?.phase !== 'rendering'}>
        <Button variant="outline" size="sm" onClick={() => props.onCancel(props.job.id)}>
          Cancel
        </Button>
      </Show>
    </>
  )
}

export default ExportProgressStatus
