import type { NativeVstAutomationSegment } from "@daw-browser/audio-engine/native-host-wire"
import type { NativeExternalAttachmentPlan } from "@daw-browser/plugin-host-protocol"
import {
  parseExternalAutomationParameterId,
  valueAtAutomationTime,
  type AutomationEnvelope,
} from "@daw-browser/shared"

const clampNormalized = (value: number) => Math.min(1, Math.max(0, value))

export const nativeVstAutomationSegmentsForEnvelopes = (input: {
  attachments: NativeExternalAttachmentPlan | undefined
  automationEnvelopes: readonly AutomationEnvelope[]
  sampleRateHz: number
  startFrame: number
  endFrame: number
}): NativeVstAutomationSegment[] => {
  if (
    !Number.isSafeInteger(input.startFrame)
    || !Number.isSafeInteger(input.endFrame)
    || input.startFrame < 0
    || input.endFrame <= input.startFrame
    || !Number.isSafeInteger(input.sampleRateHz)
    || input.sampleRateHz <= 0
  ) throw new Error("Native VST automation range is invalid.")

  const plan = input.attachments
  if (!plan) return []
  const attachments = new Map(plan.attachments.map((attachment) => [attachment.instanceId, attachment]))
  return input.automationEnvelopes.flatMap((envelope) => {
    const parsed = parseExternalAutomationParameterId(envelope.parameterId)
    const attachment = parsed ? attachments.get(parsed.instanceId) : undefined
    const descriptor = attachment?.parameters?.find((parameter) => parameter.id === parsed?.parameterId)
    if (!parsed || !attachment || attachment.bypassed || !envelope.enabled
      || descriptor?.readOnly === true
      || envelope.points.length === 0) return []
    const targetMatches = envelope.target.kind === "master"
      ? attachment.graphNodeId === "master"
      : attachment.graphNodeId === envelope.target.trackId
    if (!targetMatches) return []

    const pointFrames = envelope.points.map((point) => Math.round(point.timeSec * input.sampleRateHz))
    const fallback = descriptor?.defaultValue ?? 0
    const segments: NativeVstAutomationSegment[] = []
    const appendSegment = (
      segmentStart: number,
      segmentEnd: number,
      interpolation: "linear" | "hold",
    ) => {
      const startFrame = Math.max(input.startFrame, segmentStart)
      const endFrame = Math.min(input.endFrame, segmentEnd)
      if (startFrame >= endFrame) return
      segments.push({
        instanceId: attachment.instanceId,
        parameterId: parsed.parameterId,
        startFrame,
        endFrame,
        startValue: clampNormalized(valueAtAutomationTime(
          envelope.points,
          startFrame / input.sampleRateHz,
          fallback,
        )),
        endValue: clampNormalized(valueAtAutomationTime(
          envelope.points,
          endFrame / input.sampleRateHz,
          fallback,
        )),
        interpolation,
      })
    }

    const firstFrame = pointFrames[0] ?? input.endFrame
    appendSegment(input.startFrame, firstFrame, "hold")
    for (let index = 0; index < envelope.points.length - 1; index += 1) {
      const point = envelope.points[index]
      const pointFrame = pointFrames[index] ?? input.endFrame
      const nextFrame = pointFrames[index + 1] ?? input.endFrame
      appendSegment(pointFrame, nextFrame, point.interpolation === "linear" ? "linear" : "hold")
    }
    const lastFrame = pointFrames[pointFrames.length - 1] ?? input.startFrame
    appendSegment(lastFrame, input.endFrame, "hold")
    return segments
  }).sort((left, right) => (
    left.instanceId.localeCompare(right.instanceId)
      || left.parameterId - right.parameterId
      || left.startFrame - right.startFrame
  ))
}
