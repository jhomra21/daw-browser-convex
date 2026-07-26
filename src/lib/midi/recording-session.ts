import { MAX_MIDI_PERFORMANCE_EVENTS, type MidiClip } from '@daw-browser/shared'
import type { MidiInputEvent } from './midi-input'

const MIN_NOTE_LENGTH_SEC = 0.001

type RecordedNote = {
  id: string
  sourceId: string
  channel: number
  pitch: number
  velocity: number
  startSec: number
  endSec: number | undefined
}

type RecordedEvent =
  | { id: string; kind: 'cc'; timeSec: number; channel: number; controller: number; value: number }
  | { id: string; kind: 'pitch-bend'; timeSec: number; channel: number; value: number }
  | { id: string; kind: 'channel-pressure'; timeSec: number; channel: number; value: number }
  | { id: string; kind: 'poly-pressure'; timeSec: number; channel: number; pitch: number; value: number }

const keyFor = (sourceId: string, channel: number, pitch: number) => `${sourceId}\0${channel}\0${pitch}`
const channelKeyFor = (sourceId: string, channel: number) => `${sourceId}\0${channel}`
const secondsToBeats = (seconds: number, bpm: number) => seconds * bpm / 60

type MidiRecordingSnapshot = {
  midi: MidiClip
  eventCount: number
  complete: boolean
}

type MidiRecordingSession = {
  receive: (event: MidiInputEvent, timelineSec: number) => void
  resetSource: (sourceId: string, timelineSec: number) => void
  close: (timelineSec: number) => void
  snapshot: (bpm: number, endTimelineSec: number) => MidiRecordingSnapshot
  eventCount: () => number
  isComplete: () => boolean
}

export const createMidiRecordingSession = (
  startTimelineSec: number,
  sessionId: string = crypto.randomUUID(),
): MidiRecordingSession => {
  const notes: RecordedNote[] = []
  const expression: RecordedEvent[] = []
  const active = new Map<string, RecordedNote[]>()
  const sustained = new Map<string, RecordedNote[]>()
  const sustain = new Map<string, boolean>()
  let sequence = 0
  let complete = false

  const id = () => `${sessionId}:${sequence++}`
  const count = () => notes.length + expression.length
  const normalizeTime = (time: number) => Math.max(startTimelineSec, Number.isFinite(time) ? time : startTimelineSec)

  const closeNote = (note: RecordedNote, time: number) => {
    if (note.endSec !== undefined) return
    note.endSec = Math.max(note.startSec + MIN_NOTE_LENGTH_SEC, normalizeTime(time))
  }

  const releaseSustained = (sourceId: string, channel: number, time: number) => {
    const key = channelKeyFor(sourceId, channel)
    for (const note of sustained.get(key) ?? []) closeNote(note, time)
    sustained.delete(key)
  }

  const forceCloseChannel = (sourceId: string, channel: number, time: number) => {
    for (const [key, queue] of active) {
      if (!key.startsWith(`${sourceId}\0${channel}\0`)) continue
      for (const note of queue) closeNote(note, time)
      active.delete(key)
    }
    releaseSustained(sourceId, channel, time)
    sustain.delete(channelKeyFor(sourceId, channel))
  }

  const settle = (time: number) => {
    for (const queue of active.values()) for (const note of queue) closeNote(note, time)
    for (const queue of sustained.values()) for (const note of queue) closeNote(note, time)
    active.clear()
    sustained.clear()
    sustain.clear()
    complete = true
  }

  const reserve = (time: number) => {
    if (complete) return false
    if (count() < MAX_MIDI_PERFORMANCE_EVENTS) return true
    settle(time)
    return false
  }

  const recordExpression = (event: Exclude<MidiInputEvent, { kind: 'note-on' | 'note-off' }>, time: number) => {
    if (!reserve(time)) return
    const common = { id: id(), timeSec: normalizeTime(time), channel: event.channel }
    if (event.kind === 'control-change') expression.push({ ...common, kind: 'cc', controller: event.controller, value: event.value })
    if (event.kind === 'pitch-bend') expression.push({ ...common, kind: 'pitch-bend', value: event.value })
    if (event.kind === 'channel-pressure') expression.push({ ...common, kind: 'channel-pressure', value: event.pressure })
    if (event.kind === 'poly-pressure') expression.push({ ...common, kind: 'poly-pressure', pitch: event.note, value: event.pressure })
  }

  const receive = (event: MidiInputEvent, timelineSec: number) => {
    const time = normalizeTime(timelineSec)
    if (complete) return
    if (event.kind === 'note-on') {
      if (!reserve(time)) return
      const note: RecordedNote = {
        id: id(), sourceId: event.sourceId, channel: event.channel, pitch: event.note,
        velocity: event.velocity, startSec: time, endSec: undefined,
      }
      notes.push(note)
      const key = keyFor(event.sourceId, event.channel, event.note)
      active.set(key, [...(active.get(key) ?? []), note])
      return
    }
    if (event.kind === 'note-off') {
      const key = keyFor(event.sourceId, event.channel, event.note)
      const queue = active.get(key)
      const note = queue?.shift()
      if (queue?.length === 0) active.delete(key)
      if (!note) return
      const sustainKey = channelKeyFor(event.sourceId, event.channel)
      if (sustain.get(sustainKey)) sustained.set(sustainKey, [...(sustained.get(sustainKey) ?? []), note])
      else closeNote(note, time)
      return
    }
    if (
      event.kind !== 'control-change'
      && event.kind !== 'pitch-bend'
      && event.kind !== 'channel-pressure'
      && event.kind !== 'poly-pressure'
    ) return
    recordExpression(event, time)
    if (event.kind !== 'control-change') return
    const sustainKey = channelKeyFor(event.sourceId, event.channel)
    if (event.controller === 64) {
      const enabled = event.value >= 0.5
      sustain.set(sustainKey, enabled)
      if (!enabled) releaseSustained(event.sourceId, event.channel, time)
    } else if (event.controller === 120) {
      forceCloseChannel(event.sourceId, event.channel, time)
    } else if (event.controller === 121) {
      sustain.set(sustainKey, false)
      releaseSustained(event.sourceId, event.channel, time)
    } else if (event.controller === 123) {
      for (let pitch = 0; pitch <= 127; pitch += 1) {
        const key = keyFor(event.sourceId, event.channel, pitch)
        const queue = active.get(key) ?? []
        active.delete(key)
        if (sustain.get(sustainKey)) sustained.set(sustainKey, [...(sustained.get(sustainKey) ?? []), ...queue])
        else for (const note of queue) closeNote(note, time)
      }
    }
  }

  return {
    receive,
    resetSource: (sourceId, time) => {
      for (const note of notes) if (note.sourceId === sourceId) closeNote(note, time)
      for (const key of active.keys()) if (key.startsWith(`${sourceId}\0`)) active.delete(key)
      for (const key of sustained.keys()) if (key.startsWith(`${sourceId}\0`)) sustained.delete(key)
      for (const key of sustain.keys()) if (key.startsWith(`${sourceId}\0`)) sustain.delete(key)
    },
    close: settle,
    snapshot: (bpm, endTimelineSec) => {
      const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120
      const end = normalizeTime(endTimelineSec)
      const beat = (time: number) => secondsToBeats(Math.max(0, time - startTimelineSec), safeBpm)
      return {
        eventCount: count(),
        complete,
        midi: {
          wave: 'sine',
          notes: notes.map((note) => ({
            id: note.id,
            beat: beat(note.startSec),
            length: secondsToBeats(Math.max(MIN_NOTE_LENGTH_SEC, (note.endSec ?? end) - note.startSec), safeBpm),
            pitch: note.pitch,
            velocity: note.velocity,
            channel: note.channel,
          })),
          ...(expression.filter((entry) => entry.kind === 'cc').length > 0 ? { cc: expression.filter((entry): entry is Extract<RecordedEvent, { kind: 'cc' }> => entry.kind === 'cc').map((entry) => ({ id: entry.id, beat: beat(entry.timeSec), controller: entry.controller, value: entry.value, channel: entry.channel })) } : {}),
          ...(expression.filter((entry) => entry.kind === 'pitch-bend').length > 0 ? { pitchBends: expression.filter((entry): entry is Extract<RecordedEvent, { kind: 'pitch-bend' }> => entry.kind === 'pitch-bend').map((entry) => ({ id: entry.id, beat: beat(entry.timeSec), value: entry.value, channel: entry.channel })) } : {}),
          ...(expression.filter((entry) => entry.kind === 'channel-pressure').length > 0 ? { channelPressure: expression.filter((entry): entry is Extract<RecordedEvent, { kind: 'channel-pressure' }> => entry.kind === 'channel-pressure').map((entry) => ({ id: entry.id, beat: beat(entry.timeSec), value: entry.value, channel: entry.channel })) } : {}),
          ...(expression.filter((entry) => entry.kind === 'poly-pressure').length > 0 ? { polyPressure: expression.filter((entry): entry is Extract<RecordedEvent, { kind: 'poly-pressure' }> => entry.kind === 'poly-pressure').map((entry) => ({ id: entry.id, beat: beat(entry.timeSec), pitch: entry.pitch, value: entry.value, channel: entry.channel })) } : {}),
        },
      }
    },
    eventCount: count,
    isComplete: () => complete,
  }
}
