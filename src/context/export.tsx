import { createContext, createSignal, onCleanup, type Accessor, type JSX, useContext } from 'solid-js'
import type { ExportAudioFormat } from '@daw-browser/shared'

import { runStemExport, runTimelineExport, type ExportOutcome, type ExportProgress, type StemExportRequest, type TimelineExportRequest } from '~/lib/export/run-export-job'

type ExportJobStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'saving'

type ExportJob = {
  id: string
  name: string
  status: ExportJobStatus
  format: ExportAudioFormat
  createdAt: number
  progress?: ExportProgress
}

type EnqueueTimelineExportRequest = Omit<TimelineExportRequest, 'signal' | 'onProgress'> & {
  name?: string
}

type EnqueueStemExportRequest = Omit<StemExportRequest, 'signal' | 'onProgress'> & {
  name?: string
}

type ExportContextValue = {
  jobs: Accessor<ExportJob[]>
  activeJob: Accessor<ExportJob | undefined>
  exporting: Accessor<boolean>
  enqueueTimelineExport: (request: EnqueueTimelineExportRequest) => Promise<ExportOutcome>
  enqueueStemExport: (request: EnqueueStemExportRequest) => Promise<ExportOutcome>
  cancelExport: (jobId: string) => void
}

const ExportContext = createContext<ExportContextValue>()

const createExportJobId = () => `export-${crypto.randomUUID()}`

const statusForProgress = (progress: ExportProgress): ExportJobStatus => progress.phase

type ExportProviderProps = {
  children: JSX.Element
}

export function ExportProvider(props: ExportProviderProps) {
  const [jobs, setJobs] = createSignal<ExportJob[]>([])
  const [activeJobId, setActiveJobId] = createSignal<string | undefined>()
  const [activeController, setActiveController] = createSignal<AbortController | undefined>()
  let queue: Promise<void> = Promise.resolve()
  let disposed = false

  const updateJob = (jobId: string, update: (job: ExportJob) => ExportJob) => {
    if (disposed) return
    setJobs((current) => current.map((job) => job.id === jobId ? update(job) : job))
  }

  const activeJob = () => jobs().find((job) => job.id === activeJobId())
  const exporting = () => activeJob() !== undefined

  const runQueuedExport = async (
    jobId: string,
    runExport: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): Promise<ExportOutcome> => {
    if (disposed) return { type: 'canceled' }
    const controller = new AbortController()
    setActiveController(controller)
    setActiveJobId(jobId)
    updateJob(jobId, (job) => ({ ...job, status: 'preparing' }))
    const outcome = await runExport(controller.signal, (progress) => {
      updateJob(jobId, (job) => ({ ...job, status: statusForProgress(progress), progress }))
    })
    setActiveController(undefined)
    setActiveJobId(undefined)
    if (!disposed) setJobs((current) => current.filter((job) => job.id !== jobId))
    return outcome
  }

  const enqueueExport = (
    request: Pick<EnqueueTimelineExportRequest, 'name' | 'format'>,
    defaultName: string,
    runExport: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ): Promise<ExportOutcome> => {
    if (disposed) return Promise.resolve({ type: 'canceled' })
    const jobId = createExportJobId()
    setJobs((current) => [
      ...current,
      {
        id: jobId,
        name: request.name ?? defaultName,
        status: 'queued',
        format: request.format,
        createdAt: Date.now(),
      },
    ])
    const result = queue.then(() => runQueuedExport(jobId, runExport))
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
    if (activeJobId() !== jobId) return
    activeController()?.abort()
  }

  onCleanup(() => {
    disposed = true
    activeController()?.abort()
  })

  return (
    <ExportContext.Provider value={{ jobs, activeJob, exporting, enqueueTimelineExport, enqueueStemExport, cancelExport }}>
      {props.children}
    </ExportContext.Provider>
  )
}

export function useExportContext(): ExportContextValue {
  const context = useContext(ExportContext)
  if (!context) throw new Error('ExportProvider is missing')
  return context
}

