import type { ExportOutcome, ExportProgress } from '~/lib/export/run-export-job'

export type ExportJob = {
  id: string
  name: string
  progress?: ExportProgress
}

export type ExportQueue = {
  activeJob: () => ExportJob | undefined
  submit: (
    job: Pick<ExportJob, 'name'>,
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void, jobId: string) => Promise<ExportOutcome>,
  ) => { id: string; completion: Promise<ExportOutcome>; cancel: () => void }
  enqueue: (
    job: Pick<ExportJob, 'name'>,
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void, jobId: string) => Promise<ExportOutcome>,
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
  let disposed = false
  const listeners = new Set<(job: ExportJob | undefined) => void>()
  type PendingJob = {
    job: ExportJob
    run: (signal: AbortSignal, onProgress: (progress: ExportProgress) => void, jobId: string) => Promise<ExportOutcome>
    resolve: (outcome: ExportOutcome) => void
    canceled: boolean
  }
  const pending: PendingJob[] = []
  let draining = false
  const setActive = (job: ExportJob | undefined) => {
    active = job
    for (const listener of listeners) listener(job)
  }

  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        const next = pending.shift()
        if (!next) continue
        if (disposed || next.canceled) {
          next.resolve({ type: "canceled", outputs: [] })
          continue
        }
        const controller = new AbortController()
        activeController = controller
        setActive(next.job)
        try {
          next.resolve(await next.run(controller.signal, (progress) => {
            if (active?.id === next.job.id) setActive({ ...next.job, progress })
          }, next.job.id))
        } catch (error) {
          next.resolve({ type: "error", message: error instanceof Error ? error.message : "Export failed", outputs: [] })
        } finally {
          if (activeController === controller) activeController = undefined
          if (active?.id === next.job.id) setActive(undefined)
        }
      }
    } finally {
      draining = false
    }
  }
  const submit: ExportQueue['submit'] = (job, run) => {
    if (disposed) {
      const id = createJobId()
      return { id, completion: Promise.resolve({ type: 'canceled', outputs: [] }), cancel: () => undefined }
    }
    const queuedJob: ExportJob = { id: createJobId(), name: job.name }
    let resolveCompletion: (outcome: ExportOutcome) => void = () => undefined
    const completion = new Promise<ExportOutcome>((resolve) => {
      resolveCompletion = resolve
    })
    const entry: PendingJob = { job: queuedJob, run, resolve: resolveCompletion, canceled: false }
    pending.push(entry)
    queueMicrotask(() => { void drain() })
    return { id: queuedJob.id, completion, cancel: () => {
      if (active?.id === queuedJob.id) activeController?.abort()
      else {
        entry.canceled = true
        const index = pending.indexOf(entry)
        if (index >= 0) pending.splice(index, 1)
        entry.resolve({ type: "canceled", outputs: [] })
      }
    } }
  }

  return {
    activeJob: () => active,
    submit,
    enqueue: (job, run) => submit(job, run).completion,
    cancel: (jobId) => {
      if (active?.id === jobId) activeController?.abort()
      else {
        const entry = pending.find((candidate) => candidate.job.id === jobId)
        if (entry) {
          entry.canceled = true
          pending.splice(pending.indexOf(entry), 1)
          entry.resolve({ type: "canceled", outputs: [] })
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(active)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      activeController?.abort()
      for (const entry of pending.splice(0)) entry.resolve({ type: "canceled", outputs: [] })
    },
  }
}
