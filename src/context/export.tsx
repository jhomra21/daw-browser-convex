import { createContext, createSignal, onCleanup, type Accessor, type JSX, untrack, useContext } from 'solid-js'

import { assert } from '@daw-browser/shared'
import { runStemExport, runTimelineExport, type ExportOutcome, type ExportProgress, type StemExportSelection, type TimelineExportRequest } from '~/lib/export/run-export-job'
import type { ExportQueue } from '~/lib/export/export-queue'
import { createBrowserExportOutputTargetFactory } from '~/lib/export/browser-export-output-targets'

type ExportJob = {
  id: string
  name: string
  progress?: ExportProgress
}

type EnqueueTimelineExportRequest = Omit<TimelineExportRequest, 'signal' | 'onProgress' | 'outputTargets'> & {
  name?: string
}

type EnqueueStemExportRequest = Omit<TimelineExportRequest, 'signal' | 'onProgress' | 'outputTargets'> & StemExportSelection & {
  name?: string
}

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
}

export function ExportProvider(props: ExportProviderProps) {
  const [activeJob, setActiveJob] = createSignal<ExportJob | undefined>()
  const unsubscribe = untrack(() => props.queue.subscribe(setActiveJob))
  const outputTargets = createBrowserExportOutputTargetFactory()

  const enqueueExport = (
    request: Pick<EnqueueTimelineExportRequest, 'name'>,
    defaultName: string,
    runExport: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): Promise<ExportOutcome> => {
    return props.queue.enqueue({ name: request.name ?? defaultName }, runExport)
  }

  const enqueueTimelineExport = (request: EnqueueTimelineExportRequest): Promise<ExportOutcome> => (
    enqueueExport(request, 'Timeline mixdown', (signal, onProgress) => runTimelineExport({ ...request, signal, onProgress, outputTargets }))
  )

  const enqueueStemExport = (request: EnqueueStemExportRequest): Promise<ExportOutcome> => (
    enqueueExport(request, request.stemSelection === 'all-tracks' ? 'All track stems' : 'Selected track stems', (signal, onProgress) => runStemExport({ ...request, signal, onProgress, outputTargets }))
  )

  const cancelExport = (jobId: string) => {
    props.queue.cancel(jobId)
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

