import {
  assertPortableFrameSchedule,
  portableFrameAtTimelineTime,
  type PortableFrameSchedule,
  type PortableFrameScheduleEvent,
  type PortableParameterTarget,
} from '@daw-browser/audio-engine/portable-frame-scheduling'
import { getAutomationEnvelopeSchedulePlan } from '@daw-browser/audio-engine/automation'
import { getScheduledMidiEvents } from '@daw-browser/audio-engine/audio-scheduling'
import { resolveTrackMidiExpressionSchedule } from '@daw-browser/audio-engine/midi-expression-scheduling'
import { getAutomationParameterDescriptor, type ArpParams, type AutomationEnvelope } from '@daw-browser/shared'
import type { RuntimeTrack } from '~/lib/timeline-runtime-types'

export type PortableFrameScheduleAdapterInput = {
  revision: number
  transportEpoch: number
  sampleRateHz: number
  bpm: number
  timeOrigin: {
    timelineSec: number
    frame: number
  }
  rangeEndSec: number
  tracks: readonly RuntimeTrack[]
  automationEnvelopes: readonly AutomationEnvelope[]
  arpeggiators: ReadonlyMap<string, ArpParams | undefined>
}

type PendingEventPayload =
  | {
    type: 'note-on'
    target: { kind: 'instrument'; trackId: string }
    noteId: number
    pitch: number
    velocity: number
  }
  | {
    type: 'note-off'
    target: { kind: 'instrument'; trackId: string }
    noteId: number
    pitch: number
  }
  | {
    type: 'parameter-set' | 'parameter-restore'
    target: PortableParameterTarget
    value: number
  }
  | {
    type: 'parameter-ramp'
    target: PortableParameterTarget
    endTimelineSec: number
    startValue: number
    endValue: number
  }

type PendingEvent = {
  timelineSec: number
  ordinal: number
  event: PendingEventPayload
}

const parameterTarget = (envelope: AutomationEnvelope): PortableParameterTarget => (
  envelope.target.kind === 'track'
    ? {
      kind: 'parameter',
      scope: 'track',
      trackId: envelope.target.trackId,
      ...(envelope.target.effectInstanceId === undefined ? {} : { effectInstanceId: envelope.target.effectInstanceId }),
      parameterId: envelope.parameterId === 'volume' ? 'mixer.gain' : envelope.parameterId,
    }
    : {
      kind: 'parameter',
      scope: 'master',
      ...(envelope.target.effectInstanceId === undefined ? {} : { effectInstanceId: envelope.target.effectInstanceId }),
      parameterId: envelope.parameterId === 'volume' ? 'mixer.gain' : envelope.parameterId,
    }
)

const midiExpressionTarget = (
  trackId: string,
  parameterId: string,
  effectInstanceId: string | undefined,
): PortableParameterTarget => ({
  kind: 'parameter',
  scope: 'track',
  trackId,
  ...(effectInstanceId === undefined ? {} : { effectInstanceId }),
  parameterId: parameterId === 'volume' ? 'mixer.gain' : parameterId,
})

const eventWithFrame = (
  event: PendingEventPayload,
  timelineSec: number,
  identity: Pick<PortableFrameSchedule, 'sampleRateHz' | 'timeOrigin'>,
): PortableFrameScheduleEvent => {
  const frame = portableFrameAtTimelineTime(identity, timelineSec)
  if (event.type === 'parameter-ramp') {
    const startFrame = frame
    return {
      endFrame: portableFrameAtTimelineTime(identity, event.endTimelineSec),
      endValue: event.endValue,
      frame: startFrame,
      interpolation: 'linear',
      sequence: 0,
      startFrame,
      startValue: event.startValue,
      target: event.target,
      type: event.type,
    }
  }
  return { ...event, frame, sequence: 0 }
}

/**
 * App-owned projection from the hydrated timeline snapshot to the engine's
 * frame contract. Timing and interpolation remain delegated to engine
 * authorities; this layer only provides browser-owned identities and data.
 */
export const compilePortableFrameSchedule = (
  input: PortableFrameScheduleAdapterInput,
): PortableFrameSchedule => {
  const pending: PendingEvent[] = []
  let ordinal = 0
  let nextNoteId = 1
  const append = (timelineSec: number, event: PendingEvent['event']) => {
    pending.push({ timelineSec, ordinal, event })
    ordinal += 1
  }
  const window = {
    playheadSec: input.timeOrigin.timelineSec,
    startLimitSec: input.timeOrigin.timelineSec,
    endLimitSec: input.rangeEndSec,
  }

  for (const envelope of input.automationEnvelopes) {
    if (!envelope.enabled) continue
    const fallback = getAutomationParameterDescriptor(envelope.parameterId)?.defaultValue ?? 0
    const plan = getAutomationEnvelopeSchedulePlan(envelope, window, fallback)
    for (let index = 0; index < plan.length; index += 1) {
      const point = plan[index]
      const previous = plan[index - 1]
      if (point.kind === 'ramp' && previous) {
        append(previous.timeSec, {
          type: 'parameter-ramp',
          target: parameterTarget(envelope),
          endTimelineSec: point.timeSec,
          startValue: previous.value,
          endValue: point.value,
        })
        continue
      }
      append(point.timeSec, {
        type: 'parameter-set',
        target: parameterTarget(envelope),
        value: point.value,
      })
    }
  }

  for (const track of input.tracks) {
    for (const expression of resolveTrackMidiExpressionSchedule({
      clips: track.clips,
      trackId: track.id,
      trackVolume: track.volume,
      automationEnvelopes: input.automationEnvelopes,
      bpm: input.bpm,
      rangeStartSec: input.timeOrigin.timelineSec,
      rangeEndSec: input.rangeEndSec,
    })) {
      append(expression.timeSec, {
        type: expression.phase === 'restore' ? 'parameter-restore' : 'parameter-set',
        target: midiExpressionTarget(track.id, expression.target.parameterId, expression.target.effectInstanceId),
        value: expression.value,
      })
    }
    for (const clip of track.clips) {
      if (!clip.midi) continue
      for (const note of getScheduledMidiEvents({
        clip,
        bpm: input.bpm,
        notes: clip.midi.notes,
        rangeStartSec: input.timeOrigin.timelineSec,
        rangeEndSec: input.rangeEndSec,
        arp: input.arpeggiators.get(track.id),
      })) {
        const noteId = nextNoteId
        nextNoteId += 1
        append(note.startSec, {
          type: 'note-on',
          target: { kind: 'instrument', trackId: track.id },
          noteId,
          pitch: note.pitch,
          velocity: note.velocity ?? 1,
        })
        append(note.endSec, {
          type: 'note-off',
          target: { kind: 'instrument', trackId: track.id },
          noteId,
          pitch: note.pitch,
        })
      }
    }
  }

  const identity = {
    revision: input.revision,
    transportEpoch: input.transportEpoch,
    sampleRateHz: input.sampleRateHz,
    bpm: input.bpm,
    timeOrigin: input.timeOrigin,
  }
  const events = pending
    .map((pendingEvent) => ({
      event: eventWithFrame(pendingEvent.event, pendingEvent.timelineSec, identity),
      ordinal: pendingEvent.ordinal,
    }))
    .sort((left, right) => left.event.frame - right.event.frame || left.ordinal - right.ordinal)
    .map(({ event }, index) => ({ ...event, sequence: index + 1 }))
  return assertPortableFrameSchedule({ ...identity, events })
}
