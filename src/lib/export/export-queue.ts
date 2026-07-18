import type { ExportOutcome, ExportProgress } from '~/lib/export/run-export-job'

export type ExportJob = {
  id: string
  name: string
  progress?: ExportProgress
}

export type ExportQueue = {
  activeJob: () => ExportJob | undefined
  enqueue: (
    job: Pick<ExportJob, 'name'>,
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void) => Promise<ExportOutcome>,
  ) => Promise<ExportOutcome>
  cancel: (jobId: string) => void
  subscribe: (listener: (job: ExportJob | undefined) => void) => () => void
  dispose: () => void
}

export const createExportQueue = (
  createJobId: () => string = () => `export-${crypto.randomUUID()}`,
): ExportQueue => {
  let active: ExportJob | undefined
  let activeController: AbortController | undefined
  let queue: Promise<void> = Promise.resolve()
  let disposed = false
  const listeners = new Set<(job: ExportJob | undefined) => void>()
  const setActive = (job: ExportJob | undefined) => {
    active = job
    for (const listener of listeners) listener(job)
  }

  const enqueue: ExportQueue['enqueue'] = (job, run) => {
    if (disposed) return Promise.resolve({ type: 'canceled', outputs: [] })
    const queuedJob: ExportJob = { id: createJobId(), name: job.name }
    const result = queue.then(async () => {
      if (disposed) return { type: 'canceled', outputs: [] } as ExportOutcome
      const controller = new AbortController()
      activeController = controller
      setActive(queuedJob)
      try {
        return await run(controller.signal, (progress) => {
          if (active?.id === queuedJob.id) setActive({ ...queuedJob, progress })
        })
      } finally {
        if (activeController === controller) activeController = undefined
        if (active?.id === queuedJob.id) setActive(undefined)
      }
    })
    queue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    activeJob: () => active,
    enqueue,
    cancel: (jobId) => {
      if (active?.id === jobId) activeController?.abort()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(active)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      activeController?.abort()
    },
  }
}
