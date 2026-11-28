const localStorageOrNull = () => {
  if (globalThis.window === undefined) return null

  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

export const canUseLocalStorage = () => localStorageOrNull() !== null

type StoredValueOptions<TValue> = {
  key: (scope: string) => string
  fallback: () => TValue
  // Returns undefined for a stored string that is not a valid value; parse errors are treated the same way.
  parse: (raw: string) => TValue | undefined
  serialize: (value: TValue) => string
}

// Browser-local preference: a missing, unreadable or invalid entry reads as the fallback and a failed write is dropped.
export const createStoredValue = <TValue,>(options: StoredValueOptions<TValue>) => ({
  read: (scope: string): TValue => {
    try {
      const raw = localStorageOrNull()?.getItem(options.key(scope))

      if (raw === null || raw === undefined) return options.fallback()

      return options.parse(raw) ?? options.fallback()
    } catch {
      return options.fallback()
    }
  },
  write: (scope: string, value: TValue) => {
    try {
      localStorageOrNull()?.setItem(options.key(scope), options.serialize(value))
    } catch {}
  },
})
