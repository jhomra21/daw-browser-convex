import type createFuzzHost from "./ae-08-processor-state-fuzz-host"
import type { Mark } from "./ae-08-processor-state-fuzz-hook-checks"

type Host = ReturnType<typeof createFuzzHost>

// Witnesses that judge the native bank and asset ownership the host decoded.
// Returns whether the mode was one of them, in which case no other check applies.
export default function bankChecks(mode: string, { h, marks, mark, quiescent, checked, fail, record, populatedOwnershipChecks }: {
  h: Host; marks: ReadonlyMap<string, Mark>; mark: () => Mark; quiescent: () => boolean
  checked: (invariant: string) => void
  fail: (invariant: string, detail: string, domain: string, failureClass: string) => void
  record: <Value>(event: Value) => void
  populatedOwnershipChecks: () => number
}) {
  if (mode === "asset-released") {
    const held = marks.get("asset-hold")
    if (!held) throw new Error("Asset-wait witness has no hold mark")
    if (!quiescent()) throw new Error("Asset-wait witness has unresolved scheduler dependencies")
    checked("I1"); checked("I5")
    if (!populatedOwnershipChecks() || !h.leases.size) throw new Error("Asset-wait witness has no populated ownership")
    // The candidate already prepared when the wait began completes (the controller serializes it);
    // nothing else stale may prepare and every prepare publishes.
    const now = mark()
    const prepared = now.prepares - held.prepares
    const published = now.publishes - held.publishes
    if (prepared < 1 || prepared > 2 || prepared !== published)
      fail("I1", `Superseded compile prepared or promoted after the asset wait (prepares ${prepared}, publishes ${published})`, "live", "stale-compile")
    // Survivor content, decoded from the active bank. The scenario declares the latest clip's timing
    // independently of the fixture; a candidate published at a seam only schedules from that seam, so the
    // expected start is the declared start clamped to the seam. Stop and source count are exact.
    const declared = (name: string) => {
      const value = marks.get(name)?.value
      if (value === undefined) throw new Error(`Asset-wait witness has no declared ${name}`)
      return BigInt(value)
    }
    const expectedStart = declared("expected-start"), expectedStop = declared("expected-stop"), expectedSources = Number(declared("expected-sources"))
    const seam = h.activeBank.seam ?? 0n
    const windowStart = seam > expectedStart ? seam : expectedStart
    // Events are the bank's lossless ledger (sequence and source node), so two events on one asset stay two.
    const decoded = [...h.activeBank.events.values()]
    const wrong = decoded.filter((event) => event.start !== windowStart || event.stop !== expectedStop)
    if (decoded.length !== expectedSources || wrong.length)
      fail("I1", `Active bank does not hold the declared survivor: expected ${expectedSources} event(s) starting at frame ${windowStart} (declared start ${expectedStart}, seam ${seam}) and stopping at ${expectedStop}, decoded ${decoded.length}: ${JSON.stringify(decoded.map((event) => ({ sequence: String(event.sequence), asset: event.assetId, start: String(event.start), stop: String(event.stop) })))}; unexpected or stale event(s) ${JSON.stringify(wrong.map((event) => String(event.sequence)))}`, "live", "stale-compile")
    record({ witness: mode, held, now: { prepares: now.prepares, publishes: now.publishes }, leases: [...h.leases] })
    return true
  }
  if (mode === "sample-swap") {
    const before = marks.get("pre-swap")
    if (!before) throw new Error("Swap witness has no pre-swap mark")
    if (!quiescent()) throw new Error("Swap witness has unresolved scheduler dependencies")
    checked("I1"); checked("I5")
    const installed = [...h.assets.keys()].filter((id) => !before.assets.includes(id))
    const retired = before.assets.filter((id) => h.assets.get(id)?.released !== false)
    const bank = [...h.activeBank.sources.keys()]
    // Past the clip in a long loop the active bank legitimately holds no source yet.
    if (!installed.length || retired.length !== before.assets.length || (!bank.length && before.value !== 1)
      || bank.some((id) => before.assets.includes(id) || !installed.includes(id)))
      fail("I1", `Sample swap left the superseded asset live (before ${JSON.stringify(before.assets)}, installed ${JSON.stringify(installed)}, bank ${JSON.stringify(bank)})`, "live", "stale-compile")
    record({ witness: mode, before: before.assets, installed, bank })
    return true
  }
  return false
}
