import type { AutomationEnvelope } from '@daw-browser/shared'
import { valueAtAutomationTime } from '@daw-browser/shared'

export type AutomationAudioBinding = {
  param: {
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

export function scheduleAutomationEnvelope(
  bindings: AutomationAudioBinding[],
  envelope: AutomationEnvelope,
  window: AutomationScheduleWindow,
  timelineToCtxTime: (timeSec: number) => number,
  fallbackValue: number,
) {
  const startValue = valueAtAutomationTime(envelope.points, window.startLimitSec, fallbackValue)
  const startCtx = timelineToCtxTime(window.startLimitSec)
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

  for (const binding of bindings) {
    const param = binding.param
    param.cancelScheduledValues(startCtx)
    param.setValueAtTime(binding.valueToAudioValue(startValue), startCtx)

    for (let index = 0; index < envelope.points.length; index += 1) {
      const point = envelope.points[index]
      if (!point || point.timeSec <= window.startLimitSec) continue
      if (point.timeSec > window.endLimitSec) break
      const previous = envelope.points[index - 1]
      const ctxTime = timelineToCtxTime(point.timeSec)
      const value = binding.valueToAudioValue(point.value)
      if (!previous || previous.interpolation === 'hold') param.setValueAtTime(value, ctxTime)
      else param.linearRampToValueAtTime(value, ctxTime)
    }

    if (shouldRampToWindowEnd) {
      const endValue = valueAtAutomationTime(envelope.points, window.endLimitSec, fallbackValue)
      param.linearRampToValueAtTime(binding.valueToAudioValue(endValue), timelineToCtxTime(window.endLimitSec))
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
