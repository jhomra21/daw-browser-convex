import { describe, expect, test } from "bun:test"
import { createRequestCorrelation } from "./request-correlation"

describe("desktop request correlation", () => {
  test("uses bounded internal UUIDs for maximum-length external IDs", () => {
    const correlation = createRequestCorrelation()
    const externalId = "x".repeat(96)
    const internalId = correlation.create(externalId)

    expect(internalId).toHaveLength(36)
    expect(correlation.getExternal(internalId)).toBe(externalId)
    expect(correlation.removeExternal(externalId)).toBe(internalId)
    expect(correlation.getExternal(internalId)).toBeUndefined()
  })

  test("isolates the same external ID in separate client sessions", () => {
    const firstClient = createRequestCorrelation()
    const secondClient = createRequestCorrelation()
    const externalId = "request-1"

    expect(firstClient.create(externalId)).not.toBe(secondClient.create(externalId))
    expect(firstClient.removeExternal(externalId)).toBeDefined()
    expect(secondClient.getInternal(externalId)).toBeDefined()
  })
})
