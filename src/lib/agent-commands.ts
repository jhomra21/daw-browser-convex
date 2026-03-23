import { z } from 'zod'

export const EqBandSchema = z.object({
  id: z.string(),
  type: z.string(),
  frequency: z.number(),
  gainDb: z.number(),
  q: z.number(),
  enabled: z.boolean(),
})

export const CreateTrackCommandSchema = z.object({
  type: z.literal('createTrack'),
  kind: z.enum(['audio', 'instrument']).optional(),
  channelRole: z.enum(['track', 'return', 'group']).optional(),
})

export const SetTrackRoutingCommandSchema = z.object({
  type: z.literal('setTrackRouting'),
  trackIndex: z.number().int().min(1),
  outputTrackIndex: z.number().int().min(1).nullable().optional(),
  sends: z.array(z.object({
    targetTrackIndex: z.number().int().min(1),
    amount: z.number().min(0).max(1),
  })).optional(),
})

export const SetTrackVolumeCommandSchema = z.object({
  type: z.literal('setTrackVolume'),
  trackIndex: z.number().int().min(1).optional(),
  volume: z.number().min(0).max(1),
})

export const AddMidiClipCommandSchema = z.object({
  type: z.literal('addMidiClip'),
  trackIndex: z.number().int().min(1),
  startSec: z.number().min(0),
  duration: z.number().min(0.05),
  wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']).optional(),
  gain: z.number().min(0).max(1.5).optional(),
  notes: z.array(z.object({
    beat: z.number(),
    length: z.number(),
    pitch: z.number(),
    velocity: z.number().optional(),
  })).optional(),
})

export const SetEqParamsCommandSchema = z.object({
  type: z.literal('setEqParams'),
  target: z.union([z.literal('master'), z.number().int().min(1)]),
  enabled: z.boolean(),
  bands: z.array(EqBandSchema),
})

export const SetReverbParamsCommandSchema = z.object({
  type: z.literal('setReverbParams'),
  target: z.union([z.literal('master'), z.number().int().min(1)]),
  enabled: z.boolean(),
  wet: z.number().min(0).max(1),
  decaySec: z.number().min(0.05).max(12),
  preDelayMs: z.number().min(0).max(250),
})

export const SetSynthParamsCommandSchema = z.object({
  type: z.literal('setSynthParams'),
  trackIndex: z.number().int().min(1),
  wave1: z.enum(['sine', 'square', 'sawtooth', 'triangle']).optional(),
  wave2: z.enum(['sine', 'square', 'sawtooth', 'triangle']).optional(),
  gain: z.number().min(0).max(1.5).optional(),
  attackMs: z.number().min(0).max(500).optional(),
  releaseMs: z.number().min(0).max(500).optional(),
}).refine(
  (input) =>
    input.wave1 !== undefined
    || input.wave2 !== undefined
    || input.gain !== undefined
    || input.attackMs !== undefined
    || input.releaseMs !== undefined,
  { message: 'setSynthParams requires at least one synth field' },
)

export const DeleteTrackCommandSchema = z.object({
  type: z.literal('deleteTrack'),
  trackIndex: z.number().int().min(1),
})

export const MoveClipCommandSchema = z.object({
  type: z.literal('moveClip'),
  fromTrackIndex: z.number().int().min(1),
  newStartSec: z.number().min(0),
  toTrackIndex: z.number().int().min(1).optional(),
  clipAtOrAfterSec: z.number().min(0).optional(),
  clipIndex: z.number().int().min(1).optional(),
})

export const RemoveClipCommandSchema = z.object({
  type: z.literal('removeClip'),
  trackIndex: z.number().int().min(1),
  clipAtOrAfterSec: z.number().min(0).optional(),
  clipIndex: z.number().int().min(1).optional(),
})

export const SetArpeggiatorParamsCommandSchema = z.object({
  type: z.literal('setArpeggiatorParams'),
  trackIndex: z.number().int().min(1),
  enabled: z.boolean(),
  pattern: z.enum(['up', 'down', 'updown', 'random']),
  rate: z.enum(['1/4', '1/8', '1/16', '1/32']),
  octaves: z.number(),
  gate: z.number(),
  hold: z.boolean(),
})

export const SetTimingCommandSchema = z.object({
  type: z.literal('setTiming'),
  trackIndex: z.number().int().min(1),
  startSec: z.number().min(0),
  duration: z.number().min(0),
  leftPadSec: z.number().min(0).optional(),
  bufferOffsetSec: z.number().min(0).optional(),
  midiOffsetBeats: z.number().min(0).optional(),
  clipAtOrAfterSec: z.number().min(0).optional(),
  clipIndex: z.number().int().min(1).optional(),
})

export const RemoveManyCommandSchema = z.object({
  type: z.literal('removeMany'),
  trackIndex: z.number().int().min(1),
  rangeStartSec: z.number().min(0),
  rangeEndSec: z.number().min(0),
})

export const MoveClipsCommandSchema = z.object({
  type: z.literal('moveClips'),
  fromTrackIndex: z.number().int().min(1),
  toTrackIndex: z.number().int().min(1).optional(),
  clipIndices: z.array(z.number().int().min(1)).optional(),
  clipAtOrAfterSec: z.number().min(0).optional(),
  rangeStartSec: z.number().min(0).optional(),
  rangeEndSec: z.number().min(0).optional(),
  count: z.number().int().min(1).optional(),
  newStartSec: z.number().min(0).optional(),
  keepRelativePositions: z.boolean().optional(),
})

export const CopyClipsCommandSchema = z.object({
  type: z.literal('copyClips'),
  fromTrackIndex: z.number().int().min(1),
  toTrackIndex: z.number().int().min(1).optional(),
  clipIndices: z.array(z.number().int().min(1)).optional(),
  clipAtOrAfterSec: z.number().min(0).optional(),
  rangeStartSec: z.number().min(0).optional(),
  rangeEndSec: z.number().min(0).optional(),
  count: z.number().int().min(1).optional(),
  startAtSec: z.number().min(0).optional(),
  keepRelativePositions: z.boolean().optional(),
})

export const SetMuteCommandSchema = z.object({
  type: z.literal('setMute'),
  trackIndex: z.number().int().min(1).optional(),
  trackIndices: z.array(z.number().int().min(1)).optional(),
  value: z.boolean(),
})

export const SetSoloCommandSchema = z.object({
  type: z.literal('setSolo'),
  trackIndex: z.number().int().min(1).optional(),
  trackIndices: z.array(z.number().int().min(1)).optional(),
  value: z.boolean(),
  exclusive: z.boolean().optional(),
})

export const AddSampleClipsCommandSchema = z.object({
  type: z.literal('addSampleClips'),
  sampleQuery: z.string(),
  trackIndex: z.number().int().min(1).optional(),
  startSec: z.number().min(0).optional(),
  count: z.number().int().min(1).optional(),
  intervalSec: z.number().min(0).optional(),
  pattern: z.enum(['fourOnFloor', 'everyBeat', 'everyHalf']).optional(),
  bpm: z.number().min(20).max(300).optional(),
})

export const CommandSchema = z.discriminatedUnion('type', [
  CreateTrackCommandSchema,
  SetTrackRoutingCommandSchema,
  SetTrackVolumeCommandSchema,
  AddMidiClipCommandSchema,
  SetEqParamsCommandSchema,
  SetReverbParamsCommandSchema,
  SetSynthParamsCommandSchema,
  DeleteTrackCommandSchema,
  MoveClipCommandSchema,
  RemoveClipCommandSchema,
  SetArpeggiatorParamsCommandSchema,
  SetTimingCommandSchema,
  RemoveManyCommandSchema,
  MoveClipsCommandSchema,
  CopyClipsCommandSchema,
  SetMuteCommandSchema,
  SetSoloCommandSchema,
  AddSampleClipsCommandSchema,
])

export type AgentCommand = z.infer<typeof CommandSchema>

export const CommandsEnvelopeSchema = z.object({
  commands: z.array(CommandSchema).min(1),
})

export type CommandsEnvelope = z.infer<typeof CommandsEnvelopeSchema>
