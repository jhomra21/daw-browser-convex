import { createContext, createSignal, onCleanup, type Accessor, type JSX, untrack, useContext } from 'solid-js'

import { assert } from '@daw-browser/shared'
import type { ExportOutcome, ExportProgress } from '~/lib/export/run-export-job'
import type { ExportQueue } from '~/lib/export/export-queue'
import { createBrowserExportOutputTargetFactory } from '~/lib/export/browser-export-output-targets'
import type { TimelineExportInput, TimelineExportService, TimelineStemExportInput } from '~/lib/export/timeline-export-service'

type ExportJob = {
  id: string
  name: string
  progress?: ExportProgress
}

type EnqueueTimelineExportRequest = TimelineExportInput
type EnqueueStemExportRequest = TimelineStemExportInput

type ExportContextValue = {
  activeJob: Accessor<ExportJob | undefined>
  enqueueTimelineExport: (request: EnqueueTimelineExportRequest) => Promise<ExportOutcome>
  enqueueStemExport: (request: EnqueueStemExportRequest) => Promise<ExportOutcome>
  cancelExport: (jobId: string) => void
}

const ExportContext = createContext<ExportContextValue>()

type ExportProviderProps = {
  children: JSX.Element
  queue: ExportQueue
  service: TimelineExportService
}

export function ExportProvider(props: ExportProviderProps) {
  const [activeJob, setActiveJob] = createSignal<ExportJob | undefined>()
  const unsubscribe = untrack(() => props.queue.subscribe(setActiveJob))
  const outputTargets = createBrowserExportOutputTargetFactory()

  const enqueueTimelineExport = (request: EnqueueTimelineExportRequest): Promise<ExportOutcome> => (
    props.service.enqueueTimelineExport(request, outputTargets)
  )

  const enqueueStemExport = (request: EnqueueStemExportRequest): Promise<ExportOutcome> => (
    props.service.enqueueStemExport(request, outputTargets)
  )

  const cancelExport = (jobId: string) => {
    props.service.cancel(jobId)
  }

  onCleanup(() => {
    unsubscribe()
  })

  return (
    <ExportContext.Provider value={{ activeJob, enqueueTimelineExport, enqueueStemExport, cancelExport }}>
      {props.children}
    </ExportContext.Provider>
  )
}

export function useExportContext(): ExportContextValue {
  const context = useContext(ExportContext)
  assert(context, 'ExportProvider is missing')
  return context
}

