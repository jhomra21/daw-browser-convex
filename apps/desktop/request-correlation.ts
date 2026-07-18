import { randomUUID } from "node:crypto"

export const createRequestCorrelation = () => {
  const internalByExternal = new Map<string, string>()
  const externalByInternal = new Map<string, string>()
  return {
    create(externalId: string) {
      const internalId = randomUUID()
      internalByExternal.set(externalId, internalId)
      externalByInternal.set(internalId, externalId)
      return internalId
    },
    getInternal(externalId: string) {
      return internalByExternal.get(externalId)
    },
    getExternal(internalId: string) {
      return externalByInternal.get(internalId)
    },
    removeExternal(externalId: string) {
      const internalId = internalByExternal.get(externalId)
      if (!internalId) return undefined
      internalByExternal.delete(externalId)
      externalByInternal.delete(internalId)
      return internalId
    },
    internalIds() {
      return internalByExternal.values()
    },
    clear() {
      internalByExternal.clear()
      externalByInternal.clear()
    },
  }
}
