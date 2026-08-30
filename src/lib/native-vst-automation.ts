import type { NativeVstAutomationSegment } from '@daw-browser/audio-engine/native-host-wire'
import type { NativeExternalAttachmentPlan } from '@daw-browser/plugin-host-protocol'
import {
  parseExternalAutomationParameterId,
  valueAtAutomationTime,
  type AutomationEnvelope,
} from '@daw-browser/shared'

export type NativeVstAutomationProjectionInput = Readonly<{
  automationEnvelopes: readonly AutomationEnvelope[]
  externalAttachments?: NativeExternalAttachmentPlan
  sampleRateHz: number
  timelineOriginSec: number
  startFrame: number
  endFrame: number
}>

const clampNormalized = (value: number) => Math.min(1, Math.max(0, value))

export const isExternalVstAutomationEnvelope = (
  envelope: AutomationEnvelope,
  externalAttachments: NativeExternalAttachmentPlan | undefined,
) => {
  const parsed = parseExternalAutomationParameterId(envelope.parameterId)
  if (!parsed || !externalAttachments) return false
  const attachment = externalAttachments.attachments.find((entry) => entry.instanceId === parsed.instanceId)
  if (!attachment) return false
  return envelope.target.kind === 'master'
    ? attachment.graphNodeId === 'master'
    : attachment.graphNodeId === envelope.target.trackId
}

export const projectNativeVstAutomationSegments = (
  input: NativeVstAutomationProjectionInput,
): NativeVstAutomationSegment[] => {
  if (!Number.isFinite(input.sampleRateHz) || input.sampleRateHz <= 0
    || !Number.isFinite(input.timelineOriginSec)
    || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0
    || !Number.isSafeInteger(input.endFrame) || input.endFrame <= input.startFrame) {
    throw new Error('Native VST automation projection bounds are invalid.')
  }
  const plan = input.externalAttachments
  if (!plan) return []
  const attachments = new Map(plan.attachments.map((attachment) => [attachment.instanceId, attachment]))
  const timelineTimeAtFrame = (frame: number) => input.timelineOriginSec + frame / input.sampleRateHz
  const frameAtTimelineTime = (timeSec: number) => Math.round(
    (timeSec - input.timelineOriginSec) * input.sampleRateHz,
  )

  return input.automationEnvelopes.flatMap((envelope) => {
    const parsed = parseExternalAutomationParameterId(envelope.parameterId)
    const attachment = parsed ? attachments.get(parsed.instanceId) : undefined
    const descriptor = attachment?.parameters?.find((parameter) => parameter.id === parsed?.parameterId)
    if (!parsed || !attachment || attachment.bypassed || !envelope.enabled
      || descriptor?.readOnly === true
      || envelope.points.length === 0) return []
    const targetMatches = envelope.target.kind === 'master'
      ? attachment.graphNodeId === 'master'
      : attachment.graphNodeId === envelope.target.trackId
    if (!targetMatches) return []

    const points = envelope.points
    const pointFrames = points.map((point) => frameAtTimelineTime(point.timeSec))
    const fallback = descriptor?.defaultValue ?? 0
    const segments: NativeVstAutomationSegment[] = []
    const appendSegment = (
      segmentStart: number,
      segmentEnd: number,
      interpolation: 'linear' | 'hold',
    ) => {
      if (segmentStart >= segmentEnd) return
      segments.push({
        instanceId: attachment.instanceId,
        parameterId: parsed.parameterId,
        startFrame: segmentStart,
        endFrame: segmentEnd,
        startValue: clampNormalized(valueAtAutomationTime(
          points,
          timelineTimeAtFrame(segmentStart),
          fallback,
        )),
        endValue: clampNormalized(valueAtAutomationTime(
          points,
          timelineTimeAtFrame(segmentEnd),
          fallback,
        )),
        interpolation,
      })
    }

    const firstFrame = pointFrames[0] ?? input.endFrame
    appendSegment(
      input.startFrame,
      Math.min(input.endFrame, firstFrame),
      'hold',
    )
    for (let index = 0; index < points.length - 1; index += 1) {
      const point = points[index]
      const pointFrame = pointFrames[index] ?? input.endFrame
      const nextFrame = pointFrames[index + 1] ?? input.endFrame
      appendSegment(
        Math.max(input.startFrame, pointFrame),
        Math.min(input.endFrame, nextFrame),
        point.interpolation === 'linear' ? 'linear' : 'hold',
      )
    }
    const lastFrame = pointFrames[pointFrames.length - 1] ?? input.startFrame
    appendSegment(Math.max(input.startFrame, lastFrame), input.endFrame, 'hold')
    return segments
  }).sort((left, right) => (
    left.instanceId.localeCompare(right.instanceId)
      || left.parameterId - right.parameterId
      || left.startFrame - right.startFrame
  ))
}
