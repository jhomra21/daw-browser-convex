const chains = new Map<string, Promise<void>>()

const lockName = (projectId: string) => `daw-browser-project-assets:${projectId}`

export const withLocalProjectAssetLock = async <Value>(
  projectId: string,
  callback: () => Promise<Value>,
): Promise<Value> => {
  if (globalThis.window === globalThis) {
    if (!navigator.locks) {
      throw new Error('Web Locks are required for browser project asset mutations.')
    }
    return navigator.locks.request(lockName(projectId), { mode: 'exclusive' }, callback)
  }
  const previous = chains.get(projectId) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const next = previous.then(() => current, () => current)
  chains.set(projectId, next)
  await previous
  try {
    return await callback()
  } finally {
    release()
    if (chains.get(projectId) === next) chains.delete(projectId)
  }
}
