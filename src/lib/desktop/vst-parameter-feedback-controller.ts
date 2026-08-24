import { automationTargetKey, externalAutomationParameterId, isLocalId } from "@daw-browser/shared"
import type { DesktopVstParameterEditPayload } from "@daw-browser/desktop-protocol"
import { maxVst3WorkerEventsPerBlock } from "@daw-browser/plugin-host-protocol"
import type { NativeVstParameterQueue } from "./native-vst-parameter-queue"
import { mergeLocalExternalProcessorParameterOverrides } from "~/lib/external-plugins"

type VstParameterFeedbackControllerInput = {
  projectId: () => string
  mountedProjectGeneration: () => number
  overrideTarget: (targetKey: string) => void
  nativeVstParameterQueue?: Pick<NativeVstParameterQueue, "enqueue">
  isNativePlaybackPrepared?: () => boolean
  reportFault?: (message: string) => void
}

export type VstParameterFeedbackController = {
  dispose: () => void
}

export const createVstParameterFeedbackController = (
  input: VstParameterFeedbackControllerInput,
): VstParameterFeedbackController | undefined => {
  const subscription = window.dawDesktop?.audioHost?.session.onVstParameterEdit
  if (!subscription) return undefined
  let disposed = false
  type PendingEdit = {
    payload: DesktopVstParameterEditPayload
    projectId: string
    generation: number
  }
  type InstanceState = {
    pending: Map<number, PendingEdit>
    inFlight: boolean
    scheduled: boolean
  }
  const instances = new Map<string, InstanceState>()
  const reportFault = (failure: Error | string) => {
    input.reportFault?.(failure instanceof Error ? failure.message : failure)
  }
  const drain = async (instanceId: string, state: InstanceState) => {
    if (state.inFlight || disposed) return
    state.scheduled = false
    state.inFlight = true
    try {
      while (!disposed && state.pending.size > 0) {
        const snapshot = [...state.pending.values()]
        state.pending.clear()
        const first = snapshot[0]
        if (!first) continue
        if (
          snapshot.some((entry) => (
            entry.projectId !== first.projectId
            || entry.generation !== first.generation
            || input.projectId() !== entry.projectId
            || input.mountedProjectGeneration() !== entry.generation
          ))
        ) continue
        if (snapshot.length > maxVst3WorkerEventsPerBlock) {
          reportFault(`VST parameter feedback exceeded the bounded ${maxVst3WorkerEventsPerBlock}-parameter limit.`)
          continue
        }
        const commit = await mergeLocalExternalProcessorParameterOverrides(
          first.projectId,
          instanceId,
          snapshot.map(({ payload }) => ({
            parameterId: payload.parameterId,
            normalizedValue: payload.normalizedValue,
          })),
        )
        if (!commit || disposed) continue
        if (input.projectId() !== first.projectId || input.mountedProjectGeneration() !== first.generation) continue
        for (const { payload } of snapshot) {
          if (payload.source === "editor-session" && input.isNativePlaybackPrepared?.()) {
            const delivery = await input.nativeVstParameterQueue?.enqueue({
              instanceId,
              id: payload.parameterId,
              value: payload.normalizedValue,
            }) ?? "delivered"
            if (delivery === "superseded") continue
            if (delivery !== "delivered") {
              throw new Error("The native VST parameter feedback queue rejected delivery.")
            }
          }
          if (
            disposed
            || input.projectId() !== first.projectId
            || input.mountedProjectGeneration() !== first.generation
          ) continue
          const parameterId = externalAutomationParameterId(instanceId, payload.parameterId)
          const targetKey = automationTargetKey(
            commit.current.targetId === "master"
              ? { kind: "master", effectInstanceId: instanceId }
              : { kind: "track", trackId: commit.current.targetId, effectInstanceId: instanceId },
            parameterId,
          )
          try {
            input.overrideTarget(targetKey)
          } catch {
            // Persistence and native delivery remain authoritative when the
            // local automation controller is unavailable during teardown.
          }
        }
      }
    } catch (error) {
      reportFault(error instanceof Error ? error : "VST parameter feedback persistence failed.")
    } finally {
      state.inFlight = false
      if (state.pending.size === 0) instances.delete(instanceId)
    }
  }
  const unsubscribe = subscription((payload: DesktopVstParameterEditPayload) => {
    const projectId = input.projectId()
    const generation = input.mountedProjectGeneration()
    if (disposed || !isLocalId("project", projectId) || payload.projectId !== projectId) return
    const state = instances.get(payload.instanceId) ?? { pending: new Map(), inFlight: false, scheduled: false }
    if (!state.pending.has(payload.parameterId) && state.pending.size >= maxVst3WorkerEventsPerBlock) {
      reportFault(`VST parameter feedback exceeded the bounded ${maxVst3WorkerEventsPerBlock}-parameter limit.`)
      return
    }
    state.pending.set(payload.parameterId, { payload, projectId, generation })
    instances.set(payload.instanceId, state)
    if (!state.inFlight && !state.scheduled) {
      state.scheduled = true
      queueMicrotask(() => void drain(payload.instanceId, state))
    }
  })
  return {
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      for (const state of instances.values()) state.pending.clear()
      instances.clear()
    },
  }
}
