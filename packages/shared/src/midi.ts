import { isJsonNumber, type JsonValue } from './json-value'
import { z } from 'zod'

const finiteNumberSchema = z.number().finite()
const identifierSchema = z.string().min(1).max(256)
const midiChannelSchema = z.number().int().min(1).max(16)
const midiValueSchema = finiteNumberSchema.min(0).max(1)
const midiPitchSchema = z.number().int().min(0).max(127)
const midiWaveSchema = z.enum(['sine', 'square', 'sawtooth', 'triangle'])
const legacyMidiWaveSchema = z.string()

export const MAX_MIDI_PERFORMANCE_EVENTS = 500
export const MAX_MIDI_EVENTS_PER_ARRAY = 500
export const MAX_MIDI_MAPPINGS = 64

export const midiNoteSchema = z.object({
  id: identifierSchema.optional(),
  beat: finiteNumberSchema,
  length: finiteNumberSchema.positive(),
  pitch: midiPitchSchema,
  velocity: midiValueSchema.optional(),
  channel: midiChannelSchema.optional(),
}).strict()
const legacyMidiNoteSchema = midiNoteSchema.extend({
  length: finiteNumberSchema,
  pitch: finiteNumberSchema,
  velocity: finiteNumberSchema.optional(),
}).strict()

const midiCcEventSchema = z.object({
  id: identifierSchema.optional(),
  beat: finiteNumberSchema,
  controller: z.number().int().min(0).max(127),
  value: midiValueSchema,
  channel: midiChannelSchema.optional(),
}).strict()
const midiPitchBendEventSchema = z.object({
  id: identifierSchema.optional(),
  beat: finiteNumberSchema,
  value: finiteNumberSchema.min(-1).max(1),
  channel: midiChannelSchema.optional(),
}).strict()
const midiChannelPressureEventSchema = z.object({
  id: identifierSchema.optional(),
  beat: finiteNumberSchema,
  value: midiValueSchema,
  channel: midiChannelSchema.optional(),
}).strict()
const midiPolyPressureEventSchema = z.object({
  id: identifierSchema.optional(),
  beat: finiteNumberSchema,
  pitch: midiPitchSchema,
  value: midiValueSchema,
  channel: midiChannelSchema.optional(),
}).strict()

const midiMappingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cc'), controller: z.number().int().min(0).max(127), channel: midiChannelSchema.optional() }).strict(),
  z.object({ kind: z.literal('pitch-bend'), channel: midiChannelSchema.optional() }).strict(),
  z.object({ kind: z.literal('channel-pressure'), channel: midiChannelSchema.optional() }).strict(),
  z.object({ kind: z.literal('poly-pressure'), channel: midiChannelSchema.optional(), pitch: midiPitchSchema.optional() }).strict(),
])
const midiMappingSchema = z.object({
  id: identifierSchema,
  source: midiMappingSourceSchema,
  target: z.object({
    parameterId: identifierSchema,
    effectInstanceId: identifierSchema.optional(),
  }).strict(),
  outputMin: finiteNumberSchema,
  outputMax: finiteNumberSchema,
}).strict()

const midiClipContract = z.object({
  wave: midiWaveSchema,
  gain: finiteNumberSchema.min(0).max(2).optional(),
  inputChannel: midiChannelSchema.optional(),
  notes: z.array(midiNoteSchema),
  cc: z.array(midiCcEventSchema).optional(),
  pitchBends: z.array(midiPitchBendEventSchema).optional(),
  channelPressure: z.array(midiChannelPressureEventSchema).optional(),
  polyPressure: z.array(midiPolyPressureEventSchema).optional(),
  mappings: z.array(midiMappingSchema).optional(),
}).strict()
const legacyMidiClipContract = midiClipContract.extend({
  wave: legacyMidiWaveSchema,
  gain: finiteNumberSchema.optional(),
  notes: z.array(legacyMidiNoteSchema),
}).strict()

const midiEventArrays = (midi: z.infer<typeof midiClipContract>) => [
  midi.notes,
  midi.cc ?? [],
  midi.pitchBends ?? [],
  midi.channelPressure ?? [],
  midi.polyPressure ?? [],
]

const duplicateIds = (ids: readonly (string | undefined)[]) => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (id === undefined) continue
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return [...duplicates]
}

export const midiClipReadSchema = legacyMidiClipContract
export const midiClipSchema = midiClipContract.superRefine((midi, context) => {
  const arrays = midiEventArrays(midi)
  if (arrays.some((events) => events.length > MAX_MIDI_EVENTS_PER_ARRAY)) {
    context.addIssue({ code: 'custom', message: `MIDI event arrays support at most ${MAX_MIDI_EVENTS_PER_ARRAY} events.` })
  }
  if (arrays.reduce((total, events) => total + events.length, 0) > MAX_MIDI_PERFORMANCE_EVENTS) {
    context.addIssue({ code: 'custom', message: `MIDI clips support at most ${MAX_MIDI_PERFORMANCE_EVENTS} performance events.` })
  }
  if ((midi.mappings?.length ?? 0) > MAX_MIDI_MAPPINGS) {
    context.addIssue({ code: 'custom', message: `MIDI clips support at most ${MAX_MIDI_MAPPINGS} mappings.` })
  }
  if (duplicateIds(arrays.flatMap((events) => events.map((event) => event.id))).length > 0) {
    context.addIssue({ code: 'custom', message: 'MIDI event IDs must be unique.' })
  }
  if (duplicateIds((midi.mappings ?? []).map((mapping) => mapping.id)).length > 0) {
    context.addIssue({ code: 'custom', message: 'MIDI mapping IDs must be unique.' })
  }
})

export type MidiNote = z.infer<typeof midiNoteSchema>
export type LegacyMidiNote = z.infer<typeof legacyMidiNoteSchema>
export type MidiCcEvent = z.infer<typeof midiCcEventSchema>
export type MidiPitchBendEvent = z.infer<typeof midiPitchBendEventSchema>
export type MidiChannelPressureEvent = z.infer<typeof midiChannelPressureEventSchema>
export type MidiPolyPressureEvent = z.infer<typeof midiPolyPressureEventSchema>
export type MidiMapping = z.infer<typeof midiMappingSchema>
export type StrictMidiClip = z.infer<typeof midiClipContract>
export type MidiClip = z.infer<typeof midiClipReadSchema>
export type LegacyMidiClip = MidiClip
export type NormalizedMidiClip = Omit<StrictMidiClip, 'notes' | 'cc' | 'pitchBends' | 'channelPressure' | 'polyPressure' | 'mappings'> & {
  notes: MidiNote[]
  cc: MidiCcEvent[]
  pitchBends: MidiPitchBendEvent[]
  channelPressure: MidiChannelPressureEvent[]
  polyPressure: MidiPolyPressureEvent[]
  mappings: MidiMapping[]
}
export type NormalizedLegacyMidiClip = Omit<LegacyMidiClip, 'notes' | 'cc' | 'pitchBends' | 'channelPressure' | 'polyPressure' | 'mappings'> & {
  notes: LegacyMidiNote[]
  cc: MidiCcEvent[]
  pitchBends: MidiPitchBendEvent[]
  channelPressure: MidiChannelPressureEvent[]
  polyPressure: MidiPolyPressureEvent[]
  mappings: MidiMapping[]
}

type LegacyMidiEvent = {
  [key: string]: string | number | boolean | null | undefined
  id?: string
  channel?: number
}

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const legacyTuple = (event: LegacyMidiEvent) => JSON.stringify(
  Object.entries(event)
    .filter(([key]) => key !== 'id')
    .sort(([left], [right]) => compareText(left, right)),
)
const legacyId = (kind: string, event: LegacyMidiEvent, ordinal: number) => (
  `midi:${kind}:${legacyTuple(event)}:${ordinal}`
)

const normalizeEvents = <Event extends LegacyMidiEvent>(
  kind: string,
  events: readonly Event[] | undefined,
  compare: (left: Event, right: Event) => number,
  reservedIds: Set<string>,
): Event[] => {
  const counts = new Map<string, number>()
  const normalized = (events ?? []).map((event) => {
    const normalizedEvent = { ...event, channel: event.channel ?? 1 }
    if (event.id !== undefined) return normalizedEvent
    const key = legacyTuple(normalizedEvent)
    const ordinal = counts.get(key) ?? 0
    counts.set(key, ordinal + 1)
    const candidate = legacyId(kind, normalizedEvent, ordinal)
    let id = candidate
    let probe = 1
    while (reservedIds.has(id)) {
      id = `${candidate}:${probe}`
      probe += 1
    }
    reservedIds.add(id)
    return { ...normalizedEvent, id }
  })
  const ids = new Set<string>()
  for (const event of normalized) {
    if (event.id === undefined) throw new Error('MIDI event IDs must be normalized.')
    if (ids.has(event.id)) throw new Error(`Duplicate MIDI ${kind} ID: ${event.id}`)
    ids.add(event.id)
  }
  return normalized.sort((left, right) => compare(left, right) || compareText(left.id ?? '', right.id ?? ''))
}

const byBeat = <Event extends { beat: number }>(left: Event, right: Event) => left.beat - right.beat

const normalizeMidi = (
  value: JsonValue,
  parse: (value: JsonValue) => LegacyMidiClip,
): NormalizedLegacyMidiClip => {
  const parsed = parse(value)
  const reservedIds = new Set(
    [parsed.notes, parsed.cc ?? [], parsed.pitchBends ?? [], parsed.channelPressure ?? [], parsed.polyPressure ?? []]
      .flatMap((events) => events.flatMap((event) => event.id === undefined ? [] : [event.id])),
  )
  const notes = normalizeEvents('note', parsed.notes, (left, right) => byBeat(left, right) || left.pitch - right.pitch || left.length - right.length || (left.velocity ?? 0) - (right.velocity ?? 0), reservedIds)
  const cc = normalizeEvents('cc', parsed.cc, (left, right) => byBeat(left, right) || left.controller - right.controller || left.value - right.value, reservedIds)
  const pitchBends = normalizeEvents('pitch-bend', parsed.pitchBends, (left, right) => byBeat(left, right) || left.value - right.value, reservedIds)
  const channelPressure = normalizeEvents('channel-pressure', parsed.channelPressure, (left, right) => byBeat(left, right) || left.value - right.value, reservedIds)
  const polyPressure = normalizeEvents('poly-pressure', parsed.polyPressure, (left, right) => byBeat(left, right) || left.pitch - right.pitch || left.value - right.value, reservedIds)
  const mappings = [...(parsed.mappings ?? [])].sort((left, right) => compareText(left.id, right.id))
  const ids = new Set<string>()
  for (const event of [...notes, ...cc, ...pitchBends, ...channelPressure, ...polyPressure]) {
    if (event.id === undefined) throw new Error('MIDI event IDs must be normalized.')
    if (ids.has(event.id)) throw new Error(`Duplicate MIDI event ID: ${event.id}`)
    ids.add(event.id)
  }
  return {
    wave: parsed.wave,
    gain: parsed.gain,
    inputChannel: parsed.inputChannel,
    notes,
    cc,
    pitchBends,
    channelPressure,
    polyPressure,
    mappings,
  }
}

export const normalizeMidiClip = (value: JsonValue): NormalizedMidiClip => {
  const parsed = midiClipSchema.parse(value)
  const normalized = normalizeMidi(parsed, (input) => midiClipSchema.parse(input))
  return {
    wave: parsed.wave,
    gain: parsed.gain,
    inputChannel: parsed.inputChannel,
    notes: normalized.notes,
    cc: normalized.cc,
    pitchBends: normalized.pitchBends,
    channelPressure: normalized.channelPressure,
    polyPressure: normalized.polyPressure,
    mappings: normalized.mappings,
  }
}
export const normalizeLegacyMidiClip = (value: JsonValue): NormalizedLegacyMidiClip => normalizeMidi(value, (input) => midiClipReadSchema.parse(input))

/**
 * Produces a valid new-clip MIDI payload from a readable historical payload.
 * This deliberately drops unsupported legacy values rather than making a new
 * creation path capable of persisting them.
 */
export const sanitizeLegacyMidiClipForCreate = (value: LegacyMidiClip): StrictMidiClip => {
  let midi = midiClipSchema.parse({
    wave: midiWaveSchema.safeParse(value.wave).success ? value.wave : 'sine',
    gain: isJsonNumber(value.gain) && Number.isFinite(value.gain) && value.gain >= 0 && value.gain <= 2 ? value.gain : undefined,
    inputChannel: isJsonNumber(value.inputChannel) && Number.isInteger(value.inputChannel) && value.inputChannel >= 1 && value.inputChannel <= 16 ? value.inputChannel : undefined,
    notes: [],
  })
  const append = (patch: Partial<StrictMidiClip>) => {
    const candidate = midiClipSchema.safeParse({ ...midi, ...patch })
    if (candidate.success) midi = candidate.data
  }
  for (const note of value.notes) append({ notes: [...midi.notes, note] })
  for (const event of value.cc ?? []) append({ cc: [...(midi.cc ?? []), event] })
  for (const event of value.pitchBends ?? []) append({ pitchBends: [...(midi.pitchBends ?? []), event] })
  for (const event of value.channelPressure ?? []) append({ channelPressure: [...(midi.channelPressure ?? []), event] })
  for (const event of value.polyPressure ?? []) append({ polyPressure: [...(midi.polyPressure ?? []), event] })
  for (const mapping of value.mappings ?? []) append({ mappings: [...(midi.mappings ?? []), mapping] })
  return normalizeMidiClip(midi)
}

export const cloneMidiClip = (midi: LegacyMidiClip): LegacyMidiClip => structuredClone(midi)
export const midiClipEquals = (left: LegacyMidiClip | undefined, right: LegacyMidiClip | undefined) => (
  left === undefined || right === undefined ? left === right : JSON.stringify(normalizeLegacyMidiClip(left)) === JSON.stringify(normalizeLegacyMidiClip(right))
)
export const midiPerformanceEventCount = (midi: LegacyMidiClip) => (
  midi.notes.length + (midi.cc?.length ?? 0) + (midi.pitchBends?.length ?? 0) + (midi.channelPressure?.length ?? 0) + (midi.polyPressure?.length ?? 0)
)
export const midiMappingCount = (midi: LegacyMidiClip) => midi.mappings?.length ?? 0
export const midiSerializedByteLength = (midi: MidiClip) => new TextEncoder().encode(JSON.stringify(normalizeMidiClip(midi))).byteLength
