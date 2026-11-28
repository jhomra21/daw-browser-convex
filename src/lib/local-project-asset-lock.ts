// The non-browser fallback mirrors named Web Locks within this process.
const chains = new Map<string, Promise<void>>()

const withAssetLock = async <Value>(
  name: string,
  callback: () => Promise<Value>,
): Promise<Value> => {
  if (globalThis.window === globalThis) {
    if (!navigator.locks) {
      throw new Error('Web Locks are required for browser project asset mutations.')
    }
    return navigator.locks.request(name, { mode: 'exclusive' }, callback)
  }
  const previous = chains.get(name) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const next = previous.then(() => current, () => current)
  chains.set(name, next)
  await previous
  try {
    return await callback()
  } finally {
    release()
    if (chains.get(name) === next) chains.delete(name)
  }
}

export const withLocalProjectAssetLock = <Value>(
  projectId: string,
  callback: () => Promise<Value>,
): Promise<Value> => withAssetLock(`daw-browser-project-assets:${projectId}`, callback)

/** Acquire after the project lock, only for root reference changes and cleanup. */
export const withLocalStorageRootLock = <Value>(
  callback: () => Promise<Value>,
): Promise<Value> => withAssetLock('daw-browser-storage-roots', callback)

const withAssetLockIfAvailable = async (
  name: string,
  callback: () => Promise<void>,
): Promise<boolean> => {
  if (globalThis.window === globalThis) {
    if (!navigator.locks) throw new Error('Web Locks are required for browser project asset mutations.')
    let acquired = false
    await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (lock) {
        acquired = true
        await callback()
      }
    })
    return acquired
  }
  if (chains.has(name)) return false
  await withAssetLock(name, callback)
  return true
}

/** Skip live owners: acquiring this lock proves their copy is no longer running. */
export const withLocalProjectAssetLockIfAvailable = (
  projectId: string,
  callback: () => Promise<void>,
): Promise<boolean> => withAssetLockIfAvailable(`daw-browser-project-assets:${projectId}`, callback)

/** Skip, rather than queue, a background pass already running in another tab. */
export const withLocalProjectCleanupRunner = (
  callback: () => Promise<void>,
): Promise<void> => withAssetLockIfAvailable('daw-browser-project-cleanup-runner', callback).then(() => undefined)
