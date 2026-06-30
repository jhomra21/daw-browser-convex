import type { AutomationEnvelope } from '@daw-browser/shared'
import { valueAtAutomationTime } from '@daw-browser/shared'

export type AutomationAudioBinding = {
  param: AudioParam
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
  }
}
