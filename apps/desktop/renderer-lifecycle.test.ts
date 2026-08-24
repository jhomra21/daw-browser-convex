import { expect, test } from "bun:test"
import { createRendererLifecycleOwner } from "./renderer-lifecycle"

test("invalidates one renderer generation at most once", () => {
  const lifecycle = createRendererLifecycleOwner()
  expect(lifecycle.invalidate()).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.invalidate()).toBeUndefined()
  expect(lifecycle.generation()).toBe(1)
})

test("a new document generation can be invalidated after the first loss", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.invalidate()
  lifecycle.markDocumentLoaded()
  expect(lifecycle.invalidate()).toEqual({ previousGeneration: 1, generation: 2 })
})
