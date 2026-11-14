import { z } from "zod"
import type { SpoolProof } from "./native-spool-evidence"

const prefix = "[recording-spool-order] "
const phases = ["receipt-file-synced", "receipt-directory-synced", "source-unlink-started", "source-unlinked", "source-directory-synced"]
const integer = z.number().int().nonnegative().safe()
const eventSchema = z.object({
  version: z.literal(1), releaseOrdinal: integer.min(1), sequence: integer.min(1),
  kind: z.enum(["receipt-file-synced", "receipt-directory-synced", "source-unlink-started", "source-unlinked", "source-directory-synced"]),
  succeeded: z.boolean(), frames: integer, bytes: integer, blocks: integer,
  sampleRateHz: integer.min(8000).max(384000), channelCount: z.union([z.literal(1), z.literal(2)]),
}).strict()
export type SpoolOrderEvent = z.infer<typeof eventSchema>
type Evidence = { ready: boolean; invalid: boolean; overflow: boolean; events: SpoolOrderEvent[] }

// Only the proposed approved main-side hook may emit these operation-success
// facts. File existence, fs.watch and renderer messages never feed this collector.
export const createSpoolOrderCollector = () => {
  const evidence: Evidence = { ready: false, invalid: false, overflow: false, events: [] }
  const waiters = new Set<() => void>()
  let closed = false
  const notify = () => { for (const waiter of waiters) waiter() }
  const terminal = () => evidence.invalid || evidence.overflow
    || evidence.events.some((event) => !event.succeeded || event.kind === "source-directory-synced")
  return {
    observeLine(line: string) {
      if (!line.startsWith(prefix)) return
      try {
        if (line.length > 1024) throw new Error("Oversized order event.")
        const value = JSON.parse(line.slice(prefix.length))
        const ready = z.object({ version: z.literal(1), kind: z.literal("observer-ready") }).strict().safeParse(value)
        if (ready.success) {
          if (evidence.ready || evidence.events.length) evidence.invalid = true
          evidence.ready = true
        } else {
          const event = eventSchema.parse(value)
          if (!evidence.ready) evidence.invalid = true
          if (evidence.events.length === 16) evidence.overflow = true
          else evidence.events.push(event)
        }
      } catch { evidence.invalid = true }
      notify()
    },
    evidence: (): Evidence => ({ ...evidence, events: evidence.events.map((event) => ({ ...event })) }),
    async waitForTerminal(timeoutMs: number) {
      if (closed) throw new Error("Spool durability observation closed.")
      if (terminal()) return
      // One bounded pipe-drain observation timer, never a native Finish deadline.
      // Every completion, timeout and close clears it and unregisters the waiter.
      await new Promise<void>((resolve, reject) => {
        const settle = () => {
          if (!closed && !terminal()) return
          clearTimeout(timer); waiters.delete(settle)
          if (closed) reject(new Error("Spool durability observation closed."))
          else resolve()
        }
        const timer = setTimeout(() => {
          waiters.delete(settle)
          reject(new Error("Spool durability observation unavailable within bounded wait."))
        }, timeoutMs)
        waiters.add(settle)
      })
    },
    close() { closed = true; notify() },
  }
}
export const assessSpoolDurability = (
  evidence: Evidence, proof: SpoolProof,
  context: { savedClipObserved: boolean; assetObserved: boolean; releaseCalls: number; originalReleaseSucceeded: boolean },
) => [
  !evidence.ready || evidence.events.length !== phases.length ? "durable-sync-before-unlink-unavailable" : null,
  evidence.invalid || evidence.overflow ? "durability-observer-invalid" : null,
  evidence.events.some((event, index) => event.kind !== phases[index] || event.sequence !== index + 1
    || event.releaseOrdinal !== 1) ? "durability-event-order" : null,
  evidence.events.some((event) => !event.succeeded) ? "durability-operation-failed" : null,
  evidence.events.some((event) => event.frames !== proof.frames || event.bytes !== proof.bytes
    || event.blocks !== proof.blocks || event.sampleRateHz !== proof.sampleRateHz
    || event.channelCount !== proof.channelCount) ? "durability-proof" : null,
  !context.savedClipObserved || !context.assetObserved ? "saved-clip-asset-before-release" : null,
  context.releaseCalls !== 1 || !context.originalReleaseSucceeded ? "durability-release" : null,
].filter((issue) => issue !== null)
