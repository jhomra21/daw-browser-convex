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
  stableNoteIds?: boolean
  eventRangeStartSec?: number
  noteScheduleStartSec?: number
  clipSpanningNoteOn?: boolean
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

const stableNoteId = (trackId: string, clipId: string, identity: string) => {
  let hash = 0x811c9dc5
  for (const character of `${trackId}:${clipId}:${identity}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) || 1
}

const parameterTarget = (envelope: AutomationEnvelope): PortableParameterTarget => (
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

const midiExpressionTarget = (
  trackId: string,
  parameterId: string,
  effectInstanceId: string | undefined,
): PortableParameterTarget => ({
  kind: 'parameter',
  scope: 'track',
  trackId,
  effectInstanceId,
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
    startLimitSec: input.eventRangeStartSec ?? input.timeOrigin.timelineSec,
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
      rangeStartSec: input.eventRangeStartSec ?? input.timeOrigin.timelineSec,
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
        rangeStartSec: input.noteScheduleStartSec ?? input.eventRangeStartSec ?? input.timeOrigin.timelineSec,
        rangeEndSec: input.rangeEndSec,
        arp: input.arpeggiators.get(track.id),
      })) {
        if (
          input.clipSpanningNoteOn === true
          && note.startSec < input.timeOrigin.timelineSec
          && note.endSec > input.timeOrigin.timelineSec
        ) {
          append(input.timeOrigin.timelineSec, {
            type: 'note-on',
            target: { kind: 'instrument', trackId: track.id },
            noteId: input.stableNoteIds
              ? stableNoteId(track.id, clip.id, note.identity)
              : nextNoteId,
            pitch: note.pitch,
            velocity: note.velocity ?? 1,
          })
        }
        const noteId = nextNoteId
        nextNoteId += 1
        append(note.startSec, {
          type: 'note-on',
          target: { kind: 'instrument', trackId: track.id },
          noteId: input.stableNoteIds
            ? stableNoteId(track.id, clip.id, note.identity)
            : noteId,
          pitch: note.pitch,
          velocity: note.velocity ?? 1,
        })
        append(note.endSec, {
          type: 'note-off',
          target: { kind: 'instrument', trackId: track.id },
          noteId: input.stableNoteIds
            ? stableNoteId(track.id, clip.id, note.identity)
            : noteId,
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
    .filter(({ event }) => input.eventRangeStartSec === undefined
      || event.frame >= input.timeOrigin.frame
      && event.frame < portableFrameAtTimelineTime(identity, input.rangeEndSec))
    .sort((left, right) => left.event.frame - right.event.frame || left.ordinal - right.ordinal)
    .map(({ event }, index) => ({ ...event, sequence: index + 1 }))
  return assertPortableFrameSchedule({ ...identity, events })
}

export const compilePortableFrameScheduleWindow = (
  input: PortableFrameScheduleAdapterInput & {
    rangeStartFrame: number
    rangeEndFrame: number
  },
): PortableFrameSchedule => {
  if (!Number.isSafeInteger(input.rangeStartFrame) || input.rangeStartFrame < 0
    || !Number.isSafeInteger(input.rangeEndFrame) || input.rangeEndFrame <= input.rangeStartFrame) {
    throw new Error('Portable frame schedule window bounds are invalid.')
  }
  const startSec = input.timeOrigin.timelineSec
    + (input.rangeStartFrame - input.timeOrigin.frame) / input.sampleRateHz
  const endSec = startSec + (input.rangeEndFrame - input.rangeStartFrame) / input.sampleRateHz
  return compilePortableFrameSchedule({
    ...input,
    timeOrigin: {
      timelineSec: startSec,
      frame: input.rangeStartFrame,
    },
    eventRangeStartSec: input.eventRangeStartSec ?? input.timeOrigin.timelineSec,
    rangeEndSec: endSec,
  })
}
