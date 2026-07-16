import { v } from "convex/values";

const synthWaveValidator = v.union(
  v.literal("sine"),
  v.literal("square"),
  v.literal("sawtooth"),
  v.literal("triangle"),
);

const synthEnvelopeValidator = v.object({
  attackSec: v.number(),
  decaySec: v.number(),
  sustain: v.number(),
  releaseSec: v.number(),
});

const synthOscillatorValidator = v.object({
  wave: synthWaveValidator,
  octave: v.number(),
  semitone: v.number(),
  detuneCents: v.number(),
  level: v.number(),
});

export const synthParamsValidator = v.object({
  version: v.literal(2),
  oscillators: v.array(synthOscillatorValidator),
  ampEnvelope: synthEnvelopeValidator,
  filter: v.object({
    enabled: v.boolean(),
    mode: v.union(v.literal("lowpass"), v.literal("highpass"), v.literal("bandpass"), v.literal("notch")),
    frequencyHz: v.number(),
    q: v.number(),
    keyTracking: v.number(),
    envelopeAmountOctaves: v.number(),
    envelope: synthEnvelopeValidator,
  }),
  lfo: v.object({
    enabled: v.boolean(),
    wave: synthWaveValidator,
    frequencyHz: v.number(),
    pitchCents: v.number(),
    filterOctaves: v.number(),
    amp: v.number(),
    pan: v.number(),
  }),
  gain: v.number(),
  pan: v.number(),
  polyphony: v.number(),
  retrigger: v.boolean(),
});

export const legacySynthParamsValidator = v.object({
  wave1: synthWaveValidator,
  wave2: synthWaveValidator,
  gain: v.optional(v.number()),
  attackMs: v.optional(v.number()),
  releaseMs: v.optional(v.number()),
});

export const trackInstrumentValidator = v.union(
  v.object({ kind: v.literal("synth"), instanceId: v.string(), params: v.union(synthParamsValidator, legacySynthParamsValidator) }),
  v.object({ kind: v.literal("drum-rack"), instanceId: v.string(), params: v.any() }),
  v.object({ kind: v.literal("sampler"), instanceId: v.string(), params: v.any() }),
  v.object({ kind: v.literal("granular"), instanceId: v.string(), params: v.any() }),
);
