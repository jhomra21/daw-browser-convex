import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { PortableFrameScheduleEvent } from "@daw-browser/audio-engine/portable-frame-scheduling"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { parseExternalAutomationParameterId } from "@daw-browser/shared"
import type { NativeProcessorAutomationEvent } from "./native-processor-schedule-window"

type PortableParameterEvent = Extract<
  PortableFrameScheduleEvent,
  { type: "parameter-set" | "parameter-restore" | "parameter-ramp" }
>

const resolveNativeParameterTarget = (
  graph: AudioCoreGraphSnapshot,
  event: PortableParameterEvent,
) => {
  if (parseExternalAutomationParameterId(event.target.parameterId)) return undefined
  const nodeId = event.target.scope === "master" ? graph.masterNodeId : event.target.trackId
  const node = graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) throw new Error(`Native automation target node "${nodeId}" is unavailable.`)

  if (event.target.effectInstanceId) {
    const resolved = resolveGraphProcessor(graph, event.target.effectInstanceId, node.id)
    if (!resolved) {
      throw new Error(`Native automation processor "${event.target.effectInstanceId}" is unavailable.`)
    }
    if (resolved.processor.kind === "external-vst3") return undefined
    const parameterTarget = resolved.parameterTargets.get(event.target.parameterId)
    if (parameterTarget === undefined) {
      throw new Error(
        `Native automation parameter "${event.target.parameterId}" is unavailable on "${event.target.effectInstanceId}".`,
      )
    }
    return { processorInstanceId: resolved.processor.instanceId, parameterTarget }
  }

  const mixer = node.mixer
  const parameterTarget = mixer?.parameterTargets.find((candidate) => (
    candidate.id === event.target.parameterId
  ))?.target
  if (!mixer || parameterTarget === undefined) {
    throw new Error(`Native mixer automation parameter "${event.target.parameterId}" is unavailable on "${node.id}".`)
  }
  return { processorInstanceId: mixer.instanceId, parameterTarget }
}

export const nativeProcessorAutomationEventsForSchedule = (
  graph: AudioCoreGraphSnapshot,
  events: readonly PortableFrameScheduleEvent[],
): NativeProcessorAutomationEvent[] => {
  const projected: NativeProcessorAutomationEvent[] = []
  for (const event of events) {
    if (event.type !== "parameter-set"
      && event.type !== "parameter-restore"
      && event.type !== "parameter-ramp") continue
    const target = resolveNativeParameterTarget(graph, event)
    if (!target) continue
    if (event.type === "parameter-ramp") {
      projected.push({
        ...target,
        kind: "linear",
        frame: event.startFrame,
        endFrame: event.endFrame,
        startValue: event.startValue,
        endValue: event.endValue,
      })
      continue
    }
    projected.push({ ...target, kind: "set", frame: event.frame, value: event.value })
  }
  return projected.toSorted((left, right) => (
    left.frame - right.frame
      || left.processorInstanceId - right.processorInstanceId
      || left.parameterTarget - right.parameterTarget
  ))
}
