import { expect, test } from "bun:test"
import { desktopAcceptanceObserver } from "./acceptance-observer"

test("observer failures never throw into the product path", () => {
  const marked: string[] = []
  const throwing = desktopAcceptanceObserver({ acceptance: { externalNativeSession: false, mark: () => { throw new Error("ipc closed") } } })
  expect(() => throwing?.mark("ui-undo", () => "key")).not.toThrow()
  expect(() => throwing?.ui("ui-undo", () => "target")).not.toThrow()
  expect(() => throwing?.adoption("intent")?.("step")).not.toThrow()

  const failingKey = desktopAcceptanceObserver({ acceptance: { externalNativeSession: false, mark: (name) => { marked.push(name) } } })
  expect(() => failingKey?.mark("ui-undo", () => { throw new Error("key failed") })).not.toThrow()
  expect(() => failingKey?.ui("ui-undo", () => { throw new Error("target failed") })).not.toThrow()
  expect(marked).toEqual([])
})
