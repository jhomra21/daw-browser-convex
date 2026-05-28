const pendingEffectFlushers = new Map<string, Set<() => Promise<void>>>()

export const registerPendingEffectFlusher = (projectId: string, flush: () => Promise<void>): (() => void) => {
  const projectFlushers = pendingEffectFlushers.get(projectId) ?? new Set<() => Promise<void>>()
  projectFlushers.add(flush)
  pendingEffectFlushers.set(projectId, projectFlushers)
  return () => {
    projectFlushers.delete(flush)
    if (projectFlushers.size === 0) pendingEffectFlushers.delete(projectId)
  }
}

export const flushPendingPersistedEffectWrites = async (projectId: string): Promise<void> => {
  await Promise.all(Array.from(pendingEffectFlushers.get(projectId) ?? [], (flush) => flush()))
}
