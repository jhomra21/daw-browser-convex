import { z } from 'zod'
import {
  midiClipReadSchema,
  persistedProcessorSnapshotSchema,
} from '@daw-browser/shared'
import { CONTROL_API_VERSION_V1, CONTROL_API_VERSION_V2, controlLimitsV1 } from './versions'
import {
  audioWarpSchema,
  automationPointSchema,
  clipColorSchema,
  clipFadesSnapshotSchema,
  finiteNumberSchema,
  nameSchema,
  projectIdSchema,
  requestDigestSchema,
  secondsSchema,
  stableIdSchema,
  trackRoleSchema,
} from './primitives'

const persistedProcessorTargetSchema = z.union([
  z.object({ trackId: stableIdSchema }).strict(),
  z.object({ master: z.literal(true) }).strict(),
])
const externalProcessorSnapshotSchema = z.object({
  kind: z.literal('external-vst3'),
  params: z.object({
    identity: z.object({
      name: z.string().min(1).max(256),
      vendor: z.string().min(1).max(256),
      classId: z.string().min(1).max(256),
      role: z.enum(['effect', 'instrument']),
    }).strict(),
    bypassed: z.boolean(),
    parameterOverrides: z.record(
      z.string().regex(/^(0|[1-9]\d*)$/),
      finiteNumberSchema.min(0).max(1),
    ).superRefine((overrides, context) => {
      if (Object.keys(overrides).length > 16_384) {
        context.addIssue({ code: 'custom', message: 'External plugin parameter override limit exceeded.' })
      }
      for (const key of Object.keys(overrides)) {
        const id = Number(key)
        if (!Number.isSafeInteger(id) || id > 0xffff_ffff) {
          context.addIssue({ code: 'custom', message: 'External plugin parameter IDs must be unsigned 32-bit integers.' })
        }
      }
    }),
    parameters: z.array(z.object({
      id: z.number().int().min(0).max(0xffff_ffff),
      readOnly: z.boolean(),
    }).strict()).max(16_384).superRefine((parameters, context) => {
      const ids = parameters.map((parameter) => parameter.id)
      if (new Set(ids).size !== ids.length) {
        context.addIssue({ code: 'custom', message: 'External plugin parameter IDs must be unique.' })
      }
    }),
  }).strict(),
}).strict()
const controlProcessorSnapshotSchema = z.union([
  persistedProcessorSnapshotSchema,
  externalProcessorSnapshotSchema,
])
const snapshotTrackSchema = z.object({
  id: stableIdSchema,
  name: nameSchema,
  index: z.number().int().nonnegative(),
  kind: z.enum(['audio', 'instrument']),
  channelRole: trackRoleSchema,
  groupId: stableIdSchema.optional(),
  volume: finiteNumberSchema,
  muted: z.boolean(),
  soloed: z.boolean(),
  outputTargetId: stableIdSchema.optional(),
  sends: z.array(z.object({ targetTrackId: stableIdSchema, amount: finiteNumberSchema, tap: z.enum(['pre-fx', 'pre-fader', 'post-fader']).optional() }).strict()),
  collapsed: z.boolean(),
  color: clipColorSchema.optional(),
}).strict()
export const assetMimeTypeSchema = z.enum([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
])
export const assetSourceKindSchema = z.enum(["upload", "url", "recording"])
export const assetFolderSchemaV1 = z.object({
  id: stableIdSchema,
  name: nameSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
export const assetSnapshotSchemaV1 = z.object({
  id: stableIdSchema,
  name: nameSchema,
  sourceKind: assetSourceKindSchema,
  mimeType: assetMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(controlLimitsV1.maxAssetUploadBytes),
  contentSha256: requestDigestSchema,
  durationSec: secondsSchema.optional(),
  sampleRate: z.number().int().positive().optional(),
  channelCount: z.number().int().positive().max(64).optional(),
  folderId: stableIdSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
export const assetUploadResultSchemaV1 = z.object({
  asset: assetSnapshotSchemaV1,
  idempotencyReplay: z.boolean(),
}).strict()
export const assetFolderResultSchemaV1 = z.object({
  folder: assetFolderSchemaV1,
  applied: z.boolean(),
}).strict()
const snapshotMidiSchemaV1 = z.object({
  wave: z.string(),
  gain: finiteNumberSchema.optional(),
  notes: z.array(z.object({
    beat: finiteNumberSchema,
    length: finiteNumberSchema,
    pitch: finiteNumberSchema,
    velocity: finiteNumberSchema.optional(),
  }).strict()),
}).strict()
const snapshotClipSchemaV1 = z.object({
  id: stableIdSchema, trackId: stableIdSchema, name: nameSchema, startSec: secondsSchema,
  duration: finiteNumberSchema.positive(), gain: finiteNumberSchema.optional(),
  leftPadSec: secondsSchema,
  bufferOffsetSec: secondsSchema,
  midiOffsetBeats: secondsSchema,
  fades: clipFadesSnapshotSchema.optional(),
  color: clipColorSchema.optional(),
  audioWarp: audioWarpSchema.optional(),
  source: z.object({
    assetId: stableIdSchema,
    sourceKind: assetSourceKindSchema,
    durationSec: secondsSchema.optional(),
    sampleRate: z.number().int().positive().optional(),
    channelCount: z.number().int().positive().max(64).optional(),
  }).strict().optional(),
  midi: snapshotMidiSchemaV1.optional(),
}).strict()
export const projectSnapshotSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  project: z.object({
    id: projectIdSchema,
    name: nameSchema,
    revision: z.number().int().nonnegative(),
    tempoBpm: finiteNumberSchema,
    timeSignature: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }).strict(),
    loop: z.object({ enabled: z.boolean(), startSec: secondsSchema, endSec: secondsSchema }).strict(),
    masterVolume: finiteNumberSchema,
    updatedAt: z.number().int().nonnegative(),
  }).strict(),
  tracks: z.array(snapshotTrackSchema),
  clips: z.array(snapshotClipSchemaV1),
  processors: z.array(z.object({
    id: stableIdSchema,
    target: persistedProcessorTargetSchema,
    instanceId: stableIdSchema.optional(),
    index: z.number().int().nonnegative(),
    processor: controlProcessorSnapshotSchema,
  }).strict()),
  automation: z.array(z.object({
    target: persistedProcessorTargetSchema,
    effectInstanceId: stableIdSchema.optional(),
    parameterId: stableIdSchema,
    enabled: z.boolean(),
    points: z.array(automationPointSchema),
  }).strict()),
  sidechains: z.array(z.object({
    sourceTrackId: stableIdSchema,
    targetTrackId: stableIdSchema,
    effectInstanceId: stableIdSchema,
  }).strict()),
  assets: z.array(assetSnapshotSchemaV1).max(controlLimitsV1.maxAssetsPerSnapshot),
  assetFolders: z.array(assetFolderSchemaV1).max(controlLimitsV1.maxAssetFoldersPerSnapshot),
}).strict()
const snapshotClipSchemaV2 = snapshotClipSchemaV1.extend({
  midi: midiClipReadSchema.optional(),
}).strict()
export const projectSnapshotSchemaV2 = projectSnapshotSchemaV1.extend({
  version: z.literal(CONTROL_API_VERSION_V2),
  clips: z.array(snapshotClipSchemaV2),
}).strict()

export const canonicalProjectSnapshotSchema = projectSnapshotSchemaV2
export const projectSnapshotSchema = canonicalProjectSnapshotSchema

export const projectCanonicalProjectSnapshotV1 = (
  snapshot: ProjectSnapshotV2,
): ProjectSnapshotV1 => projectSnapshotSchemaV1.parse({
  ...snapshot,
  version: CONTROL_API_VERSION_V1,
  clips: snapshot.clips.map((clip) => ({
    ...clip,
    midi: clip.midi === undefined ? undefined : {
      wave: clip.midi.wave,
      gain: clip.midi.gain,
      notes: clip.midi.notes.map(({ beat, length, pitch, velocity }) => ({
        beat,
        length,
        pitch,
        velocity,
      })),
    },
  })),
})

export type ProjectSnapshotV1 = z.infer<typeof projectSnapshotSchemaV1>
export type ProjectSnapshotV2 = z.infer<typeof projectSnapshotSchemaV2>
export type AssetSnapshotV1 = z.infer<typeof assetSnapshotSchemaV1>
export type AssetFolderV1 = z.infer<typeof assetFolderSchemaV1>
export type AssetUploadResultV1 = z.infer<typeof assetUploadResultSchemaV1>
export type CanonicalProjectSnapshot = ProjectSnapshotV2
export type ProjectSnapshot = CanonicalProjectSnapshot
