import { z } from 'zod'

export const EqBandSchema = z.object({
  id: z.string(),
  type: z.string(),
  frequency: z.number(),
  gainDb: z.number(),
  q: z.number(),
  enabled: z.boolean(),
})

export const CommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('createTrack'),
    kind: z.enum(['audio', 'instrument']).optional(),
  }),
  z.object({
    type: z.literal('setTrackVolume'),
    trackIndex: z.number().int().min(0).optional(),
    volume: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('addMidiClip'),
    trackIndex: z.number().int().min(0),
    startSec: z.number().min(0),
    duration: z.number().min(0.05),
    wave: z.enum(['sine','square','sawtooth','triangle']).optional(),
    gain: z.number().min(0).max(1.5).optional(),
    notes: z.array(z.object({
      beat: z.number(),
      length: z.number(),
      pitch: z.number(),
      velocity: z.number().optional(),
    })).optional(),
  }),
  z.object({
    type: z.literal('setEqParams'),
    target: z.union([z.literal('master'), z.number().int().min(0)]),
    enabled: z.boolean(),
    bands: z.array(EqBandSchema),
  }),
  z.object({
    type: z.literal('setReverbParams'),
    target: z.union([z.literal('master'), z.number().int().min(0)]),
    enabled: z.boolean(),
    wet: z.number().min(0).max(1),
    decaySec: z.number().min(0.05).max(12),
    preDelayMs: z.number().min(0).max(250),
  }),
  z.object({
    type: z.literal('setSynthParams'),
    trackIndex: z.number().int().min(0),
    wave: z.enum(['sine','square','sawtooth','triangle']),
    gain: z.number().min(0).max(1.5).optional(),
    attackMs: z.number().min(0).max(500).optional(),
    releaseMs: z.number().min(0).max(500).optional(),
  }),
  z.object({
    type: z.literal('deleteTrack'),
    trackIndex: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('moveClip'),
    fromTrackIndex: z.number().int().min(0),
    newStartSec: z.number().min(0),
    toTrackIndex: z.number().int().min(0).optional(),
    // Selection of source clip
    clipAtOrAfterSec: z.number().min(0).optional(),
    clipIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('removeClip'),
    trackIndex: z.number().int().min(0),
    clipAtOrAfterSec: z.number().min(0).optional(),
    clipIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('setArpeggiatorParams'),
    trackIndex: z.number().int().min(0),
    enabled: z.boolean(),
    pattern: z.enum(['up','down','updown','random']),
    rate: z.enum(['1/4','1/8','1/16','1/32']),
    octaves: z.number(),
    gate: z.number(),
    hold: z.boolean(),
  }),
  z.object({
    type: z.literal('setTiming'),
    trackIndex: z.number().int().min(0),
    startSec: z.number().min(0),
    duration: z.number().min(0),
    leftPadSec: z.number().min(0).optional(),
    clipAtOrAfterSec: z.number().min(0).optional(),
    clipIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('removeMany'),
    trackIndex: z.number().int().min(0),
    rangeStartSec: z.number().min(0),
    rangeEndSec: z.number().min(0),
  }),
  z.object({
    type: z.literal('moveClips'),
    fromTrackIndex: z.number().int().min(0),
    toTrackIndex: z.number().int().min(0).optional(),
    // Selection
    clipIndices: z.array(z.number().int().min(0)).optional(),
    clipAtOrAfterSec: z.number().min(0).optional(),
    rangeStartSec: z.number().min(0).optional(),
    rangeEndSec: z.number().min(0).optional(),
    count: z.number().int().min(1).optional(),
    // Placement
    newStartSec: z.number().min(0).optional(),
    keepRelativePositions: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('copyClips'),
    fromTrackIndex: z.number().int().min(0),
    toTrackIndex: z.number().int().min(0).optional(),
    // Selection
    clipIndices: z.array(z.number().int().min(0)).optional(),
    clipAtOrAfterSec: z.number().min(0).optional(),
    rangeStartSec: z.number().min(0).optional(),
    rangeEndSec: z.number().min(0).optional(),
    count: z.number().int().min(1).optional(),
    // Placement
    startAtSec: z.number().min(0).optional(),
    keepRelativePositions: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('setMute'),
    // Targets: provide one or many; if neither provided, default to most recently created track
    trackIndex: z.number().int().min(0).optional(),
    trackIndices: z.array(z.number().int().min(0)).optional(),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal('setSolo'),
    // Targets: provide one or many; if neither provided, default to most recently created track
    trackIndex: z.number().int().min(0).optional(),
    trackIndices: z.array(z.number().int().min(0)).optional(),
    value: z.boolean(),
    // When true and value=true, clear solo on all other tracks (best-effort)
    exclusive: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('addSampleClips'),
    // Match a sample in this project by name (substring) or exact URL
    sampleQuery: z.string(),
    // Destination: if omitted, create a new audio track
    trackIndex: z.number().int().min(0).optional(),
    // Placement
    startSec: z.number().min(0).optional(),
    count: z.number().int().min(1).optional(),
    intervalSec: z.number().min(0).optional(),
    // Pattern helpers (uses bpm if provided; default 120)
    pattern: z.enum(['fourOnFloor','everyBeat','everyHalf']).optional(),
    bpm: z.number().min(20).max(300).optional(),
  }),
])

export type AgentCommand = z.infer<typeof CommandSchema>

export const CommandsEnvelopeSchema = z.object({
  commands: z.array(CommandSchema).min(1),
})

export type CommandsEnvelope = z.infer<typeof CommandsEnvelopeSchema>
