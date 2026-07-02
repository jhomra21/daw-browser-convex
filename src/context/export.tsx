import { createContext, createSignal, onCleanup, type Accessor, type JSX, useContext } from 'solid-js'

import { assert } from '@daw-browser/shared'
import { runStemExport, runTimelineExport, type ExportOutcome, type ExportProgress, type StemExportRequest, type TimelineExportRequest } from '~/lib/export/run-export-job'

type ExportJob = {
  id: string
  name: string
  progress?: ExportProgress
}

type EnqueueTimelineExportRequest = Omit<TimelineExportRequest, 'signal' | 'onProgress'> & {
  name?: string
}

type EnqueueStemExportRequest = Omit<StemExportRequest, 'signal' | 'onProgress'> & {
  name?: string
}

type ExportContextValue = {
  activeJob: Accessor<ExportJob | undefined>
  enqueueTimelineExport: (request: EnqueueTimelineExportRequest) => Promise<ExportOutcome>
  enqueueStemExport: (request: EnqueueStemExportRequest) => Promise<ExportOutcome>
  cancelExport: (jobId: string) => void
}

const ExportContext = createContext<ExportContextValue>()

const createExportJobId = () => `export-${crypto.randomUUID()}`

type ExportProviderProps = {
  children: JSX.Element
}

export function ExportProvider(props: ExportProviderProps) {
  const [activeJob, setActiveJob] = createSignal<ExportJob | undefined>()
  const [activeController, setActiveController] = createSignal<AbortController | undefined>()
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const updateActiveJob = (update: (job: ExportJob) => ExportJob) => {
    if (disposed) return
    setActiveJob((job) => job ? update(job) : job)
  }

  const runQueuedExport = async (
    job: ExportJob,
    runExport: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): Promise<ExportOutcome> => {
    if (disposed) return { type: 'canceled', outputs: [] }
    const controller = new AbortController()
    setActiveController(controller)
    setActiveJob(job)
    const outcome = await runExport(controller.signal, (progress) => {
      updateActiveJob((job) => ({ ...job, progress }))
    })
    setActiveController(undefined)
    if (!disposed) setActiveJob(undefined)
    return outcome
  }

  const enqueueExport = (
    request: Pick<EnqueueTimelineExportRequest, 'name'>,
    defaultName: string,
    runExport: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): Promise<ExportOutcome> => {
    if (disposed) return Promise.resolve({ type: 'canceled', outputs: [] })
    const job = {
      id: createExportJobId(),
      name: request.name ?? defaultName,
    }
    const result = queue.then(() => runQueuedExport(job, runExport))
    queue = result.then(() => {}, () => {})
    return result
  }

  const enqueueTimelineExport = (request: EnqueueTimelineExportRequest): Promise<ExportOutcome> => (
    enqueueExport(request, 'Timeline mixdown', (signal, onProgress) => runTimelineExport({ ...request, signal, onProgress }))
  )

  const enqueueStemExport = (request: EnqueueStemExportRequest): Promise<ExportOutcome> => (
    enqueueExport(request, request.stemMode === 'all-tracks' ? 'All track stems' : 'Selected track stems', (signal, onProgress) => runStemExport({ ...request, signal, onProgress }))
  )

  const cancelExport = (jobId: string) => {
    if (activeJob()?.id !== jobId) return
    activeController()?.abort()
  }

  onCleanup(() => {
    disposed = true
    activeController()?.abort()
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

