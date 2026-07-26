import type { AutomationEnvelope } from '@daw-browser/shared'
import { valueAtAutomationTime } from '@daw-browser/shared'

export type AutomationAudioBinding = {
  param: {
    value?: number
    cancelScheduledValues: (startTime: number) => unknown
    linearRampToValueAtTime: (value: number, endTime: number) => unknown
    setValueAtTime: (value: number, startTime: number) => unknown
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
  const startValue = valueAtAutomationTime(envelope.points, window.startLimitSec, fallbackValue)
  const endBoundaryPoint = envelope.points.find((point) => point.timeSec === window.endLimitSec)
  const nextAfterEndIndex = envelope.points.findIndex((point) => point.timeSec > window.endLimitSec)
  const nextAfterEnd = nextAfterEndIndex === -1 ? undefined : envelope.points[nextAfterEndIndex]
  const previousBeforeEnd = nextAfterEndIndex <= 0 ? undefined : envelope.points[nextAfterEndIndex - 1]
  const shouldRampToWindowEnd = Boolean(
    !endBoundaryPoint
      && nextAfterEnd
      && previousBeforeEnd
      && previousBeforeEnd.timeSec < window.endLimitSec
      && previousBeforeEnd.interpolation === 'linear',
  )
  const points: AutomationSchedulePoint[] = [{
    timeSec: window.startLimitSec,
    value: startValue,
    kind: 'set',
  }]
  for (let index = 0; index < envelope.points.length; index += 1) {
    const point = envelope.points[index]
    if (!point || point.timeSec <= window.startLimitSec) continue
    if (point.timeSec > window.endLimitSec) break
    const previous = envelope.points[index - 1]
    points.push({
      timeSec: point.timeSec,
      value: point.value,
      kind: !previous || previous.interpolation === 'hold' ? 'set' : 'ramp',
    })
  }
  if (shouldRampToWindowEnd) {
    points.push({
      timeSec: window.endLimitSec,
      value: valueAtAutomationTime(envelope.points, window.endLimitSec, fallbackValue),
      kind: 'ramp',
    })
  }
  return points
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
  const value = valueAtAutomationTime(envelope.points, timelineSec, fallbackValue)
  for (const binding of bindings) {
    binding.param.cancelScheduledValues(audioCtxTime)
    binding.param.setValueAtTime(binding.valueToAudioValue(value), audioCtxTime)
  }
}
