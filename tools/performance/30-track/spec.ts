import { z } from "zod"

export const thirtyTrackFixtureVersion = "30-track-v1"
export const thirtyTrackSampleRate = 48_000
export const thirtyTrackSourceDurationSec = 90
export const thirtyTrackTimelineDurationSec = 60
export const thirtyTrackCount = 30
export const thirtyTrackClipGain = 0.1
export const thirtyTrackProjectName = "30 Track Performance v1"
export type ThirtyTrackFixtureVersion = typeof thirtyTrackFixtureVersion
export type ThirtyTrackColor = "#ff5f57" | "#febc2e" | "#28c840" | "#4da3ff" | "#a78bfa" | "#f472b6"
export const thirtyTrackColors: readonly ThirtyTrackColor[] = Object.freeze([
  "#ff5f57",
  "#febc2e",
  "#28c840",
  "#4da3ff",
  "#a78bfa",
  "#f472b6",
])

const benchmarkName = (index: number) => `Benchmark ${String(index + 1).padStart(2, "0")}`
const colorAt = (index: number): ThirtyTrackColor => {
  const color = thirtyTrackColors[index % thirtyTrackColors.length]
  if (color === undefined) throw new Error(`Missing 30-track color at index ${index}.`)
  return color
}

export type ThirtyTrackSemanticManifest = {
  readonly fixtureVersion: typeof thirtyTrackFixtureVersion
  readonly sampleRate: typeof thirtyTrackSampleRate
  readonly projectName: typeof thirtyTrackProjectName
  readonly source: {
    readonly durationSec: typeof thirtyTrackSourceDurationSec
    readonly channelCount: 2
    readonly channels: {
      readonly left: {
        readonly components: readonly [{ readonly amplitude: 0.12; readonly period: 240 }, { readonly amplitude: 0.06; readonly period: 60 }]
      }
      readonly right: {
        readonly components: readonly [{ readonly amplitude: 0.12; readonly period: 160 }, { readonly amplitude: 0.06; readonly period: 40 }]
      }
    }
  }
  readonly timeline: {
    readonly durationSec: typeof thirtyTrackTimelineDurationSec
    readonly trackCount: typeof thirtyTrackCount
    readonly clipCount: typeof thirtyTrackCount
    readonly clipDurationSec: typeof thirtyTrackTimelineDurationSec
    readonly clipGain: typeof thirtyTrackClipGain
    readonly sourceOffsetsSec: readonly number[]
    readonly colors: readonly ThirtyTrackColor[]
    readonly tracks: readonly {
      readonly index: number
      readonly name: string
      readonly kind: "audio"
      readonly volume: 1
      readonly color: ThirtyTrackColor
    }[]
    readonly clips: readonly {
      readonly index: number
      readonly name: string
      readonly trackIndex: number
      readonly startSec: 0
      readonly durationSec: typeof thirtyTrackTimelineDurationSec
      readonly sourceOffsetSec: number
      readonly gain: typeof thirtyTrackClipGain
      readonly color: ThirtyTrackColor
      readonly sourceKind: "recording"
      readonly sourceDurationSec: typeof thirtyTrackSourceDurationSec
      readonly sourceSampleRate: typeof thirtyTrackSampleRate
      readonly sourceChannelCount: 2
    }[]
  }
  readonly asset: {
    readonly name: "30-track-source.wav"
    readonly sourceKind: "recording"
    readonly durationSec: typeof thirtyTrackSourceDurationSec
    readonly sampleRate: typeof thirtyTrackSampleRate
    readonly channelCount: 2
  }
}

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
    trackCount: z.literal(thirtyTrackCount),
    clipCount: z.literal(thirtyTrackCount),
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
  asset: z.object({
    name: z.literal("30-track-source.wav"),
    sourceKind: z.literal("recording"),
    durationSec: z.literal(thirtyTrackSourceDurationSec),
    sampleRate: z.literal(thirtyTrackSampleRate),
    channelCount: z.literal(2),
  }).strict(),
}).strict()
export const thirtyTrackFixtureGenerationResultSchema = z.object({
  semanticManifest: semanticManifestSchema,
  projectId: z.string().min(1),
  assetId: z.string().min(1),
  tracks: z.number().int().nonnegative(),
  clips: z.number().int().nonnegative(),
}).strict()
export const thirtyTrackFixtureBrowserOutputSchema = z.union([
  thirtyTrackFixtureGenerationResultSchema,
  z.object({ error: z.string().min(1) }).strict(),
])

export const thirtyTrackSemanticManifest: ThirtyTrackSemanticManifest = Object.freeze({
  fixtureVersion: thirtyTrackFixtureVersion,
  sampleRate: thirtyTrackSampleRate,
  projectName: thirtyTrackProjectName,
  source: Object.freeze({
    durationSec: thirtyTrackSourceDurationSec,
    channelCount: 2,
    channels: Object.freeze({
      left: Object.freeze({ components: Object.freeze([{ amplitude: 0.12, period: 240 }, { amplitude: 0.06, period: 60 }]) }),
      right: Object.freeze({ components: Object.freeze([{ amplitude: 0.12, period: 160 }, { amplitude: 0.06, period: 40 }]) }),
    }),
  }),
  timeline: Object.freeze({
    durationSec: thirtyTrackTimelineDurationSec,
    trackCount: thirtyTrackCount,
    clipCount: thirtyTrackCount,
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
  asset: Object.freeze({
    name: "30-track-source.wav",
    sourceKind: "recording",
    durationSec: thirtyTrackSourceDurationSec,
    sampleRate: thirtyTrackSampleRate,
    channelCount: 2,
  }),
})

export const triangle = (sampleIndex: number, period: number): number => (
  4 * (Math.abs(((sampleIndex % period) / period) - 0.5)) - 1
)

export const sampleThirtyTrackSource = (sampleIndex: number) => ({
  left: 0.12 * triangle(sampleIndex, 240) + 0.06 * triangle(sampleIndex, 60),
  right: 0.12 * triangle(sampleIndex, 160) + 0.06 * triangle(sampleIndex, 40),
})

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const validateThirtyTrackSemanticManifest = (value: unknown): ThirtyTrackSemanticManifest => {
  const parsed = semanticManifestSchema.parse(value)
  if (parsed.timeline.sourceOffsetsSec.some((offset, index) => offset !== index)) {
    throw new Error("30-track fixture source offsets must be the integers 0 through 29.")
  }
  return parsed
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const assertThirtyTrackSemanticManifest = (value: unknown): void => {
  validateThirtyTrackSemanticManifest(value)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const assertThirtyTrackSemanticManifestExact = (value: unknown): void => {
  const parsed = validateThirtyTrackSemanticManifest(value)
  if (JSON.stringify(parsed) !== JSON.stringify(thirtyTrackSemanticManifest)) {
    throw new Error("30-track fixture semantics do not match the canonical manifest.")
  }
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
