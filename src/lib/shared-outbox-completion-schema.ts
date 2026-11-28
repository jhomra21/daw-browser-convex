import { AUDIO_EFFECT_KINDS, midiClipReadSchema } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import type { TrackAutomationSnapshot, TrackEffectSnapshot } from '~/lib/undo/types'
import { z } from 'zod'

export const finiteNumberSchema = z.number().refine(Number.isFinite)
const optionalFiniteNumberSchema = finiteNumberSchema.optional()

const clipFadesSchema = z.object({
  fadeInSec: finiteNumberSchema,
  fadeOutSec: finiteNumberSchema,
  fadeInCurve: finiteNumberSchema,
  fadeOutCurve: finiteNumberSchema,
})

const audioWarpSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['repitch', 'stretch']),
  sourceBpm: optionalFiniteNumberSchema,
  sourceBeatOffset: optionalFiniteNumberSchema,
  markers: z.array(z.object({
    id: z.string(),
    sourceBeat: finiteNumberSchema,
    timelineBeat: finiteNumberSchema,
  })).optional(),
}).optional()

const timelineClipSchema = z.object({
  id: z.string(),
  historyRef: z.string().optional(),
  name: z.string(),
  mediaStatus: z.enum(['missing', 'permission-denied']).optional(),
  startSec: finiteNumberSchema,
  duration: finiteNumberSchema,
  sourceAssetKey: z.string().optional(),
  waveformAssetKey: z.string().optional(),
  sourceKind: z.enum(['upload', 'url', 'recording']).optional(),
  sourceDurationSec: optionalFiniteNumberSchema,
  sourceSampleRate: optionalFiniteNumberSchema,
  sourceChannelCount: optionalFiniteNumberSchema,
  leftPadSec: optionalFiniteNumberSchema,
  bufferOffsetSec: optionalFiniteNumberSchema,
  audioWarp: audioWarpSchema,
  gain: optionalFiniteNumberSchema,
  fades: clipFadesSchema.optional(),
  color: z.string(),
  sampleUrl: z.string().optional(),
  midi: midiClipReadSchema.optional(),
  midiOffsetBeats: optionalFiniteNumberSchema,
})

const timelineTrackSchema = z.object({
  id: z.string(),
  historyRef: z.string().optional(),
  name: z.string(),
  volume: finiteNumberSchema,
  clips: z.array(timelineClipSchema),
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
  lockedBy: z.string().nullable().optional(),
  lockedAt: finiteNumberSchema.nullable().optional(),
  kind: z.enum(['audio', 'instrument']).optional(),
  channelRole: z.enum(['track', 'group', 'return']).optional(),
  groupId: z.string().optional(),
  collapsed: z.boolean().optional(),
  color: z.string().optional(),
  outputTargetId: z.string().optional(),
  sends: z.array(z.object({
    targetId: z.string(),
    amount: finiteNumberSchema,
    tap: z.enum(['pre-fx', 'pre-fader', 'post-fader']).optional(),
  })).optional(),
})

const automationEnvelopeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  target: z.union([
    z.object({ kind: z.literal('master') }),
    z.object({ kind: z.literal('track'), trackId: z.string() }),
  ]),
  targetKey: z.string(),
  parameterId: z.string(),
  enabled: z.boolean(),
  points: z.array(z.object({
    id: z.string(),
    timeSec: finiteNumberSchema,
    value: finiteNumberSchema,
    interpolation: z.enum(['linear', 'hold']),
  })),
  updatedAt: finiteNumberSchema,
})

const audioEffectSnapshotSchema = z.object({
  effect: z.enum(AUDIO_EFFECT_KINDS),
  instanceId: z.string().optional(),
  index: finiteNumberSchema.optional(),
  params: z.json(),
})

const trackEffectSnapshotSchema = z.object({
  eq: z.json().optional(),
  compressor: z.json().optional(),
  saturator: z.json().optional(),
  limiter: z.json().optional(),
  delay: z.json().optional(),
  reverb: z.json().optional(),
  spectral: z.json().optional(),
  audioEffects: z.array(audioEffectSnapshotSchema).optional(),
  synth: z.json().optional(),
  instrument: z.json().optional(),
  arp: z.json().optional(),
})

export const sharedOutboxCompletionSchema = z.object({
  kind: z.literal('tracks.ungroup'),
  tracks: z.array(z.custom<Track>((value) => timelineTrackSchema.safeParse(value).success)),
  groupTrack: z.custom<Track>((value) => timelineTrackSchema.safeParse(value).success),
  effects: z.custom<TrackEffectSnapshot>((value) => trackEffectSnapshotSchema.safeParse(value).success),
  automation: z.custom<TrackAutomationSnapshot>((value) => z.array(automationEnvelopeSchema).safeParse(value).success),
})
