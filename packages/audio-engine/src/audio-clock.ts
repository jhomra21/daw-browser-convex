type AudioClockContext = {
  currentTime: number
  state: AudioContextState
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
}

export type AudioClockResult = {
  contextTime: number
  timelineTime: number
  scheduledContextTime: number
}

type MidiTimestampConverter = ((eventTimeStamp: number) => AudioClockResult | undefined) & {
  reset: () => void
}

export const createMidiTimestampConverter = (input: {
  context: () => AudioClockContext | null
  performanceNow: () => number
  contextTimeToTimeline: (contextTime: number) => number
}): MidiTimestampConverter => {
  let fallback: { performanceTime: number; contextTime: number } | undefined

  const convert = (eventTimeStamp: number): AudioClockResult | undefined => {
    const context = input.context()
    if (!context || !Number.isFinite(eventTimeStamp)) return undefined
    const current = Number.isFinite(context.currentTime) ? context.currentTime : 0
    if (context.state !== 'running') {
      fallback = undefined
      return {
        contextTime: current,
        timelineTime: input.contextTimeToTimeline(current),
        scheduledContextTime: current,
      }
    }
    const outputTimestamp = context.getOutputTimestamp?.()
    const outputContextTime = outputTimestamp?.contextTime
    const outputPerformanceTime = outputTimestamp?.performanceTime
    const contextTime = typeof outputContextTime === 'number'
      && Number.isFinite(outputContextTime)
      && typeof outputPerformanceTime === 'number'
      && Number.isFinite(outputPerformanceTime)
      ? outputContextTime + (eventTimeStamp - outputPerformanceTime) / 1000
      : (() => {
          const now = input.performanceNow()
          if (!fallback || now < fallback.performanceTime) {
            fallback = { performanceTime: now, contextTime: current }
          }
          return fallback.contextTime + (eventTimeStamp - fallback.performanceTime) / 1000
        })()
    return {
      contextTime,
      timelineTime: input.contextTimeToTimeline(contextTime),
      scheduledContextTime: Math.max(current, contextTime),
    }
  }
  convert.reset = () => {
    fallback = undefined
  }
  return convert
}
