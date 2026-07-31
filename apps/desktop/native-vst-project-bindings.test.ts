import { expect, test } from "bun:test"
import { createNativeVstProjectBindings } from "./native-vst-project-bindings"

test("publishes only committed staged bindings", () => {
  const bindings = createNativeVstProjectBindings()
  bindings.stage(["one"], "project-a")
  expect(bindings.projectFor("one")).toBeUndefined()
  bindings.commit()
  expect(bindings.projectFor("one")).toBe("project-a")
})

test("rollback preserves prior bindings and a later commit replaces them", () => {
  const bindings = createNativeVstProjectBindings()
  bindings.stage(["one"], "project-a")
  bindings.commit()
  bindings.stage(["two"], "project-b")
  bindings.rollback()
  expect(bindings.projectFor("one")).toBe("project-a")
  bindings.stage(["two"], "project-b")
  bindings.commit()
  expect(bindings.projectFor("one")).toBeUndefined()
  expect(bindings.projectFor("two")).toBe("project-b")
})

test("detach and clear remove ownership", () => {
  const bindings = createNativeVstProjectBindings()
  bindings.stage(["one", "two"], "project-a")
  bindings.commit()
  bindings.remove("one")
  expect(bindings.matches("one", "project-a")).toBeFalse()
  bindings.clear()
  expect(bindings.projectFor("two")).toBeUndefined()
})
