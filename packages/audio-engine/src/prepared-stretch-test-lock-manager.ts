import type { PreparedStretchArtifactLockManager } from './prepared-stretch-store'

const tails = new Map<string, Promise<void>>()

export const preparedStretchTestLockManager: PreparedStretchArtifactLockManager = {
  request: async <Value>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string } | null) => Promise<Value>,
  ) => {
    const previous = tails.get(name)
    if (options.ifAvailable === true && previous) return callback(null)
    let release: () => void = () => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    const next = (previous ?? Promise.resolve()).then(() => current, () => current)
    tails.set(name, next)
    await previous
    try {
      return await callback({ name })
    } finally {
      release()
      if (tails.get(name) === next) tails.delete(name)
    }
  },
}
