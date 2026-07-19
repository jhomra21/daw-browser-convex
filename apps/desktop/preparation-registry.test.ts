import { describe, expect, test } from "bun:test"
import { createPreparationRegistry } from "./preparation-registry"

describe("preparation registry", () => {
  test("aborts and removes all registered preparations", () => {
    const registry = createPreparationRegistry()
    const first = new AbortController()
    const second = new AbortController()
    registry.add(first)
    registry.add(second)
    registry.abortAll()
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(registry.size()).toBe(0)
  })
})
