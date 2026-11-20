import { v, type Infer } from "convex/values";

export const audioWarpValidator = v.object({
  enabled: v.boolean(),
  sourceBpm: v.optional(v.number()),
  sourceBeatOffset: v.optional(v.number()),
  markers: v.optional(v.array(v.object({
    id: v.string(),
    sourceBeat: v.number(),
    timelineBeat: v.number(),
  }))),
  mode: v.union(v.literal("repitch"), v.literal("stretch")),
});

export const clipFadesValidator = v.object({
  fadeInStartSec: v.optional(v.number()),
  fadeInSec: v.number(),
  fadeOutSec: v.number(),
  fadeOutEndSec: v.optional(v.number()),
  fadeInCurve: v.number(),
  fadeOutCurve: v.number(),
  fadeInCurvePosition: v.optional(v.number()),
  fadeOutCurvePosition: v.optional(v.number()),
})

export const midiValidator = v.object({
  wave: v.string(),
  gain: v.optional(v.number()),
  inputChannel: v.optional(v.number()),
  notes: v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), length: v.number(), pitch: v.number(),
    velocity: v.optional(v.number()), channel: v.optional(v.number()),
  })),
  cc: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), controller: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  pitchBends: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  channelPressure: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  polyPressure: v.optional(v.array(v.object({
    id: v.optional(v.string()), beat: v.number(), pitch: v.number(), value: v.number(), channel: v.optional(v.number()),
  }))),
  mappings: v.optional(v.array(v.object({
    id: v.string(),
    source: v.union(
      v.object({ kind: v.literal('cc'), controller: v.number(), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('pitch-bend'), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('channel-pressure'), channel: v.optional(v.number()) }),
      v.object({ kind: v.literal('poly-pressure'), channel: v.optional(v.number()), pitch: v.optional(v.number()) }),
    ),
    target: v.object({ parameterId: v.string(), effectInstanceId: v.optional(v.string()) }),
    outputMin: v.number(),
    outputMax: v.number(),
  }))),
})

// Validators are built at module load from plain values; the literal type of each member is the union of the values.
export const literalUnion = <Value extends string>(values: readonly Value[]) => v.union(...values.map((value) => v.literal(value)));

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
  enabled: v.optional(v.boolean()),
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
  noise: v.optional(v.object({
    enabled: v.boolean(),
    level: v.number(),
  })),
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

const manifestEntityRowValidator = v.object({
  kind: v.string(),
  id: v.string(),
  value: v.any(),
  updatedAt: v.number(),
});

const manifestStateRowValidator = v.object({
  key: v.string(),
  value: v.any(),
  updatedAt: v.number(),
});

export const projectManifestValidator = v.object({
  schemaVersion: v.number(),
  projectId: v.string(),
  name: v.string(),
  mode: v.union(v.literal("backup"), v.literal("shared")),
  updatedAt: v.number(),
  entityCount: v.number(),
  assetCount: v.number(),
  entities: v.array(manifestEntityRowValidator),
  assets: v.array(v.object({
    id: v.string(),
    name: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    storagePath: v.string(),
    folderId: v.optional(v.string()),
    missing: v.optional(v.boolean()),
    originalFileName: v.optional(v.string()),
    originalLastModified: v.optional(v.number()),
    contentHash: v.optional(v.string()),
    sourceKind: v.optional(v.union(v.literal("upload"), v.literal("url"), v.literal("recording"))),
    durationSec: v.optional(v.number()),
    sampleRate: v.optional(v.number()),
    channelCount: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
    cloudKey: v.optional(v.string()),
  })),
  projectState: v.array(manifestStateRowValidator),
  syncState: v.array(manifestStateRowValidator),
  externalPluginArtifacts: v.optional(v.array(v.object({
    id: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
    kind: v.union(v.literal("plugin-state"), v.literal("plugin-freeze")),
    ownerId: v.string(),
    acl: v.union(v.literal("owner"), v.literal("project-members")),
    bucket: v.union(v.literal("local"), v.literal("r2-plugin-artifacts")),
    location: v.string(),
  }))),
});

export const sendTapValidator = v.union(v.literal("pre-fx"), v.literal("pre-fader"), v.literal("post-fader"));

export const automationPointValidator = v.object({
  id: v.string(),
  timeSec: v.number(),
  value: v.number(),
  interpolation: v.union(v.literal("linear"), v.literal("hold")),
});

export const arpeggiatorParamsValidator = v.object({
  enabled: v.boolean(),
  pattern: v.union(v.literal("up"), v.literal("down"), v.literal("updown"), v.literal("random")),
  rate: v.union(v.literal("1/4"), v.literal("1/8"), v.literal("1/16"), v.literal("1/32")),
  octaves: v.number(),
  gate: v.number(),
  hold: v.boolean(),
});

export type SendTap = Infer<typeof sendTapValidator>;
