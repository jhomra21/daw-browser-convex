import type { EffectTimingInput } from "@daw-browser/audio-engine/effects/timing"
import type { AudioCoreInstrumentState, AudioCoreSynthState } from "@daw-browser/audio-core-contract"

export type LiveProcessorParameterValue = {
  parameterId: string
  value: number
}

// A renderer-local discriminator that keeps a synth target distinct from the
// built-in processor kinds (1-17). It is not a native processor kind: native
// synths are instrument nodes, dispatched by instrument events. A synth is
// identified everywhere (edits, requests, owner targets) by its instanceId.
export const SYNTH_KIND_ID = 18

// What a built-in processor's state patch reads of its parameters at the tempo it is sent at: whether the effect is
// enabled and the input its tail is derived from.
export type ProcessorTiming = {
  enabled?: boolean
  input: EffectTimingInput
}

export type LiveProcessorEditIdentity = {
  id: string
  order: number
  // Restores the engine after a failed save or a cancelled gesture, so no gesture is left holding native.
  rollback?: true
  target: {
    nodeId: string
    instanceId: string
    kindId: number
    incarnation: number
  }
  content: {
    params: object
    state?: Uint8Array
    values?: Readonly<Record<string, number>>
    // `params` is untyped here; the allocator knows its effect, so it captures the timing input beside it.
    timing?: ProcessorTiming
  }
}

// Why native, or the policy that retries it, definitely did not take a delivery. `claim-failed` is a claimed patch
// whose resolution reported a failure; `native-refused` is a parameter or urgent batch native answered no to.
export type ProcessorRefusal =
  | "invalid" | "stage-failed" | "apply-failed" | "not-claimed" | "claim-failed" | "native-refused" | "unsupported"
  | "preparing" | "stale-revision" | "claim-pending"

// One vocabulary for every leg of a delivery (design 1.2). Only a proof produces `applied`; only a definite refusal of
// every attempt produces `refused`; a lost reply produces neither.
export type ProcessorDeliveryOutcome =
  | { state: "applied" }
  | { state: "superseded"; by: number }
  | { state: "refused"; reason: ProcessorRefusal }
  | { state: "unconfirmed" }
  | { state: "unavailable" }

// Opaque to callers: witnesses and the drain use it to read receipts that are still unanswered.
export type ReceiptHandle = { key: string; serial: number }
export type DeliveryRegistration = { receipt: ReceiptHandle; settled: Promise<ProcessorDeliveryOutcome> }

// `holds`: a preview inside an open gesture; not `holds`: this delivery ends the gesture (a flush or a rollback).
export type ProcessorDelivery = {
  edit: LiveProcessorEditIdentity
  gesture?: { token: string; holds: boolean }
}

// Structural or sampled content with no registry edit: its receipt is answered by the adoption that carries it.
export type PublicationJoin = {
  target: { nodeId: string; instanceId: string }
  contentKey: string
  lifetime: number
}

export type DesiredInstrument = {
  kind: "synth"
  instanceId: string
  state: AudioCoreSynthState
} | {
  kind: "sampled"
  instanceId: string
  contentKey: string
}

// All three boundaries key the compiled native configuration, never browser-only params or a request identity.
export const nativeInstrumentContentKey = (state: AudioCoreInstrumentState): string => JSON.stringify(
  Object.fromEntries(Object.entries(state).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)))

export const nativeSynthValues = (state: AudioCoreSynthState) => ({
  "synth.outputGain": state.outputGain ?? 1, "synth.outputPan": state.outputPan ?? 0,
  "synth.filterCutoffHz": state.filterCutoffHz ?? 20_000, "synth.filterResonance": state.filterResonance ?? 0.7,
  "synth.ampAttackMs": state.ampAttackMs ?? 0, "synth.ampDecayMs": state.ampDecayMs ?? 0,
  "synth.ampSustain": state.ampSustain ?? 1, "synth.ampReleaseMs": state.ampReleaseMs ?? 0,
})

export const nativeSynthStructureKey = (state: AudioCoreSynthState): string => nativeInstrumentContentKey({
  ...state, outputGain: 0, outputPan: 0, filterCutoffHz: 0, filterResonance: 0,
  ampAttackMs: 0, ampDecayMs: 0, ampSustain: 0, ampReleaseMs: 0,
})

export type LiveProcessorControlRequest = {
  instanceId: string
  values: readonly LiveProcessorParameterValue[]
  revision?: number
  epoch?: number
  sequence?: number
  edit?: LiveProcessorEditIdentity
}

export type LiveProcessorControlResult =
  | {
      accepted: true
      sequence: number
      // Present only after native progress proved the edit applied: the batch
      // sequence for processors, the urgent-lane sequence for instruments.
      appliedSequence?: number
    }
  | {
      accepted: false
      // `cancelled`: the edit's session or target ended and the persisted draft is the record; nothing is owed.
      // `bridge-error` reports a failed portable-control operation.
      reason: 'unavailable' | 'unprepared' | 'stale' | 'cancelled' | 'unsupported' | 'overflow' | 'bridge-error'
      error?: string
    }

export type LiveProcessorControlRejectReason = Extract<
  LiveProcessorControlResult,
  { accepted: false }
>["reason"]

export type LiveProcessorControl = {
  preview: (request: LiveProcessorControlRequest) => LiveProcessorControlResult | Promise<LiveProcessorControlResult>
  flush: (request: LiveProcessorControlRequest) => Promise<LiveProcessorControlResult>
  reenableAutomation: (instanceId: string, parameterIds: readonly string[], revision: number, epoch: number) => Promise<LiveProcessorControlResult>
}

export const rejectedLiveProcessorControl = (
  reason: LiveProcessorControlRejectReason,
): LiveProcessorControlResult => ({ accepted: false, reason })
