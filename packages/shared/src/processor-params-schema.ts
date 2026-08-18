import { z } from 'zod'

const finiteNumber = z.number().finite()
const identifier = z.string().min(1)
const envelope = <State extends z.ZodObject>(state: State) => z.object({
  version: z.literal(1),
  state,
}).strict()

const eqBand = z.object({
  id: identifier,
  frequency: finiteNumber,
  gainDb: finiteNumber,
  q: finiteNumber,
  enabled: z.boolean(),
  type: z.enum(['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass']),
}).strict()

const eq = z.object({ bands: z.array(eqBand), enabled: z.boolean(), channelMode: z.enum(['stereo', 'mono']) }).strict()
const reverb = z.object({
  enabled: z.boolean(), wet: finiteNumber, decaySec: finiteNumber, preDelayMs: finiteNumber,
  reflections: finiteNumber, reflectionSpin: z.boolean(), reflectionModAmountMs: finiteNumber,
  reflectionModRateHz: finiteNumber, 'reflectionShape': finiteNumber, diffuse: finiteNumber,
  size: finiteNumber, diffusion: finiteNumber, density: finiteNumber, lowCutHz: finiteNumber,
  highCutHz: finiteNumber, diffusionLowCutHz: finiteNumber, diffusionHighCutHz: finiteNumber,
  stereoWidth: finiteNumber,
}).strict()
const saturator = z.object({
  enabled: z.boolean(), driveDb: finiteNumber, curve: z.enum(['soft', 'medium', 'hard', 'clip']),
  color: z.boolean(), colorFrequencyHz: finiteNumber, colorAmount: finiteNumber,
  outputDb: finiteNumber, dryWet: finiteNumber,
}).strict()
const delay = z.object({
  enabled: z.boolean(), mode: z.enum(['sync', 'time']), timeMs: finiteNumber,
  syncDivision: z.enum(['1/16', '1/8', '1/4', '1/2', '1/1']), feedback: finiteNumber,
  dryWet: finiteNumber, pingPong: z.boolean(), filterEnabled: z.boolean(),
  lowCutHz: finiteNumber, highCutHz: finiteNumber,
}).strict()
const compressor = z.object({
  enabled: z.boolean(), thresholdDb: finiteNumber, ratio: finiteNumber, attackMs: finiteNumber,
  releaseMs: finiteNumber, autoRelease: z.boolean(), makeupDb: finiteNumber, outputDb: finiteNumber,
  dryWet: finiteNumber, kneeDb: finiteNumber, lookaheadMs: finiteNumber,
  detectorMode: z.enum(['peak', 'rms']), dynamicsMode: z.enum(['compress', 'expand']),
  envelopeCurve: z.enum(['log', 'linear']),
  sidechain: z.object({
    enabled: z.boolean(), filterType: z.enum(['lowpass', 'highpass', 'bandpass']),
    frequencyHz: finiteNumber, q: finiteNumber,
  }).strict(),
}).strict()
const utility = envelope(z.object({
  enabled: z.boolean(), gainDb: finiteNumber, polarity: z.enum(['normal', 'invert']),
  inputMode: z.enum(['stereo', 'mono-sum']), pan: finiteNumber, balance: finiteNumber,
  width: finiteNumber, matrix: z.enum(['stereo', 'mid-side-encode', 'mid-side-decode']),
  swap: z.boolean(), dcBlock: z.boolean(),
}).strict())
const gate = envelope(z.object({
  enabled: z.boolean(), mode: z.enum(['gate', 'expander']), thresholdDb: finiteNumber,
  ratio: finiteNumber, attackMs: finiteNumber, holdMs: finiteNumber, releaseMs: finiteNumber,
  hysteresisDb: finiteNumber, rangeDb: finiteNumber, lookaheadMs: finiteNumber,
  detector: z.enum(['peak', 'rms']), link: finiteNumber,
  sidechain: z.object({
    enabled: z.boolean(), filterType: z.literal('highpass'), frequencyHz: finiteNumber, q: finiteNumber,
  }).strict(),
}).strict())
const limiter = envelope(z.object({
  enabled: z.boolean(), ceilingDbtp: finiteNumber, releaseMs: finiteNumber,
  lookaheadMs: finiteNumber, link: finiteNumber, detectorOversampling: z.literal(4),
}).strict())
const autoFilter = envelope(z.object({
  enabled: z.boolean(), mode: z.enum(['lowpass', 'highpass', 'bandpass', 'notch', 'peak']),
  frequencyHz: finiteNumber, resonance: finiteNumber, driveDb: finiteNumber, mix: finiteNumber,
  envelope: z.object({ amountOctaves: finiteNumber, attackMs: finiteNumber, releaseMs: finiteNumber }).strict(),
  lfo: z.object({
    waveform: z.enum(['sine', 'triangle']), rateHz: finiteNumber, depthOctaves: finiteNumber,
    phaseOffset: finiteNumber, stereoPhase: finiteNumber,
  }).strict(),
  quality: z.literal('2x'),
}).strict())
const chorus = envelope(z.object({
  enabled: z.boolean(), delayMs: finiteNumber, depthMs: finiteNumber, rateHz: finiteNumber,
  feedback: finiteNumber, stereoPhase: finiteNumber, mix: finiteNumber,
}).strict())
const phaser = envelope(z.object({
  enabled: z.boolean(), stages: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(12)]),
  centerHz: finiteNumber, depthOctaves: finiteNumber, rateHz: finiteNumber,
  feedback: finiteNumber, stereoPhase: finiteNumber, mix: finiteNumber,
}).strict())
const tremolo = envelope(z.object({
  enabled: z.boolean(), waveform: z.enum(['sine', 'triangle']), rateHz: finiteNumber,
  depth: finiteNumber, 'shape': finiteNumber, phase: finiteNumber,
}).strict())
const ensemble = envelope(z.object({
  enabled: z.boolean(), voices: z.literal(3), delayMs: finiteNumber, depthMs: finiteNumber,
  rateHz: finiteNumber, spread: finiteNumber, mix: finiteNumber,
}).strict())
const lofi = envelope(z.object({
  enabled: z.boolean(), bitDepth: finiteNumber, sampleRateRatio: finiteNumber, jitter: finiteNumber,
  noiseDb: finiteNumber, quantization: z.enum(['round', 'floor', 'truncate']),
  dither: z.enum(['off', 'rectangular', 'triangular']), mix: finiteNumber, seed: finiteNumber,
}).strict())
const spectral = envelope(z.object({
  enabled: z.boolean(), fftSize: z.union([z.literal(512), z.literal(1024), z.literal(2048), z.literal(4096)]),
  overlap: z.union([z.literal(2), z.literal(4)]),
  mode: z.enum(['freeze', 'gate', 'morph', 'shift-blur', 'hpss', 'noise-reduce']),
  freeze: finiteNumber, gateThresholdDb: finiteNumber, gateAttackMs: finiteNumber,
  gateReleaseMs: finiteNumber, morph: finiteNumber, binShift: finiteNumber, blur: finiteNumber,
  harmonicPercussiveBalance: finiteNumber, noiseReduction: finiteNumber, profileLearn: finiteNumber,
  mix: finiteNumber,
}).strict())

const synthEnvelope = z.object({
  attackSec: finiteNumber, decaySec: finiteNumber, sustain: finiteNumber, releaseSec: finiteNumber,
}).strict()
const synth = z.object({
  version: z.literal(2),
  oscillators: z.tuple([
    z.object({ enabled: z.boolean(), wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']), octave: finiteNumber, semitone: finiteNumber, detuneCents: finiteNumber, level: finiteNumber }).strict(),
    z.object({ enabled: z.boolean(), wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']), octave: finiteNumber, semitone: finiteNumber, detuneCents: finiteNumber, level: finiteNumber }).strict(),
  ]),
  ampEnvelope: synthEnvelope,
  filter: z.object({
    enabled: z.boolean(), mode: z.enum(['lowpass', 'highpass', 'bandpass', 'notch']),
    frequencyHz: finiteNumber, q: finiteNumber, keyTracking: finiteNumber,
    envelopeAmountOctaves: finiteNumber, envelope: synthEnvelope,
  }).strict(),
  lfo: z.object({
    enabled: z.boolean(), wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
    frequencyHz: finiteNumber, pitchCents: finiteNumber, filterOctaves: finiteNumber,
    amp: finiteNumber, pan: finiteNumber,
  }).strict(),
  noise: z.object({ enabled: z.boolean(), level: finiteNumber }).strict(),
  gain: finiteNumber, pan: finiteNumber, polyphony: finiteNumber, retrigger: z.boolean(),
}).strict()
const legacySynth = z.object({
  wave1: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  wave2: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  gain: finiteNumber.optional(),
  attackMs: finiteNumber.optional(),
  releaseMs: finiteNumber.optional(),
}).strict()
const sample = z.object({
  assetKey: identifier, url: identifier, name: z.string().optional(),
  sourceKind: z.enum(['upload', 'url', 'recording']),
  source: z.object({ durationSec: finiteNumber, sampleRate: finiteNumber, channelCount: finiteNumber }).strict(),
}).strict()
const samplerZone = z.object({
  id: identifier, sample, keyLow: finiteNumber, keyHigh: finiteNumber, velocityLow: finiteNumber,
  velocityHigh: finiteNumber, rootNote: finiteNumber, tuneCents: finiteNumber, gain: finiteNumber,
  pan: finiteNumber, roundRobinGroup: finiteNumber, roundRobinIndex: finiteNumber,
  playbackMode: z.enum(['one-shot', 'forward-loop', 'crossfade-loop']), startSec: finiteNumber,
  endSec: finiteNumber.optional(), loopStartSec: finiteNumber.optional(), loopEndSec: finiteNumber.optional(),
  crossfadeSec: finiteNumber, chokeGroup: finiteNumber,
}).strict()
const samplerEnvelope = z.object({
  attackSec: finiteNumber, decaySec: finiteNumber, sustain: finiteNumber, releaseSec: finiteNumber, amount: finiteNumber,
}).strict()
const sampler = z.object({
  version: z.literal(1), zones: z.array(samplerZone), ampEnvelope: samplerEnvelope, filterEnvelope: samplerEnvelope,
  filterMode: z.enum(['lowpass', 'highpass', 'bandpass', 'notch']), filterFrequencyHz: finiteNumber,
  filterQ: finiteNumber, lfo: z.object({
    enabled: z.boolean(), frequencyHz: finiteNumber, pitchCents: finiteNumber, filterHz: finiteNumber,
    amp: finiteNumber, pan: finiteNumber,
  }).strict(),
  polyphony: finiteNumber, retrigger: z.boolean(), cachePolicy: z.enum(['preload', 'lazy']), maxDecodedBytes: finiteNumber,
}).strict()
const granular = z.object({
  version: z.literal(1), zone: samplerZone.optional(), grainSizeMs: finiteNumber, densityHz: finiteNumber,
  position: finiteNumber, spray: finiteNumber, pitchSemitones: finiteNumber, reverseProbability: finiteNumber,
  'windowShape': z.enum(['hann', 'tukey', 'gaussian']), stereoSpread: finiteNumber, freeze: z.boolean(),
  seed: finiteNumber, maxGrains: finiteNumber, maxDecodedBytes: finiteNumber,
}).strict()
const drumRack = z.object({
  pads: z.array(z.object({
    id: identifier, note: finiteNumber, name: z.string().optional(), sample: sample.optional(), gain: finiteNumber,
    pan: finiteNumber, transpose: finiteNumber, startSec: finiteNumber, endSec: finiteNumber.optional(),
    mute: z.boolean(), chokeGroup: finiteNumber,
  }).strict()),
  selectedPadId: identifier.optional(),
}).strict()
export const arpeggiatorParamsSchema = z.object({
  enabled: z.boolean(), pattern: z.enum(['up', 'down', 'updown', 'random']),
  rate: z.enum(['1/4', '1/8', '1/16', '1/32']), octaves: finiteNumber, gate: finiteNumber, hold: z.boolean(),
}).strict()

export const audioEffectAddPayloadSchema = z.discriminatedUnion('effectKind', [
  z.object({ effectKind: z.literal('utility'), params: utility.optional() }).strict(),
  z.object({ effectKind: z.literal('eq'), params: eq.optional() }).strict(),
  z.object({ effectKind: z.literal('autofilter'), params: autoFilter.optional() }).strict(),
  z.object({ effectKind: z.literal('gate'), params: gate.optional() }).strict(),
  z.object({ effectKind: z.literal('compressor'), params: compressor.optional() }).strict(),
  z.object({ effectKind: z.literal('saturator'), params: saturator.optional() }).strict(),
  z.object({ effectKind: z.literal('limiter'), params: limiter.optional() }).strict(),
  z.object({ effectKind: z.literal('lofi'), params: lofi.optional() }).strict(),
  z.object({ effectKind: z.literal('chorus'), params: chorus.optional() }).strict(),
  z.object({ effectKind: z.literal('flanger'), params: chorus.optional() }).strict(),
  z.object({ effectKind: z.literal('phaser'), params: phaser.optional() }).strict(),
  z.object({ effectKind: z.literal('tremolo'), params: tremolo.optional() }).strict(),
  z.object({ effectKind: z.literal('autopan'), params: tremolo.optional() }).strict(),
  z.object({ effectKind: z.literal('ensemble'), params: ensemble.optional() }).strict(),
  z.object({ effectKind: z.literal('delay'), params: delay.optional() }).strict(),
  z.object({ effectKind: z.literal('reverb'), params: reverb.optional() }).strict(),
  z.object({ effectKind: z.literal('spectral'), params: spectral.optional() }).strict(),
])

export const instrumentAddPayloadSchema = z.discriminatedUnion('instrumentKind', [
  z.object({ instrumentKind: z.literal('synth'), params: synth.optional() }).strict(),
  z.object({ instrumentKind: z.literal('drum-rack'), params: drumRack.optional() }).strict(),
  z.object({ instrumentKind: z.literal('sampler'), params: sampler.optional() }).strict(),
  z.object({ instrumentKind: z.literal('granular'), params: granular.optional() }).strict(),
])

export const persistedProcessorSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('utility'), params: utility }).strict(),
  z.object({ kind: z.literal('eq'), params: eq }).strict(),
  z.object({ kind: z.literal('autofilter'), params: autoFilter }).strict(),
  z.object({ kind: z.literal('gate'), params: gate }).strict(),
  z.object({ kind: z.literal('compressor'), params: compressor }).strict(),
  z.object({ kind: z.literal('saturator'), params: saturator }).strict(),
  z.object({ kind: z.literal('limiter'), params: limiter }).strict(),
  z.object({ kind: z.literal('lofi'), params: lofi }).strict(),
  z.object({ kind: z.literal('chorus'), params: chorus }).strict(),
  z.object({ kind: z.literal('flanger'), params: chorus }).strict(),
  z.object({ kind: z.literal('phaser'), params: phaser }).strict(),
  z.object({ kind: z.literal('tremolo'), params: tremolo }).strict(),
  z.object({ kind: z.literal('autopan'), params: tremolo }).strict(),
  z.object({ kind: z.literal('ensemble'), params: ensemble }).strict(),
  z.object({ kind: z.literal('delay'), params: delay }).strict(),
  z.object({ kind: z.literal('reverb'), params: reverb }).strict(),
  z.object({ kind: z.literal('spectral'), params: spectral }).strict(),
  z.object({ kind: z.literal('synth'), params: z.union([synth, legacySynth]) }).strict(),
  z.object({ kind: z.literal('drum-rack'), params: drumRack }).strict(),
  z.object({ kind: z.literal('sampler'), params: sampler }).strict(),
  z.object({ kind: z.literal('granular'), params: granular }).strict(),
  z.object({ kind: z.literal('instrument'), params: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('synth'), instanceId: identifier, params: synth }).strict(),
    z.object({ kind: z.literal('drum-rack'), instanceId: identifier, params: drumRack }).strict(),
    z.object({ kind: z.literal('sampler'), instanceId: identifier, params: sampler }).strict(),
    z.object({ kind: z.literal('granular'), instanceId: identifier, params: granular }).strict(),
  ]) }).strict(),
  z.object({ kind: z.literal('arpeggiator'), params: arpeggiatorParamsSchema }).strict(),
])
