import { z } from 'zod'
import {
  midiClipSchema,
  midiClipReadSchema,
  midiPerformanceEventCount,
  normalizeLegacyMidiClip,
  normalizeMidiClip,
  persistedProcessorSnapshotSchema,
  isJsonObject,
  type JsonValue,
  type NormalizedLegacyMidiClip,
  type NormalizedMidiClip,
} from '@daw-browser/shared'
import { controlLimitsV1 } from './versions'
import {
  clipColorSchema,
  finiteNumberSchema,
  nameSchema,
  projectIdSchema,
  requestDigestSchema,
  secondsSchema,
  stableIdSchema,
  trackColorSchema,
  trackRoleSchema,
} from './primitives'
import {
  assetMimeTypeSchema,
  assetSourceKindSchema,
} from './snapshots'
import { canonicalJson } from './serialization'

const recoveryPointSchemaV1 = z.object({
  id: stableIdSchema,
  timeSec: finiteNumberSchema,
  value: finiteNumberSchema,
  interpolation: z.enum(['linear', 'hold']),
}).strict()
const recoveryFadesSchemaV1 = z.object({
  fadeInStartSec: secondsSchema.optional(),
  fadeInSec: secondsSchema,
  fadeOutSec: secondsSchema,
  fadeOutEndSec: secondsSchema.optional(),
  fadeInCurve: finiteNumberSchema,
  fadeOutCurve: finiteNumberSchema,
  fadeInCurvePosition: finiteNumberSchema.optional(),
  fadeOutCurvePosition: finiteNumberSchema.optional(),
}).strict()
const recoveryAudioWarpSchemaV1 = z.object({
  enabled: z.boolean(),
  sourceBpm: finiteNumberSchema.min(30).max(300).optional(),
  sourceBeatOffset: finiteNumberSchema.optional(),
  markers: z.array(z.object({
    id: stableIdSchema,
    sourceBeat: finiteNumberSchema,
    timelineBeat: finiteNumberSchema,
  }).strict()).max(1_000).optional(),
  mode: z.enum(['repitch', 'stretch']),
}).strict()
const recoveryMidiSchemaV1 = z.object({
  wave: z.string(),
  gain: finiteNumberSchema.optional(),
  notes: z.array(z.object({
    beat: finiteNumberSchema,
    length: finiteNumberSchema.positive(),
    pitch: z.number().int().min(0).max(127),
    velocity: finiteNumberSchema.min(0).max(1).optional(),
  }).strict()),
}).strict()
const recoveryClipSchemaV1 = z.object({
  projectId: projectIdSchema,
  trackId: stableIdSchema,
  startSec: secondsSchema,
  duration: finiteNumberSchema.positive(),
  sourceAssetKey: stableIdSchema.optional(),
  sourceKind: assetSourceKindSchema.optional(),
  sourceDurationSec: secondsSchema.optional(),
  sourceSampleRate: z.number().int().positive().optional(),
  sourceChannelCount: z.number().int().positive().max(64).optional(),
  leftPadSec: secondsSchema.optional(),
  bufferOffsetSec: secondsSchema.optional(),
  audioWarp: recoveryAudioWarpSchemaV1.optional(),
  gain: finiteNumberSchema.optional(),
  fades: recoveryFadesSchemaV1.optional(),
  color: clipColorSchema.optional(),
  name: nameSchema.optional(),
  sampleUrl: z.string().min(1).max(2048).optional(),
  midi: recoveryMidiSchemaV1.optional(),
  midiOffsetBeats: finiteNumberSchema.optional(),
}).strict()
const cloudRecoveryOwnershipSchemaV1 = z.object({
  projectId: projectIdSchema,
  ownerUserId: stableIdSchema,
  role: z.enum(['owner', 'editor', 'viewer']).optional(),
}).strict()
const localRecoveryOwnershipSchemaV1 = z.object({
  projectId: projectIdSchema,
  localActorSubject: stableIdSchema,
}).strict()
const recoveryOwnershipSchemaV1 = z.union([
  cloudRecoveryOwnershipSchemaV1,
  localRecoveryOwnershipSchemaV1,
])
const cloudRecoveryAssetSchemaV1 = z.object({
  projectId: projectIdSchema,
  assetKey: stableIdSchema,
  sourceKind: assetSourceKindSchema,
  name: nameSchema,
  mimeType: assetMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(controlLimitsV1.maxAssetUploadBytes),
  contentSha256: requestDigestSchema,
  r2Key: z.string().min(1).max(2048),
  duration: secondsSchema.optional(),
  sampleRate: z.number().int().positive().optional(),
  channelCount: z.number().int().positive().max(64).optional(),
  ownerUserId: stableIdSchema,
  folderId: stableIdSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
const localRecoveryAssetSchemaV1 = z.object({
  projectId: projectIdSchema,
  assetKey: stableIdSchema,
  sourceKind: assetSourceKindSchema,
  name: nameSchema,
  mimeType: assetMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(controlLimitsV1.maxAssetUploadBytes),
  contentSha256: requestDigestSchema,
  storagePath: z.string().min(1).max(2048),
  duration: secondsSchema.optional(),
  sampleRate: z.number().int().positive().optional(),
  channelCount: z.number().int().positive().max(64).optional(),
  folderId: stableIdSchema.optional(),
  missing: z.boolean().optional(),
  originalFileName: z.string().min(1).max(1_024).optional(),
  originalLastModified: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()
const recoveryAssetSchemaV1 = z.union([
  cloudRecoveryAssetSchemaV1,
  localRecoveryAssetSchemaV1,
])
export type CloudRecoveryOwnershipV1 = z.infer<typeof cloudRecoveryOwnershipSchemaV1>
export type RecoveryOwnershipV1 = z.infer<typeof recoveryOwnershipSchemaV1>
export type CloudRecoveryAssetV1 = z.infer<typeof cloudRecoveryAssetSchemaV1>
export type RecoveryAssetV1 = z.infer<typeof recoveryAssetSchemaV1>
export const isCloudRecoveryOwnershipV1 = (
  ownership: RecoveryOwnershipV1,
): ownership is CloudRecoveryOwnershipV1 => 'ownerUserId' in ownership
export const isCloudRecoveryAssetV1 = (
  asset: RecoveryAssetV1,
): asset is CloudRecoveryAssetV1 => 'r2Key' in asset
const recoveryAutomationSchemaV1 = z.object({
  projectId: projectIdSchema,
  targetKind: z.enum(['track', 'master']),
  trackId: stableIdSchema.optional(),
  effectInstanceId: stableIdSchema.optional(),
  targetKey: stableIdSchema,
  parameterId: stableIdSchema,
  enabled: z.boolean(),
  points: z.array(recoveryPointSchemaV1).max(controlLimitsV1.maxRecoveryAutomationPoints),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((row, context) => {
  if (row.targetKind === 'track' && row.trackId === undefined) {
    context.addIssue({ code: 'custom', message: 'Track automation needs a track ID.', path: ['trackId'] })
  }
  if (row.targetKind === 'master' && row.trackId !== undefined) {
    context.addIssue({ code: 'custom', message: 'Master automation cannot carry a track ID.', path: ['trackId'] })
  }
})
const recoverySidechainSchemaV1 = z.object({
  projectId: projectIdSchema,
  sourceTrackId: stableIdSchema,
  targetTrackId: stableIdSchema,
  effectInstanceId: stableIdSchema,
}).strict()
const recoveryEffectSchemaV1 = z.object({
  projectId: projectIdSchema,
  target: z.union([
    z.object({ kind: z.literal('master') }).strict(),
    z.object({ kind: z.literal('track'), trackId: stableIdSchema }).strict(),
  ]),
  index: z.number().int().nonnegative(),
  processor: persistedProcessorSnapshotSchema,
  instanceId: stableIdSchema.optional(),
  createdAt: z.number().int().nonnegative(),
}).strict()
const recoveryEffectBundleSchemaV1 = z.object({
  effects: z.array(z.object({
    id: stableIdSchema,
    effect: recoveryEffectSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
  automation: z.array(z.object({ id: stableIdSchema, automation: recoveryAutomationSchemaV1 }).strict())
    .max(controlLimitsV1.maxRecoveryEntities),
  sidechains: z.array(z.object({ id: stableIdSchema, sidechain: recoverySidechainSchemaV1 }).strict())
    .max(controlLimitsV1.maxRecoveryEntities),
}).strict()
const recoveryTrackStateSchemaV1 = z.object({
  projectId: projectIdSchema,
  name: nameSchema,
  index: z.number().int().nonnegative(),
  kind: z.enum(['audio', 'instrument']).optional(),
  historyRef: stableIdSchema.optional(),
  groupId: stableIdSchema.optional(),
  collapsed: z.boolean().optional(),
  color: trackColorSchema.optional(),
  mixer: z.object({
    volume: finiteNumberSchema.min(0).max(2),
    muted: z.boolean().optional(),
    soloed: z.boolean().optional(),
    channelRole: trackRoleSchema,
    outputTargetId: stableIdSchema.optional(),
    sends: z.array(z.object({
      targetId: stableIdSchema,
      amount: finiteNumberSchema.min(0).max(2),
      tap: z.enum(['pre-fx', 'pre-fader', 'post-fader']).optional(),
    }).strict()).max(controlLimitsV1.maxRecoverySends),
  }).strict(),
}).strict()
const recoveryTrackSchemaV1 = z.object({
  id: stableIdSchema,
  track: recoveryTrackStateSchemaV1,
  ownership: recoveryOwnershipSchemaV1,
}).strict()
const recoveryClipBundleSchemaV1 = z.object({
  id: stableIdSchema,
  clip: recoveryClipSchemaV1,
  ownership: recoveryOwnershipSchemaV1,
}).strict()
const recoveryTrackEntityBundleSchemaV1 = z.object({
  tracks: z.array(recoveryTrackSchemaV1).min(1).max(controlLimitsV1.maxRecoveryEntities),
  clips: z.array(recoveryClipBundleSchemaV1).max(controlLimitsV1.maxRecoveryEntities),
  effects: recoveryEffectBundleSchemaV1['shape'].effects,
  automation: recoveryEffectBundleSchemaV1['shape'].automation,
  sidechains: recoveryEffectBundleSchemaV1['shape'].sidechains,
}).strict().superRefine((data, context) => {
  const entities = data.tracks.length + data.clips.length + data.effects.length + data.automation.length + data.sidechains.length
  const notes = data.clips.reduce((total, entry) => total + (entry.clip.midi ? midiPerformanceEventCount(entry.clip.midi) : 0), 0)
  const points = data.automation.reduce((total, entry) => total + entry.automation.points.length, 0)
  const warpMarkers = data.clips.reduce((total, entry) => total + (entry.clip.audioWarp?.markers?.length ?? 0), 0)
  const sends = data.tracks.reduce((total, entry) => total + entry.track.mixer.sends.length, 0)
  if (entities > controlLimitsV1.maxRecoveryEntities) context.addIssue({ code: 'custom', message: 'Recovery entity limit exceeded.' })
  if (entities > controlLimitsV1.maxRecoveryMappings) context.addIssue({ code: 'custom', message: 'Recovery mapping limit exceeded.' })
  if (notes > controlLimitsV1.maxRecoveryMidiNotes) context.addIssue({ code: 'custom', message: 'Recovery MIDI note limit exceeded.' })
  if (points > controlLimitsV1.maxRecoveryAutomationPoints) context.addIssue({ code: 'custom', message: 'Recovery automation point limit exceeded.' })
  if (warpMarkers > controlLimitsV1.maxRecoveryWarpMarkers) context.addIssue({ code: 'custom', message: 'Recovery warp marker limit exceeded.' })
  if (sends > controlLimitsV1.maxRecoverySends) context.addIssue({ code: 'custom', message: 'Recovery send limit exceeded.' })
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Recovery IDs must be unique.', path })
  }
  unique(data.tracks.map((entry) => entry.id), ['tracks'])
  unique(data.clips.map((entry) => entry.id), ['clips'])
  unique(data.effects.map((entry) => entry.id), ['effects'])
  unique(data.automation.map((entry) => entry.id), ['automation'])
  unique(data.sidechains.map((entry) => entry.id), ['sidechains'])
  const trackIds = new Set(data.tracks.map((entry) => entry.id))
  for (const [index, entry] of data.tracks.entries()) {
    if (entry.track.groupId && !trackIds.has(entry.track.groupId)) continue
    if (entry.track.mixer.outputTargetId && !trackIds.has(entry.track.mixer.outputTargetId)) continue
    if (entry.ownership.projectId !== entry.track.projectId) {
      context.addIssue({ code: 'custom', message: 'Track ownership must belong to its project.', path: ['tracks', index, 'ownership'] })
    }
  }
  for (const [index, entry] of data.clips.entries()) {
    if (!trackIds.has(entry.clip.trackId)) {
      context.addIssue({ code: 'custom', message: 'Recovered clips must belong to recovered tracks.', path: ['clips', index, 'clip', 'trackId'] })
    }
  }
})
const recoveryTrackStateTransitionsSchemaV1 = z.array(z.object({
    id: stableIdSchema,
    before: recoveryTrackStateSchemaV1,
    after: recoveryTrackStateSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities)
const recoveryTrackDeleteSchemaV1 = recoveryTrackEntityBundleSchemaV1.extend({
  rootTrackId: stableIdSchema,
  survivors: recoveryTrackStateTransitionsSchemaV1,
}).strict().superRefine((data, context) => {
  if (!data.tracks.some((track) => track.id === data.rootTrackId)) {
    context.addIssue({ code: 'custom', message: 'Deleted root must be captured.', path: ['rootTrackId'] })
  }
  const trackIds = new Set(data.tracks.map((entry) => entry.id))
  const survivorIds = data.survivors.map((entry) => entry.id)
  if (new Set(survivorIds).size !== survivorIds.length || survivorIds.some((id) => trackIds.has(id))) {
    context.addIssue({ code: 'custom', message: 'Recovery survivor IDs must be unique and distinct from deleted tracks.', path: ['survivors'] })
  }
})
const recoveryUngroupSchemaV1 = recoveryTrackEntityBundleSchemaV1.extend({
  groupId: stableIdSchema,
  children: recoveryTrackStateTransitionsSchemaV1,
}).strict().superRefine((data, context) => {
  if (data.tracks.length !== 1 || data.tracks[0]?.id !== data.groupId) {
    context.addIssue({ code: 'custom', message: 'Ungroup recovery must capture exactly its group.', path: ['groupId'] })
  }
  const ids = data.children.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Ungroup children must be unique.', path: ['children'] })
})
export const recoveryPayloadSchemaV1 = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('clip.delete'), data: z.object({
    clip: recoveryClipSchemaV1, clipId: stableIdSchema, ownership: recoveryOwnershipSchemaV1,
  }).strict() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('asset.delete'), data: z.object({
    asset: recoveryAssetSchemaV1, assetId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('automation.delete'), data: z.object({
    automation: recoveryAutomationSchemaV1, automationId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('sidechain.remove'), data: z.object({
    sidechain: recoverySidechainSchemaV1, sidechainId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('effect.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('instrument.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('arpeggiator.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('track.delete'), data: recoveryTrackDeleteSchemaV1 }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('track.ungroup'), data: recoveryUngroupSchemaV1 }).strict(),
])
export type RecoveryPayloadV1 = z.infer<typeof recoveryPayloadSchemaV1>

const recoveryClipSchemaV2 = recoveryClipSchemaV1.extend({
  historyRef: stableIdSchema.optional(),
  midi: midiClipSchema.optional(),
}).strict()
const recoveryClipBundleSchemaV2 = recoveryClipBundleSchemaV1.extend({
  clip: recoveryClipSchemaV2,
}).strict()
const recoveryTrackEntityBundleSchemaV2 = recoveryTrackEntityBundleSchemaV1.safeExtend({
  clips: z.array(recoveryClipBundleSchemaV2).max(controlLimitsV1.maxRecoveryEntities),
}).strict()
const recoveryTrackDeleteSchemaV2 = recoveryTrackEntityBundleSchemaV2.safeExtend({
  rootTrackId: stableIdSchema,
  survivors: recoveryTrackStateTransitionsSchemaV1,
}).strict()
const recoveryUngroupSchemaV2 = recoveryTrackEntityBundleSchemaV2.safeExtend({
  groupId: stableIdSchema,
  children: recoveryTrackStateTransitionsSchemaV1,
}).strict()
const validateRecoveryRangeDataV2 = (
  data: {
    range: { trackIds: string[] }
    deletedClips: Array<{ id: string; before: { trackId: string } }>
    updatedClips: Array<{ id: string; before: { trackId: string } }>
    createdClips: Array<{ id: string }>
    automation: Array<{ id: string; before: { points: unknown[] } }>
  },
  context: z.RefinementCtx,
) => {
  const entities = data.deletedClips.length + data.updatedClips.length + data.createdClips.length + data.automation.length
  const points = data.automation.reduce((total, entry) => total + entry.before.points.length, 0)
  if (entities > controlLimitsV1.maxRecoveryEntities) context.addIssue({ code: 'custom', message: 'Recovery entity limit exceeded.' })
  if (points > controlLimitsV1.maxRecoveryAutomationPoints) context.addIssue({ code: 'custom', message: 'Recovery automation point limit exceeded.' })
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Recovery IDs must be unique.', path })
  }
  unique(data.range.trackIds, ['range', 'trackIds'])
  unique(data.deletedClips.map((entry) => entry.id), ['deletedClips'])
  unique(data.updatedClips.map((entry) => entry.id), ['updatedClips'])
  unique(data.createdClips.map((entry) => entry.id), ['createdClips'])
  unique(data.automation.map((entry) => entry.id), ['automation'])
  const deletedIds = new Set(data.deletedClips.map((entry) => entry.id))
  if (data.updatedClips.some((entry) => deletedIds.has(entry.id))) {
    context.addIssue({ code: 'custom', message: 'Range recovery clip deletes and updates must be distinct.', path: ['updatedClips'] })
  }
  const trackIds = new Set(data.range.trackIds)
  if (
    data.deletedClips.some((entry) => !trackIds.has(entry.before.trackId))
    || data.updatedClips.some((entry) => !trackIds.has(entry.before.trackId))
  ) {
    context.addIssue({ code: 'custom', message: 'Range recovery clips must belong to selected tracks.' })
  }
}
const recoveryRangeDataSchemaV2 = z.object({
  range: z.object({
    trackIds: z.array(stableIdSchema).min(1).max(controlLimitsV1.maxRecoveryEntities),
    startSec: secondsSchema,
    endSec: secondsSchema,
  }).strict().refine((range) => range.endSec > range.startSec, 'Range end must be after range start.'),
  deletedClips: z.array(z.object({
    id: stableIdSchema,
    before: recoveryClipSchemaV2,
    ownership: recoveryOwnershipSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
  updatedClips: z.array(z.object({
    id: stableIdSchema,
    before: recoveryClipSchemaV2,
    expectedAfterDigest: requestDigestSchema,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
  createdClips: z.array(z.object({
    id: stableIdSchema,
    expectedAfterDigest: requestDigestSchema,
    expectedOwnershipDigest: requestDigestSchema,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
  automation: z.array(z.object({
    id: stableIdSchema,
    before: recoveryAutomationSchemaV1,
    expectedAfterDigest: requestDigestSchema,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
}).strict().superRefine(validateRecoveryRangeDataV2)
export const recoveryPayloadSchemaV2 = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(2), kind: z.literal('clip.delete'), data: z.object({
    clip: recoveryClipSchemaV2, clipId: stableIdSchema, ownership: recoveryOwnershipSchemaV1,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('asset.delete'), data: z.object({
    asset: recoveryAssetSchemaV1, assetId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('automation.delete'), data: z.object({
    automation: recoveryAutomationSchemaV1, automationId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('sidechain.remove'), data: z.object({
    sidechain: recoverySidechainSchemaV1, sidechainId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('effect.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('instrument.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('arpeggiator.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('track.delete'), data: recoveryTrackDeleteSchemaV2 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('track.ungroup'), data: recoveryUngroupSchemaV2 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('timeline.range.delete'), data: recoveryRangeDataSchemaV2 }).strict(),
])
export type RecoveryPayloadV2 = z.infer<typeof recoveryPayloadSchemaV2>
const recoveryCapturedClipSchemaV2 = recoveryClipSchemaV1.extend({
  historyRef: stableIdSchema.optional(),
  midi: midiClipReadSchema.optional(),
}).strict()
const recoveryCapturedClipBundleSchemaV2 = recoveryClipBundleSchemaV1.extend({
  clip: recoveryCapturedClipSchemaV2,
}).strict()
const validateCapturedRecoveryTrackEntityBundle = (
  data: {
    tracks: Array<{ id: string; track: { projectId: string; groupId?: string; mixer: { outputTargetId?: string; sends: unknown[] } }; ownership: { projectId: string } }>
    clips: Array<{ id: string; clip: { trackId: string; audioWarp?: { markers?: unknown[] } } }>
    effects: Array<{ id: string }>
    automation: Array<{ id: string; automation: { points: unknown[] } }>
    sidechains: Array<{ id: string }>
  },
  context: z.RefinementCtx,
) => {
  const entities = data.tracks.length + data.clips.length + data.effects.length + data.automation.length + data.sidechains.length
  const points = data.automation.reduce((total, entry) => total + entry.automation.points.length, 0)
  const warpMarkers = data.clips.reduce((total, entry) => total + (entry.clip.audioWarp?.markers?.length ?? 0), 0)
  const sends = data.tracks.reduce((total, entry) => total + entry.track.mixer.sends.length, 0)
  if (entities > controlLimitsV1.maxRecoveryEntities) context.addIssue({ code: 'custom', message: 'Recovery entity limit exceeded.' })
  if (entities > controlLimitsV1.maxRecoveryMappings) context.addIssue({ code: 'custom', message: 'Recovery mapping limit exceeded.' })
  if (points > controlLimitsV1.maxRecoveryAutomationPoints) context.addIssue({ code: 'custom', message: 'Recovery automation point limit exceeded.' })
  if (warpMarkers > controlLimitsV1.maxRecoveryWarpMarkers) context.addIssue({ code: 'custom', message: 'Recovery warp marker limit exceeded.' })
  if (sends > controlLimitsV1.maxRecoverySends) context.addIssue({ code: 'custom', message: 'Recovery send limit exceeded.' })
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'Recovery IDs must be unique.', path })
  }
  unique(data.tracks.map((entry) => entry.id), ['tracks'])
  unique(data.clips.map((entry) => entry.id), ['clips'])
  unique(data.effects.map((entry) => entry.id), ['effects'])
  unique(data.automation.map((entry) => entry.id), ['automation'])
  unique(data.sidechains.map((entry) => entry.id), ['sidechains'])
  const trackIds = new Set(data.tracks.map((entry) => entry.id))
  for (const [index, entry] of data.tracks.entries()) {
    if (entry.track.groupId && !trackIds.has(entry.track.groupId)) continue
    if (entry.track.mixer.outputTargetId && !trackIds.has(entry.track.mixer.outputTargetId)) continue
    if (entry.ownership.projectId !== entry.track.projectId) {
      context.addIssue({ code: 'custom', message: 'Track ownership must belong to its project.', path: ['tracks', index, 'ownership'] })
    }
  }
  for (const [index, entry] of data.clips.entries()) {
    if (!trackIds.has(entry.clip.trackId)) {
      context.addIssue({ code: 'custom', message: 'Recovered clips must belong to recovered tracks.', path: ['clips', index, 'clip', 'trackId'] })
    }
  }
}
const recoveryCapturedTrackEntityBundleSchemaV2 = z.object({
  ...recoveryTrackEntityBundleSchemaV1['shape'],
  clips: z.array(recoveryCapturedClipBundleSchemaV2).max(controlLimitsV1.maxRecoveryEntities),
}).strict().superRefine(validateCapturedRecoveryTrackEntityBundle)
const recoveryCapturedTrackDeleteSchemaV2 = recoveryCapturedTrackEntityBundleSchemaV2.extend({
  rootTrackId: stableIdSchema,
  survivors: recoveryTrackStateTransitionsSchemaV1,
}).strict().superRefine((data, context) => {
  if (!data.tracks.some((track) => track.id === data.rootTrackId)) {
    context.addIssue({ code: 'custom', message: 'Deleted root must be captured.', path: ['rootTrackId'] })
  }
  const trackIds = new Set(data.tracks.map((entry) => entry.id))
  const survivorIds = data.survivors.map((entry) => entry.id)
  if (new Set(survivorIds).size !== survivorIds.length || survivorIds.some((id) => trackIds.has(id))) {
    context.addIssue({ code: 'custom', message: 'Recovery survivor IDs must be unique and distinct from deleted tracks.', path: ['survivors'] })
  }
})
const recoveryCapturedUngroupSchemaV2 = recoveryCapturedTrackEntityBundleSchemaV2.extend({
  groupId: stableIdSchema,
  children: recoveryTrackStateTransitionsSchemaV1,
}).strict().superRefine((data, context) => {
  if (data.tracks.length !== 1 || data.tracks[0]?.id !== data.groupId) {
    context.addIssue({ code: 'custom', message: 'Ungroup recovery must capture exactly its group.', path: ['groupId'] })
  }
  const ids = data.children.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Ungroup children must be unique.', path: ['children'] })
})
const recoveryCapturedRangeDataSchemaV2 = z.object({
  ...recoveryRangeDataSchemaV2['shape'],
  deletedClips: z.array(z.object({
    id: stableIdSchema,
    before: recoveryCapturedClipSchemaV2,
    ownership: recoveryOwnershipSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
  updatedClips: z.array(z.object({
    id: stableIdSchema,
    before: recoveryCapturedClipSchemaV2,
    expectedAfterDigest: requestDigestSchema,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
}).strict().superRefine(validateRecoveryRangeDataV2)
export const recoveryCapturedPayloadSchemaV2 = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(2), kind: z.literal('clip.delete'), data: z.object({
    clip: recoveryCapturedClipSchemaV2, clipId: stableIdSchema, ownership: recoveryOwnershipSchemaV1,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('asset.delete'), data: z.object({
    asset: recoveryAssetSchemaV1, assetId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('automation.delete'), data: z.object({
    automation: recoveryAutomationSchemaV1, automationId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('sidechain.remove'), data: z.object({
    sidechain: recoverySidechainSchemaV1, sidechainId: stableIdSchema,
  }).strict() }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('effect.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('instrument.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('arpeggiator.remove'), data: recoveryEffectBundleSchemaV1 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('track.delete'), data: recoveryCapturedTrackDeleteSchemaV2 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('track.ungroup'), data: recoveryCapturedUngroupSchemaV2 }).strict(),
  z.object({ version: z.literal(2), kind: z.literal('timeline.range.delete'), data: recoveryCapturedRangeDataSchemaV2 }).strict(),
])
export type CapturedRecoveryPayloadV2 = z.infer<typeof recoveryCapturedPayloadSchemaV2>
export type RecoveryPayloadWire = RecoveryPayloadV1 | RecoveryPayloadV2
export type RecoveryPayload = CapturedRecoveryPayloadV2

const normalizeRecoveryClipMidi = <Clip extends { midi?: JsonValue }>(
  clip: Clip,
  normalizeMidi: (value: JsonValue) => NormalizedMidiClip | NormalizedLegacyMidiClip,
) => (
  clip.midi === undefined ? clip : { ...clip, midi: normalizeMidi(clip.midi) }
)

export const normalizeRecoveryPayloadV1 = (
  payload: RecoveryPayloadV1,
  normalizeMidi = normalizeLegacyMidiClip,
): RecoveryPayload => {
  if (payload.kind === 'clip.delete') {
    return {
      ...payload,
      version: 2,
      data: { ...payload.data, clip: normalizeRecoveryClipMidi(payload.data.clip, normalizeMidi) },
    }
  }
  if (payload.kind === 'track.delete') {
    return {
      version: 2,
      kind: 'track.delete',
      data: {
        ...payload.data,
        clips: payload.data.clips.map((entry) => ({
          ...entry,
          clip: normalizeRecoveryClipMidi(entry.clip, normalizeMidi),
        })),
      },
    }
  }
  if (payload.kind === 'track.ungroup') {
    return {
      version: 2,
      kind: 'track.ungroup',
      data: {
        ...payload.data,
        clips: payload.data.clips.map((entry) => ({
          ...entry,
          clip: normalizeRecoveryClipMidi(entry.clip, normalizeMidi),
        })),
      },
    }
  }
  return { ...payload, version: 2 }
}
export const normalizeRecoveryPayloadV2 = (
  payload: RecoveryPayloadV2,
  normalizeMidi = normalizeMidiClip,
): RecoveryPayload => {
  if (payload.kind === 'clip.delete') {
    return recoveryPayloadSchemaV2.parse({
      ...payload,
      data: { ...payload.data, clip: normalizeRecoveryClipMidi(payload.data.clip, normalizeMidi) },
    })
  }
  if (payload.kind === 'track.delete' || payload.kind === 'track.ungroup') {
    return recoveryPayloadSchemaV2.parse({
      ...payload,
      data: {
        ...payload.data,
        clips: payload.data.clips.map((entry) => ({
          ...entry,
          clip: normalizeRecoveryClipMidi(entry.clip, normalizeMidi),
        })),
      },
    })
  }
  if (payload.kind === 'timeline.range.delete') {
    return recoveryPayloadSchemaV2.parse({
      ...payload,
      data: {
        ...payload.data,
        deletedClips: payload.data.deletedClips.map((entry) => ({
          ...entry,
          before: normalizeRecoveryClipMidi(entry.before, normalizeMidi),
        })),
        updatedClips: payload.data.updatedClips.map((entry) => ({
          ...entry,
          before: normalizeRecoveryClipMidi(entry.before, normalizeMidi),
        })),
      },
    })
  }
  return payload
}
export const normalizeCapturedRecoveryPayloadV2 = (
  payload: CapturedRecoveryPayloadV2,
): CapturedRecoveryPayloadV2 => {
  if (payload.kind === 'clip.delete') {
    return recoveryCapturedPayloadSchemaV2.parse({
      ...payload,
      data: { ...payload.data, clip: normalizeRecoveryClipMidi(payload.data.clip, normalizeLegacyMidiClip) },
    })
  }
  if (payload.kind === 'track.delete' || payload.kind === 'track.ungroup') {
    return recoveryCapturedPayloadSchemaV2.parse({
      ...payload,
      data: {
        ...payload.data,
        clips: payload.data.clips.map((entry) => ({
          ...entry,
          clip: normalizeRecoveryClipMidi(entry.clip, normalizeLegacyMidiClip),
        })),
      },
    })
  }
  if (payload.kind === 'timeline.range.delete') {
    return recoveryCapturedPayloadSchemaV2.parse({
      ...payload,
      data: {
        ...payload.data,
        deletedClips: payload.data.deletedClips.map((entry) => ({
          ...entry,
          before: normalizeRecoveryClipMidi(entry.before, normalizeLegacyMidiClip),
        })),
        updatedClips: payload.data.updatedClips.map((entry) => ({
          ...entry,
          before: normalizeRecoveryClipMidi(entry.before, normalizeLegacyMidiClip),
        })),
      },
    })
  }
  return payload
}

export const recoveryPayloadBytesV1 = (payload: string) => new TextEncoder().encode(payload).byteLength
export const parseRecoveryPayload = (payload: string): RecoveryPayload => {
  if (recoveryPayloadBytesV1(payload) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  const parsed: JsonValue = JSON.parse(payload)
  if (!isJsonObject(parsed) || !('version' in parsed)) {
    throw new Error('Recovery payload version is invalid.')
  }
  const validated = parsed.version === 1
    ? recoveryPayloadSchemaV1.parse(parsed)
    : parsed.version === 2
      ? recoveryPayloadSchemaV2.parse(parsed)
      : (() => { throw new Error('Recovery payload version is invalid.') })()
  if (canonicalJson(validated) !== payload) throw new Error('Recovery payload is not canonical.')
  return validated.version === 1 ? normalizeRecoveryPayloadV1(validated) : normalizeRecoveryPayloadV2(validated)
}
export const parseCapturedRecoveryPayload = (payload: string): RecoveryPayload => {
  if (recoveryPayloadBytesV1(payload) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  const parsed: JsonValue = JSON.parse(payload)
  if (!isJsonObject(parsed) || !('version' in parsed) || parsed.version !== 2) {
    throw new Error('Recovery payload version is invalid.')
  }
  const validated = recoveryCapturedPayloadSchemaV2.parse(parsed)
  if (canonicalJson(validated) !== payload) throw new Error('Recovery payload is not canonical.')
  return normalizeCapturedRecoveryPayloadV2(validated)
}
/**
 * Parses a recovery payload that was already committed to durable storage.
 * Integrity callers must hash the original text before calling this function:
 * the V1 representation is intentionally normalized only after its exact
 * stored bytes have been schema-validated and canonicality-checked.
 */
export const parseStoredRecoveryPayload = (payload: string): RecoveryPayload => {
  if (recoveryPayloadBytesV1(payload) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  const parsed: JsonValue = JSON.parse(payload)
  if (!isJsonObject(parsed) || !('version' in parsed)) {
    throw new Error('Recovery payload version is invalid.')
  }
  if (parsed.version === 1) {
    const validated = recoveryPayloadSchemaV1.parse(parsed)
    if (canonicalJson(validated) !== payload) throw new Error('Recovery payload is not canonical.')
    return normalizeRecoveryPayloadV1(validated)
  }
  if (parsed.version === 2) return parseCapturedRecoveryPayload(payload)
  throw new Error('Recovery payload version is invalid.')
}
export const canonicalRecoveryPayloadV1 = (payload: RecoveryPayloadV1) => {
  const canonical = canonicalJson(recoveryPayloadSchemaV1.parse(payload))
  if (recoveryPayloadBytesV1(canonical) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  return canonical
}
export const canonicalRecoveryPayloadV2 = (payload: RecoveryPayloadV2) => {
  const canonical = canonicalJson(normalizeRecoveryPayloadV2(recoveryPayloadSchemaV2.parse(payload)))
  if (recoveryPayloadBytesV1(canonical) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  return canonical
}
export const canonicalCapturedRecoveryPayloadV2 = (payload: CapturedRecoveryPayloadV2) => {
  const canonical = canonicalJson(normalizeCapturedRecoveryPayloadV2(recoveryCapturedPayloadSchemaV2.parse(payload)))
  if (recoveryPayloadBytesV1(canonical) > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Recovery payload exceeds the serialized body limit.')
  }
  return canonical
}
