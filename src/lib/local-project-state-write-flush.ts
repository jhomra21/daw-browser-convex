const pendingProjectStateFlushers = new Map<string, Set<() => Promise<void>>>()

export const registerPendingProjectStateFlusher = (projectId: string, flush: () => Promise<void>): (() => void) => {
  const projectFlushers = pendingProjectStateFlushers.get(projectId) ?? new Set<() => Promise<void>>()
  projectFlushers.add(flush)
  pendingProjectStateFlushers.set(projectId, projectFlushers)
  return () => {
    projectFlushers.delete(flush)
    if (projectFlushers.size === 0) pendingProjectStateFlushers.delete(projectId)
  }
}

export const flushPendingProjectStateWrites = async (projectId: string): Promise<void> => {
  await Promise.all(Array.from(pendingProjectStateFlushers.get(projectId) ?? [], (flush) => flush()))
}
