export type RuntimeFaultKind = 'compressor' | 'owned-processor' | 'track-meter' | 'recorder'

export type RuntimeFault = {
  kind: RuntimeFaultKind
  code: string
  context?: string
}

export type RuntimeFaultSnapshot = {
  eventCount: number
  uniqueSignatureCount: number
  byKind: Readonly<Record<RuntimeFaultKind, number>>
  last: RuntimeFault | null
}

export type ResourceObserver = {
  acquire: (kind: string, id: object | string) => () => void
}

export const observeResource = (
  observer: ResourceObserver | undefined,
  kind: string,
  id: object | string,
): (() => void) => observer?.acquire(kind, id) ?? (() => undefined)

const emptyCounts = (): Record<RuntimeFaultKind, number> => ({
  compressor: 0,
  'owned-processor': 0,
  'track-meter': 0,
  recorder: 0,
})

export const createRuntimeFaultCounter = (limit = 256) => {
  let generation = 0
  let eventCount = 0
  let byKind = emptyCounts()
  let last: RuntimeFault | null = null
  const seen = new Set<string>()

  return {
    generation: () => generation,
    report(faultGeneration: number, fault: RuntimeFault) {
      if (faultGeneration !== generation) return false
      const key = `${fault.kind}\0${fault.code}\0${fault.context ?? ''}`
      eventCount += 1
      byKind[fault.kind] += 1
      if (!seen.has(key) && seen.size < limit) {
        seen.add(key)
        last = fault
      }
      return true
    },
    reset() {
      generation += 1
      eventCount = 0
      byKind = emptyCounts()
      last = null
      seen.clear()
      return generation
    },
    snapshot: (): RuntimeFaultSnapshot => ({
      eventCount,
      uniqueSignatureCount: seen.size,
      byKind: { ...byKind },
      last,
    }),
  }
}
