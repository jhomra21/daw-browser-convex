type CacheEntry<Value> = { value: Value; bytes: number; pins: number }

type SamplerBufferCachePin = {
  release: () => void
}

export function createSamplerBufferCache<Value>(
  maxBytes: number,
  onEvict?: (key: string, value: Value) => void,
) {
  const entries = new Map<string, CacheEntry<Value>>()
  const retired = new Set<CacheEntry<Value>>()
  const pinEntries = new WeakMap<SamplerBufferCachePin, CacheEntry<Value>>()
  let byteLimit = maxBytes
  let bytes = 0

  const touch = (key: string, entry: CacheEntry<Value>) => {
    entries.delete(key)
    entries.set(key, entry)
  }

  const evict = () => {
    const evicted: [string, Value][] = []

    while (bytes > byteLimit) {
      const candidate = Array.from(entries).find(([, entry]) => entry.pins === 0)

      if (!candidate) break
      entries.delete(candidate[0])
      bytes -= candidate[1].bytes
      evicted.push([candidate[0], candidate[1].value])
    }

    for (const [key, value] of evicted) onEvict?.(key, value)
  }

  const removeRetired = (entry: CacheEntry<Value>) => {
    if (!retired.delete(entry)) return
    bytes -= entry.bytes
  }

  const releasePin = (pin: SamplerBufferCachePin) => {
    const entry = pinEntries.get(pin)

    if (!entry) return
    pinEntries.delete(pin)

    if (entry.pins > 0) entry.pins -= 1

    if (retired.has(entry) && entry.pins === 0) removeRetired(entry)
    evict()
  }

  const createPin = (entry: CacheEntry<Value>): SamplerBufferCachePin => {
    entry.pins += 1
    const pin: SamplerBufferCachePin = { release: () => releasePin(pin) }
    pinEntries.set(pin, entry)

    return pin
  }

  return {
    get: (key: string) => {
      const entry = entries.get(key)

      if (!entry) return undefined
      touch(key, entry)

      return entry.value
    },
    set: (key: string, value: Value, entryBytes: number) => {
      const existing = entries.get(key)

      if (existing?.pins) {
        entries.delete(key)
        retired.add(existing)
      } else if (existing) bytes -= existing.bytes
      const normalizedBytes = Math.max(0, entryBytes)
      entries.set(key, { value, bytes: normalizedBytes, pins: 0 })
      bytes += normalizedBytes
      evict()
    },
    pin: (key: string) => {
      const entry = entries.get(key)

      if (!entry) return undefined
      const pin = createPin(entry)
      touch(key, entry)

      return pin
    },
    unpin: (pin: SamplerBufferCachePin) => {
      pin.release()
    },
    delete: (key: string) => {
      const entry = entries.get(key)

      if (!entry) return

      if (entry.pins > 0) {
        entries.delete(key)
        retired.add(entry)
      } else {
        entries.delete(key)
        bytes -= entry.bytes
      }
    },
    clear: () => {
      entries.clear()
      retired.clear()
      bytes = 0
    },
    keys: () => Array.from(entries.keys()),
    pinnedKeys: () => Array.from(entries)
      .filter(([, entry]) => entry.pins > 0)
      .map(([key]) => key),
    byteLengthFor: (key: string) => entries.get(key)?.bytes ?? 0,
    byteLength: () => bytes,
    maxByteLength: () => byteLimit,
    setMaxByteLength: (nextMaxBytes: number) => {
      byteLimit = Math.max(0, nextMaxBytes)
      evict()
    },
    overBudgetPinned: () => bytes > byteLimit,
  }
}
