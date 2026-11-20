export type ImportProjectBinding = {
  projectId: string
  mountedProjectGeneration: number
}

export type ImportFileOutcome = {
  fileName: string
  status: 'created' | 'queued' | 'skipped' | 'local-save-failed' | 'failed' | 'canceled'
  message?: string
  assetId?: string
  clipId?: string
  operationId?: string
}

export type ImportSummary = {
  outcomes: readonly ImportFileOutcome[]
}
