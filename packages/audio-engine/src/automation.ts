import {
  getAutomationParameterDescriptor,
  normalizeAutomationPoints,
  valueAtAutomationTime,
  type AutomationEnvelope,
} from '@daw-browser/shared'

export type AutomationAudioBinding = {
  param: {
    value?: number
    cancelScheduledValues: (startTime: number) => void
    linearRampToValueAtTime: (value: number, endTime: number) => void
    setValueAtTime: (value: number, startTime: number) => void
  }
  valueToAudioValue: (value: number) => number
}

export type AutomationScheduleWindow = {
  playheadSec: number
  startLimitSec: number
  endLimitSec: number
}

export type AutomationSchedulePoint = {
  timeSec: number
  value: number
  kind: 'set' | 'ramp'
}

export const getAutomationEnvelopeSchedulePlan = (
  envelope: AutomationEnvelope,
  window: AutomationScheduleWindow,
  fallbackValue: number,
): readonly AutomationSchedulePoint[] => {
  const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
  const points = descriptor ? normalizeAutomationPoints(envelope.points, descriptor) : envelope.points
  const startValue = valueAtAutomationTime(points, window.startLimitSec, fallbackValue)
  const endBoundaryPoint = points.find((point) => point.timeSec === window.endLimitSec)
  const nextAfterEndIndex = points.findIndex((point) => point.timeSec > window.endLimitSec)
  const nextAfterEnd = nextAfterEndIndex === -1 ? undefined : points[nextAfterEndIndex]
  const previousBeforeEnd = nextAfterEndIndex <= 0 ? undefined : points[nextAfterEndIndex - 1]
  const shouldRampToWindowEnd = Boolean(
    !endBoundaryPoint
      && nextAfterEnd
      && previousBeforeEnd
      && previousBeforeEnd.timeSec < window.endLimitSec
      && previousBeforeEnd.interpolation === 'linear',
  )
  const schedulePoints: AutomationSchedulePoint[] = [{
    timeSec: window.startLimitSec,
    value: startValue,
    kind: 'set',
  }]
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    if (!point || point.timeSec <= window.startLimitSec) continue
    if (point.timeSec > window.endLimitSec) break
    const previous = points[index - 1]
    schedulePoints.push({
      timeSec: point.timeSec,
      value: point.value,
      kind: !previous || previous.interpolation === 'hold' ? 'set' : 'ramp',
    })
  }
  if (shouldRampToWindowEnd) {
    schedulePoints.push({
      timeSec: window.endLimitSec,
      value: valueAtAutomationTime(points, window.endLimitSec, fallbackValue),
      kind: 'ramp',
    })
  }
  return schedulePoints
}

export function scheduleAutomationEnvelope(
  bindings: AutomationAudioBinding[],
  envelope: AutomationEnvelope,
  window: AutomationScheduleWindow,
  timelineToCtxTime: (timeSec: number) => number,
  fallbackValue: number,
) {
  const startCtx = timelineToCtxTime(window.startLimitSec)
  const plan = getAutomationEnvelopeSchedulePlan(envelope, window, fallbackValue)
  const first = plan[0]
  if (!first) return

  for (const binding of bindings) {
    const param = binding.param
    param.cancelScheduledValues(startCtx)
    param.setValueAtTime(binding.valueToAudioValue(first.value), timelineToCtxTime(first.timeSec))
    for (const point of plan.slice(1)) {
      const value = binding.valueToAudioValue(point.value)
      const time = timelineToCtxTime(point.timeSec)
      if (point.kind === 'set') param.setValueAtTime(value, time)
      else param.linearRampToValueAtTime(value, time)
    }
  }
}

export function applyAutomationEnvelopeAtTime(
  bindings: AutomationAudioBinding[],
  envelope: AutomationEnvelope,
  timelineSec: number,
  audioCtxTime: number,
  fallbackValue: number,
) {
  const descriptor = getAutomationParameterDescriptor(envelope.parameterId)
  const points = descriptor ? normalizeAutomationPoints(envelope.points, descriptor) : envelope.points
  const value = valueAtAutomationTime(points, timelineSec, fallbackValue)
  for (const binding of bindings) {
    binding.param.cancelScheduledValues(audioCtxTime)
    binding.param.setValueAtTime(binding.valueToAudioValue(value), audioCtxTime)
  }
}
