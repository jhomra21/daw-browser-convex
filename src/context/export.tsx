import { createContext, createSignal, onCleanup, type Accessor, untrack, useContext } from 'solid-js'
import type { JSX } from '@solidjs/web'

import type { ExportOutcome, ExportProgress } from '~/lib/export/export-job-types'
import type { ExportQueue } from '~/lib/export/export-queue'
import { createBrowserExportOutputTargetFactory } from '~/lib/export/browser-export-output-targets'
import { createDesktopRendererExportOutputTargetFactory } from '~/lib/desktop/capability-export-output-targets'
import type { TimelineExportInput, TimelineExportService, TimelineStemExportInput } from '~/lib/export/timeline-export-service'
import { desktopBridge, isDesktopRenderer } from '~/lib/runtime'

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

  const bridge = isDesktopRenderer() ? desktopBridge() : undefined

  const outputTargets = bridge
    ? createDesktopRendererExportOutputTargetFactory(bridge)
    : createBrowserExportOutputTargetFactory()

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
    <ExportContext value={{ activeJob, enqueueTimelineExport, enqueueStemExport, cancelExport }}>
      {props.children}
    </ExportContext>
  )
}

export function useExportContext(): ExportContextValue {
  return useContext(ExportContext)
}
