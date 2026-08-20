import {
  normalizeLegacyMidiClip,
  normalizeMidiClip,
  type LegacyMidiClip,
  type MidiCcEvent,
  type MidiChannelPressureEvent,
  type MidiMapping,
  type MidiPitchBendEvent,
  type MidiPolyPressureEvent,
  type NormalizedMidiClip,
  type NormalizedLegacyMidiClip,
} from '@daw-browser/shared'
import { z } from 'zod'

type ControlMidiActionV1 = {
  wave: string
  gain?: number
  notes: LegacyMidiClip['notes']
  inputChannel?: number | null
  cc?: MidiCcEvent[]
  pitchBends?: MidiPitchBendEvent[]
  channelPressure?: MidiChannelPressureEvent[]
  polyPressure?: MidiPolyPressureEvent[]
  mappings?: MidiMapping[]
}

type StrictMidiPatch = Partial<Omit<ControlMidiActionV1, 'inputChannel'>> & {
  inputChannel?: number
}

export class ControlMidiResolutionError extends Error {
  constructor(
    readonly code: 'validation' | 'limit-exceeded',
    message: string,
  ) {
    super(message)
  }
}

const strict = (value: StrictMidiPatch): NormalizedMidiClip => {
  try {
    return normalizeMidiClip({ wave: 'sine', notes: [], ...value })
  } catch (cause) {
    throw new ControlMidiResolutionError('validation', cause instanceof Error ? cause.message : 'Invalid MIDI action.')
  }
}

const normalizeStrictAction = (action: ControlMidiActionV1) => {
  const input: StrictMidiPatch & Pick<ControlMidiActionV1, 'wave' | 'notes'> = {
    wave: action.wave,
    notes: action.notes,
  }
  if (action.gain !== undefined) input.gain = action.gain
  if (action.inputChannel !== undefined && action.inputChannel !== null) input.inputChannel = action.inputChannel
  if (action.cc !== undefined) input.cc = action.cc
  if (action.pitchBends !== undefined) input.pitchBends = action.pitchBends
  if (action.channelPressure !== undefined) input.channelPressure = action.channelPressure
  if (action.polyPressure !== undefined) input.polyPressure = action.polyPressure
  if (action.mappings !== undefined) input.mappings = action.mappings
  return normalizeMidiClip(z.json().parse(input))
}

const noteKey = (note: { beat: number; length: number; pitch: number; velocity?: number }) => (
  JSON.stringify([
    note.beat,
    note.length,
    note.pitch,
    note.velocity === undefined ? 'velocity-omitted' : note.velocity,
  ])
)

const same = <Value>(left: Value, right: Value) => JSON.stringify(left) === JSON.stringify(right)
const legacy = (value: LegacyMidiClip): NormalizedLegacyMidiClip => {
  try {
    return normalizeLegacyMidiClip(value)
  } catch (cause) {
    throw new ControlMidiResolutionError('validation', cause instanceof Error ? cause.message : 'Invalid MIDI action.')
  }
}

export const resolveControlMidiActionV1 = (
  action: ControlMidiActionV1,
  existing?: LegacyMidiClip,
): NormalizedLegacyMidiClip => {
  if (existing === undefined) {
    try {
      return normalizeStrictAction(action)
    } catch (cause) {
      throw new ControlMidiResolutionError('validation', cause instanceof Error ? cause.message : 'Invalid MIDI action.')
    }
  }

  const current = legacy(existing)
  const available = new Map<string, Array<typeof current.notes[number]>>()
  for (const note of current.notes) {
    const key = noteKey(note)
    const queue = available.get(key)
    if (queue) queue.push(note)
    else available.set(key, [note])
  }
  const hasInputChannel = Object.hasOwn(action, 'inputChannel')
  const replacesExpanded = (
    hasInputChannel
    || action.cc !== undefined
    || action.pitchBends !== undefined
    || action.channelPressure !== undefined
    || action.polyPressure !== undefined
    || action.mappings !== undefined
  )
  const notes = action.notes.map((note) => {
    if (note.id !== undefined || note.channel !== undefined) return note
    const queue = available.get(noteKey(note))
    const before = queue?.shift()
    return before === undefined ? note : { ...note, id: before.id, channel: before.channel }
  })
  const candidate = legacy({
    wave: action.wave,
    gain: action.gain,
    notes,
    ...(action.inputChannel === undefined
      ? (replacesExpanded ? {} : (current.inputChannel === undefined ? {} : { inputChannel: current.inputChannel }))
      : action.inputChannel === null ? {} : { inputChannel: action.inputChannel }),
    cc: action.cc ?? (replacesExpanded ? [] : current.cc),
    pitchBends: action.pitchBends ?? (replacesExpanded ? [] : current.pitchBends),
    channelPressure: action.channelPressure ?? (replacesExpanded ? [] : current.channelPressure),
    polyPressure: action.polyPressure ?? (replacesExpanded ? [] : current.polyPressure),
    mappings: action.mappings ?? (replacesExpanded ? [] : current.mappings),
  })
  const currentById = new Map(current.notes.map((note) => [note.id, note]))
  for (const note of candidate.notes) {
    const before = currentById.get(note.id)
    if (before && same(before, note)) continue
    strict({ notes: [note] })
  }

  const performanceEventCount = (midi: NormalizedLegacyMidiClip) => (
    midi.notes.length + midi.cc.length + midi.pitchBends.length
    + midi.channelPressure.length + midi.polyPressure.length
  )
  if (performanceEventCount(current) > 500 && performanceEventCount(candidate) > performanceEventCount(current)) {
    throw new ControlMidiResolutionError('limit-exceeded', 'Legacy MIDI performance event counts cannot increase beyond the current limit.')
  }
  if (performanceEventCount(current) <= 500 && performanceEventCount(candidate) > 500) {
    throw new ControlMidiResolutionError('limit-exceeded', 'MIDI clips support at most 500 performance events.')
  }
  if (
    current.mappings.length > 64
    && (
      candidate.mappings.length > current.mappings.length
      || (candidate.mappings.length >= current.mappings.length && !same(current.mappings, candidate.mappings))
    )
  ) {
    throw new ControlMidiResolutionError('limit-exceeded', 'Legacy MIDI mappings above the current limit can only remain unchanged or be reduced.')
  }
  if (current.mappings.length <= 64 && candidate.mappings.length > 64) {
    throw new ControlMidiResolutionError('limit-exceeded', 'MIDI clips support at most 64 mappings.')
  }

  if (!same(current.wave, candidate.wave)) strict({ wave: candidate.wave })
  if (!same(current.gain, candidate.gain)) strict({ gain: candidate.gain })
  if (!same(current.inputChannel, candidate.inputChannel)) {
    strict(candidate.inputChannel === undefined ? {} : { inputChannel: candidate.inputChannel })
  }
  if (!same(current.cc, candidate.cc)) strict({ cc: candidate.cc })
  if (!same(current.pitchBends, candidate.pitchBends)) strict({ pitchBends: candidate.pitchBends })
  if (!same(current.channelPressure, candidate.channelPressure)) strict({ channelPressure: candidate.channelPressure })
  if (!same(current.polyPressure, candidate.polyPressure)) strict({ polyPressure: candidate.polyPressure })
  if (!same(current.mappings, candidate.mappings)) strict({ mappings: candidate.mappings })

  return candidate
}

export const normalizeControlMidiActionV1 = (action: ControlMidiActionV1) => (
  resolveControlMidiActionV1(action)
)
