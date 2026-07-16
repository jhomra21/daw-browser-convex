import { z } from 'zod'
import {
  REVERB_DECAY_SEC_MAX,
  REVERB_DECAY_SEC_MIN,
  REVERB_DIFFUSION_HIGH_CUT_HZ_MAX,
  REVERB_DIFFUSION_HIGH_CUT_HZ_MIN,
  REVERB_DIFFUSION_LOW_CUT_HZ_MAX,
  REVERB_DIFFUSION_LOW_CUT_HZ_MIN,
  REVERB_HIGH_CUT_HZ_MAX,
  REVERB_HIGH_CUT_HZ_MIN,
  REVERB_LOW_CUT_HZ_MAX,
  REVERB_LOW_CUT_HZ_MIN,
  REVERB_PRE_DELAY_MS_MAX,
  REVERB_PRE_DELAY_MS_MIN,
  REVERB_REFLECTION_MOD_AMOUNT_MS_MAX,
  REVERB_REFLECTION_MOD_AMOUNT_MS_MIN,
  REVERB_REFLECTION_MOD_RATE_HZ_MAX,
  REVERB_REFLECTION_MOD_RATE_HZ_MIN,
  REVERB_STEREO_WIDTH_MAX,
  REVERB_STEREO_WIDTH_MIN,
  REVERB_UNIT_PARAM_MAX,
  REVERB_UNIT_PARAM_MIN,
  REVERB_WET_MAX,
  REVERB_WET_MIN,
} from './effects-params'
import { SYNTH_PARAMETER_LIMITS } from './synth-params'

const EqBandSchema = z.object({
  id: z.string(),
  type: z.string(),
  frequency: z.number(),
  gainDb: z.number(),
  q: z.number(),
  enabled: z.boolean(),
})

const SynthWaveSchema = z.enum(['sine', 'square', 'sawtooth', 'triangle'])
const SynthEnvelopeUpdateSchema = z.object({
  attackSec: z.number().min(SYNTH_PARAMETER_LIMITS.envelopeSeconds.min).max(SYNTH_PARAMETER_LIMITS.envelopeSeconds.max).optional(),
  decaySec: z.number().min(SYNTH_PARAMETER_LIMITS.envelopeSeconds.min).max(SYNTH_PARAMETER_LIMITS.envelopeSeconds.max).optional(),
  sustain: z.number().min(SYNTH_PARAMETER_LIMITS.sustain.min).max(SYNTH_PARAMETER_LIMITS.sustain.max).optional(),
  releaseSec: z.number().min(SYNTH_PARAMETER_LIMITS.envelopeSeconds.min).max(SYNTH_PARAMETER_LIMITS.envelopeSeconds.max).optional(),
})
const SynthOscillatorUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  wave: SynthWaveSchema.optional(),
  octave: z.number().int().min(SYNTH_PARAMETER_LIMITS.oscillatorOctave.min).max(SYNTH_PARAMETER_LIMITS.oscillatorOctave.max).optional(),
  semitone: z.number().int().min(SYNTH_PARAMETER_LIMITS.oscillatorSemitone.min).max(SYNTH_PARAMETER_LIMITS.oscillatorSemitone.max).optional(),
  detuneCents: z.number().min(SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents.min).max(SYNTH_PARAMETER_LIMITS.oscillatorDetuneCents.max).optional(),
  level: z.number().min(SYNTH_PARAMETER_LIMITS.oscillatorLevel.min).max(SYNTH_PARAMETER_LIMITS.oscillatorLevel.max).optional(),
})
const SynthFilterUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['lowpass', 'highpass', 'bandpass', 'notch']).optional(),
  frequencyHz: z.number().min(SYNTH_PARAMETER_LIMITS.filterFrequencyHz.min).max(SYNTH_PARAMETER_LIMITS.filterFrequencyHz.max).optional(),
  q: z.number().min(SYNTH_PARAMETER_LIMITS.filterQ.min).max(SYNTH_PARAMETER_LIMITS.filterQ.max).optional(),
  keyTracking: z.number().min(SYNTH_PARAMETER_LIMITS.filterKeyTracking.min).max(SYNTH_PARAMETER_LIMITS.filterKeyTracking.max).optional(),
  envelopeAmountOctaves: z.number().min(SYNTH_PARAMETER_LIMITS.filterEnvelopeAmountOctaves.min).max(SYNTH_PARAMETER_LIMITS.filterEnvelopeAmountOctaves.max).optional(),
  envelope: SynthEnvelopeUpdateSchema.optional(),
})
const SynthLfoUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  wave: SynthWaveSchema.optional(),
  frequencyHz: z.number().min(SYNTH_PARAMETER_LIMITS.lfoFrequencyHz.min).max(SYNTH_PARAMETER_LIMITS.lfoFrequencyHz.max).optional(),
  pitchCents: z.number().min(SYNTH_PARAMETER_LIMITS.lfoPitchCents.min).max(SYNTH_PARAMETER_LIMITS.lfoPitchCents.max).optional(),
  filterOctaves: z.number().min(SYNTH_PARAMETER_LIMITS.lfoFilterOctaves.min).max(SYNTH_PARAMETER_LIMITS.lfoFilterOctaves.max).optional(),
  amp: z.number().min(SYNTH_PARAMETER_LIMITS.lfoAmp.min).max(SYNTH_PARAMETER_LIMITS.lfoAmp.max).optional(),
  pan: z.number().min(SYNTH_PARAMETER_LIMITS.lfoPan.min).max(SYNTH_PARAMETER_LIMITS.lfoPan.max).optional(),
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
  channelMode: z.union([z.literal('mono'), z.literal('stereo')]).optional(),
  bands: z.array(EqBandSchema),
})

export const SetReverbParamsCommandSchema = z.object({
  type: z.literal('setReverbParams'),
  target: z.union([z.literal('master'), z.number().int().min(1)]),
  enabled: z.boolean(),
  wet: z.number().min(REVERB_WET_MIN).max(REVERB_WET_MAX),
  decaySec: z.number().min(REVERB_DECAY_SEC_MIN).max(REVERB_DECAY_SEC_MAX),
  preDelayMs: z.number().min(REVERB_PRE_DELAY_MS_MIN).max(REVERB_PRE_DELAY_MS_MAX),
  reflections: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  reflectionSpin: z.boolean().optional(),
  reflectionModAmountMs: z.number().min(REVERB_REFLECTION_MOD_AMOUNT_MS_MIN).max(REVERB_REFLECTION_MOD_AMOUNT_MS_MAX).optional(),
  reflectionModRateHz: z.number().min(REVERB_REFLECTION_MOD_RATE_HZ_MIN).max(REVERB_REFLECTION_MOD_RATE_HZ_MAX).optional(),
  reflectionShape: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  diffuse: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  size: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  diffusion: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  density: z.number().min(REVERB_UNIT_PARAM_MIN).max(REVERB_UNIT_PARAM_MAX).optional(),
  lowCutHz: z.number().min(REVERB_LOW_CUT_HZ_MIN).max(REVERB_LOW_CUT_HZ_MAX).optional(),
  highCutHz: z.number().min(REVERB_HIGH_CUT_HZ_MIN).max(REVERB_HIGH_CUT_HZ_MAX).optional(),
  diffusionLowCutHz: z.number().min(REVERB_DIFFUSION_LOW_CUT_HZ_MIN).max(REVERB_DIFFUSION_LOW_CUT_HZ_MAX).optional(),
  diffusionHighCutHz: z.number().min(REVERB_DIFFUSION_HIGH_CUT_HZ_MIN).max(REVERB_DIFFUSION_HIGH_CUT_HZ_MAX).optional(),
  stereoWidth: z.number().min(REVERB_STEREO_WIDTH_MIN).max(REVERB_STEREO_WIDTH_MAX).optional(),
})

export const SetSynthParamsCommandSchema = z.object({
  type: z.literal('setSynthParams'),
  trackIndex: z.number().int().min(1),
  oscillators: z.tuple([SynthOscillatorUpdateSchema.optional(), SynthOscillatorUpdateSchema.optional()]).optional(),
  ampEnvelope: SynthEnvelopeUpdateSchema.optional(),
  filter: SynthFilterUpdateSchema.optional(),
  lfo: SynthLfoUpdateSchema.optional(),
  pan: z.number().min(SYNTH_PARAMETER_LIMITS.pan.min).max(SYNTH_PARAMETER_LIMITS.pan.max).optional(),
  polyphony: z.number().int().min(SYNTH_PARAMETER_LIMITS.polyphony.min).max(SYNTH_PARAMETER_LIMITS.polyphony.max).optional(),
  retrigger: z.boolean().optional(),
  wave1: SynthWaveSchema.optional(),
  wave2: SynthWaveSchema.optional(),
  gain: z.number().min(SYNTH_PARAMETER_LIMITS.gain.min).max(SYNTH_PARAMETER_LIMITS.gain.max).optional(),
  attackMs: z.number().min(SYNTH_PARAMETER_LIMITS.envelopeSeconds.min * 1000).max(SYNTH_PARAMETER_LIMITS.envelopeSeconds.max * 1000).optional(),
  releaseMs: z.number().min(SYNTH_PARAMETER_LIMITS.envelopeSeconds.min * 1000).max(SYNTH_PARAMETER_LIMITS.envelopeSeconds.max * 1000).optional(),
}).refine(
  (input) =>
    input.oscillators !== undefined
    || input.ampEnvelope !== undefined
    || input.filter !== undefined
    || input.lfo !== undefined
    || input.pan !== undefined
    || input.polyphony !== undefined
    || input.retrigger !== undefined
    || input.wave1 !== undefined
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

const CommandSchema = z.discriminatedUnion('type', [
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
