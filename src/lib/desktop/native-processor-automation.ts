import type { AudioCoreGraphSnapshot } from "@daw-browser/audio-core-contract"
import type { NativeProcessorAutomationEvent } from "@daw-browser/audio-engine/native-host-wire"
import type { PortableFrameScheduleEvent } from "@daw-browser/audio-engine/portable-frame-scheduling"
import { resolveGraphProcessor } from "@daw-browser/audio-engine/mixer/resolve-graph-processor"
import { parseExternalAutomationParameterId } from "@daw-browser/shared"

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

const sortNativeProcessorAutomationEvents = (
  events: readonly NativeProcessorAutomationEvent[],
): NativeProcessorAutomationEvent[] => (
  [...events].sort((left, right) => (
    left.frame - right.frame
      || left.processorInstanceId - right.processorInstanceId
      || left.parameterTarget - right.parameterTarget
  ))
)

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
  const deduplicated = new Map<string, NativeProcessorAutomationEvent>()
  for (const event of projected) {
    deduplicated.set(
      `${event.processorInstanceId}\u0000${event.parameterTarget}\u0000${event.frame}`,
      event,
    )
  }
  return sortNativeProcessorAutomationEvents([...deduplicated.values()])
}

const linearValueAtFrame = (
  event: Extract<NativeProcessorAutomationEvent, { kind: "linear" }>,
  frame: number,
) => {
  if (frame <= event.frame) return event.startValue
  if (frame >= event.endFrame) return event.endValue
  const progress = (frame - event.frame) / (event.endFrame - event.frame)
  return event.startValue + (event.endValue - event.startValue) * progress
}

export const sliceNativeProcessorAutomationEvents = (
  events: readonly NativeProcessorAutomationEvent[],
  startFrame: number,
  endFrame: number,
): NativeProcessorAutomationEvent[] => {
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame)
    || startFrame < 0 || endFrame <= startFrame) {
    throw new Error("Native processor automation window bounds are invalid.")
  }
  const sliced: NativeProcessorAutomationEvent[] = []
  for (const event of events) {
    if (event.kind === "set") {
      if (event.frame >= startFrame && event.frame < endFrame) sliced.push(event)
      continue
    }
    const frame = Math.max(startFrame, event.frame)
    const rampEndFrame = Math.min(endFrame, event.endFrame)
    if (frame >= rampEndFrame) continue
    sliced.push({
      ...event,
      frame,
      endFrame: rampEndFrame,
      startValue: linearValueAtFrame(event, frame),
      endValue: linearValueAtFrame(event, rampEndFrame),
    })
  }
  return sortNativeProcessorAutomationEvents(sliced)
}

export const nativeProcessorAutomationEventsAtCallbackBoundaries = (
  events: readonly NativeProcessorAutomationEvent[],
  maximumFramesPerBlock: number,
  callbackStartFrame: number,
  windowEndFrame: number,
): NativeProcessorAutomationEvent[] => {
  if (!Number.isSafeInteger(maximumFramesPerBlock) || maximumFramesPerBlock <= 0) {
    throw new Error("Native processor automation callback block size is invalid.")
  }
  if (!Number.isSafeInteger(callbackStartFrame) || callbackStartFrame < 0
    || !Number.isSafeInteger(windowEndFrame) || windowEndFrame <= callbackStartFrame) {
    throw new Error("Native processor automation window end is invalid.")
  }
  const projected: NativeProcessorAutomationEvent[] = []
  for (const event of events) {
    if (event.kind === "set") {
      projected.push(event)
      continue
    }
    let frame = event.frame
    while (frame < event.endFrame) {
      projected.push({
        kind: "set",
        processorInstanceId: event.processorInstanceId,
        parameterTarget: event.parameterTarget,
        frame,
        value: linearValueAtFrame(event, frame),
      })
      const nextBoundary = callbackStartFrame
        + (Math.floor((frame - callbackStartFrame) / maximumFramesPerBlock) + 1) * maximumFramesPerBlock
      frame = Math.min(event.endFrame, nextBoundary)
    }
    if (event.endFrame < windowEndFrame) {
      projected.push({
        kind: "set",
        processorInstanceId: event.processorInstanceId,
        parameterTarget: event.parameterTarget,
        frame: event.endFrame,
        value: event.endValue,
      })
    }
  }
  const deduplicated = new Map<string, NativeProcessorAutomationEvent>()
  for (const event of projected) {
    deduplicated.set(
      `${event.processorInstanceId}\u0000${event.parameterTarget}\u0000${event.frame}`,
      event,
    )
  }
  return sortNativeProcessorAutomationEvents([...deduplicated.values()])
}
