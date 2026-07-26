import {
  compileMidiMappingSourceIndex,
  getAutomationParameterDescriptor,
  midiMappingTargetKey,
  midiMappingValue,
  normalizeLegacyMidiClip,
  valueAtAutomationTime,
  type AutomationEnvelope,
  type MidiMapping,
  type MidiMappingSourceEvent,
} from '@daw-browser/shared'
import type { Clip } from '@daw-browser/timeline-core/types'

export type MidiExpressionScheduleEvent = {
  timeSec: number
  phase: 'set' | 'restore'
  target: MidiMapping['target']
  value?: number
  clipId: string
  mappingId: string
  eventId: string
}

export type ResolvedMidiExpressionScheduleEvent = MidiExpressionScheduleEvent & {
  value: number
}

type ExpressionCandidate = {
  timeSec: number
  sourceTimeSec: number
  source: 'pre-trim' | 'event'
  clipId: string
  mapping: MidiMapping
  event: MidiMappingSourceEvent & { id: string }
}

type ActiveValue = {
  value: number
  timeSec: number
  clipId: string
  mappingId: string
  eventId: string
  target: MidiMapping['target']
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const compareCandidate = (left: ExpressionCandidate, right: ExpressionCandidate) => (
  left.timeSec - right.timeSec
  || (left.source === right.source ? 0 : left.source === 'pre-trim' ? -1 : 1)
  || left.sourceTimeSec - right.sourceTimeSec
  || compareText(left.clipId, right.clipId)
  || compareText(left.mapping.id, right.mapping.id)
  || compareText(left.event.id, right.event.id)
)

const expressionEvents = (
  midi: ReturnType<typeof normalizeLegacyMidiClip>,
): Array<MidiMappingSourceEvent & { beat: number; id: string }> => [
  ...midi.cc.map((event) => ({ ...event, kind: 'cc' as const, id: event.id ?? '' })),
  ...midi.pitchBends.map((event) => ({ ...event, kind: 'pitch-bend' as const, id: event.id ?? '' })),
  ...midi.channelPressure.map((event) => ({ ...event, kind: 'channel-pressure' as const, id: event.id ?? '' })),
  ...midi.polyPressure.map((event) => ({ ...event, kind: 'poly-pressure' as const, id: event.id ?? '' })),
]

export const compileTrackMidiExpressionSchedule = (input: {
  clips: readonly Pick<Clip, 'id' | 'startSec' | 'duration' | 'midiOffsetBeats' | 'midi'>[]
  trackId?: string
  automationEnvelopes?: readonly AutomationEnvelope[]
  bpm: number
  rangeStartSec: number
  rangeEndSec: number
}): MidiExpressionScheduleEvent[] => {
  const secondsPerBeat = 60 / Math.max(1, input.bpm || 120)
  const candidates: ExpressionCandidate[] = []
  const endings: Array<{ timeSec: number; clipId: string; mapping: MidiMapping }> = []
  for (const clip of input.clips) {
    if (!clip.midi) continue
    const midi = normalizeLegacyMidiClip(clip.midi)
    if (midi.mappings.length === 0) continue
    const clipStart = clip.startSec
    const clipEnd = clip.startSec + clip.duration
    const start = Math.max(clipStart, input.rangeStartSec)
    if (
      clipEnd <= start
      || (input.rangeStartSec === input.rangeEndSec
        ? clipStart > input.rangeEndSec
        : clipStart >= input.rangeEndSec)
    ) continue
    const index = compileMidiMappingSourceIndex(midi.mappings)
    const offset = Math.max(0, clip.midiOffsetBeats ?? 0)
    const trimmedState = new Map<string, ExpressionCandidate>()
    for (const event of expressionEvents(midi)) {
      const beat = Math.max(0, event.beat - offset)
      const timeSec = clipStart + (beat * secondsPerBeat)
      for (const mapping of index.match(event)) {
        const value = midiMappingValue(mapping, event)
        if (value === undefined) continue
        if (event.beat < offset) {
          const targetKey = midiMappingTargetKey(mapping.target)
          const trimmedCandidate: ExpressionCandidate = {
            timeSec: clipStart + (event.beat * secondsPerBeat),
            sourceTimeSec: clipStart + (event.beat * secondsPerBeat),
            source: 'pre-trim',
            clipId: clip.id,
            mapping,
            event,
          }
          const priorCandidate = trimmedState.get(targetKey)
          if (!priorCandidate || compareCandidate(priorCandidate, trimmedCandidate) < 0) {
            trimmedState.set(targetKey, trimmedCandidate)
          }
          continue
        }
        if (timeSec < clipStart || timeSec >= clipEnd) continue
        candidates.push({
          timeSec,
          sourceTimeSec: clipStart + (event.beat * secondsPerBeat),
          source: 'event',
          clipId: clip.id,
          mapping,
          event,
        })
      }
    }
    candidates.push(...Array.from(trimmedState.values(), (candidate) => ({ ...candidate, timeSec: clipStart })))
    for (const mapping of midi.mappings) endings.push({ timeSec: clipEnd, clipId: clip.id, mapping })
  }

  candidates.sort(compareCandidate)
  endings.sort((left, right) => (
    left.timeSec - right.timeSec
    || compareText(left.clipId, right.clipId)
    || compareText(left.mapping.id, right.mapping.id)
  ))
  const active = new Map<string, Map<string, ActiveValue>>()
  const scheduled: MidiExpressionScheduleEvent[] = []
  const update = (candidate: ExpressionCandidate, timeSec: number) => {
    const value = midiMappingValue(candidate.mapping, candidate.event)
    if (value === undefined) return
    const targetKey = midiMappingTargetKey(candidate.mapping.target)
    const mappingKey = `${candidate.clipId}\u0000${candidate.mapping.id}`
    const entries = active.get(targetKey) ?? new Map<string, ActiveValue>()
    entries.set(mappingKey, {
      value,
      timeSec,
      clipId: candidate.clipId,
      mappingId: candidate.mapping.id,
      eventId: candidate.event.id,
      target: candidate.mapping.target,
    })
    active.set(targetKey, entries)
    scheduled.push({
      timeSec,
      phase: 'set',
      target: candidate.mapping.target,
      value,
      clipId: candidate.clipId,
      mappingId: candidate.mapping.id,
      eventId: candidate.event.id,
    })
  }
  const latest = (entries: Iterable<ActiveValue>) => (
    [...entries].sort((left, right) => (
      right.timeSec - left.timeSec
      || compareText(right.clipId, left.clipId)
      || compareText(right.mappingId, left.mappingId)
      || compareText(right.eventId, left.eventId)
    ))[0]
  )
  const hasLaterAutomation = (value: ActiveValue, endSec: number) => (
    input.automationEnvelopes?.some((envelope) => (
      envelope.enabled
      && envelope.target.kind === 'track'
      && (input.trackId === undefined || envelope.target.trackId === input.trackId)
      && envelope.target.effectInstanceId === value.target.effectInstanceId
      && envelope.parameterId === value.target.parameterId
      && envelope.points.some((point) => (
        point.timeSec > value.timeSec && point.timeSec <= endSec
      ))
    )) ?? false
  )
  let candidateIndex = 0
  let endingIndex = 0
  while (candidateIndex < candidates.length || endingIndex < endings.length) {
    const nextCandidate = candidates[candidateIndex]
    const nextEnding = endings[endingIndex]
    const timeSec = Math.min(nextCandidate?.timeSec ?? Infinity, nextEnding?.timeSec ?? Infinity)
    while (candidates[candidateIndex]?.timeSec === timeSec) {
      const candidate = candidates[candidateIndex]
      if (candidate) update(candidate, timeSec)
      candidateIndex += 1
    }
    while (endings[endingIndex]?.timeSec === timeSec) {
      const ending = endings[endingIndex]
      if (!ending) break
      const targetKey = midiMappingTargetKey(ending.mapping.target)
      const mappingKey = `${ending.clipId}\u0000${ending.mapping.id}`
      const entries = active.get(targetKey)
      const wasActive = entries?.delete(mappingKey) ?? false
      if (!wasActive) {
        endingIndex += 1
        continue
      }
      const continuing = entries ? latest(entries.values()) : undefined
      scheduled.push(continuing && !hasLaterAutomation(continuing, timeSec)
        ? {
            timeSec,
            phase: 'set',
            target: continuing.target,
            value: continuing.value,
            clipId: ending.clipId,
            mappingId: ending.mapping.id,
            eventId: `restore:${ending.mapping.id}`,
          }
        : {
            timeSec,
            phase: 'restore',
            target: ending.mapping.target,
            clipId: ending.clipId,
            mappingId: ending.mapping.id,
            eventId: `restore:${ending.mapping.id}`,
          })
      endingIndex += 1
    }
  }
  const ordered = scheduled.sort((left, right) => (
    left.timeSec - right.timeSec
    || (left.phase === right.phase ? 0 : left.phase === 'set' ? -1 : 1)
  ))
  const valuesAtStart = new Map<string, MidiExpressionScheduleEvent>()
  for (const event of ordered) {
    if (event.timeSec > input.rangeStartSec) break
    const targetKey = midiMappingTargetKey(event.target)
    if (event.phase === 'restore') valuesAtStart.delete(targetKey)
    else valuesAtStart.set(targetKey, event)
  }
  return [
    ...Array.from(valuesAtStart.values(), (event) => ({
      ...event,
      timeSec: input.rangeStartSec,
      eventId: `seed:${event.eventId}`,
    })),
    ...ordered.filter((event) => event.timeSec > input.rangeStartSec && event.timeSec <= input.rangeEndSec),
  ]
    .sort((left, right) => (
      left.timeSec - right.timeSec
      || (left.phase === right.phase ? 0 : left.phase === 'set' ? -1 : 1)
    ))
}

export const resolveTrackMidiExpressionSchedule = (input: {
  clips: readonly Pick<Clip, 'id' | 'startSec' | 'duration' | 'midiOffsetBeats' | 'midi'>[]
  trackId: string
  trackVolume: number
  automationEnvelopes: readonly AutomationEnvelope[]
  bpm: number
  rangeStartSec: number
  rangeEndSec: number
}): ResolvedMidiExpressionScheduleEvent[] => (
  compileTrackMidiExpressionSchedule(input).flatMap<ResolvedMidiExpressionScheduleEvent>((event) => {
    if (event.phase === 'set' && event.value !== undefined) return [{ ...event, value: event.value }]
    const descriptor = getAutomationParameterDescriptor(event.target.parameterId)
    const envelope = input.automationEnvelopes.find((candidate) => (
      candidate.enabled
      && candidate.target.kind === 'track'
      && candidate.target.trackId === input.trackId
      && candidate.target.effectInstanceId === event.target.effectInstanceId
      && candidate.parameterId === event.target.parameterId
    ))
    const value = envelope
      ? valueAtAutomationTime(envelope.points, event.timeSec, descriptor?.defaultValue ?? 0)
      : event.target.parameterId === 'volume'
        ? input.trackVolume
        : descriptor?.defaultValue ?? 0
    return Number.isFinite(value) ? [{ ...event, value }] : []
  })
)
