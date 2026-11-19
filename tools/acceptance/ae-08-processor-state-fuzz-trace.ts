import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

export const traceSchema = z.enum(["failures", "all", "none"])
export type Trace = z.infer<typeof traceSchema>

// Per-seed artifact policy. events.jsonl streams while the seed runs, so an outer
// alarm still leaves evidence, and is compressed or dropped once the status is
// known. Nothing in the fuzzer reads the compressed files back. Files that
// --replay consumes stay plain.
export type SeedTrace = ReturnType<typeof createSeedTrace>
export default function createSeedTrace(trace: Trace, directory: string, serialize: <Value>(value: Value) => string) {
  if (trace !== "none") mkdirSync(directory, { recursive: true })
  const events = trace === "none" ? undefined : path.join(directory, "events.jsonl")
  if (events) writeFileSync(events, "")
  const keeps = (status: string) => trace === "all" || trace === "failures" && status !== "pass"
  return {
    record: (line: string) => { if (events) appendFileSync(events, line) },
    seed: <Value>(value: Value) => { if (trace !== "none") writeFileSync(path.join(directory, "seed.json"), serialize(value)) },
    // Read back by --replay: always plain.
    replayable: <Value>(status: string, name: string, value: Value) => {
      if (keeps(status)) writeFileSync(path.join(directory, name), serialize(value))
    },
    bulky: <Value>(status: string, name: string, value: Value) => {
      if (!keeps(status)) return
      if (trace === "failures") writeFileSync(path.join(directory, `${name}.zst`), Bun.zstdCompressSync(serialize(value)))
      else writeFileSync(path.join(directory, name), serialize(value))
    },
    finish: (status: string) => {
      if (!events || trace === "all") return
      if (keeps(status)) writeFileSync(`${events}.zst`, Bun.zstdCompressSync(readFileSync(events)))
      rmSync(events)
    },
  }
}
