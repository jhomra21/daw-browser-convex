import { getAutomationParameterDescriptor, type AutomationEnvelope } from '@daw-browser/shared'
import { getAutomationEnvelopeSchedulePlan } from './automation'
import {
  assertPortableFrameSchedule,
  portableEventWithFrame,
  type PortableFrameScheduleEvent,
  type PortableParameterTarget,
  type PortableSchedulePayload,
} from './portable-frame-scheduling'

export type PortableAutomationEvent = {
  timelineSec: number
  payload: Exclude<PortableSchedulePayload, { type: 'note-on' | 'note-off' }>
}

export const portableParameterTarget = (envelope: AutomationEnvelope): PortableParameterTarget => (
  envelope.target.kind === 'track'
    ? {
      kind: 'parameter',
      scope: 'track',
      trackId: envelope.target.trackId,
      effectInstanceId: envelope.target.effectInstanceId,
      parameterId: envelope.parameterId === 'volume' ? 'mixer.gain' : envelope.parameterId,
    }
    : {
      kind: 'parameter',
      scope: 'master',
      effectInstanceId: envelope.target.effectInstanceId,
      parameterId: envelope.parameterId === 'volume' ? 'mixer.gain' : envelope.parameterId,
    }
)

/**
 * The one projection from automation envelopes to portable parameter events,
 * shared by live scheduling and export so both honour the same edge semantics
 * as the legacy Web Audio scheduler (a set at the window start, then sets and
 * linear ramps between points).
 */
export const compilePortableAutomationEvents = (
  envelopes: readonly AutomationEnvelope[],
  window: { playheadSec: number; startLimitSec: number; endLimitSec: number },
): readonly PortableAutomationEvent[] => envelopes.flatMap((envelope) => {
  if (!envelope.enabled) return []
  const fallback = getAutomationParameterDescriptor(envelope.parameterId)?.defaultValue ?? 0
  const plan = getAutomationEnvelopeSchedulePlan(envelope, window, fallback)
  const target = portableParameterTarget(envelope)

  return plan.map((point, index): PortableAutomationEvent => {
    const previous = plan[index - 1]

    return point.kind === 'ramp' && previous
      ? {
        timelineSec: previous.timeSec,
        payload: {
          type: 'parameter-ramp',
          target,
          endTimelineSec: point.timeSec,
          startValue: previous.value,
          endValue: point.value,
        },
      }
      : { timelineSec: point.timeSec, payload: { type: 'parameter-set', target, value: point.value } }
  })
})

/**
 * Export automation in the export's own frame domain: frame 0 is the range
 * start and graph latency is never added, because automation times are
 * timeline times (the graph delays its output, not its parameters).
 */
export const compilePortableExportAutomation = (input: {
  envelopes: readonly AutomationEnvelope[]
  startSec: number
  endSec: number
  sampleRateHz: number
  bpm: number
  revision: number
  epoch: number
}): readonly PortableFrameScheduleEvent[] => {
  const identity = { sampleRateHz: input.sampleRateHz, timeOrigin: { timelineSec: input.startSec, frame: 0 } }

  const events = compilePortableAutomationEvents(input.envelopes, {
    playheadSec: input.startSec,
    startLimitSec: input.startSec,
    endLimitSec: input.endSec,
  })
    .map((event, ordinal) => ({ event: portableEventWithFrame(event.payload, event.timelineSec, identity), ordinal }))
    .toSorted((left, right) => left.event.frame - right.event.frame || left.ordinal - right.ordinal)
    .map(({ event }, index) => ({ ...event, sequence: index + 1 }))

  return assertPortableFrameSchedule({
    revision: input.revision,
    transportEpoch: input.epoch,
    bpm: input.bpm,
    ...identity,
    events,
  }).events
}
