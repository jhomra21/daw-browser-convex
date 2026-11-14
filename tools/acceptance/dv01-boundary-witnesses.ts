// DV01 boundary witnesses for the ledger (L1-L7) and the supervisor/main adapters.
// Run: bun tools/acceptance/dv01-boundary-witnesses.ts
// Writes witnesses/step1-m2b.json under the boundary report directory. Every witness drives the real
// `createNativeProcessorStateOwner` through the API the controller uses; a witness is `green` when the designed
// behaviour holds and `red` when it does not. The runner exits non-zero if any is red.
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import "fake-indexeddb/auto"
import { batch, createComputed, createRoot, createSignal } from "solid-js"
import { createPersistedEffectState } from "../../src/components/timeline/create-persisted-effect-state"
import { createParameterGestureOwner, ParameterGestureHolder, parameterSaveResult, type ParameterSaveResult } from "../../src/components/timeline/parameter-gesture-owner"
import type { DeliveryRegistration, ProcessorDeliveryOutcome } from "../../src/lib/live-processor-control"
import { publishSharedTimelineOperation, decodeEffectsOperationResult } from "../../src/lib/shared-timeline-operations-api"
import { setLocalEffect, setLocalEffectInstance, listLocalEffects } from "../../src/lib/local-effects"
import { createLocalEffectsViewOwner } from "../../src/components/timeline/create-local-effects-view"
import { AUDIO_EFFECT_CONTRACTS, createDefaultUtilityParams } from "@daw-browser/shared"
import type { EngineDisposition } from "@daw-browser/audio-engine/audio-engine"
import { openLocalProjectDb } from "../../src/lib/local-project-db"
import { publishDurableEffectsOperation, readSharedOutboxOperation, flushSharedOutbox, subscribeToSharedOutboxSettlements } from "../../src/lib/shared-outbox"
import { z } from "zod"
import {
  NativeAudioHostCommandError,
  NativeAudioHostNotSentError,
  decodeNativeProcessorPatchStatus,
  nativeDeliveryFailureKind,
  nativeProcessorPatchReply,
} from "../../apps/desktop/audio-host"
import {
  createNativeProcessorStateOwner,
  type Delivery,
  type Execution,
  type PatchReply,
  type ProcessorDesired,
} from "../../src/lib/desktop/native-processor-state-owner"
import type { AudioCoreSynthState } from "@daw-browser/audio-core-contract"
import type { NativeScheduleProgress } from "@daw-browser/audio-engine/native-host-wire"

type Check = () => string | undefined | Promise<string | undefined>
type Witness = { name: string; milestone: 1 | 2; mutation: string; check: Check }
type Owner = ReturnType<typeof createNativeProcessorStateOwner>

const outputIndex = process.argv.indexOf("--out")
const outputArgument = outputIndex < 0 ? undefined : process.argv[outputIndex + 1]
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) throw new Error("--out requires a directory")
const reportDirectory = outputArgument ? path.resolve(outputArgument) : path.join(
  import.meta.dirname, "../../acceptance-reports/device-control-cost-2026-10-31/dv01-parent/boundary/witnesses",
)

const statusPayload = (outcome: number, refusal: number, core: number, token: bigint) => {
  const payload = Buffer.alloc(20)
  payload.writeUInt32BE(outcome, 0)
  payload.writeUInt32BE(refusal, 4)
  payload.writeUInt32BE(core, 8)
  payload.writeBigUInt64BE(token, 12)
  return payload
}

const gain = "utility.gainDb"
const bytes = (value: number) => new Uint8Array([value & 255])
const desiredFor = (key: string, id: string, order: number, value: number, state = value): ProcessorDesired => ({
  id, order, target: { nodeId: "master", instanceId: key, kindId: 1, incarnation: 1 },
  content: { state: bytes(state), params: { gain: value }, values: { [gain]: value } }, bypassed: false, tailFrames: 0,
})
const frame = (sequence: number, processorSequence = 0, urgentSequence = 0): NativeScheduleProgress => ({
  revision: 1, epoch: 1, progressSequence: BigInt(sequence), renderedThroughFrame: 0n, acceptedThroughFrame: 0n,
  lastAcceptedWindowId: 0n, appliedTransportTransitionId: 0n, appliedUrgentSequence: BigInt(urgentSequence),
  appliedProcessorSequence: BigInt(processorSequence), running: true, scheduleComplete: false,
  instrumentCredits: 0, sourceCredits: 0, automationCredits: 0,
})
const kinds = new Map([["A", 1], ["B", 1]])
const turns = async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }

type Notice = { category: "refused" | "unconfirmed"; targets: number }
const ledgerWithNotices = () => {
  const notices: Notice[] = []
  return { notices, ledger: createNativeProcessorStateOwner({ reportIncident: (category, targets) => { notices.push({ category, targets }) } }) }
}
type Answer = { value: ProcessorDeliveryOutcome | undefined }
const answerOf = (delivery: Delivery) => {
  const box: Answer = { value: undefined }
  void delivery.receipt.settled.then((outcome) => { box.value = outcome })
  return box
}
const stateOf = (answer: Answer) => answer.value?.state ?? "pending"

// A patch delivery of state/value `value` for `key` (state defaults to the value so contents differ by value).
const deliverPatch = (ledger: Owner, key: string, id: string, order: number, value: number, state = value) =>
  ledger.deliver({
    key, editId: id, order, kindId: 1, incarnation: 1, epoch: 1, state: bytes(state), values: { [gain]: value },
    desired: desiredFor(key, id, order, value, state),
  })
// A parameters-only delivery (no state): its plan carries the values to dispatch.
const deliverValue = (ledger: Owner, key: string, id: string, order: number, value: number, desired = false) =>
  ledger.deliver({
    key, editId: id, order, kindId: 1, incarnation: 1, epoch: 1, values: { [gain]: value },
    ...(desired && { desired: { ...desiredFor(key, id, order, value), content: { state: bytes(0), params: { gain: value }, values: { [gain]: value } } } }),
  })
// What the controller does with a parameters/urgent plan: register the record, then hand it to the bridge.
const dispatch = (ledger: Owner, delivery: Delivery, sequence: number, urgent = false): Execution => {
  const { plan, receipt } = delivery
  if (plan.carrier !== "parameters" && plan.carrier !== "urgent") throw new Error(`plan was ${plan.carrier}`)
  const execution = ledger.register({
    key: receipt.key, editId: `dispatch-${sequence}`, order: receipt.order, kindId: urgent ? 18 : 1, sequence,
    values: plan.values, strategy: urgent ? { kind: "urgent", sequence: 0 } : { kind: "parameters" }, receipts: [receipt],
  }, { epoch: 1, revision: 1 })
  ledger.send(execution, sequence, urgent ? sequence : undefined)
  ledger.admit(execution)
  return execution
}
const redispatch = (ledger: Owner, execution: Execution, sequence: number, urgent = false) => {
  ledger.rebind(execution, { epoch: 1, revision: 1 }, sequence)
  ledger.send(execution, sequence, urgent ? sequence : undefined)
  ledger.admit(execution)
}
const nextPatch = (ledger: Owner) => ledger.nextPatch((content) => content)
const sendPatch = (ledger: Owner) => {
  const next = nextPatch(ledger)
  if (!next) throw new Error("no patch to send")
  return next.execution
}
const applied: PatchReply = { kind: "applied" }
const refusedPatch: PatchReply = { kind: "refused", refusal: "invalid", transient: false }
const lostPatch: PatchReply = { kind: "unconfirmed" }
// One failed patch of `key`: sent, then refused for good.
const failPatch = (ledger: Owner, key: string, id: string, order: number, value: number) => {
  const delivery = deliverPatch(ledger, key, id, order, value)
  ledger.patchReplied(sendPatch(ledger), refusedPatch)
  return delivery
}
const recoverPatch = (ledger: Owner, key: string, id: string, order: number, value: number) => {
  const delivery = deliverPatch(ledger, key, id, order, value)
  ledger.patchReplied(sendPatch(ledger), applied)
  return delivery
}
const installed = (ledger: Owner, state = 0, values: Record<string, number> = { [gain]: 0 }) =>
  ledger.configured(0, new Map([["A", { kindId: 1, state: bytes(state), values }], ["B", { kindId: 1, state: bytes(state), values }]]))

const witnesses: Witness[] = [
  {
    name: "r2 older-publication-keeps-newer-synth", milestone: 2, mutation: "older-publication-supersedes",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      const state = { version: 1, kind: "synth", voiceCapacity: 8, outputLayout: "stereo" } satisfies AudioCoreSynthState
      const delivery = ledger.deliver({ key: "synth", editId: "newer", order: 11, kindId: 18, incarnation: 1,
        epoch: 1, instrument: state, values: {} })
      ledger.adopted(new Map([["synth", 18]]), new Set(), new Set(), 10, () => false,
        new Map([["synth", { kindId: 18, incarnation: 1, contentKey: "older-content", instrument: { ...state, voiceCapacity: 4 } }]]))
      return delivery.receipt.answered === undefined ? undefined : `older order 10 answered order 11 ${delivery.receipt.answered.state}`
    },
  },
  {
    name: "join-lifetime-not-matched", milestone: 2, mutation: "match-lifetime",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const receipt = ledger.join("sampled", 1, "content", 987)
      ledger.adopted(new Map([["sampled", 19]]), new Set(), new Set(), 1, () => false,
        new Map([["sampled", { kindId: 19, contentKey: "content", incarnation: receipt.incarnation }]]))
      await turns()
      return receipt.answered?.state === "applied" ? undefined : `matching content/incarnation with independent panel lifetime answered ${receipt.answered?.state ?? "pending"}`
    },
  },
  {
    name: "sampled-abort-and-readd", milestone: 2, mutation: "no-incarnation-on-readd",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.configured(0, new Map([["sampled", { kindId: 19, contentKey: "content" }]]))
      const old = ledger.join("sampled", 1, "content", 5)
      ledger.adopted(new Map(), new Set(), new Set(), 1, () => false)
      const next = ledger.join("sampled", 2, "content", 5)
      if (old.incarnation === next.incarnation) return `remove/re-add reused incarnation ${old.incarnation}`
      ledger.adopted(new Map([["sampled", 19]]), new Set(), new Set(), 2, () => false,
        new Map([["sampled", { kindId: 19, contentKey: "content" }]]))
      return old.answered?.state !== "applied" && next.answered?.state === "applied"
        ? undefined : `old/new answers ${old.answered?.state}/${next.answered?.state}`
    },
  },
  {
    name: "sampled-incarnation-mismatch", milestone: 2, mutation: "ignore-incarnation",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      const receipt = ledger.join("sampled", 1, "content", 5)
      ledger.adopted(new Map([["sampled", 19]]), new Set(), new Set(), 1, () => false,
        new Map([["sampled", { kindId: 19, contentKey: "content", incarnation: receipt.incarnation + 1 }]]))
      return receipt.answered?.state !== "applied" ? undefined : "wrong incarnation certified sampled content"
    },
  },
  {
    name: "state-only-reset-with-live-override",
    milestone: 2,
    mutation: "r5-unknown-overrides-proven",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.configured(0, new Map([["A", { kindId: 1, state: bytes(0), values: { [gain]: 0 } }]]))
      const override = ledger.register({
        key: "A", editId: "override", order: 1, kindId: 1, sequence: 1,
        strategy: { kind: "parameters" }, values: new Map([[gain, -9]]),
      }, { epoch: 1, revision: 1 })
      ledger.send(override, 1)
      ledger.admit(override)
      ledger.observe(frame(1, 1))
      const reset = ledger.deliver({
        key: "A", editId: "state-only-reset", order: 2, kindId: 1, incarnation: 1, epoch: 1,
        state: bytes(0), values: {}, desired: {
          id: "state-only-reset", order: 2,
          target: { nodeId: "master", instanceId: "A", kindId: 1, incarnation: 1 },
          content: { state: bytes(0), params: {}, values: {} }, bypassed: false, tailFrames: 0,
        },
      })
      return reset.plan.carrier === "patch" ? undefined : `state-only reset selected ${reset.plan.carrier}, native override remains -9`
    },
  },
  {
    name: "token-beyond-safe-integer",
    milestone: 1,
    mutation: "token-as-number",
    check: () => {
      const decoded = decodeNativeProcessorPatchStatus(statusPayload(3, 0, 0, 2n ** 53n + 1n))
      if (decoded?.outcome !== "claimed") return "decode lost the claimed outcome"
      const reply = structuredClone(nativeProcessorPatchReply(decoded))
      if (!("token" in reply) || reply.token !== "9007199254740993") return `reply token is ${"token" in reply ? reply.token : "absent"}`
      return BigInt(reply.token) === 2n ** 53n + 1n ? undefined : "decimal text did not parse back to the u64"
    },
  },
  {
    name: "status-combos-validated",
    milestone: 1,
    mutation: "accept-any-combo",
    check: () => {
      const invalid = [
        statusPayload(1, 0, 0, 1n), statusPayload(3, 0, 0, 0n), statusPayload(2, 3, 0, 0n),
        statusPayload(2, 4, 0, 1n), statusPayload(2, 4, 3, 0n), statusPayload(2, 9, 0, 0n),
        statusPayload(0, 0, 0, 0n), statusPayload(1, 0, 0, 0n).subarray(0, 19),
      ]
      const accepted = invalid.findIndex((payload) => decodeNativeProcessorPatchStatus(payload) !== undefined)
      return accepted === -1 ? undefined : `invalid combination ${accepted} was accepted`
    },
  },
  {
    name: "kinds-parameter-urgent-patch",
    milestone: 1,
    mutation: "collapse-kinds",
    check: () => {
      const kindsSeen = [
        nativeDeliveryFailureKind(new NativeAudioHostCommandError(1)),
        nativeDeliveryFailureKind(new NativeAudioHostCommandError(1, "audio session is unavailable")),
        nativeDeliveryFailureKind(new NativeAudioHostCommandError(1, "any text", "unavailable")),
        nativeDeliveryFailureKind(new NativeAudioHostNotSentError("queue full")),
        nativeDeliveryFailureKind(new Error("control request timed out")),
        nativeDeliveryFailureKind(undefined),
      ]
      return kindsSeen.join(",") === "refused,refused,unavailable,unavailable,unconfirmed,unavailable" ? undefined : `kinds were ${kindsSeen.join(",")}`
    },
  },
  {
    name: "ledger-claims-by-token",
    milestone: 2,
    mutation: "claimed-as-refused",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = deliverPatch(ledger, "A", "p1", 2, -1)
      const answer = answerOf(delivery)
      ledger.patchReplied(sendPatch(ledger), { kind: "claimed", token: 7n })
      await turns()
      const fence = ledger.fence()
      if (fence.kind !== "claimed" || fence.token !== 7n || stateOf(answer) !== "pending") return `a claim is neither held nor unanswered (fence ${fence.kind}, answer ${stateOf(answer)})`
      ledger.resolution(7n, 0)
      await turns()
      return ledger.fence().kind === "open" && stateOf(answer) === "applied"
        ? undefined : `resolution 7/OK left fence ${ledger.fence().kind} and answer ${stateOf(answer)}`
    },
  },
  {
    name: "ledger-host-wide-patch-fence",
    milestone: 2,
    mutation: "fence-per-target",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      deliverPatch(ledger, "A", "a1", 2, -1)
      ledger.patchReplied(sendPatch(ledger), { kind: "claimed", token: 7n })
      deliverPatch(ledger, "B", "b1", 3, 2)
      const sentWhileClaimed = nextPatch(ledger)
      ledger.resolution(7n, 0)
      const sentAfter = nextPatch(ledger)
      await turns()
      return !sentWhileClaimed && sentAfter?.execution.key === "B"
        ? undefined : `another target's patch was ${sentWhileClaimed ? "sent while a claim was unresolved" : "not sent after the resolution"}`
    },
  },
  {
    name: "claim-blocks-target-until-resolution",
    milestone: 2,
    mutation: "claimed-after-window",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const first = answerOf(deliverPatch(ledger, "A", "p1", 2, -1))
      ledger.patchReplied(sendPatch(ledger), { kind: "claimed", token: 7n })
      const second = answerOf(deliverPatch(ledger, "A", "p2", 3, 2))
      const newerSendable = nextPatch(ledger) !== undefined
      await turns()
      if (newerSendable || stateOf(first) !== "pending") return `a newer patch was ${newerSendable ? "sendable" : "answered"} behind an unresolved claim (no frame was needed or sent)`
      ledger.resolution(7n, 0)
      const released = nextPatch(ledger)
      await turns()
      return released?.desired.order === 3 && stateOf(first) !== "pending" && stateOf(second) === "pending"
        ? undefined : "the token's resolution did not release the newer patch and answer the first"
    },
  },
  {
    name: "publication-supersedes-unsent",
    milestone: 2,
    mutation: "floor-answers",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const old = answerOf(deliverPatch(ledger, "A", "old", 2, -1))
      ledger.submit(desiredFor("A", "newer", 3, 0))
      ledger.adopted(kinds, new Set(), new Set(), 4, () => false)
      await turns()
      return old.value?.state === "superseded" ? undefined : `an unsent patch of content different from the newer desired was answered ${stateOf(old)} by the floor (designed: superseded)`
    },
  },
  {
    name: "same-content-retry-joins",
    milestone: 2,
    mutation: "requeue-new-receipt",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const first = deliverPatch(ledger, "A", "same-1", 2, 1)
      const firstAnswer = answerOf(first)
      ledger.patchReplied(sendPatch(ledger), { kind: "claimed", token: 7n })
      const again = deliverPatch(ledger, "A", "same-2", 3, 1)
      const againAnswer = answerOf(again)
      if (again.plan.carrier !== "none") return `the same content in flight was dispatched again (${again.plan.carrier})`
      if (stateOf(firstAnswer) !== "pending") return `the first receipt was ${stateOf(firstAnswer)} before any proof`
      ledger.resolution(7n, 0)
      await turns()
      return stateOf(firstAnswer) === "applied" && stateOf(againAnswer) === "applied" && again.receipt !== first.receipt
        ? undefined : "the two requests were not answered separately at the one proof"
    },
  },
  {
    name: "exhausted-refusal-terminal",
    milestone: 2,
    mutation: "no-terminal",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = deliverValue(ledger, "A", "r", 1, 0)
      const answer = answerOf(delivery)
      const carrier = dispatch(ledger, delivery, 1)
      const first = ledger.refuse(carrier, "definite")
      redispatch(ledger, carrier, 2)
      const second = ledger.refuse(carrier, "definite")
      await turns()
      const offered = ledger.reoffer()
      return first === "retry" && second === "ended" && answer.value?.state === "refused" && offered.length === 1
        ? undefined : `first ${first}, second ${second}, answer ${stateOf(answer)}, re-offered ${offered.length} (designed: retry, ended, refused, 1)`
    },
  },
  {
    name: "materialized-newer-supersedes-older",
    milestone: 2,
    mutation: "answer-materialized",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const older = answerOf(deliverPatch(ledger, "A", "older", 2, -1))
      const newer = answerOf(deliverPatch(ledger, "A", "newer", 3, 4))
      const sent = nextPatch(ledger)
      if (sent) ledger.patchReplied(sent.execution, applied)
      await turns()
      return sent?.desired.order === 3 && older.value?.state === "superseded" && newer.value?.state === "applied"
        ? undefined : `older ${stateOf(older)}, newer ${stateOf(newer)} (designed: superseded, applied)`
    },
  },
  {
    name: "ladder-without-caller",
    milestone: 2,
    mutation: "caller-map-gate",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = deliverValue(ledger, "A", "ladder", 2, 0, true)
      const carrier = dispatch(ledger, delivery, 1)
      ledger.refuse(carrier, "definite")
      redispatch(ledger, carrier, 2)
      const action = ledger.refuse(carrier, "definite")
      const sent = nextPatch(ledger)
      return action === "ladder" && sent?.desired.id === "ladder"
        ? undefined : `the second refusal answered ${action}; the ladder patch was ${sent ? "sent" : "not queued"}`
    },
  },
  {
    name: "mixed-carrier-close",
    milestone: 2,
    mutation: "close-latest-edit",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      ledger.holdGesture("A", "g1")
      const parameters = deliverValue(ledger, "A", "parameter-preview", 1, -1)
      dispatch(ledger, parameters, 1)
      ledger.observe(frame(1, 1))
      const structural = deliverPatch(ledger, "A", "structural-preview", 2, -1, 99)
      if (structural.plan.carrier !== "patch") return "the structural preview was not a patch"
      ledger.patchReplied(sendPatch(ledger), applied)
      ledger.submit(desiredFor("A", "restore", 3, 0))
      if (ledger.reconcile(kinds).length !== 0) return "the gesture did not own native while it was held"
      const released = ledger.endGesture("A", "g1")
      return released.length === 1
        ? undefined : `the close by the gesture's token released ${released.length} items (designed: the restore, whichever carrier dispatched last)`
    },
  },
  {
    name: "param-no-dispatch-close",
    milestone: 2,
    mutation: "close-latest-edit",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.holdGesture("A", "g1")
      const closed = ledger.endGesture("A", "g1")
      if (closed.length !== 0 || ledger.reconcile(kinds).length !== 0 || ledger.capture().size !== 0) return "a gesture that never dispatched left reconcile work behind"
      installed(ledger)
      ledger.submit(desiredFor("A", "after", 2, 5))
      return ledger.reconcile(kinds).length === 1 ? undefined : "the closed gesture still held the target"
    },
  },
  {
    name: "mixed-close-below-floor",
    milestone: 2,
    mutation: "close-latest-edit",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.configured(10, new Map([["A", { kindId: 1, state: bytes(0), values: { [gain]: 0 } }]]))
      ledger.holdGesture("A", "g1")
      ledger.endGesture("A", "g1")
      ledger.submit(desiredFor("A", "restore", 11, 5))
      return ledger.reconcile(kinds).length === 1 ? undefined : "a close of a gesture whose edits were below the floor left the gesture holding"
    },
  },
  {
    name: "old-close-after-new-gesture",
    milestone: 2,
    mutation: "close-latest-edit",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      ledger.holdGesture("A", "g1")
      ledger.holdGesture("A", "g2")
      ledger.endGesture("A", "g1")
      ledger.submit(desiredFor("A", "edit", 6, 2))
      if (ledger.reconcile(kinds).length !== 0) return "an old close ended the newer gesture's hold (designed: a token mismatch is a no-op)"
      return ledger.endGesture("A", "g2").length === 1 ? undefined : "the newer gesture's own close released nothing"
    },
  },
  {
    name: "edit-less-flush-never-ends",
    milestone: 2,
    mutation: "close-without-token",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      ledger.holdGesture("A", "gesture")
      ledger.endGesture("A", "")
      ledger.submit(desiredFor("A", "edit", 2, 2))
      return ledger.reconcile(kinds).length === 0 ? undefined : "a flush with no edit ended an open gesture"
    },
  },
  {
    name: "a7-benign-below-floor",
    milestone: 2,
    mutation: "floor-dispatches",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.configured(5, new Map([["A", { kindId: 1, state: bytes(0), values: { [gain]: 0 } }]]))
      const late = deliverPatch(ledger, "A", "late", 3, 1)
      const answer = answerOf(late)
      await turns()
      return late.plan.carrier === "none" && answer.value?.state === "superseded" && !ledger.hasQueuedPatch() && ledger.isSuperseded("A", 3)
        ? undefined : `a patch below the published floor was ${late.plan.carrier}, answered ${stateOf(answer)}`
    },
  },
  {
    name: "structural-reconcile-patch",
    milestone: 2,
    mutation: "parameters-only",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      ledger.submit(desiredFor("A", "structural-only", 5, 0, 77))
      const items = ledger.reconcile(kinds)
      return items.length === 1 && "patch" in items[0]!
        ? undefined : `desired content that differs only in state reconciled as ${items.length} items (designed: one whole-content item, carrier = patch)`
    },
  },
  {
    name: "synth-installed-from-sent-config",
    milestone: 2,
    mutation: "held-as-installed",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      ledger.configured(0, new Map([["synth", { kindId: 18, values: { "synth.outputGain": 0.5 } }]]))
      const same = ledger.deliver({ key: "synth", editId: "s1", order: 2, kindId: 18, incarnation: 1, epoch: 1, values: { "synth.outputGain": 0.5 } })
      const other = ledger.deliver({ key: "synth", editId: "s2", order: 3, kindId: 18, incarnation: 1, epoch: 1, values: { "synth.outputGain": 0.7 } })
      const sameAnswer = answerOf(same)
      await turns()
      return same.plan.carrier === "none" && stateOf(sameAnswer) === "applied" && other.plan.carrier === "urgent" && ledger.heldParams("synth") === undefined
        ? undefined : `the configuration sent was ${same.plan.carrier}/${stateOf(sameAnswer)} and a different value was ${other.plan.carrier}`
    },
  },
  {
    name: "urgent-refusal-recovers",
    milestone: 2,
    mutation: "urgent-cancel",
    check: async () => {
      const { ledger, notices } = ledgerWithNotices()
      const delivery = ledger.deliver({ key: "synth", editId: "s1", order: 2, kindId: 18, incarnation: 1, epoch: 1, values: { "synth.outputGain": 0.5 } })
      const answer = answerOf(delivery)
      if (delivery.plan.carrier !== "urgent") return `the synth delivery was ${delivery.plan.carrier}`
      const carrier = ledger.register({ key: "synth", editId: "s1", order: 2, kindId: 18, sequence: 1,
        values: delivery.plan.values, strategy: { kind: "urgent", sequence: 0 }, receipts: [delivery.receipt] }, { epoch: 1, revision: 1 })
      ledger.send(carrier, 1, 1)
      const action = ledger.refuse(carrier, "definite")
      redispatch(ledger, carrier, 2, true)
      ledger.observe(frame(1, 0, 2))
      await turns()
      return action === "retry" && stateOf(answer) === "applied" && notices.length === 0
        ? undefined : `an urgent refusal answered ${action}; the request was ${stateOf(answer)} with ${notices.length} notices (designed: one retry, applied, none)`
    },
  },
  {
    name: "equal-after-applied-no-event",
    milestone: 2,
    mutation: "wait-for-event",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      deliverPatch(ledger, "A", "first", 2, -1)
      ledger.patchReplied(sendPatch(ledger), applied)
      const equal = deliverPatch(ledger, "A", "equal", 3, -1)
      const answer = answerOf(equal)
      await turns()
      return equal.plan.carrier === "none" && stateOf(answer) === "applied" && nextPatch(ledger) === undefined
        ? undefined : `equal content proven applied was ${equal.plan.carrier}, answered ${stateOf(answer)} (designed: applied at registration, 0 dispatches)`
    },
  },
  {
    name: "equal-content-distinct-reservations",
    milestone: 2,
    mutation: "by-id",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const deliveries = [deliverPatch(ledger, "A", "r1", 2, -1), deliverPatch(ledger, "A", "r2", 3, -1), deliverPatch(ledger, "A", "r3", 4, -1)]
      const answers = deliveries.map(answerOf)
      const sends: number[] = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = nextPatch(ledger)
        if (!next) break
        sends.push(next.desired.order)
        ledger.patchReplied(next.execution, applied)
      }
      await turns()
      const serials = new Set(deliveries.map(({ receipt }) => receipt.serial))
      return sends.length === 1 && answers.every((answer) => answer.value?.state === "applied") && serials.size === 3
        ? undefined : `${sends.length} dispatches for one content under 3 reservations; answers ${answers.map(stateOf).join("/")} (designed: 1 dispatch, all applied)`
    },
  },
  {
    name: "different-in-flight-over-equal-installed",
    milestone: 2,
    mutation: "ignore-pending",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      recoverPatch(ledger, "A", "a", 2, -1)
      deliverPatch(ledger, "A", "b", 3, 5)
      const sentOther = sendPatch(ledger)
      const again = deliverPatch(ledger, "A", "a2", 4, -1)
      ledger.patchReplied(sentOther, applied)
      const sentAgain = nextPatch(ledger)
      await turns()
      return again.plan.carrier === "patch" && sentAgain?.desired.content.values?.[gain] === -1
        ? undefined : "requesting the installed content while different content was in flight did not dispatch it afterwards"
    },
  },
  {
    name: "values-behind-pending-patch",
    milestone: 2,
    mutation: "values-behind-patch",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      recoverPatch(ledger, "A", "a", 2, -1)
      deliverPatch(ledger, "A", "b", 3, 5)
      const flush = deliverValue(ledger, "A", "flush", 4, -1)
      return flush.plan.carrier === "parameters" && flush.plan.values.get(gain) === -1
        ? undefined : "newer values equal to the installed ones were dropped while a patch that replaces them was pending (designed: dispatched)"
    },
  },
  {
    name: "install-erases-unmapped-overrides",
    milestone: 2,
    mutation: "install-keeps-overrides",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      dispatch(ledger, deliverValue(ledger, "A", "override", 3, 7), 3)
      ledger.observe(frame(1, 3))
      // An install that names no values zeroes the slot's overrides, so the 7 is no longer in force.
      ledger.deliver({ key: "A", editId: "p", order: 4, kindId: 1, incarnation: 1, epoch: 1, state: bytes(9), values: {},
        desired: { ...desiredFor("A", "p", 4, 0, 9), content: { state: bytes(9), params: {} } } })
      ledger.patchReplied(sendPatch(ledger), applied)
      const again = deliverValue(ledger, "A", "again", 5, 7)
      return again.plan.carrier === "parameters" && again.plan.values.get(gain) === 7
        ? undefined : "an override a patch install zeroed was still believed in force (designed: unknown after the install, so dispatched)"
    },
  },
  {
    name: "older-request-for-newer-desired-content-keeps-carrier",
    milestone: 2,
    mutation: "r3-older-request-superseded-by-same-content",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      installed(ledger)
      ledger.submit(desiredFor("A", "newer", 7, -13))
      // The gesture's own older preview names content the newer desired also names: not "different content" (§1.2).
      const older = ledger.deliver({ key: "A", editId: "older", order: 5, kindId: 1, incarnation: 1, epoch: 1,
        state: bytes(-13), values: { [gain]: -13 }, desired: desiredFor("A", "older", 5, -13) })
      return older.plan.carrier === "patch"
        ? undefined : "an older request was superseded by a newer desired that names the same content (designed: it keeps its own carrier)"
    },
  },
  {
    name: "publication-with-retained-override",
    milestone: 2,
    mutation: "installed-only",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      recoverPatch(ledger, "A", "a", 2, -1)
      const override = deliverValue(ledger, "A", "override", 3, 7)
      dispatch(ledger, override, 3)
      ledger.observe(frame(1, 3))
      ledger.submit(desiredFor("A", "a-again", 4, -1))
      ledger.adopted(kinds, new Set(), new Set(), 5, () => true, new Map([["A", { kindId: 1, state: bytes(-1), values: { [gain]: -1 } }]]))
      return ledger.reconcile(kinds).length === 1
        ? undefined : "an adoption whose installed content equals the request hid the retained override that differs from it (designed: a dispatch, then applied)"
    },
  },
  {
    name: "recovery-after-target-retirement",
    milestone: 2,
    mutation: "keep-retired",
    check: async () => {
      const { ledger, notices } = ledgerWithNotices()
      failPatch(ledger, "A", "a1", 2, -1)
      if (notices.length !== 1) return `the first failure sent ${notices.length} notices`
      const pending = answerOf(deliverPatch(ledger, "A", "a2", 3, -2))
      ledger.retire("A")
      await turns()
      if (pending.value?.state !== "unavailable") return `a request of the retired target was ${stateOf(pending)} (designed: unavailable)`
      failPatch(ledger, "B", "b1", 4, -3)
      return notices.length === 2
        ? undefined : `${notices.length} notices: the retired target stayed in the incident, so the next failure joined it silently`
    },
  },
  {
    name: "incident-aggregation",
    milestone: 2,
    mutation: "per-target, never-close",
    check: () => {
      const { ledger, notices } = ledgerWithNotices()
      const counts: number[] = []
      failPatch(ledger, "A", "a1", 2, -1)
      counts.push(notices.length)
      failPatch(ledger, "B", "b1", 3, -2)
      counts.push(notices.length)
      recoverPatch(ledger, "A", "a2", 4, -3)
      failPatch(ledger, "A", "a3", 5, -4)
      counts.push(notices.length)
      recoverPatch(ledger, "A", "a4", 6, -5)
      recoverPatch(ledger, "B", "b2", 7, -6)
      failPatch(ledger, "A", "a5", 8, -7)
      counts.push(notices.length)
      ledger.clear()
      failPatch(ledger, "A", "a6", 9, -8)
      counts.push(notices.length)
      const mixed = createNativeProcessorStateOwner({ reportIncident: (category, targets) => { notices.push({ category, targets }) } })
      const before = notices.length
      deliverPatch(mixed, "A", "m1", 2, -1)
      mixed.patchReplied(sendPatch(mixed), lostPatch)
      mixed.patchReplied(sendPatch(mixed), lostPatch)
      failPatch(mixed, "B", "m2", 3, -2)
      counts.push(notices.length - before)
      return counts.join("/") === "1/1/1/2/3/1" && notices[0]?.targets === 1 && notices.at(-1)?.category === "unconfirmed"
        ? undefined : `notices after each step ${counts.join("/")} (designed: 1/1/1/2/3, then one for a mixed-category incident)`
    },
  },
  {
    name: "lost-then-refused",
    milestone: 2,
    mutation: "refusal-overrides-uncertain",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = deliverPatch(ledger, "A", "p", 2, -1)
      const answer = answerOf(delivery)
      ledger.patchReplied(sendPatch(ledger), lostPatch)
      if (ledger.fence().kind !== "uncertain") return `a lost patch left the fence ${ledger.fence().kind}`
      ledger.patchReplied(sendPatch(ledger), refusedPatch)
      await turns()
      const parameters = deliverValue(ledger, "B", "q", 1, 3)
      const parameterAnswer = answerOf(parameters)
      const carrier = dispatch(ledger, parameters, 1)
      ledger.refuse(carrier, "uncertain")
      redispatch(ledger, carrier, 2)
      ledger.refuse(carrier, "definite")
      await turns()
      return answer.value?.state === "unconfirmed" && parameterAnswer.value?.state === "unconfirmed"
        ? undefined : `a lost attempt followed by a refusal answered ${stateOf(answer)} (patch) and ${stateOf(parameterAnswer)} (parameters), designed: unconfirmed`
    },
  },
  {
    name: "fence-held-carriers-only",
    milestone: 2,
    mutation: "fence-from-any-reply",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      deliverPatch(ledger, "A", "old-session", 2, -1)
      const disposed = sendPatch(ledger)
      ledger.clear()
      ledger.patchReplied(disposed, lostPatch)
      if (ledger.fence().kind !== "open") return `a late lost reply for a disposed carrier moved the new session's fence to ${ledger.fence().kind}`
      ledger.patchReplied(disposed, { kind: "refused", refusal: "claim-pending", transient: false, token: 9n })
      if (ledger.fence().kind !== "open") return `a late claim-pending reply for a disposed carrier moved the new session's fence to ${ledger.fence().kind}`
      deliverPatch(ledger, "A", "new-session", 3, -2)
      return nextPatch(ledger) ? undefined : "the new session's patch was not sendable"
    },
  },
  {
    name: "uncertain-nothing-to-resend-opens",
    milestone: 2,
    mutation: "wait-for-resend",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      deliverPatch(ledger, "A", "a", 2, -1)
      const lost = sendPatch(ledger)
      deliverPatch(ledger, "B", "b", 3, 4)
      ledger.retire("A")
      ledger.patchReplied(lost, lostPatch)
      if (ledger.fence().kind !== "open") return `a lost reply for a retired target left the fence ${ledger.fence().kind} with nothing to resend`
      return nextPatch(ledger)?.execution.key === "B" ? undefined : "another target's patch was not sent"
    },
  },
  {
    name: "publication-failure-classified-by-kind",
    milestone: 2,
    mutation: "publication-all-refused",
    check: async () => {
      const seen: string[] = []
      for (const kind of ["refused", "unconfirmed", "unavailable"] as const) {
        const { ledger, notices } = ledgerWithNotices()
        const answer = answerOf(deliverPatch(ledger, "A", "p", 2, -1))
        sendPatch(ledger)
        ledger.settlePatches(3, () => false, kind)
        await turns()
        seen.push(`${kind}:${answer.value?.state ?? "pending"}/${notices.length}`)
      }
      return seen.join(",") === "refused:refused/1,unconfirmed:unconfirmed/1,unavailable:unavailable/0"
        ? undefined : `a failed publication answered ${seen.join(",")} (designed: refused/1 notice, unconfirmed/1, unavailable/0)`
    },
  },
  {
    name: "publication-resend-opens-fence",
    milestone: 2,
    mutation: "publication-no-fence-open",
    check: () => {
      const ledger = createNativeProcessorStateOwner()
      deliverPatch(ledger, "A", "p", 2, -1)
      ledger.patchReplied(sendPatch(ledger), lostPatch)
      if (ledger.fence().kind !== "uncertain") return `a lost patch left the fence ${ledger.fence().kind}`
      const resend = sendPatch(ledger)
      // The recovery resend of content that changes latency is a publication: its completion is the resend's reply.
      ledger.settlePatches(3, () => true)
      return resend && ledger.fence().kind === "open" ? undefined : `a publication that carried the resend left the fence ${ledger.fence().kind}`
    },
  },
  {
    name: "incident-clears-on-current-desired",
    milestone: 2,
    mutation: "stored-key-map",
    check: () => {
      const { ledger, notices } = ledgerWithNotices()
      // A is created first, so its patch is the one `nextPatch` sends first.
      recoverPatch(ledger, "A", "a0", 1, 9)
      failPatch(ledger, "B", "c1", 2, -1)
      // C2 is the newer request; a publication that carries C1 proves the old content, not the current desired.
      deliverPatch(ledger, "B", "c2", 3, -2)
      ledger.adopted(kinds, new Set(), new Set(), 3, () => false, new Map([["B", { kindId: 1, state: bytes(-1), values: { [gain]: -1 } }]]))
      failPatch(ledger, "A", "a1", 4, 5)
      if (notices.length !== 1) return `${notices.length} notices: A's failure did not join B's incident (designed 1)`
      const sent = nextPatch(ledger)
      if (sent?.execution.key !== "B") return "B's current desired was not the patch left to send"
      ledger.patchReplied(sent.execution, applied)
      failPatch(ledger, "A", "a2", 5, 6)
      if (notices.length !== 1) return `${notices.length} notices: the incident closed while A was still failed, or on C1's proof (designed 1)`
      recoverPatch(ledger, "A", "a3", 6, 7)
      failPatch(ledger, "A", "a4", 7, 8)
      return notices.length === 2 ? undefined : `${notices.length} notices after B's current desired and A recovered (designed: the incident closed, so a new failure notifies: 2)`
    },
  },
  {
    name: "join-mismatch-does-not-apply",
    milestone: 2,
    mutation: "adopt-any-content",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = ledger.join("sampled", 7, "wanted-content", 12)
      const answer = answerOf({ receipt: delivery, plan: { carrier: "none" } })
      ledger.adopted(new Map([["sampled", 91]]), new Set(), new Set(), 7, () => false,
        new Map([["sampled", { kindId: 91, contentKey: "different-content", incarnation: delivery.incarnation }]]))
      await turns()
      return answer.value?.state === "applied" ? "adoption answered a join without matching its content" : undefined
    },
  },
  {
    name: "sampled-join-target-survives-unrelated-adoption",
    milestone: 2,
    mutation: "drop-unknown-target-kind",
    check: async () => {
      const ledger = createNativeProcessorStateOwner()
      const delivery = ledger.join("sampled", 8, "sample-content", 13)
      const answer = answerOf({ receipt: delivery, plan: { carrier: "none" } })
      ledger.adopted(new Map(), new Set(), new Set(), 8, () => false)
      await turns()
      return answer.value === undefined ? undefined : `unrelated adoption answered sampled join ${answer.value.state}`
    },
  },
]

type Step3Result = {
  name: string; location: string; flip: string; standIn: string | null;
  expectedFailure: string | null; failure: string | null;
  status: "green" | "expected-red" | "red";
}
// Frozen 3B-0 inventory. Reasons describe the old contract, not an excuse to waive 3B-1 coverage.
const requiredPromotions = [
  { name: "R3-6 unanswered-receipt retention/drain", location: "src/components/timeline/parameter-gesture-owner.ts:775-795",
    reason: "flushPending returns void and waits legacy flush; it cannot report an unanswered receipt or retain its registration. A8.3 and idle-retirement stand-ins run." },
  { name: "R4-1 native refused versus unconfirmed at panel boundary", location: "src/components/timeline/create-persisted-effect-state.ts:34-39",
    reason: "Boolean/void callbacks cannot expose the native outcome. Rejected-terminal stand-ins and real controller classification run; no application is inferred." },
  { name: "R6-1 native superseded(by) at panel boundary", location: "src/components/timeline/parameter-gesture-owner.ts:55-56",
    reason: "Boolean flush erases the replacing receipt. The eight original schedules run as ordering controls; materialized-newer-supersedes-older remains a producer control." },
  { name: "R7-1 holding G2 token", location: "src/components/timeline/parameter-gesture-owner.ts:112-123,492-507",
    reason: "The panel owns edit IDs, not stable gesture tokens. Effective G2 ordering runs; token authorization cannot be observed through this callback." },
  { name: "R7-2 refused restore recovery through panel", location: "src/components/timeline/create-effects-panel-audio-effects-state.ts:709,720",
    reason: "Panel callbacks return no recovery membership/receipt. Producer recovery controls run; the panel registration/outcome half requires the cutover." },
  { name: "A1 native held restore proof after foreign row", location: "src/components/timeline/create-persisted-effect-state.ts:34-39",
    reason: "A receipt cannot be held/re-observed through today's panel callback. Portable ordering and provenance stand-ins run without calling submitted content heard." },
  { name: "A3 structural native selector through panel", location: "src/components/timeline/create-effects-panel-audio-effects-state.ts:709-733",
    reason: "Mapped-empty preview returns void and structural close uses the old history fallback, not a registration. The real-controller equal-mapped/different-structure control runs." },
  { name: "A3 declined native registration", location: "src/components/timeline/EffectsPanel.tsx:124-125",
    reason: "False/undefined is the only current callback result; it cannot be a refused/unconfirmed registration. Native submission counters explicitly remain unproven." },
  { name: "A7 harmful/benign native panel token floors", location: "src/components/timeline/parameter-gesture-owner.ts:492-517",
    reason: "The panel cannot send holds/token. Retained-override/below-floor producer controls and every-prefix campaign run; full adapter close-by-token is 3B-1." },
  { name: "Multi-field panel token clear", location: "src/components/timeline/parameter-gesture-owner.ts:112-123",
    reason: "Four-dispatch hook prefixes run, but actual end token cannot be exposed by an edit-ID-only callback." },
  { name: "N2 publication structure through panel", location: "src/hooks/useTimelinePlayback.ts:2164-2190",
    reason: "The hook forwards old preview/flush, not deliverProcessor. Real-controller one-patch structure control runs, not a fabricated panel receipt." },
  { name: "N3 below-floor native panel close", location: "src/components/timeline/parameter-gesture-owner.ts:492-517",
    reason: "No panel gesture token can reach the controller. Mixed-close-below-floor and benign producer controls remain green." },
  { name: "N4 claimed native panel receipt", location: "src/components/timeline/EffectsPanel.tsx:124-125",
    reason: "A claimed/unanswered registration cannot pass a boolean callback. Protocol-29 claim/resolution controls run directly on the real controller." },
  { name: "N5 native panel decline/recovery", location: "src/components/Timeline.tsx:1156-1234",
    reason: "The current Timeline fallback owns retry/history delivery. The producer ladder/no-prepare/one-notice controls run; replacing that fallback is 3B-1." },
  { name: "R2-B3 mixed-carrier/no-dispatch panel token close", location: "src/components/timeline/parameter-gesture-owner.ts:492-517",
    reason: "No token-bearing native panel entry exists. Mixed-carrier and no-dispatch ledger controls run independently." },
  { name: "R2-B6a full Timeline desired-instrument callback", location: "src/components/Timeline.tsx:769-782",
    reason: "Timeline does not yet pass typed desired instruments. Real configured/start/stale callback controls and instrument post-capture ingest run; changing Timeline is prohibited." },
  { name: "R2-B6b panel full-structure reconciliation", location: "src/components/timeline/create-effects-panel-audio-effects-state.ts:709-733",
    reason: "The params-only panel carrier cannot return a structural registration. Equal-mapped/different-structure controller control runs." },
  { name: "R2-B6c panel reconfigure from sent synth", location: "src/hooks/useTimelinePlayback.ts:2164-2190",
    reason: "Configured native facts are observable at the controller, but not forwarded as panel receipts. Configured-content-not-held producer control runs." },
  { name: "R2-B6d urgent outcome through panel", location: "src/components/timeline/create-persisted-effect-state.ts:34-39",
    reason: "Void preview cannot expose urgent completion/incident. Actual urgent retry/refusal controls run; no panel retry is added." },
  { name: "R2-A1 panel multi-target incident membership", location: "src/components/timeline/EffectsPanel.tsx:124-125",
    reason: "No receipt/incident membership passes this prop. Existing real-controller and ledger aggregation/re-arm controls run." },
  { name: "R3-A3b/R3-A6 panel installed-A/pending-B/request-A", location: "src/components/timeline/parameter-gesture-owner.ts:263,420",
    reason: "Panel delivered equality suppresses the logical close before native rule 0 can observe it. A8 isolates that suppression; different-inflight-over-equal-installed producer control runs." },
  { name: "R4-5 compressor in-place pending tick plus panel cancel", location: "tools/acceptance/device-control-cost.browser-runtime.tsx:394-426",
    reason: "The AudioEngine facade exposes no deterministic hold at the runtime's internal state.set await. Existing engine controls cover liveParams; browser A8 runs the real panel boundary, but is not this held-node witness." },
  { name: "R4-2d native panel incident healing", location: "src/components/timeline/create-persisted-effect-state.ts:34-39",
    reason: "Native current-desired proof/incident is not returned to the panel. Incident-clears-on-current-desired and late-old-proof controls run." },
  { name: "P per-key revision propagation and positive equal stamps", location: "src/components/timeline/create-effects-panel-audio-effects-state.ts:237-243,328-352",
    reason: "Both adapter sync signatures erase through. Equal-content echo and real HTTP/local scheduling stand-ins run; observing actual per-key stamps at the owner needs the new observation contract." },
  { name: "P admitted old-project/remove-readd binding and exact consume-once", location: "src/components/timeline/create-persisted-effect-state.ts:137-140",
    reason: "Persist discards typed admission and supplies no entry binding. Actual outbox rejection/duplicate/no-op/missing/event-before-bind stand-ins run; exact owner transition/consume count is not observable today." },
  { name: "local-save-returns-row both normalized consumers", location: "src/components/timeline/create-persisted-effect-state.ts:156-169",
    reason: "Real setLocalEffect/setLocalEffectInstance and one-view sequences run, but normalized consumer methods accept params only. Full through propagation requires 3B-1." },
  { name: "sampled-joins-publication real fixture callback return", location: "tools/acceptance/device-control-cost.browser-runtime.tsx:652-688",
    reason: "Amendment 1 explicitly defers returning/consuming DeliveryRegistration. All three real-controller adapter ordering stand-ins run; native callbacks count submitted/unproven only." },
]
const deferred = <Value,>() => {
  let resolve: (value: Value) => void = () => {}
  let reject: (cause: Error) => void = () => {}
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const checkpoint = async () => { for (let turn = 0; turn < 100; turn++) await Promise.resolve() }
const sameEvidence = <Actual, Expected,>(actual: Actual, expected: Expected) => JSON.stringify(actual) === JSON.stringify(expected)
  ? null : `expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`

// This is a current-contract behavioral stand-in, not a second owner or a native installed-state model.
// It exposes deterministic holds around the real persisted adapter and real parameter owner. Native
// outcome/claim/adoption facts come from the real-controller matrix below, never these numeric callbacks.
const persistedProbe = (options: {
  apply?: (value: number) => void | EngineDisposition | Promise<void | EngineDisposition>
  flush?: (value: number) => Promise<boolean | undefined>
  save?: (value: number) => Promise<void | ParameterSaveResult>
  announce?: (value: number) => void | Promise<void>
  clear?: () => void
  projectId?: string
  userId?: string
} = {}) => {
  let dispose = () => {}
  const [project, setProject] = createSignal(options.projectId ?? "project:3b-A")
  const [user, setUser] = createSignal(options.userId ?? "user-A")
  const [generation, setGeneration] = createSignal(0)
  const [row, publishRow] = createSignal<number | undefined>(0)
  const [through, setThrough] = createSignal(0)
  let observedThrough = 5
  const setRow = (value: number | undefined, stamp = ++observedThrough) => batch(() => { setThrough(stamp); publishRow(() => value) })
  const applied: number[] = [], histories: string[] = [], announced: number[] = []
  const saves: { projectId: string | undefined; userId: string | undefined; value: number }[] = []
  const state = createRoot((end) => {
    dispose = end
    return createPersistedEffectState<number | undefined, number>({
      targetId: () => "track", scopeId: project, row, readQueryParams: value => value, readQueryThrough: through,
      createInitialParams: () => 0, serializeParams: String,
      createPersistContext: () => ({ projectId: project(), userId: user(), projectGeneration: generation() }),
      applyToEngine: async (_target, value) => {
        const result = await options.apply?.(value)
        if (result !== "dropped" && result !== "superseded") applied.push(value)
        return result ?? "applied"
      },
      registerDelivery: options.flush ? (_target, value): DeliveryRegistration => ({
        receipt: { key: "track", serial: value },
        settled: options.flush!(value).then((): ProcessorDeliveryOutcome => ({ state: "applied" }), (): ProcessorDeliveryOutcome => ({ state: "unconfirmed" })),
      }) : undefined,
      persistParams: async (_target, value, context) => {
        saves.push({ projectId: context.projectId, userId: context.userId, value })
        return (await options.save?.(value)) ?? { kind: "committed", through: 5 }
      },
      history: (_target, from, to) => { histories.push(`${from}->${to}`) },
      announce: (_target, value) => { announced.push(value); return options.announce?.(value) },
      clearFromEngine: options.clear,
    })
  })
  const tick = (holder: ParameterGestureHolder, value: number) => state.gestureOwner.tick(holder, () => state.update(() => value))
  return { state, setProject, setUser, setGeneration, setRow, applied, histories, announced, saves, tick, dispose }
}

// Expected failures are literals, not learned from the run. An unexpected pass, a different failure,
// an exception or an extra red fails the runner. 3B-1 removes the expected failure only after the oracle flips.
const runStep3B0Witnesses = async (): Promise<Step3Result[]> => {
  const rows: Step3Result[] = []
  const record = async (name: string, location: string, _baselineFailure: string | null, flip: string,
    check: () => Promise<string | null>, standIn: string | null = null) => {
    let failure: string | null
    try { failure = await check() } catch (cause) { failure = `threw ${cause instanceof Error ? cause.message : String(cause)}` }
    rows.push({ name, location, flip, standIn, expectedFailure: null, failure,
      status: failure === null ? "green" : "red" })
  }
  const ownerSite = "src/components/timeline/parameter-gesture-owner.ts"
  const persistedSite = "src/components/timeline/create-persisted-effect-state.ts"
  await record("R3-1 released project and user", `${persistedSite}:79-83`, 'expected ["project:3b-A","user-A"]; received ["project:3b-A","user-B"]',
    "Capture user with the release lifetime, not when queued persistence starts", async () => {
      const gate = deferred<boolean | undefined>()
      const f = persistedProbe({ flush: () => gate.promise })
      await checkpoint()
      f.state.setForTarget("track", 1); await checkpoint()
      f.setProject("project:3b-B"); f.setUser("user-B"); await checkpoint()
      gate.resolve(false); await f.state.flushPending()
      const failure = sameEvidence([f.saves[0]?.projectId, f.saves[0]?.userId], ["project:3b-A", "user-A"])
      f.dispose(); return failure
    })
  for (const outcome of ["refused", "unconfirmed"]) {
    await record(`R3-2 native ${outcome} cannot veto persistence`, `${ownerSite}:434-436`, 'expected [2]; received []',
      "Register native work synchronously; native settlement does not gate save/history", async () => {
        // Current flush has no typed outcome. Its rejected promise is the semantic stand-in for a failed native terminal.
        const f = persistedProbe({ flush: () => Promise.reject(new Error(outcome)) })
        await checkpoint()
        const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
        f.state.setForTarget("track", 2); await checkpoint(); f.state.gestureOwner.cancel(holder); await f.state.flushPending().catch(() => {})
        const failure = sameEvidence(f.saves.map(save => save.value), [2])
        f.dispose(); return failure
      }, "Rejected boolean flush stands in for a refused/lost native terminal; real outcome classification is covered separately by the controller")
  }
  await record("R3-2 portable throw", `${ownerSite}:422-426`, null, "Keep portable throws failing releases", async () => {
    const f = persistedProbe({ apply: value => { if (value === 2) throw new Error("portable") } })
    await checkpoint(); f.state.setForTarget("track", 2); await f.state.flushPending().catch(() => {})
    const failure = sameEvidence([f.saves.length, f.histories, f.state.params()], [0, [], 0])
    f.dispose(); return failure
  })
  await record("R3-5 failed predecessor rebases successor", `${ownerSite}:373-378`, null, "Preserve committed history baseline", async () => {
    const gate = deferred<void>()
    const f = persistedProbe({ save: value => value === 1 ? gate.promise : Promise.resolve() })
    await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
    f.state.setForTarget("track", 2); gate.reject(new Error("save")); await f.state.flushPending().catch(() => {})
    const failure = sameEvidence(f.histories, ["0->2"]); f.dispose(); return failure
  })
  await record("R3-4 own echo then newer foreign row", `${ownerSite}:586-608`, null, "Keep newer genuine row after early own echo", async () => {
    const save = deferred<void>(), f = persistedProbe({ save: () => save.promise })
    await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
    f.setRow(1); await checkpoint(); f.setRow(7); await checkpoint()
    save.resolve(); await f.state.flushPending()
    const failure = sameEvidence([f.state.params(), f.histories], [7, ["0->1"]]); f.dispose(); return failure
  })
  for (const scenario of ["R3-3 removal and readd", "R4-3 old-project removal"]) {
    await record(scenario, `${ownerSite}:554-567`, null, "Fence deferred clears by target lifetime and project", async () => {
      const gate = deferred<void>(); let clears = 0
      const f = persistedProbe({ apply: value => value === 1 ? gate.promise : undefined, clear: () => { clears++ } })
      await checkpoint()
      const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
      f.state.syncRemoteForTarget("track", undefined)
      if (scenario.startsWith("R4")) { f.setProject("project:3b-B"); await checkpoint() }
      f.state.syncRemoteForTarget("track", 7); await checkpoint()
      gate.resolve(); await f.state.flushPending()
      const failure = sameEvidence([clears, f.state.readForTarget("track")], [0, 7]); f.dispose(); return failure
    })
  }
  await record("R4-2 equal-content stamped echoes", `${ownerSite}:583-588`,
    'expected null; received 1', "Consume echoes by observation through even when content did not change", async () => {
      const f = persistedProbe(); await checkpoint()
      f.state.setForTarget("track", 1); await f.state.flushPending()
      // One row publication coalesces two own writes. With today's API an equal observation cannot carry
      // a newer stamp. Keep a genuinely later equal-value echo pending instead of fabricating consumption.
      f.setRow(1); await checkpoint(); f.state.setForTarget("track", 2); await f.state.flushPending()
      f.state.setForTarget("track", 1); await f.state.flushPending()
      f.setRow(1); await checkpoint()
      const failure = sameEvidence(f.state.readProvisionalForTarget("track") ?? null, null)
      f.dispose(); return failure
    }, "Params-only observation re-notifies the same content; coalesced/newer stamps cannot be passed until 3B-1")
  await record("R5-1 cancel allocates before projection without registry replace", `${ownerSite}:492-503`,
    "expected 0; received 1", "Allocate restore before publication and close by gesture token, not replaceEdit", async () => createRoot(async dispose => {
      let order = 0, allocatedValue: number | undefined, publicationBeforeAllocation = false
      const owner = createParameterGestureOwner<string, number>({
        key: target => target, scope: () => ({ projectId: "project:tokens", generation: 0 }),
        exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
        initial: () => 0, committed: () => 0, apply: () => Promise.resolve("applied"),
        persist: () => Promise.resolve({ kind: "committed-unordered" }), history: () => {},
        allocateEdit: (_target, _from, to) => {
          allocatedValue = to;
          return { id: `edit-${++order}`, order,
            target: { nodeId: "track", instanceId: "A", kindId: 1, incarnation: 1 }, content: { params: { value: to } } };
        },
        onError: () => {},
      })
      createComputed(() => {
        const value = owner.effective("track");
        if (order > 0 && value !== allocatedValue) publicationBeforeAllocation = true;
      })
      const holder = new ParameterGestureHolder(), handle = owner.handle(() => "track")
      handle.open(holder); handle.tick(holder, () => owner.write("track", () => 1)); await owner.settle("track")
      handle.cancel(holder); await owner.flushPending()
      const failure = sameEvidence([publicationBeforeAllocation, allocatedValue, order > 1], [false, 0, true]); dispose(); return failure
    }))
  await record("R7-1 old cancel under live G2", `${ownerSite}:496-507`,
    null, "Cancel must deliver G2's effective value with G2's holding token", async () => {
      const native = deferred<boolean | undefined>()
      const f = persistedProbe({ flush: value => value === -3 ? native.promise : Promise.resolve(undefined) })
      await checkpoint()
      const g1 = new ParameterGestureHolder(); f.state.gestureOwner.open(g1); f.tick(g1, -1); await checkpoint()
      f.state.setForTarget("track", -3); await checkpoint(); f.state.gestureOwner.cancel(g1)
      const g2 = new ParameterGestureHolder(); f.state.gestureOwner.open(g2); f.tick(g2, -2)
      native.resolve(false); await checkpoint()
      const whileHolding = [f.state.params(), f.applied.at(-1)]
      f.state.gestureOwner.cancel(g2); await f.state.flushPending()
      const failure = sameEvidence(whileHolding, [-2, -2]); f.dispose(); return failure
    }, "Heard/effective ordering control only; current callback carries an edit, not G2's gesture token")
  await record("R7-3 queued return re-evaluates row", `${ownerSite}:496-507`, null, "Select against current effective and actual installed content", async () => {
    const gate = deferred<void>(), f = persistedProbe({ apply: value => value === 1 ? gate.promise : undefined })
    await checkpoint(); const holder = new ParameterGestureHolder()
    f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
    f.state.gestureOwner.cancel(holder); f.setRow(7); await checkpoint(); gate.resolve(); await f.state.flushPending()
    const failure = sameEvidence([f.state.params(), f.applied.at(-1)], [7, 7]); f.dispose(); return failure
  })
  for (const position of ["before-ack", "after-ack"]) {
    await record(`A2 foreign row with successor ${position}`, `${ownerSite}:583-608`,
      'expected ["0->1","7->2"]; received ["0->1","1->2"]', "Recheck the latest observation when each save binds", async () => {
        const first = deferred<void>(), next = deferred<void>()
        const f = persistedProbe({ save: value => value === 1 ? first.promise : next.promise })
        await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
        if (position === "before-ack") f.setRow(7)
        else { first.resolve(); await f.state.flushPending() }
        f.state.setForTarget("track", 2); await checkpoint()
        if (position === "after-ack") f.setRow(7)
        await checkpoint(); first.resolve(); next.resolve(); await f.state.flushPending()
        const failure = sameEvidence(f.histories, ["0->1", "7->2"]); f.dispose(); return failure
      })
  }
  await record("A1 late restore acknowledgment after genuine row", `${ownerSite}:583-621`, null,
    "Old acknowledgment is proof, not current panel authority", async () => {
      const restore = deferred<void>()
      let holdRestore = false
      const f = persistedProbe({ apply: value => value === 0 && holdRestore ? restore.promise : undefined })
      await checkpoint()
      const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
      holdRestore = true
      f.state.gestureOwner.cancel(holder); await checkpoint()
      f.setRow(9); await checkpoint()
      restore.resolve(); await f.state.flushPending()
      const beforeNext = [f.state.params(), f.applied.at(-1)]
      f.state.setForTarget("track", 0); await f.state.flushPending()
      const failure = sameEvidence([beforeNext, f.histories], [[9, 9], ["9->0"]]); f.dispose(); return failure
    }, "Current portable ordering control; held native restore acknowledgment belongs to the real-controller matrix")
  await record("R3-6 idle lane retires", `${ownerSite}:246-260`, "expected 0; received 1",
    "Retire the lane once observations and work settle; retain no delivered cache", async () => createRoot(async dispose => {
      let value = 0
      const owner = createParameterGestureOwner<string, number>({
        key: target => target, scope: () => ({ projectId: "project:retire", generation: 0 }),
        exists: () => true, canWrite: () => true, equal: (_target, a, b) => a === b,
        initial: () => 0, committed: () => value, rowsReachEngine: () => true,
        apply: () => Promise.resolve("applied"),
        persist: () => Promise.resolve({ kind: "committed-unordered" }), history: () => {}, allocateEdit: () => undefined,
        onError: () => {},
      })
      owner.external("track", 0); await owner.flushPending()
      owner.set("track", 1); await owner.flushPending()
      value = 1; owner.external("track", value); await owner.flushPending()
      const failure = sameEvidence(owner.retained(), 0); dispose(); return failure
    }))
  await record("R4-4 held portable apply scope fence", `${ownerSite}:267-280`, null, "Preserve the post-await lifetime fence", async () => {
    const gate = deferred<void>()
    const f = persistedProbe({ apply: value => value === 1 ? gate.promise : undefined })
    await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
    f.setProject("project:3b-B"); await checkpoint(); gate.resolve(); await f.state.flushPending()
    const failure = sameEvidence([f.state.params(), f.histories, f.announced.includes(1)], [undefined, [], false])
    f.dispose(); return failure
  })
  await record("R5-2 cancel after newer save", `${ownerSite}:487-507`, null, "Resolve cancellation destination at execution", async () => {
    const f = persistedProbe(); await checkpoint()
    const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
    f.state.setForTarget("track", 7); await checkpoint(); f.state.gestureOwner.cancel(holder)
    await f.state.flushPending()
    const failure = sameEvidence([f.state.params(), f.applied.at(-1)], [7, 7]); f.dispose(); return failure
  })
  for (const schedule of ["a", "b", "c", "d"]) {
    for (const leg of ["portable", "native"]) {
      await record(`R6-1${schedule} ${leg}`, `${ownerSite}:487-521`, null,
        "Keep effective-at-execution cancellation and failed-save recovery", async () => {
          const send = deferred<boolean | undefined>(), save = deferred<void>(), second = deferred<void>()
          const f = persistedProbe({
            flush: value => value === -3 ? send.promise : Promise.resolve(undefined),
            save: value => value === -3 ? save.promise : value === -4 ? second.promise : Promise.resolve(),
          })
          await checkpoint()
          const g1 = new ParameterGestureHolder(); f.state.gestureOwner.open(g1); f.tick(g1, -1); await checkpoint()
          f.state.setForTarget("track", -3); await checkpoint()
          if (schedule === "b") { f.tick(g1, -2); await checkpoint() }
          if (schedule === "c") { f.tick(g1, 0); f.state.gestureOwner.end(g1) }
          else f.state.gestureOwner.cancel(g1)
          if (schedule === "d") {
            const g2 = new ParameterGestureHolder(); f.state.gestureOwner.open(g2); f.tick(g2, -2)
            f.state.setForTarget("track", -4); f.state.gestureOwner.cancel(g2)
          }
          send.resolve(false); await checkpoint(); save.reject(new Error("save -3"))
          if (schedule === "d") { await checkpoint(); second.reject(new Error("save -4")) }
          await f.state.flushPending().catch(() => {})
          const terminal = [f.state.params(), f.applied.at(-1), f.histories]
          const fresh = new ParameterGestureHolder(); f.state.gestureOwner.open(fresh); f.tick(fresh, -3); await checkpoint()
          const heardFresh = f.applied.at(-1)
          f.state.gestureOwner.cancel(fresh); await f.state.flushPending().catch(() => {})
          const failure = sameEvidence([terminal, heardFresh, f.applied.at(-1)], [[0, 0, []], -3, 0])
          f.dispose(); return failure
        }, leg === "native" ? "Boolean native terminal ordering only; native heard/proof and gesture tokens require 3B-1 forwarding" : null)
    }
  }
  await record("R7-4 history opens over failed predecessor", `${ownerSite}:373-378`, null, "Rebase history at release execution", async () => {
    const save = deferred<void>(); const f = persistedProbe({ save: value => value === 1 ? save.promise : Promise.resolve() })
    await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
    const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, -2); f.state.gestureOwner.end(holder)
    save.reject(new Error("predecessor")); await f.state.flushPending().catch(() => {})
    const failure = sameEvidence(f.histories, ["0->-2"]); f.dispose(); return failure
  })
  await record("A5 removal invalidates queued release", `${ownerSite}:540-567`, null, "Removal ends the lifetime before persistence", async () => {
    const gate = deferred<void>(), f = persistedProbe({ apply: value => value === 1 ? gate.promise : undefined })
    await checkpoint(); f.state.setForTarget("track", 1); await checkpoint(); f.state.syncRemoteForTarget("track", undefined)
    gate.resolve(); await f.state.flushPending()
    const failure = sameEvidence([f.saves.length, f.histories.length], [0, 0]); f.dispose(); return failure
  })
  await record("A5 same-project reset repairs effective", `${ownerSite}:631-654`, null,
    "Reset must repair current effective without relying on caller installed caches", async () => {
      const f = persistedProbe(); await checkpoint()
      const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1); await checkpoint()
      f.setGeneration(1); await f.state.flushPending()
      const failure = sameEvidence([f.state.params(), f.applied.at(-1), f.histories], [0, 0, []])
      f.dispose(); return failure
    })
  for (const terminal of ["end", "cancel"]) {
    await record(`A6 queued preview after ${terminal}`, `${ownerSite}:305-345`, null,
      "Queued work is authorized by the actual gesture, never by key alone", async () => {
        const originalRequest = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame
        const jobs = new Map<number, FrameRequestCallback>()
        // This is a manual callback queue, not an animation loop or a clock. Every job is run or cancelled here.
        globalThis.requestAnimationFrame = callback => { jobs.set(1, callback); return 1 }
        globalThis.cancelAnimationFrame = id => { jobs.delete(id) }
        const f = persistedProbe()
        try {
          await checkpoint()
          const holder = new ParameterGestureHolder(); f.state.gestureOwner.open(holder); f.tick(holder, 1)
          const obsolete = [...jobs.values()]
          if (terminal === "end") f.state.gestureOwner.end(holder)
          else f.state.gestureOwner.cancel(holder)
          for (const job of obsolete) job(0)
          await f.state.flushPending()
          return sameEvidence(f.applied.filter(value => value === 1).length, terminal === "end" ? 1 : 0)
        } finally {
          f.dispose(); globalThis.requestAnimationFrame = originalRequest; globalThis.cancelAnimationFrame = originalCancel
        }
      })
  }
  await record("N7 old-scope completion removes only its release", `${ownerSite}:325-330`, null, "Keep identity-safe removal across project switch", async () => {
    const save = deferred<void>(), f = persistedProbe({ save: value => value === 5 ? save.promise : Promise.resolve() })
    await checkpoint(); f.state.setForTarget("track", 5); await checkpoint()
    f.setProject("project:3b-B"); await checkpoint(); f.state.setForTarget("track", 6); await checkpoint()
    save.resolve(); await f.state.flushPending()
    const failure = sameEvidence([f.saves.map(item => `${item.projectId}=${item.value}`), f.state.params(), f.applied.at(-1)],
      [["project:3b-A=5", "project:3b-B=6"], 6, 6]); f.dispose(); return failure
  })
  for (const origin of ["release", "foreign-row"]) {
    await record(origin === "release" ? "registration-before-receipt" : "synth-foreign-structural-row", `${persistedSite}:130,138`,
      origin === "release" ? "expected false; received true" : "expected false; received true",
      "Await the structural handoff at announce/rowApplied, independently of native receipt settlement", async () => {
        const handoff = deferred<void>()
        const f = persistedProbe({ announce: () => handoff.promise })
        await checkpoint()
        if (origin === "release") f.state.setForTarget("track", 1)
        else f.state.syncRemoteForTarget("track", 7)
        let drained = false
        const drain = f.state.flushPending().then(() => { drained = true })
        await checkpoint()
        const failure = sameEvidence(drained, false)
        handoff.resolve(); await drain; f.dispose(); return failure
      }, "Number content stands in for structural synth content; real controller instruments are exercised by the instrument matrix")
  }
  await record("A8.3 native flush cannot precede save receipt", `${ownerSite}:434,444`, "expected [1]; received []",
    "Synchronous native registration lets the lane reach save while settled remains unanswered", async () => {
      const native = deferred<boolean | undefined>(), f = persistedProbe({ flush: () => native.promise })
      await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
      const failure = sameEvidence(f.saves.map(save => save.value), [1])
      native.resolve(false); await f.state.flushPending(); f.dispose(); return failure
    }, "Held boolean flush represents today's receipt-before-save dependency, without returning a type-invalid registration")

  // P schedules use the actual HTTP client/decoder. The current adapter necessarily erases the
  // decoded write result and accepts only params on observation. We retain the real stamp beside it
  // in the fixture; we never fabricate a typed successful result at the adapter seam.
  for (let schedule = 1; schedule <= 9; schedule++) {
    await record(`P${schedule} cloud provenance`, `${persistedSite}:137-140,156-169`,
      schedule === 3 || schedule === 9 ? schedule === 9
        ? 'expected ["0->1","7->2"]; received ["0->1","1->2"]'
        : "expected 7; received 1" : null,
      "Return decoded save truth, carry per-row through, and re-evaluate observations on save binding", async () => {
        const response = deferred<Response>()
        const request: typeof fetch = Object.assign(async () => (await response.promise).clone(), { preconnect: fetch.preconnect })
        const f = persistedProbe({ save: async () => {
          const result = await publishSharedTimelineOperation("cloud-project", { kind: "effects.setUtilityParams",
            payload: { trackId: "track", params: { version: 1, state: createDefaultUtilityParams() } } }, { fetch: request })
          return parameterSaveResult({ kind: "applied", entryId: "http-write", result })
        } })
        await checkpoint(); f.state.setForTarget("track", 1); await checkpoint()
        const observe = (value: number, through: number) => {
          if (through < 0) throw new Error("Invalid fixture stamp")
          f.setRow(value, through)
        }
        if (schedule === 2) { observe(1, 5); await checkpoint(); observe(7, 6) }
        if (schedule === 3 || schedule === 9) observe(7, 6)
        if (schedule === 4 || schedule === 5) observe(7, 5)
        await checkpoint()
        response.resolve(Response.json({ status: "applied", effectId: "row", revision: schedule === 4 || schedule === 5 ? 6 : schedule === 7 || schedule === 8 ? 2 : 5 }))
        await f.state.flushPending()
        if (schedule === 1) { if (f.state.params() !== 1) throw new Error("ack became a row"); observe(1, 5) }
        if (schedule === 4 || schedule === 5) { if (f.state.params() !== 1) throw new Error("uncovered foreign row overrode own write"); observe(1, 6) }
        if (schedule === 6) observe(7, 6)
        if (schedule === 7) { observe(0, 1); await checkpoint(); observe(1, 2) }
        if (schedule === 8) { observe(1, 2); await checkpoint(); observe(7, 3) }
        await checkpoint()
        let failure = sameEvidence(f.state.params(), [2, 3, 6, 8, 9].includes(schedule) ? 7 : 1)
        if (schedule === 9) {
          f.state.setForTarget("track", 2); await f.state.flushPending()
          failure = sameEvidence(f.histories, ["0->1", "7->2"])
        }
        f.dispose(); return failure
      }, schedule === 5 ? "Online HTTP continuation is the ordering stand-in; admitted/outbox binding is a separate row" :
        schedule === 7 || schedule === 8 ? "HTTP ordering control; actual local returned-row/view schedules are separate rows" : null)
  }
  for (const revision of [0, undefined]) {
    await record(`P committed-unordered ${revision === undefined ? "missing" : "zero"}`, `${persistedSite}:137-140`, null,
      "Keep unordered echoes until content-equal or later positive observation", async () => {
        const decoded = decodeEffectsOperationResult(revision === undefined
          ? { status: "applied", effectId: "row" } : { status: "applied", effectId: "row", revision })
        const f = persistedProbe({ save: async () => parameterSaveResult({ kind: "applied", entryId: "unordered", result: decoded }) }); await checkpoint()
        f.state.setForTarget("track", 1); await f.state.flushPending()
        f.setRow(1); await checkpoint(); f.setRow(7); await checkpoint()
        const failure = sameEvidence([decoded.status === "applied" ? decoded.revision.kind : "invalid", f.state.params()], ["committed-unordered", 7])
        f.dispose(); return failure
      }, "Current adapter erases save stamps; this is the real decoder plus content-equal observation control, not admitted provenance proof")
  }
  for (const writer of ["setLocalEffect", "setLocalEffectInstance"]) {
    await record(`local-save-returns-row ${writer}`, `${persistedSite}:137-140`, "persist returned row+sequence, but adapter exposed no committed-through observation",
      "Return and bind the real local row/sequence instead of erasing it", async () => {
        const projectId = `project:3b-local-${writer}`
        let saved: { row: { params: number }; sequence: number } | undefined
        const f = persistedProbe({ save: async value => {
          saved = writer === "setLocalEffect"
            ? await setLocalEffect(projectId, "track", "arp", value)
            : await setLocalEffectInstance(projectId, "track", "compressor", value, { instanceId: "effect:local" })
          return parameterSaveResult(saved)
        } })
        await checkpoint(); f.state.setForTarget("track", 1); await f.state.flushPending()
        if (!saved || saved.row.params !== 1 || saved.sequence <= 0) throw new Error("local write fixture failed")
        f.setRow(7, saved.sequence + 1); await f.state.flushPending()
        const failure = sameEvidence([f.state.params(), f.state.readProvisionalForTarget("track") ?? null], [7, null])
        f.dispose(); return failure
      }, "Real local writer; row/through cannot be passed through today's params-only adapter")
  }
  for (const schedule of [7, 8, 9]) {
    await record(`P${schedule} real local view`, `${persistedSite}:137-140,156-169`,
      null,
      "Bind returned sequence and share observed through with both consumers", async () => {
        const projectId = `project:3b-local-P${schedule}-${crypto.randomUUID()}`
        const save = deferred<void>()
        const returned = await setLocalEffect(projectId, "track", "arp", 0)
        let views = 0
        const f = persistedProbe({ save: async value => {
          const result = await setLocalEffect(projectId, "track", "arp", value)
          if (value === 1 && schedule === 9) await save.promise
          return parameterSaveResult(result)
        } })
        const view = createLocalEffectsViewOwner({
          currentProjectId: () => projectId, list: listLocalEffects,
          publish: next => {
            if (!next) return
            views++
            const row = next.rows.find(entry => entry.targetId === "track" && entry.effect === "arp")
            const value = z.number().parse(row?.params)
            f.setRow(value, next.through)
          },
          fail: error => { if (error) throw error },
        })
        view.sync(); await view.reload(); await checkpoint()
        f.state.setForTarget("track", 1); await checkpoint()
        // Waiting on the writer's notification/load is event-driven, not a wall-clock poll.
        await view.reload()
        if (schedule === 9) {
          await setLocalEffect(projectId, "track", "arp", 7); await view.reload()
          save.resolve(); await f.state.flushPending()
          f.state.setForTarget("track", 2); await f.state.flushPending()
        } else {
          await f.state.flushPending()
          if (schedule === 7) f.setRow(0, returned.sequence)
          else await setLocalEffect(projectId, "track", "arp", 7)
          await view.reload(); await checkpoint()
        }
        const failure = schedule === 9 ? sameEvidence(f.histories, ["0->1", "7->2"])
          : sameEvidence([f.state.params(), returned.sequence > 0, views > 0], [schedule === 7 ? 1 : 7, true, true])
        view.dispose(); f.dispose(); return failure
      })
  }
  for (const scenario of ["admitted-rejection", "dead-letter", "missing-completion", "duplicate-wakes",
    "foreign-drainer-noop", "foreign-drainer-rejection", "event-before-admission"]) {
    const rejects = scenario.includes("rejection") || scenario === "dead-letter"
    await record(`P outbox ${scenario}`, `${persistedSite}:137-140`,
      rejects ? 'expected []; received ["0->1"]' : "owner did not bind/consume the durable completion",
      rejects ? "Bind admitted entry; durable rejection removes echo and suppresses history"
        : "Bind entry, immediately read durable result, recheck observation, consume once; wakes carry no authority", async () => {
        const projectId = `3b-outbox-${scenario}-${crypto.randomUUID()}`, userId = "user"
        const originalFetch = globalThis.fetch
        let online = false
        globalThis.fetch = Object.assign(async () => online
          ? rejects ? new Response("deleted", { status: 403 }) : Response.json({ status: "applied", effectId: "row", revision: 6 })
          : new Response("offline", { status: 503 }), { preconnect: originalFetch.preconnect })
        let publication: Awaited<ReturnType<typeof publishDurableEffectsOperation>> | undefined
        const f = persistedProbe({ projectId, userId, save: async () => {
          publication = await publishDurableEffectsOperation({ projectId, userId,
            operation: { kind: "effects.setUtilityParams", payload: { trackId: "track", instanceId: "utility-1", params: AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams() } } })
          if (scenario === "event-before-admission") {
            online = true
            await flushSharedOutbox(projectId, userId, { retryFailed: true })
          }
          return parameterSaveResult(publication)
        } })
        let wakes = 0
        const unsubscribe = subscribeToSharedOutboxSettlements(projectId, userId, () => { wakes++ })
        try {
          await checkpoint(); f.state.setForTarget("track", 1); await f.state.flushPending()
          const entry = publication
          if (!entry) throw new Error("Publication never ran")
          online = true
          if (entry.kind === "admitted") await flushSharedOutbox(projectId, userId, { retryFailed: true })
          if (scenario === "missing-completion") {
            const db = await openLocalProjectDb(projectId)
            await db.delete("syncState", `shared-outbox-completion:${projectId}:${userId}:${entry.entryId}`)
          }
          if (scenario === "duplicate-wakes") {
            await flushSharedOutbox(projectId, userId, { retryFailed: true })
            await flushSharedOutbox(projectId, userId, { retryFailed: true })
          }
          await f.state.flushPending().catch(() => {})
          const after = await readSharedOutboxOperation(projectId, userId, entry.entryId)
          if (rejects && after.status !== "rejected") throw new Error(`Expected actual durable rejection, got ${after.status}`)
          if (wakes === 0) throw new Error("Real outbox produced no settlement wake")
          await checkpoint()
          return rejects ? sameEvidence([f.histories, f.state.params()], [[], 0])
            : sameEvidence([f.histories, after.status], [["0->1"], "missing"])
        } finally { unsubscribe(); f.dispose(); globalThis.fetch = originalFetch }
      }, scenario.startsWith("foreign-") ? "A second real drain runs after admission; durable read/wake are real, adapter still has no admitted binding contract" : null)
  }
  return rows
}

const main = async () => {
const results = []
// The controller matrix runs in its existing Bun test file, with its real bridge fake. Reuse it here rather than
// duplicating the controller fixture or treating a ledger-only probe as a controller witness.
const controllerRun = Bun.spawn({
  cmd: ["perl", "-e", "alarm shift; exec @ARGV", "120", process.execPath, "test", "--conditions=browser", path.join(import.meta.dirname, "../../src/lib/desktop/native-playback-controller.test.ts"),
    "--test-name-pattern", "3B1|DV01 instrument truth|configure-calls-real-callback|configure-stale-start-ingests-nothing|configure-reconciles-edit-after-capture|quiet-paused|incident-aggregation|urgent-refusal-recovers|old-panel-no-duplicate|lost-then-refused-is-unconfirmed|paused-claim-resolves-by-token|late-old-proof-after-newer-failure|progress-before-reply|publication-refused-is-refused"],
  stdout: "pipe", stderr: "pipe",
  env: { ...process.env, DV01_3B0_REPORT: "1", DV01_3B1_REPORT: "1" },
})
const [controllerOut, controllerError, controllerExit] = await Promise.all([
  new Response(controllerRun.stdout).text(), new Response(controllerRun.stderr).text(), controllerRun.exited,
])
const controllerSource = await Bun.file(path.join(import.meta.dirname, "../../src/lib/desktop/native-playback-controller.test.ts")).text()
const producerControls = [
  { name: "synth-unknown-live", rows: ["N6 synth-unknown-live"] },
  { name: "synth-unknown-nonlive", rows: ["N6 synth-unknown-nonlive"] },
  { name: "synth-instance-swap", rows: ["N6 synth-instance-swap"] },
  { name: "sampled-superseded-content", rows: ["N6 sampled-superseded-content"] },
  { name: "sampled-abort-and-readd-controller", rows: ["N6 sampled-abort-and-readd"] },
  { name: "R2-B6b-N2-equal-mapped-different-structure", rows: ["A3 structural", "N2", "R2-B6b"] },
  { name: "R2-B6c-configured-content-not-held", rows: ["R2-B6c"] },
  { name: "R2-B6a-post-capture-instrument-ingest", rows: ["R2-B6a"] },
  { name: "configure-calls-real-callback", rows: ["R2-B6a"] },
  { name: "configure-stale-start-ingests-nothing", rows: ["R2-B6a"] },
  { name: "configure-reconciles-edit-after-capture", rows: ["R2-B6a"] },
  { name: "paused-claim-resolves-by-token", rows: ["N4"] },
  { name: "progress-before-reply", rows: ["N4"] },
  { name: "quiet-paused-parameter-refusal", rows: ["N5"] },
  { name: "old-panel-no-duplicate", rows: ["N5", "R3-2 native"] },
  { name: "lost-then-refused-is-unconfirmed", rows: ["R4-1"] },
  { name: "incident-aggregation", rows: ["R2-A1"] },
  { name: "urgent-refusal-recovers", rows: ["R2-B6d"] },
  { name: "quiet-paused-urgent-refusal", rows: ["R2-B6d"] },
  { name: "late-old-proof-after-newer-failure", rows: ["R4-2d"] },
  { name: "publication-refused-is-refused", rows: ["A3 declined", "R4-1"] },
].map(entry => {
  const sourceOffset = controllerSource.indexOf(`test("${entry.name}`)
  const passed = (controllerOut + controllerError).split("\n").some(line => line.includes("(pass)") && line.includes(entry.name))
  return { ...entry, location: `src/lib/desktop/native-playback-controller.test.ts:${controllerSource.slice(0, sourceOffset).split("\n").length}`,
    status: sourceOffset >= 0 && passed ? "green" : "red", boundary: "accepted real-controller producer control, not panel registration proof" }
})
results.push({ name: "native-instrument-controller-matrix", milestone: 2, mutation: "controller-instrument-truth",
  status: controllerExit === 0 ? "green" : "red", detail: controllerExit === 0 ? null : controllerOut + controllerError })
// These named rows reuse the reviewer's permanent real-controller setups and the product desired helper.
for (const [name, mutation] of [
  ["r3 equal-order mismatching synth adoption stays unanswered", "equal-order-supersedes"],
  ["r3 incarnation guard keeps raised-floor request unanswered", "equal-order-supersedes"],
  ["r3 retained buffer rejects changed sample", "skip-overlay-validation"],
  ["r3 retained buffer rejects changed region", "skip-overlay-validation"],
  ["r3 known unavailable sampler keeps matching desired content", "drop-unavailable-keys"],
  ["r3 known unavailable granular keeps matching desired content", "drop-unavailable-keys"],
  ["r3 known unavailable drum-rack keeps matching desired content", "drop-unavailable-keys"],
]) {
  const passed = (controllerOut + controllerError).split("\n").some(line => line.includes("(pass)") && line.includes(name))
  results.push({ name, milestone: 2, mutation, status: passed ? "green" : "red",
    detail: passed ? null : controllerOut + controllerError })
}
for (const witness of witnesses) {
  let failure: string | undefined
  try {
    failure = await witness.check()
  } catch (error) {
    failure = `threw ${error instanceof Error ? error.message : String(error)}`
  }
  results.push({ name: witness.name, milestone: witness.milestone, mutation: witness.mutation, status: failure === undefined ? "green" : "red", detail: failure ?? null })
}
const step3B0 = await runStep3B0Witnesses()
await mkdir(reportDirectory, { recursive: true })
const raw = await mkdtemp(path.join(reportDirectory, "a8-raw-"))
let engineControls: { row: string; checks: { name: string; pass: true }[] }[] = []
const browserPanelRows: unknown[] = []
try {
  const child = Bun.spawn({
    cmd: ["perl", "-e", "alarm shift; exec @ARGV", "180", process.execPath, "test",
      path.join(import.meta.dirname, "device-control-cost.browser.test.ts"), "-t", "part A"],
    env: { ...process.env, DEVICE_COST_RAW_DIR: raw, DEVICE_COST_SCRATCH_DIR: raw, DEVICE_COST_A8_ONLY: "1" },
    stdout: "pipe", stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`A8 browser fixture failed: ${out}\n${err}`)
  engineControls = z.array(z.object({
    row: z.string(), checks: z.array(z.object({ name: z.string(), pass: z.literal(true) })),
  })).parse(await Bun.file(path.join(raw, "engine-controls.json")).json())
  const heldCompressor = z.array(z.record(z.string(), z.unknown()))
    .parse(await Bun.file(path.join(raw, "engine-controls.json")).json())
    .find(row => row.row === "R4-5 compressor in-place pending tick plus panel cancel")
  if (!heldCompressor) throw new Error("Missing actual held compressor panel cancel")
  browserPanelRows.push({ name: "R4-5 compressor in-place pending tick plus panel cancel",
    location: "tools/acceptance/dv01-engine-witnesses.browser-runtime.ts", evidence: heldCompressor,
    flip: "Actual in-place set held across panel cancel", status: "green", failure: null, expectedFailure: null, standIn: null })
  const callbacks = z.array(z.object({ device: z.string(), nativeSubmitted: z.number().positive(),
    outcomes: z.object({ unavailable: z.number().positive(), pending: z.literal(0) }),
    consumerReads: z.array(z.number().positive()).nonempty(), synthCallbacks: z.literal(0), registryAllocations: z.literal(0),
  })).length(3).parse(await Bun.file(path.join(raw, "publication-callbacks.json")).json())
  if (new Set(callbacks.map(row => row.device)).size !== 3) throw new Error("Duplicate sampled fixture kind")
  browserPanelRows.push({ name: "sampled-joins-publication real fixture callback return",
    location: "tools/acceptance/device-control-cost.browser-runtime.tsx", evidence: { callbacks },
    flip: "Actual EffectsPanel callback returns registrations read by its owner; no-host means unavailable",
    status: "green", failure: null, expectedFailure: null, standIn: null })
  const measured = z.array(z.object({ name: z.string(), ticks: z.number(), actual: z.object({
    calls: z.number(), applications: z.number(), skips: z.number(), joins: z.number(),
    dropped: z.number(), superseded: z.number(), notHeld: z.number(), rejected: z.number(), unproven: z.number(),
  }) })).parse(await Bun.file(path.join(raw, "a8.json")).json())
  if (measured.length !== 6) throw new Error(`A8 expected six rows, received ${measured.length}`)
  for (const row of measured) {
    const expected = { calls: row.ticks + 1, applications: row.ticks, skips: 1, joins: 0 }
    const current = { calls: row.actual.calls, applications: row.actual.applications, skips: row.actual.skips, joins: row.actual.joins }
    const failure = sameEvidence(current, expected)
    const expectedFailure = null
    step3B0.push({
      name: row.name, location: "src/components/timeline/parameter-gesture-owner.ts:420-428",
      flip: "3B-1 logical equal close reaches the actual runtime: N+1 calls, N applications, one skip, zero joins",
      standIn: null, expectedFailure, failure,
      status: failure === null && row.actual.dropped + row.actual.superseded + row.actual.notHeld + row.actual.rejected + row.actual.unproven === 0 ? "green" : "red",
    })
  }
} finally { await rm(raw, { recursive: true, force: true }) }
const controllerRow = z.object({
  name: z.string(), location: z.string(), flip: z.string(), standIn: z.string().nullable(),
  expectedFailure: z.null(), failure: z.null(), status: z.literal("green"),
})
for (const line of (controllerOut + controllerError).split("\n")) {
  if (!line.startsWith("DV01-3B0 ")) continue
  step3B0.push(controllerRow.parse(JSON.parse(line.slice("DV01-3B0 ".length))))
}
if (step3B0.filter(row => row.name.endsWith("real-controller") || row.name.startsWith("sampled-joins-publication adapter") || row.name.startsWith("R3-A3a")).length !== 5) {
  throw new Error("Missing real adapter/controller expected-red evidence")
}
const hookRun = Bun.spawn({
  cmd: ["perl", "-e", "alarm shift; exec @ARGV", "120", process.execPath, "test", "--conditions=browser",
    path.join(import.meta.dirname, "../../src/hooks/useEffectsPanelAudioSync.test.ts")],
  env: { ...process.env, DV01_3B0_REPORT: "1" }, stdout: "pipe", stderr: "pipe",
})
const [hookOut, hookErr, hookCode] = await Promise.all([
  new Response(hookRun.stdout).text(), new Response(hookRun.stderr).text(), hookRun.exited,
])
if (hookCode !== 0) throw new Error(`Hook adapter witnesses failed: ${hookOut}\n${hookErr}`)
for (const line of (hookOut + hookErr).split("\n")) {
  if (line.startsWith("DV01-3B0 ")) step3B0.push(controllerRow.parse(JSON.parse(line.slice("DV01-3B0 ".length))))
}
if (!step3B0.some(row => row.name.startsWith("R2-B5")) || !step3B0.some(row => row.name.startsWith("R5-3"))) {
  throw new Error("Missing arp/drum adapter evidence")
}
const expectedRedNames = [
  "R3-1 released project and user",
  "R3-2 native refused cannot veto persistence",
  "R3-2 native unconfirmed cannot veto persistence",
  "R4-2 equal-content stamped echoes",
  "R5-1 cancel allocates before projection without registry replace",
  "A2 foreign row with successor before-ack",
  "A2 foreign row with successor after-ack",
  "R3-6 idle lane retires",
  "registration-before-receipt",
  "synth-foreign-structural-row",
  "A8.3 native flush cannot precede save receipt",
  "P3 cloud provenance",
  "P9 cloud provenance",
  "local-save-returns-row setLocalEffect",
  "local-save-returns-row setLocalEffectInstance",
  "P outbox admitted-rejection",
  "P outbox dead-letter",
  "P outbox missing-completion",
  "P outbox duplicate-wakes",
  "P outbox foreign-drainer-noop",
  "P outbox foreign-drainer-rejection",
  "P outbox event-before-admission",
  "A8-audio-track-3",
  "A8-audio-master-3",
  "A8-persisted-synth-3",
  "A8-audio-track-20",
  "A8-audio-master-20",
  "A8-persisted-synth-20",
  "R3-A3a panel logical close after native proof",
  "registration-before-receipt real-controller",
  "sampled-joins-publication adapter sampler",
  "sampled-joins-publication adapter granular",
  "sampled-joins-publication adapter drum-rack",
  "R2-B5 unselected local arp owner delivery",
  "R5-3 sampled drum registry allocation",
]
if (sameEvidence(step3B0.filter(row => expectedRedNames.includes(row.name)).map(row => row.name), expectedRedNames) !== null) {
  throw new Error("The 35 required 3B-0 flip witnesses changed")
}
const counts = new Map<string, number>()
for (const row of step3B0) counts.set(row.name, (counts.get(row.name) ?? 0) + 1)
if ([...counts.values()].some(count => count !== 1) || step3B0.some(row => row.status !== "green" || row.failure !== null || row.expectedFailure !== null)) {
  throw new Error("Duplicate, skipped, expected-red or failing 3B-0 witness")
}
const fullPanelRows = []
for (const row of browserPanelRows) fullPanelRows.push(controllerRow.extend({ evidence: z.record(z.string(), z.unknown()) }).parse(row))
const timelineRun = Bun.spawn({
  cmd: ["perl", "-e", "alarm shift; exec @ARGV", "180", process.execPath, "test", "--conditions=browser",
    path.join(import.meta.dirname, "../../src/lib/desktop/native-playback-lifecycle.browser.test.ts"), "-t", "3B1 full Timeline"],
  env: { ...process.env, DV01_3B1_REPORT: "1", DAW_INSTRUMENT_EVIDENCE: path.join(reportDirectory, "timeline-desired") },
  stdout: "pipe", stderr: "pipe",
})
const [timelineOut, timelineErr, timelineCode] = await Promise.all([
  new Response(timelineRun.stdout).text(), new Response(timelineRun.stderr).text(), timelineRun.exited,
])
if (timelineCode !== 0) throw new Error(`Full Timeline witness failed: ${timelineOut}\n${timelineErr}`)
for (const line of (timelineOut + timelineErr).split("\n")) if (line.startsWith("DV01-3B1 "))
  fullPanelRows.push(controllerRow.extend({ evidence: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line.slice("DV01-3B1 ".length))))
for (const line of (controllerOut + controllerError).split("\n")) {
  if (line.startsWith("DV01-3B1 ")) fullPanelRows.push(controllerRow.extend({ evidence: z.record(z.string(), z.unknown()) })
    .parse(JSON.parse(line.slice("DV01-3B1 ".length))))
}
const promotionCoverage = [
  { name: "R4-1 native refused versus unconfirmed at panel boundary",
    witnesses: ["R4-1 native refused at panel boundary", "R4-1 native unconfirmed at panel boundary"] },
  { name: "R6-1 native superseded(by) at panel boundary", witnesses: ["R6-1 native superseded(by) at panel boundary"] },
  { name: "R7-1 holding G2 token", witnesses: ["R7-1 holding G2 token"] },
  { name: "N4 claimed native panel receipt", witnesses: ["N4 claimed native panel receipt"] },
  { name: "R3-A3b/R3-A6 panel installed-A/pending-B/request-A", witnesses: ["R3-A3b/R3-A6 panel installed-A/pending-B/request-A"] },
  { name: "A1 native held restore proof after foreign row", witnesses: ["A1 native held restore proof after foreign row"] },
  { name: "Multi-field panel token clear", witnesses: ["Multi-field panel token clear end", "Multi-field panel token clear cancel"] },
  { name: "R2-B3 mixed-carrier/no-dispatch panel token close", witnesses: ["R2-B3 mixed-carrier panel token close", "R2-B3 no-dispatch panel token close"] },
  { name: "A3 structural native selector through panel", witnesses: ["A3 structural native selector through panel"] },
  { name: "A3 declined native registration", witnesses: ["A3 declined native registration"] },
  { name: "R2-B6b panel full-structure reconciliation", witnesses: ["R2-B6b panel full-structure reconciliation"] },
  { name: "R7-2 refused restore recovery through panel", witnesses: ["R7-2 refused restore recovery through panel"] },
  { name: "N5 native panel decline/recovery", witnesses: ["N5 native panel decline/recovery"] },
  { name: "R4-2d native panel incident healing", witnesses: ["R4-2d native panel incident healing"] },
  { name: "N2 publication structure through panel", witnesses: ["N2 publication structure through panel"] },
  { name: "R2-A1 panel multi-target incident membership", witnesses: ["R2-A1 panel multi-target incident membership"] },
  { name: "A7 harmful/benign native panel token floors", witnesses: ["Below-floor panel close harmful", "Below-floor panel close benign"] },
  { name: "N3 below-floor native panel close", witnesses: ["Below-floor panel close harmful"] },
  { name: "R2-B6d urgent outcome through panel", witnesses: ["R2-B6d urgent outcome through panel"] },
  { name: "R2-B6c panel reconfigure from sent synth", witnesses: ["R2-B6c panel reconfigure from sent synth"] },
  { name: "R3-6 unanswered-receipt retention/drain", witnesses: ["R3-6 unanswered-receipt retention/drain"] },
  { name: "P admitted old-project/remove-readd binding and exact consume-once", witnesses: ["P admitted old-project/remove-readd binding and exact consume-once"] },
  { name: "P per-key revision propagation and positive equal stamps", witnesses: ["P per-key revision propagation and positive equal stamps"] },
  { name: "local-save-returns-row both normalized consumers", witnesses: ["local-save-returns-row both normalized consumers"] },
  { name: "R4-5 compressor in-place pending tick plus panel cancel", witnesses: ["R4-5 compressor in-place pending tick plus panel cancel"] },
  { name: "R2-B6a full Timeline desired-instrument callback", witnesses: ["R2-B6a full Timeline desired-instrument callback"] },
  { name: "sampled-joins-publication real fixture callback return", witnesses: ["sampled-joins-publication real fixture callback return"] },
]
const step3B1 = promotionCoverage.map(promotion => {
  const evidence = fullPanelRows.filter(row => promotion.witnesses.includes(row.name))
  if (evidence.length !== promotion.witnesses.length || new Set(evidence.map(row => row.name)).size !== evidence.length)
    throw new Error(`Missing or duplicate full panel witness: ${promotion.name}`)
  if (!requiredPromotions.some(row => row.name === promotion.name)) throw new Error(`Unknown promotion: ${promotion.name}`)
  return { ...promotion, evidence, status: "green" }
})
const completedPromotions = new Set(step3B1.map(row => row.name))
const threeB1Only = requiredPromotions.filter(row => !completedPromotions.has(row.name)).map(({ name, location }) => ({
  name, location, reason: "Full 3B-1 adapter/owner/controller witness and deliberate mutation evidence are not yet complete.",
}))
if (requiredPromotions.length !== 27 || new Set(requiredPromotions.map(row => row.name)).size !== 27)
  throw new Error("The 27 required promotions changed")

await mkdir(reportDirectory, { recursive: true })
await Bun.write(
  path.join(reportDirectory, "step1-m2b.json"),
  `${JSON.stringify({ tool: "dv01-boundary-witnesses", complete: threeB1Only.length === 0,
    results, producerControls, engineControls, step3B0, step3B1, threeB1Only,
    expectedRed: step3B0.filter(row => row.status === "expected-red").map(({ name, location, failure, flip, standIn }) => ({ name, location, failure, flip, standIn })) }, null, 2)}\n`,
)
for (const result of results) console.log(`${result.status.padEnd(6)} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`)
for (const row of step3B0) console.log(`${row.status} ${row.name}: ${row.failure ?? "oracle holds"}`)
for (const row of step3B1) console.log(`green ${row.name}: full panel witness`)
for (const row of threeB1Only) console.log(`incomplete ${row.name}`)
process.exit(threeB1Only.length || results.some((result) => result.status === "red") || producerControls.some(row => row.status === "red") || step3B0.some(row => row.status === "red") ? 1 : 0)
}
if (import.meta.main) await main()
