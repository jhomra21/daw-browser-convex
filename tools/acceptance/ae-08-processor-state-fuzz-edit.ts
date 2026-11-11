import { createDefaultUtilityParams } from "@daw-browser/shared"
import { captureNativeBuiltInParameterValues, encodeNativeBuiltInStateCommit, nativeBuiltInPatchTiming, type NativeBuiltInParameterPayload } from "../../src/lib/desktop/native-built-in-parameter-mapper"
import type { LiveProcessorEditIdentity } from "../../src/lib/live-processor-control"

const kindIds = { utility: 1, spectral: 15 }

// Fixture-side edit identity. The order is the fuzzer's own desired-model
// order; content bytes come from the product encoder, never a winner/merge. `valued` captures the parameter values the
// registry captures for its edits; the default keeps the edits of the scenarios written without them.
export const fixtureEdit = (payload: NativeBuiltInParameterPayload, order: number, bpm: number, incarnation: number, valued = false): LiveProcessorEditIdentity | undefined => {
  const state = encodeNativeBuiltInStateCommit(payload, bpm)?.state
  const kindId = payload.effect === "utility" ? kindIds.utility : payload.effect === "spectral" ? kindIds.spectral : undefined
  if (!state || !payload.instanceId || kindId === undefined) return undefined
  const values = valued ? captureNativeBuiltInParameterValues(payload, bpm) : undefined
  return { id: `edit:${order}`, order, target: { nodeId: payload.targetId, instanceId: payload.instanceId, kindId, incarnation },
    content: { params: payload.to, state, timing: nativeBuiltInPatchTiming(payload), ...(values && { values }) } }
}

export const utilityGainPayload = (gain: number): NativeBuiltInParameterPayload => ({
  effect: "utility", instanceId: "utility:1", targetId: "track",
  from: { version: 1, state: createDefaultUtilityParams() },
  to: { version: 1, state: { ...createDefaultUtilityParams(), gainDb: gain } },
})
