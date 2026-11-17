import { expect, test } from "bun:test"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAe08Evidence } from "./ae08-evidence"

test("an unavailable evidence directory cannot throw into desktop control", () => {
  const previousDirectory = process.env.DAW_AE08_EVIDENCE_DIR
  process.env.DAW_AE08_EVIDENCE_DIR = path.join(tmpdir(), `missing-ae08-${crypto.randomUUID()}`)
  try {
    const evidence = createAe08Evidence(process.env.DAW_AE08_EVIDENCE_DIR)
    expect(evidence).toBeDefined()
    expect(() => evidence?.("host-spawn", { pid: 1 })).not.toThrow()
    expect(evidence?.writeFailures()).toBe(1)
  } finally {
    if (previousDirectory === undefined) delete process.env.DAW_AE08_EVIDENCE_DIR
    else process.env.DAW_AE08_EVIDENCE_DIR = previousDirectory
  }
})
