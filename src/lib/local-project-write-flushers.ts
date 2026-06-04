type PendingWriteKind = 'effects' | 'history' | 'project-state'

const pendingFlushers = new Map<PendingWriteKind, Map<string, Set<() => Promise<void>>>>()

export const registerPendingLocalProjectWriteFlusher = (
  kind: PendingWriteKind,
  projectId: string,
  flush: () => Promise<void>,
): (() => void) => {
  const kindFlushers = pendingFlushers.get(kind) ?? new Map<string, Set<() => Promise<void>>>()
  const projectFlushers = kindFlushers.get(projectId) ?? new Set<() => Promise<void>>()
  projectFlushers.add(flush)
  kindFlushers.set(projectId, projectFlushers)
  pendingFlushers.set(kind, kindFlushers)
  return () => {
    projectFlushers.delete(flush)
    if (projectFlushers.size === 0) kindFlushers.delete(projectId)
    if (kindFlushers.size === 0) pendingFlushers.delete(kind)
  }
}

export const flushRegisteredLocalProjectWrites = async (projectId?: string): Promise<void> => {
  await Promise.all(Array.from(pendingFlushers.values()).flatMap((byProject) => (
    projectId
      ? Array.from(byProject.get(projectId) ?? [], (flush) => flush())
      : Array.from(byProject.values()).flatMap((projectFlushers) => Array.from(projectFlushers, (flush) => flush()))
  )))
}
