export type PortableScheduleIdentity = {
  revision: number
  transportEpoch: number
  sampleRateHz: number
  bpm: number
  timeOrigin: {
    timelineSec: number
    frame: number
  }
}

export type PortableInstrumentTarget = {
  kind: 'instrument'
  trackId: string
}

export type PortableParameterTarget = {
  kind: 'parameter'
  scope: 'track' | 'master'
  trackId?: string
  effectInstanceId?: string
  parameterId: string
}

export type PortableScheduleTarget = PortableInstrumentTarget | PortableParameterTarget

export type PortableFrameScheduleEvent =
  | {
    frame: number
    sequence: number
    type: 'note-on'
    target: PortableInstrumentTarget
    noteId: number
    pitch: number
    velocity: number
  }
  | {
    frame: number
    sequence: number
    type: 'note-off'
    target: PortableInstrumentTarget
    noteId: number
    pitch: number
  }
  | {
    frame: number
    sequence: number
    type: 'parameter-set' | 'parameter-restore'
    target: PortableParameterTarget
    value: number
  }
  | {
    frame: number
    sequence: number
    type: 'parameter-ramp'
    target: PortableParameterTarget
    startFrame: number
    endFrame: number
    startValue: number
    endValue: number
    interpolation: 'linear'
  }

export type PortableFrameSchedule = PortableScheduleIdentity & {
  events: readonly PortableFrameScheduleEvent[]
}

export type PortableFrameScheduleBlock = {
  startFrame: number
  frameCount: number
  events: readonly (PortableFrameScheduleEvent & { frameOffset: number })[]
}

const positiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const nonnegativeSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validTarget = (target: unknown): boolean => (
  isRecord(target)
  && (target.kind === 'instrument'
    ? typeof target.trackId === 'string' && target.trackId.length > 0
    : typeof target.parameterId === 'string' && target.parameterId.length > 0
      && (target.scope === 'master' || typeof target.trackId === 'string' && target.trackId.length > 0))
)

const validEvent = (event: unknown): event is PortableFrameScheduleEvent => (
  isRecord(event)
  && nonnegativeSafeInteger(event.frame)
  && positiveSafeInteger(event.sequence)
  && validTarget(event.target)
  && (event.type === 'note-on'
    ? nonnegativeSafeInteger(event.pitch) && event.pitch <= 127
      && positiveSafeInteger(event.noteId)
      && finiteNumber(event.velocity) && event.velocity >= 0 && event.velocity <= 1
    : event.type === 'note-off'
      ? nonnegativeSafeInteger(event.pitch) && event.pitch <= 127 && positiveSafeInteger(event.noteId)
    : event.type === 'parameter-ramp'
      ? nonnegativeSafeInteger(event.startFrame)
        && nonnegativeSafeInteger(event.endFrame)
        && event.startFrame === event.frame
        && event.endFrame > event.startFrame
        && finiteNumber(event.startValue)
        && finiteNumber(event.endValue)
        && event.interpolation === 'linear'
      : finiteNumber(event.value))
)

export const isPortableFrameSchedule = (value: unknown): value is PortableFrameSchedule => {
  if (!isRecord(value) || !isRecord(value.timeOrigin) || !Array.isArray(value.events)) return false
  if (
    !positiveSafeInteger(value.revision)
    || !positiveSafeInteger(value.transportEpoch)
    || !positiveSafeInteger(value.sampleRateHz)
    || !finiteNumber(value.bpm) || value.bpm <= 0
    || !finiteNumber(value.timeOrigin.timelineSec)
    || !nonnegativeSafeInteger(value.timeOrigin.frame)
  ) return false
  let priorFrame = -1
  let priorSequence = 0
  const sequences = new Set<number>()
  for (const event of value.events) {
    if (!validEvent(event) || sequences.has(event.sequence)) return false
    if (event.frame < value.timeOrigin.frame || event.frame < priorFrame || event.frame === priorFrame && event.sequence <= priorSequence) {
      return false
    }
    sequences.add(event.sequence)
    priorFrame = event.frame
    priorSequence = event.sequence
  }
  return true
}

export const assertPortableFrameSchedule = (value: PortableFrameSchedule): PortableFrameSchedule => {
  if (!isPortableFrameSchedule(value)) throw new Error('Portable frame schedule has invalid identity or event ordering.')
  return value
}

export const isPortableFrameScheduleCurrent = (
  schedule: PortableFrameSchedule,
  identity: Pick<PortableScheduleIdentity, 'revision' | 'transportEpoch'>,
) => schedule.revision === identity.revision && schedule.transportEpoch === identity.transportEpoch

export const portableFrameAtTimelineTime = (
  identity: Pick<PortableScheduleIdentity, 'sampleRateHz' | 'timeOrigin'>,
  timelineSec: number,
) => identity.timeOrigin.frame + Math.round((timelineSec - identity.timeOrigin.timelineSec) * identity.sampleRateHz)

export const eventsForPortableFrameBlock = (
  schedule: PortableFrameSchedule,
  startFrame: number,
  frameCount: number,
): PortableFrameScheduleBlock => {
  if (!nonnegativeSafeInteger(startFrame) || !positiveSafeInteger(frameCount)) {
    throw new Error('Portable frame block bounds are invalid.')
  }
  assertPortableFrameSchedule(schedule)
  const endFrame = startFrame + frameCount
  return {
    startFrame,
    frameCount,
    events: schedule.events.flatMap((event) => (
      event.frame < startFrame || event.frame >= endFrame
        ? []
        : [{ ...event, frameOffset: event.frame - startFrame }]
    )),
  }
}
