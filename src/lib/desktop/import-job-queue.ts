import type { ImportSummary } from "~/hooks/useTimelineClipImport"

export type ImportJobStatus = {
  id: string
  name: string
  status: "queued" | "running" | "completed" | "canceled" | "failed"
  summary?: ImportSummary
  error?: string
}

type PendingImport = {
  job: ImportJobStatus
  run: (signal: AbortSignal) => Promise<ImportSummary>
  resolve: (summary: ImportSummary) => void
  isCurrent?: () => boolean
  canceled: boolean
}

const maximumRetainedTerminalJobs = 16

export type ImportJobQueue = {
  submit: (name: string, run: (signal: AbortSignal) => Promise<ImportSummary>, isCurrent?: () => boolean) => {
    id: string
    completion: Promise<ImportSummary>
  }
  cancel: (jobId: string) => void
  cancelAll: () => void
  status: (jobId?: string) => ImportJobStatus | undefined
  dispose: () => void
}

export const createImportJobQueue = (
  createJobId: () => string = () => `import-${crypto.randomUUID()}`,
): ImportJobQueue => {
  const jobs = new Map<string, ImportJobStatus>()
  const pending: PendingImport[] = []
  const terminalJobIds: string[] = []
  let activeController: AbortController | undefined
  let activeEntry: PendingImport | undefined
  let draining = false
  let disposed = false

  const setTerminalJob = (job: ImportJobStatus) => {
    jobs.set(job.id, job)
    terminalJobIds.push(job.id)
    while (terminalJobIds.length > maximumRetainedTerminalJobs) {
      const expiredId = terminalJobIds.shift()
      if (expiredId) jobs.delete(expiredId)
    }
  }

  const drain = async () => {
    if (draining) return
    draining = true
    try {
      while (pending.length > 0) {
        const entry = pending.shift()
        if (!entry) continue
        if (disposed || entry.canceled || entry.isCurrent?.() === false) {
          const summary = { outcomes: [] }
          setTerminalJob({ ...entry.job, status: "canceled", summary })
          entry.resolve(summary)
          continue
        }
        const controller = new AbortController()
        activeController = controller
        activeEntry = entry
        jobs.set(entry.job.id, { ...entry.job, status: "running" })
        try {
          const summary = await entry.run(controller.signal)
          if (entry.isCurrent?.() === false) {
            const canceled = { outcomes: [] }
            setTerminalJob({ ...entry.job, status: "canceled", summary: canceled })
            entry.resolve(canceled)
            continue
          }
          const status = summary.outcomes.some((outcome) => outcome.status === "created" || outcome.status === "queued")
            ? "completed"
            : summary.outcomes.every((outcome) => outcome.status === "canceled")
              ? "canceled"
              : "failed"
          setTerminalJob({ ...entry.job, status, summary })
          entry.resolve(summary)
        } catch (error) {
          const summary = { outcomes: [] }
          setTerminalJob({
            ...entry.job,
            status: controller.signal.aborted || entry.isCurrent?.() === false ? "canceled" : "failed",
            summary,
            error: error instanceof Error ? error.message : "Audio import failed.",
          })
          entry.resolve(summary)
        } finally {
          if (activeController === controller) activeController = undefined
          if (activeEntry === entry) activeEntry = undefined
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    submit: (name, run, isCurrent) => {
      const job: ImportJobStatus = { id: createJobId(), name, status: "queued" }
      let resolveCompletion: (summary: ImportSummary) => void = () => undefined
      const completion = new Promise<ImportSummary>((resolve) => {
        resolveCompletion = resolve
      })
      pending.push({ job, run, resolve: resolveCompletion, isCurrent, canceled: false })
      jobs.set(job.id, job)
      queueMicrotask(() => { void drain() })
      return { id: job.id, completion }
    },
    cancel: (jobId) => {
      const entry = pending.find((candidate) => candidate.job.id === jobId)
      if (entry) {
        entry.canceled = true
        pending.splice(pending.indexOf(entry), 1)
        const summary = { outcomes: [] }
        setTerminalJob({ ...entry.job, status: "canceled", summary })
        entry.resolve(summary)
        return
      }
      const job = jobs.get(jobId)
      if (job?.status === "running") {
        jobs.set(jobId, { ...job, status: "canceled", summary: { outcomes: [] } })
        activeController?.abort()
      }
    },
    cancelAll: () => {
      if (activeEntry) {
        jobs.set(activeEntry.job.id, { ...activeEntry.job, status: "canceled", summary: { outcomes: [] } })
      }
      activeController?.abort()
      for (const entry of pending.splice(0)) {
        const summary = { outcomes: [] }
        setTerminalJob({ ...entry.job, status: "canceled", summary })
        entry.resolve(summary)
      }
    },
    status: (jobId) => {
      if (jobId) return jobs.get(jobId)
      return [...jobs.values()].at(-1)
    },
    dispose: () => {
      disposed = true
      if (activeEntry) {
        jobs.set(activeEntry.job.id, { ...activeEntry.job, status: "canceled", summary: { outcomes: [] } })
      }
      activeController?.abort()
      for (const entry of pending.splice(0)) {
        const summary = { outcomes: [] }
        setTerminalJob({ ...entry.job, status: "canceled", summary })
        entry.resolve(summary)
      }
    },
  }
}
