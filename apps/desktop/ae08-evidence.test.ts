import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAe08Evidence } from "./ae08-evidence"

test("an unavailable evidence directory cannot throw into desktop control", () => {
  const evidence = createAe08Evidence(path.join(tmpdir(), `missing-ae08-${crypto.randomUUID()}`))
  expect(evidence).toBeFunction()
  expect(() => evidence?.("host-spawn", { pid: 1 })).not.toThrow()
})
