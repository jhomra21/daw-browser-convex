import { expect, test } from "bun:test"
import { importLocalDawProjectFile } from "./project-archive-import-choice"

test("routes a 773 MiB stored ZIP to bounded streamed import", async () => {
  const calls: string[] = []
  const file = new File([], "30-track-v3.dawproject")
  Object.defineProperty(file, "size", { value: 773_440_716 })
  const imported = await importLocalDawProjectFile(file, {
    legacy: async () => { calls.push("legacy"); return "legacy" },
    streamed: async () => { calls.push("streamed"); return "restored" },
  })
  expect(imported).toBe("restored")
  expect(calls).toEqual(["streamed"])
})

test("preserves the existing small-archive import path", async () => {
  const calls: string[] = []
  await importLocalDawProjectFile(new File([], "small.dawproject"), {
    legacy: async () => { calls.push("legacy"); return "restored" },
    streamed: async () => { calls.push("streamed"); return "wrong" },
  })
  expect(calls).toEqual(["legacy"])
})
