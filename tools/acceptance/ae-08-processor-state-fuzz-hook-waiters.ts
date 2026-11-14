import { z } from "zod"
import type createFuzzHost from "./ae-08-processor-state-fuzz-host"
import { endingRejectionClass, rejectionClassification, type Content } from "./ae-08-processor-state-fuzz-oracle"

type Host = ReturnType<typeof createFuzzHost>
type Waiter = {
  id: number; name: string; settled: boolean; result?: unknown; content: Content
  domain: number; epoch: number; incarnation: number; fieldOrder: number; removal: number; targetPresent: boolean
  applicationStart: number; nativeSequence?: number; settledDomain?: string
}

// Every controller request the fixture awaits, with the edit order, domain and
// application proofs needed to judge its settlement or rejection afterwards.
export default function createWaiterLedger({ h, mutation, record, fail, checked, desired, prepared }: {
  h: Host; mutation?: string
  record: <Value>(event: Value) => void
  fail: (invariant: string, detail: string, domain?: string, failureClass?: string,
    reason?: string | null, error?: string | null, transition?: string | null) => void
  checked: (invariant: string) => void
  desired: () => Content
  prepared: () => boolean
}) {
  const waiters: Waiter[] = []
  const rejections: Waiter[] = []
  const rejectionClasses: { id: number; name: string; classification: string; domain: string; class?: string }[] = []
  let gainOrder = 0
  let fftOrder = 0
  const gainBoundaries: number[] = []
  const fftBoundaries: number[] = []
  let confirmedGain = 0
  let confirmedOrder = 1
  let removal = 0
  const confirm = (sequence: number, gain: number) => {
    if (sequence >= confirmedOrder) { confirmedGain = gain; confirmedOrder = sequence }
  }
  const watch = <Value>(name: string, promise: Promise<Value>, content = desired()) => {
    const submittedNative = h.nativeFields(h.active)
    const waiter: Waiter = { id: ++h.nextId, name, settled: false, content: { ...content },
      removal, targetPresent: desired().utilityPresent !== false,
      domain: h.domain, epoch: h.epoch, incarnation: h.utilityIncarnation,
      fieldOrder: name === "latency" ? fftOrder : gainOrder, applicationStart: h.applications.length,
      nativeSequence: h.lastParameterSequence }
    waiters.push(waiter)
    void promise.then((result) => {
      if (mutation === "swallow-waiter" && name === "wrapper-waiter"
        || mutation === "never-wake-latency" && name === "latency") return
      waiter.settled = true; waiter.result = result
      const settlementId = h.nextId
      const transition = h.domainCommands.find((command) => command.id > waiter.id && command.id <= settlementId)
      waiter.settledDomain = h.lost ? "dead-host" : !waiter.targetPresent || waiter.removal !== removal ? "ending-incarnation"
        : transition || waiter.domain !== h.domain || waiter.epoch !== h.epoch ? "ending-transport-domain"
        : !prepared() ? "dead-session"
        // As the controller fixture: an edit for a target native's graph does not carry cannot reach native.
        : waiter.incarnation !== h.utilityIncarnation
          || ((name === "flush" || name === "preview") && h.nativeFields(h.active).gain === null) ? "ending-incarnation" : "live"
      record({ event: "settled", id: waiter.id, settlementId, name, result, domain: waiter.settledDomain, transition: transition?.name })
      if (z.object({ state: z.literal("applied") }).safeParse(result).success && ["preview", "flush", "mutation-preview", "wrapper-flush"].includes(name)) {
        checked("I3")
        // The scenario domain counter also increments for a no-op pause. It is not a native identity.
        // Queued work may be re-stamped at a transport change, but cannot cross a target incarnation.
        const proven = submittedNative.gain === waiter.content.gain || h.applications.slice(waiter.applicationStart).some(application =>
          application.incarnation === waiter.incarnation && application.content.gain === waiter.content.gain)
        if (!proven) {
          record({ event: "unproven-receipt", waiter, submittedNative, applications: h.applications.slice(waiter.applicationStart) })
          fail("I3", "Applied receipt names gain never applied by callback")
        }
        confirm(waiter.content.sequence, waiter.content.gain)
      }
      if (name === "mutation-preview" && z.object({ state: z.enum(["refused", "unconfirmed"]) }).safeParse(result).success)
        rejections.push(waiter)
    }, (error) => { waiter.settled = true; waiter.result = String(error); record({ event: "rejected", id: waiter.id, name, error: String(error) }) })
    return waiter
  }
  const checkRejections = () => {
    for (const waiter of rejections.splice(0)) {
      const domain = waiter.settledDomain ?? "dead-session"
      const result = z.object({ reason: z.string().optional(), error: z.string().optional() }).safeParse(waiter.result)
      const reason = result.success ? result.data.reason ?? null : null
      const error = result.success ? result.data.error ?? null : null
      const endingClass = endingRejectionClass(domain, result.success ? result.data.reason : undefined)
      if (endingClass) {
        rejectionClasses.push({ id: waiter.id, name: waiter.name, classification: "stale-ending-domain", domain, class: endingClass })
        checked("I7")
        fail("I7", `Pause/seek flush settled stale: ${waiter.id}`, domain, endingClass, reason, error, "transport")
        continue
      }
      const latency = waiter.name === "latency"
      const boundary = (latency ? fftBoundaries : gainBoundaries)[waiter.fieldOrder]
      const applied = h.applications.slice(waiter.applicationStart).some((proof, index) =>
        proof.domain === waiter.domain && proof.epoch === waiter.epoch
        && (latency ? proof.strategy === "publication" && proof.content.fft === waiter.content.fft
          && proof.content.latency === waiter.content.fft && (boundary === undefined || waiter.applicationStart + index < boundary)
          : proof.incarnation === waiter.incarnation && proof.content.gain === waiter.content.gain
            && (proof.strategy === "parameters" ? proof.sequence === waiter.nativeSequence
              : boundary === undefined || waiter.applicationStart + index < boundary)))
      const classification = domain === "live"
        ? rejectionClassification(applied, (latency ? fftOrder : gainOrder) > waiter.fieldOrder) : "cancelled"
      const failureClass = latency ? applied ? "latency-after-publish-false-rejection" : "latency-before-publish-lost-edit"
        : applied ? "restamp-timeout" : "stale-stamp-at-dispatch/host-refused/resend"
      rejectionClasses.push({ id: waiter.id, name: waiter.name, classification, domain, class: classification === "cancelled" ? undefined : failureClass })
      if (domain !== "live") continue
      checked(classification === "lost-edit" ? "I1" : "I3")
      if (classification !== "rejected-then-superseded")
        fail(classification === "lost-edit" ? "I1" : "I3", `${classification}: ${waiter.name} ${waiter.id}`, domain, failureClass, reason, error)
    }
  }
  return {
    waiters, rejectionClasses, watch, checkRejections, confirm,
    // A terminal or fallback result the caller must judge in the next check.
    refuse: (waiter: Waiter) => { rejections.push(waiter) },
    confirmed: () => ({ gain: confirmedGain, order: confirmedOrder }),
    resetConfirmed: () => { confirmedOrder = 1 },
    beginGainEdit: () => { gainBoundaries.push(h.applications.length); gainOrder++ },
    beginLatencyEdit: () => { fftBoundaries.push(h.applications.length); fftOrder++ },
    removeTarget: () => { removal++ },
  }
}
