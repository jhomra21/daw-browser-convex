import { z } from "zod"
import { AUDIO_EFFECT_CONTRACTS, createDefaultSynthParams } from "@daw-browser/shared"

export const thirtyTrackFixtureVersion = "30-track-v2"
export const thirtyTrackSampleRate = 48_000
export const thirtyTrackSourceDurationSec = 90
export const thirtyTrackTimelineDurationSec = 60
export const thirtyTrackCount = 30
export const thirtyTrackTotalTrackCount = 31
export const thirtyTrackTotalClipCount = 31
export const thirtyTrackClipGain = 0.1

// Independent source plan; the committed v2 archive and generator remain unchanged.
const mixedRateDurations = [3, 10, 30, 60, 120, 360, 600] as const
export const planThirtyTrackMixedRateSources = () => Object.freeze(
  Array.from({ length: thirtyTrackCount }, (_, trackIndex) => {
    const sampleRate = [44_100, 48_000, 96_000][trackIndex % 3]
    if (sampleRate === undefined) throw new Error(`Missing source rate for track ${trackIndex}.`)
    const channelCount = trackIndex % 2 === 0 ? 1 : 2
    const durationSec = trackIndex === 0 ? 600 : mixedRateDurations[(trackIndex - 1) % 6]
    if (durationSec === undefined) throw new Error(`Missing source duration for track ${trackIndex}.`)
    return Object.freeze({
      trackIndex,
      sampleRate,
      channelCount,
      durationSec,
      uncompressedBytes: sampleRate * channelCount * durationSec * Float32Array.BYTES_PER_ELEMENT,
    })
  }),
)

// Generate only the requested frames; never allocate or encode the entire source.
export const sampleThirtyTrackMixedRatePage = (
  source: ReturnType<typeof planThirtyTrackMixedRateSources>[number],
  startFrame: number,
  frameCount: number,
): readonly Float32Array[] => {
  const totalFrames = source.sampleRate * source.durationSec
  if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(frameCount)
    || startFrame < 0 || frameCount < 1 || frameCount > 16_384
    || startFrame + frameCount > totalFrames) {
    throw new RangeError("Mixed-rate page must contain 1–16384 frames within the source.")
  }
  if (![44_100, 48_000, 96_000].includes(source.sampleRate)
    || (source.channelCount !== 1 && source.channelCount !== 2)
    || !mixedRateDurations.includes(source.durationSec)) {
    throw new RangeError("Invalid mixed-rate source descriptor.")
  }
  return Array.from({ length: source.channelCount }, (_, channel) => {
    const samples = new Float32Array(frameCount)
    for (let frame = 0; frame < frameCount; frame += 1) {
      const absoluteFrame = startFrame + frame
      // Integer-period triangular signals remain reproducible across page boundaries.
      samples[frame] = channel === 0
        ? 0.12 * triangle(absoluteFrame, 240) + 0.06 * triangle(absoluteFrame, 60)
        : 0.12 * triangle(absoluteFrame, 160) + 0.06 * triangle(absoluteFrame, 40)
    }
    return samples
  })
}
export const thirtyTrackProjectName = "30 Track Performance v2"
export const thirtyTrackArchiveName = `${thirtyTrackFixtureVersion}.dawproject`
type ThirtyTrackColor = "#ff5f57" | "#febc2e" | "#28c840" | "#4da3ff" | "#a78bfa" | "#f472b6"
const thirtyTrackColors: readonly ThirtyTrackColor[] = Object.freeze([
  "#ff5f57",
  "#febc2e",
  "#28c840",
  "#4da3ff",
  "#a78bfa",
  "#f472b6",
])

const tierTwoPitches: readonly [60, 64, 67, 71] = [60, 64, 67, 71]

const benchmarkName = (index: number) => `Benchmark ${String(index + 1).padStart(2, "0")}`
const colorAt = (index: number): ThirtyTrackColor => {
  const color = thirtyTrackColors[index % thirtyTrackColors.length]
  if (color === undefined) throw new Error(`Missing 30-track color at index ${index}.`)
  return color
}

const synthParamsSchema = z.object({
  version: z.literal(2),
  oscillators: z.tuple([
    z.object({ enabled: z.literal(true), wave: z.literal("sawtooth"), octave: z.literal(0), semitone: z.literal(0), detuneCents: z.literal(-7), level: z.literal(0.7) }).strict(),
    z.object({ enabled: z.literal(true), wave: z.literal("sawtooth"), octave: z.literal(0), semitone: z.literal(0), detuneCents: z.literal(7), level: z.literal(0.45) }).strict(),
  ]),
  ampEnvelope: z.object({ attackSec: z.literal(0.005), decaySec: z.literal(0.1), sustain: z.literal(0.8), releaseSec: z.literal(0.12) }).strict(),
  filter: z.object({
    enabled: z.literal(true),
    mode: z.literal("lowpass"),
    frequencyHz: z.literal(12000),
    q: z.literal(0.7),
    keyTracking: z.literal(0),
    envelopeAmountOctaves: z.literal(0),
    envelope: z.object({ attackSec: z.literal(0.005), decaySec: z.literal(0.15), sustain: z.literal(0), releaseSec: z.literal(0.15) }).strict(),
  }).strict(),
  lfo: z.object({
    enabled: z.literal(false),
    wave: z.literal("sine"),
    frequencyHz: z.literal(5),
    pitchCents: z.literal(0),
    filterOctaves: z.literal(0),
    amp: z.literal(0),
    pan: z.literal(0),
  }).strict(),
  noise: z.object({ enabled: z.literal(false), level: z.literal(0.25) }).strict(),
  gain: z.literal(0.8),
  pan: z.literal(0),
  polyphony: z.literal(1),
  retrigger: z.literal(true),
}).strict()

const saturatorParamsSchema = z.object({
  enabled: z.literal(true),
  driveDb: z.literal(6),
  curve: z.literal("soft"),
  color: z.literal(false),
  colorFrequencyHz: z.literal(1200),
  colorAmount: z.literal(0),
  outputDb: z.literal(0),
  dryWet: z.literal(1),
}).strict()

const utilityParamsSchema = z.object({
  version: z.literal(1),
  state: z.object({
    enabled: z.literal(true),
    gainDb: z.literal(-12),
    polarity: z.literal("normal"),
    inputMode: z.literal("stereo"),
    pan: z.literal(0),
    balance: z.literal(0),
    width: z.literal(1),
    matrix: z.literal("stereo"),
    swap: z.literal(false),
    dcBlock: z.literal(true),
  }).strict(),
}).strict()

const tierTwoNoteSchema = z.object({
  id: z.string().min(1),
  beat: z.number().int().min(0).max(15),
  length: z.literal(0.75),
  pitch: z.union([z.literal(60), z.literal(64), z.literal(67), z.literal(71)]),
  velocity: z.literal(0.5),
}).strict()

const triangleComponentSchema = z.object({
  amplitude: z.number(),
  period: z.number().int().positive(),
}).strict()

const semanticManifestSchema = z.object({
  fixtureVersion: z.literal(thirtyTrackFixtureVersion),
  sampleRate: z.literal(thirtyTrackSampleRate),
  projectName: z.literal(thirtyTrackProjectName),
  source: z.object({
    durationSec: z.literal(thirtyTrackSourceDurationSec),
    channelCount: z.literal(2),
    channels: z.object({
      left: z.object({ components: z.tuple([triangleComponentSchema, triangleComponentSchema]) }).strict(),
      right: z.object({ components: z.tuple([triangleComponentSchema, triangleComponentSchema]) }).strict(),
    }).strict(),
  }).strict(),
  timeline: z.object({
    durationSec: z.literal(thirtyTrackTimelineDurationSec),
    trackCount: z.literal(thirtyTrackTotalTrackCount),
    clipCount: z.literal(thirtyTrackTotalClipCount),
    clipDurationSec: z.literal(thirtyTrackTimelineDurationSec),
    clipGain: z.literal(thirtyTrackClipGain),
    sourceOffsetsSec: z.array(z.number().int().min(0)).length(thirtyTrackCount),
    colors: z.array(z.enum(thirtyTrackColors)).length(thirtyTrackColors.length),
    tracks: z.array(z.object({
      index: z.number().int().min(0),
      name: z.string().min(1),
      kind: z.literal("audio"),
      volume: z.literal(1),
      color: z.enum(thirtyTrackColors),
    }).strict()).length(thirtyTrackCount),
    clips: z.array(z.object({
      index: z.number().int().min(0),
      name: z.string().min(1),
      trackIndex: z.number().int().min(0),
      startSec: z.literal(0),
      durationSec: z.literal(thirtyTrackTimelineDurationSec),
      sourceOffsetSec: z.number().int().min(0),
      gain: z.literal(thirtyTrackClipGain),
      color: z.enum(thirtyTrackColors),
      sourceKind: z.literal("recording"),
      sourceDurationSec: z.literal(thirtyTrackSourceDurationSec),
      sourceSampleRate: z.literal(thirtyTrackSampleRate),
      sourceChannelCount: z.literal(2),
    }).strict()).length(thirtyTrackCount),
  }).strict(),
  tier2: z.object({
    track: z.object({
      id: z.literal("tier2-track"),
      name: z.literal("Tier 2 Synth"),
      index: z.literal(30),
      kind: z.literal("instrument"),
      volume: z.literal(1),
    }).strict(),
    midiClip: z.object({
      id: z.literal("tier2-midi-clip"),
      name: z.literal("Tier 2 Synth Clip"),
      startSec: z.literal(0),
      durationSec: z.literal(8),
      wave: z.literal("sawtooth"),
      notes: z.array(tierTwoNoteSchema).length(16),
    }).strict(),
    instrument: z.object({
      id: z.literal("tier2-instrument"),
      kind: z.literal("synth"),
      params: synthParamsSchema,
    }).strict(),
    effects: z.tuple([
      z.object({ id: z.literal("tier2-saturator"), index: z.literal(0), kind: z.literal("saturator"), params: saturatorParamsSchema }).strict(),
      z.object({ id: z.literal("tier2-utility"), index: z.literal(1), kind: z.literal("utility"), params: utilityParamsSchema }).strict(),
    ]),
    automation: z.object({
      effectKind: z.literal("saturator"),
      parameterId: z.literal("saturator.driveDb"),
      enabled: z.literal(true),
      points: z.tuple([
        z.object({ id: z.literal("tier2-saturator-drive-0"), timeSec: z.literal(0), value: z.literal(0), interpolation: z.literal("linear") }).strict(),
        z.object({ id: z.literal("tier2-saturator-drive-4"), timeSec: z.literal(4), value: z.literal(12), interpolation: z.literal("linear") }).strict(),
        z.object({ id: z.literal("tier2-saturator-drive-8"), timeSec: z.literal(8), value: z.literal(0), interpolation: z.literal("linear") }).strict(),
      ]),
    }).strict(),
  }).strict(),
  asset: z.object({
    name: z.literal("30-track-source.wav"),
    sourceKind: z.literal("recording"),
    durationSec: z.literal(thirtyTrackSourceDurationSec),
    sampleRate: z.literal(thirtyTrackSampleRate),
    channelCount: z.literal(2),
  }).strict(),
}).strict()

type DeepReadonly<Value> = Value extends object
  ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
  : Value

type ThirtyTrackSemanticManifest = DeepReadonly<z.infer<typeof semanticManifestSchema>>

const tuple = <Items extends readonly unknown[]>(...items: Items): Readonly<Items> => Object.freeze(items)

const tierTwoNotes: ThirtyTrackSemanticManifest["tier2"]["midiClip"]["notes"] = Object.freeze(
  Array.from({ length: 16 }, (_, beat) => {
    const pitch = tierTwoPitches[beat % tierTwoPitches.length]
    if (pitch === undefined) throw new Error(`Missing Tier 2 pitch at beat ${beat}.`)
    return Object.freeze({
      id: `tier2-note-${String(beat).padStart(2, "0")}`,
      beat,
      length: 0.75,
      pitch,
      velocity: 0.5,
    })
  }),
)

const tierTwoSynthParams = synthParamsSchema.parse(createDefaultSynthParams())
const tierTwoSaturatorParams = saturatorParamsSchema.parse(AUDIO_EFFECT_CONTRACTS.saturator.createDefaultParams())
const utilityDefaults = AUDIO_EFFECT_CONTRACTS.utility.createDefaultParams()
const tierTwoUtilityParams = utilityParamsSchema.parse({
  ...utilityDefaults,
  state: { ...utilityDefaults.state, gainDb: -12 },
})

export const thirtyTrackSemanticManifest: ThirtyTrackSemanticManifest = Object.freeze({
  fixtureVersion: thirtyTrackFixtureVersion,
  sampleRate: thirtyTrackSampleRate,
  projectName: thirtyTrackProjectName,
  source: Object.freeze({
    durationSec: thirtyTrackSourceDurationSec,
    channelCount: 2,
    channels: Object.freeze({
      left: Object.freeze({ components: tuple({ amplitude: 0.12, period: 240 }, { amplitude: 0.06, period: 60 }) }),
      right: Object.freeze({ components: tuple({ amplitude: 0.12, period: 160 }, { amplitude: 0.06, period: 40 }) }),
    }),
  }),
  timeline: Object.freeze({
    durationSec: thirtyTrackTimelineDurationSec,
    trackCount: thirtyTrackTotalTrackCount,
    clipCount: thirtyTrackTotalClipCount,
    clipDurationSec: thirtyTrackTimelineDurationSec,
    clipGain: thirtyTrackClipGain,
    sourceOffsetsSec: Object.freeze(Array.from({ length: thirtyTrackCount }, (_, index) => index)),
    colors: thirtyTrackColors,
    tracks: Object.freeze(Array.from({ length: thirtyTrackCount }, (_, index) => Object.freeze({
      index,
      name: benchmarkName(index),
      kind: "audio",
      volume: 1,
      color: colorAt(index),
    }))),
    clips: Object.freeze(Array.from({ length: thirtyTrackCount }, (_, index) => Object.freeze({
      index,
      name: `${benchmarkName(index)} Clip`,
      trackIndex: index,
      startSec: 0,
      durationSec: thirtyTrackTimelineDurationSec,
      sourceOffsetSec: index,
      gain: thirtyTrackClipGain,
      color: colorAt(index),
      sourceKind: "recording",
      sourceDurationSec: thirtyTrackSourceDurationSec,
      sourceSampleRate: thirtyTrackSampleRate,
      sourceChannelCount: 2,
    }))),
  }),
  tier2: Object.freeze({
    track: Object.freeze({ id: "tier2-track", name: "Tier 2 Synth", index: 30, kind: "instrument", volume: 1 }),
    midiClip: Object.freeze({
      id: "tier2-midi-clip",
      name: "Tier 2 Synth Clip",
      startSec: 0,
      durationSec: 8,
      wave: "sawtooth",
      notes: tierTwoNotes,
    }),
    instrument: Object.freeze({ id: "tier2-instrument", kind: "synth", params: tierTwoSynthParams }),
    effects: tuple(
      Object.freeze({ id: "tier2-saturator", index: 0, kind: "saturator", params: tierTwoSaturatorParams }),
      Object.freeze({ id: "tier2-utility", index: 1, kind: "utility", params: tierTwoUtilityParams }),
    ),
    automation: Object.freeze({
      effectKind: "saturator",
      parameterId: "saturator.driveDb",
      enabled: true,
      points: tuple(
        Object.freeze({ id: "tier2-saturator-drive-0", timeSec: 0, value: 0, interpolation: "linear" }),
        Object.freeze({ id: "tier2-saturator-drive-4", timeSec: 4, value: 12, interpolation: "linear" }),
        Object.freeze({ id: "tier2-saturator-drive-8", timeSec: 8, value: 0, interpolation: "linear" }),
      ),
    }),
  }),
  asset: Object.freeze({
    name: "30-track-source.wav",
    sourceKind: "recording",
    durationSec: thirtyTrackSourceDurationSec,
    sampleRate: thirtyTrackSampleRate,
    channelCount: 2,
  }),
})

const thirtyTrackFixtureGenerationResultSchema = z.object({
  semanticManifest: semanticManifestSchema,
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  tracks: z.literal(thirtyTrackTotalTrackCount),
  clips: z.literal(thirtyTrackTotalClipCount),
}).strict()
export const thirtyTrackFixtureBrowserOutputSchema = z.union([
  thirtyTrackFixtureGenerationResultSchema,
  z.object({ error: z.string().min(1) }).strict(),
])

export const triangle = (sampleIndex: number, period: number): number => (
  4 * (Math.abs(((sampleIndex % period) / period) - 0.5)) - 1
)

export const sampleThirtyTrackSource = (sampleIndex: number) => ({
  left: 0.12 * triangle(sampleIndex, 240) + 0.06 * triangle(sampleIndex, 60),
  right: 0.12 * triangle(sampleIndex, 160) + 0.06 * triangle(sampleIndex, 40),
})

// oxlint-disable-next-line anti-slop/no-unknown-parameters
const validateThirtyTrackSemanticManifest = (value: unknown): ThirtyTrackSemanticManifest => {
  const parsed = semanticManifestSchema.parse(value)
  if (parsed.timeline.sourceOffsetsSec.some((offset, index) => offset !== index)) {
    throw new Error("30-track fixture source offsets must be the integers 0 through 29.")
  }
  if (parsed.tier2.midiClip.notes.some((note, index) => (
    note.id !== `tier2-note-${String(index).padStart(2, "0")}`
    || note.beat !== index
    || note.pitch !== tierTwoPitches[index % tierTwoPitches.length]
  ))) {
    throw new Error("Tier 2 MIDI notes do not match the canonical sequence.")
  }
  return parsed
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const assertThirtyTrackSemanticManifest = (value: unknown): void => {
  validateThirtyTrackSemanticManifest(value)
}

export const thirtyTrackTrackAt = (index: number): ThirtyTrackSemanticManifest["timeline"]["tracks"][number] => {
  const track = thirtyTrackSemanticManifest.timeline.tracks[index]
  if (track === undefined) throw new Error(`Missing 30-track track at index ${index}.`)
  return track
}

export const thirtyTrackClipAt = (index: number): ThirtyTrackSemanticManifest["timeline"]["clips"][number] => {
  const clip = thirtyTrackSemanticManifest.timeline.clips[index]
  if (clip === undefined) throw new Error(`Missing 30-track clip at index ${index}.`)
  return clip
}
