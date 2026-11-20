// Runs callbacks for the same key one at a time, in call order. A failed callback does not block the next one.
export const createKeyedLock = () => {
  const chains = new Map<string, Promise<void>>()

  return {
    has: (key: string) => chains.has(key),
    run: async <Value>(key: string, callback: () => Promise<Value>): Promise<Value> => {
      const previous = chains.get(key) ?? Promise.resolve()
      let release: () => void = () => undefined
      const current = new Promise<void>((resolve) => { release = resolve })
      const next = previous.then(() => current, () => current)
      chains.set(key, next)
      await previous

      try {
        return await callback()
      } finally {
        release()

        if (chains.get(key) === next) chains.delete(key)
      }
    },
  }
}
