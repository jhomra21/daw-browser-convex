import { z } from 'zod'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  projectControlSnapshotCoreV1,
  projectControlSnapshotCoreV2,
  type ControlProjectSnapshotInput,
} from './projection'
import { recoveryLimitsV1 } from './recovery-limits'
import {
  audioEffectAddPayloadSchema,
  arpeggiatorParamsSchema,
  instrumentAddPayloadSchema,
  midiClipSchema,
  midiClipReadSchema,
  midiPerformanceEventCount,
  normalizeLegacyMidiClip,
  normalizeMidiClip,
  persistedProcessorSnapshotSchema,
  type NormalizedLegacyMidiClip,
  type NormalizedMidiClip,
} from '@daw-browser/shared'
export { normalizeControlMidiActionV1, resolveControlMidiActionV1 } from './midi'
export { buildTimelineRangeDeletePatchV1, type TimelineRangeDeletePatchV1 } from './timeline-range-delete'

export const CONTROL_API_VERSION_V1 = 'v1'
export const CONTROL_API_VERSION_V2 = 'v2'

const stableIdSchema = z.string().min(1).max(256)
const hasAsciiControlCharacter = (value: string) => (
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
)
const projectIdSchema = stableIdSchema.refine(
  (projectId) => (
    projectId !== '.'
    && projectId !== '..'
    && !hasAsciiControlCharacter(projectId)
    && !/[/\\?#]|%(?:[01][0-9a-f]|7f|2f|5c|3f|23)/i.test(projectId)
  ),
  'Project IDs must be opaque URL-safe identifiers.',
)
const clientRefValueSchema = z.string().min(1).max(256)
const nameSchema = z.string().trim().min(1).max(120)
const finiteNumberSchema = z.number().finite()
const secondsSchema = finiteNumberSchema.min(0)
const trackColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
const clipColorSchema = z.union([
  trackColorSchema,
  z.literal('clip-audio'),
  z.literal('clip-midi'),
  z.literal('clip-recording'),
])
const trackRoleSchema = z.enum(['track', 'group', 'return'])
const revisionSchema = z.number().int().nonnegative()
const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Request digest must be a lowercase SHA-256 hex digest.')
export const approvalTokenSchemaV1 = z.string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Approval tokens must be URL-safe opaque values.')
const opaqueCursorSchema = z.string()
  .min(1)
  .max(2_048)
  .regex(/^[\x20-\x7e]+$/, 'Cursor must contain printable ASCII characters only.')

export const controlLimitsV1 = {
  maxActions: 100,
  maxSerializedBodyBytes: 256 * 1024,
  maxRecoveryEntities: recoveryLimitsV1.maxEntities,
  maxRecoveryMappings: recoveryLimitsV1.maxMappings,
  maxRecoveryMidiNotes: recoveryLimitsV1.maxMidiNotes,
  maxRecoveryAutomationPoints: recoveryLimitsV1.maxAutomationPoints,
  maxRecoveryWarpMarkers: recoveryLimitsV1.maxWarpMarkers,
  maxRecoverySends: recoveryLimitsV1.maxSends,
  maxAssetsPerSnapshot: 1_000,
  maxAssetFoldersPerSnapshot: 500,
  maxAssetUploadBytes: 10 * 1024 * 1024,
  maxMidiNotesPerCommit: 500,
  maxAutomationPointsPerCommit: 1000,
  maxErrorDetails: 16,
  defaultHistoryPageSize: 50,
  maxHistoryPageSize: 100,
  defaultRecoveryPageSize: 50,
  maxRecoveryPageSize: 100,
}
export const controlLimitsV2 = {
  ...controlLimitsV1,
  maxMidiPerformanceEventsPerCommit: 500,
  maxMidiPerformanceEventsPerClip: 500,
  maxMidiEventsPerArray: 500,
  maxMidiMappingsPerClip: 64,
}

export const stableIdSchemaV1 = stableIdSchema
export const projectIdSchemaV1 = projectIdSchema
export const clientRefSchemaV1 = clientRefValueSchema
export const contextualRefSchemaV1 = z.discriminatedUnion('source', [
  z.object({ source: z.literal('persisted'), id: stableIdSchema }).strict(),
  z.object({ source: z.literal('client'), clientRef: clientRefValueSchema }).strict(),
])
export const trackRefSchemaV1 = contextualRefSchemaV1.describe('Track reference')
export const clipRefSchemaV1 = contextualRefSchemaV1.describe('Clip reference')
export const processorRefSchemaV1 = contextualRefSchemaV1.describe('Effect reference')
export const assetRefSchemaV1 = z.object({ source: z.literal('persisted'), id: stableIdSchema }).strict()
export const groupRefSchemaV1 = contextualRefSchemaV1.describe('Group track reference')
export const outputRefSchemaV1 = contextualRefSchemaV1.describe('Output track reference')
export const sendRefSchemaV1 = contextualRefSchemaV1.describe('Send target track reference')
export const sourceRefSchemaV1 = contextualRefSchemaV1.describe('Sidechain source track reference')
export const targetRefSchemaV1 = contextualRefSchemaV1.describe('Sidechain target track reference')
export const processorTargetSchemaV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('track'), track: trackRefSchemaV1 }).strict(),
  z.object({ kind: z.literal('master') }).strict(),
])
export const trackProcessorTargetSchemaV1 = z.object({
  kind: z.literal('track'),
  track: trackRefSchemaV1,
}).strict()
export const executionTargetSchemaV1 = z.enum(['cloud-project', 'local-project'])
export const controlCapabilitiesSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  executionTarget: executionTargetSchemaV1,
  actionKinds: z.array(z.string()).readonly(),
  approvals: z.object({
    requiredForDestructiveActions: z.literal(true),
    expiresInSeconds: z.literal(600),
    tool: z.literal('control_request_approval'),
  }).strict(),
  recovery: z.object({
    supportedKinds: z.array(z.string().min(1).max(64)).readonly(),
    unavailableKinds: z.array(z.string().min(1).max(64)).readonly(),
    expiresInSeconds: z.literal(7 * 24 * 60 * 60),
  }).strict(),
  limits: z.object({
    maxActions: z.number().int().positive(),
    maxSerializedBodyBytes: z.number().int().positive(),
    maxRecoveryEntities: z.number().int().positive(),
    maxRecoveryMappings: z.number().int().positive(),
    maxRecoveryMidiNotes: z.number().int().positive(),
    maxRecoveryAutomationPoints: z.number().int().positive(),
    maxRecoveryWarpMarkers: z.number().int().positive(),
    maxRecoverySends: z.number().int().positive(),
    maxAssetsPerSnapshot: z.number().int().positive(),
    maxAssetFoldersPerSnapshot: z.number().int().positive(),
    maxAssetUploadBytes: z.number().int().positive(),
    maxMidiNotesPerCommit: z.number().int().positive(),
    maxAutomationPointsPerCommit: z.number().int().positive(),
    maxErrorDetails: z.number().int().positive(),
    defaultHistoryPageSize: z.number().int().positive(),
    maxHistoryPageSize: z.number().int().positive(),
    defaultRecoveryPageSize: z.number().int().positive(),
    maxRecoveryPageSize: z.number().int().positive(),
  }).strict(),
}).strict()

export const controlCapabilitiesQuerySchemaV1 = z.object({}).strict()
export const controlCapabilitiesSchemaV2 = controlCapabilitiesSchemaV1.extend({
  version: z.literal(CONTROL_API_VERSION_V2),
  limits: controlCapabilitiesSchemaV1.shape.limits.extend({
    maxMidiPerformanceEventsPerCommit: z.number().int().positive(),
    maxMidiPerformanceEventsPerClip: z.number().int().positive(),
    maxMidiEventsPerArray: z.number().int().positive(),
    maxMidiMappingsPerClip: z.number().int().positive(),
  }).strict(),
}).strict()
export const controlCapabilitiesQuerySchemaV2 = z.object({}).strict()

const projectRenameActionSchema = z.object({
  kind: z.literal('project.rename'),
  name: nameSchema,
}).strict()
const projectSettingsActionSchema = z.object({
  kind: z.literal('project.settings.set'),
  tempoBpm: finiteNumberSchema.int().min(30).max(300).optional(),
  timeSignatureNumerator: finiteNumberSchema.int().min(1).max(32).optional(),
  timeSignatureDenominator: z.union([
    z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32),
  ]).optional(),
  loopEnabled: z.boolean().optional(),
  loopStartSec: secondsSchema.optional(),
  loopEndSec: secondsSchema.optional(),
}).strict().refine((action) => Object.keys(action).length > 1, 'Project settings action must change a setting.')
const trackCreateActionSchema = z.object({
  kind: z.literal('track.create'),
  clientRef: clientRefValueSchema.optional(),
  name: nameSchema.optional(),
  index: z.number().int().nonnegative().optional(),
  trackKind: z.enum(['audio', 'instrument']).optional(),
  channelRole: trackRoleSchema.optional(),
  color: trackColorSchema.optional(),
}).strict()
const trackRenameActionSchema = z.object({
  kind: z.literal('track.rename'),
  track: trackRefSchemaV1,
  name: nameSchema,
}).strict()
const trackMixActionSchema = z.object({
  kind: z.literal('track.mix.set'),
  track: trackRefSchemaV1,
  volume: finiteNumberSchema.min(0).max(2).optional(),
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Track mix action must change a value.')
const trackRoutingActionSchema = z.object({
  kind: z.literal('track.routing.set'),
  track: trackRefSchemaV1,
  output: outputRefSchemaV1.nullable().optional(),
  sends: z.array(z.object({
    target: sendRefSchemaV1,
    amount: finiteNumberSchema.min(0).max(2),
    tap: z.enum(['pre-fx', 'pre-fader', 'post-fader']).optional(),
  }).strict()).max(64).optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Track routing action must change routing.')
const trackReorderActionSchema = z.object({
  kind: z.literal('track.reorder'),
  tracks: z.array(z.object({
    track: trackRefSchemaV1,
    index: z.number().int().nonnegative(),
    group: groupRefSchemaV1.nullable(),
  }).strict()).min(1).max(500),
}).strict()
const trackGroupActionSchema = z.object({
  kind: z.literal('track.group.set'),
  track: trackRefSchemaV1,
  group: groupRefSchemaV1.nullable(),
}).strict()
const trackDeleteActionSchema = z.object({
  kind: z.literal('track.delete'),
  track: trackRefSchemaV1,
}).strict()
const trackCollapsedSetActionSchema = z.object({
  kind: z.literal('track.collapsed.set'), track: trackRefSchemaV1, collapsed: z.boolean(),
}).strict()
const trackColorSetActionSchema = z.object({
  kind: z.literal('track.color.set'), track: trackRefSchemaV1, color: trackColorSchema.nullable(),
}).strict()
const trackColorCascadeActionSchema = z.object({
  kind: z.literal('track.color.cascade'), root: trackRefSchemaV1, color: trackColorSchema.nullable(), cascadeClipColors: z.boolean(),
}).strict()
const trackUngroupActionSchema = z.object({
  kind: z.literal('track.ungroup'), group: trackRefSchemaV1,
}).strict()
const midiNoteSchema = midiClipSchema.shape.notes.element
const midiActionFields = {
  inputChannel: midiClipSchema.shape.inputChannel.nullable(),
  cc: midiClipSchema.shape.cc,
  pitchBends: midiClipSchema.shape.pitchBends,
  channelPressure: midiClipSchema.shape.channelPressure,
  polyPressure: midiClipSchema.shape.polyPressure,
  mappings: midiClipSchema.shape.mappings,
}
const validateMidiActionIds = (
  action: {
    notes: Array<{ id?: string }>
    cc?: Array<{ id?: string }>
    pitchBends?: Array<{ id?: string }>
    channelPressure?: Array<{ id?: string }>
    polyPressure?: Array<{ id?: string }>
    mappings?: Array<{ id: string }>
  },
  context: z.RefinementCtx,
) => {
  const eventIds = [
    ...action.notes,
    ...(action.cc ?? []),
    ...(action.pitchBends ?? []),
    ...(action.channelPressure ?? []),
    ...(action.polyPressure ?? []),
  ].flatMap((event) => event.id === undefined ? [] : [event.id])
  const eventArrays = [
    action.notes,
    action.cc ?? [],
    action.pitchBends ?? [],
    action.channelPressure ?? [],
    action.polyPressure ?? [],
  ]
  if (eventArrays.some((events) => events.length > controlLimitsV2.maxMidiEventsPerArray)) {
    context.addIssue({ code: 'custom', message: `MIDI event arrays support at most ${controlLimitsV2.maxMidiEventsPerArray} events.` })
  }
  if (eventArrays.reduce((total, events) => total + events.length, 0) > controlLimitsV2.maxMidiPerformanceEventsPerClip) {
    context.addIssue({ code: 'custom', message: `MIDI clips support at most ${controlLimitsV2.maxMidiPerformanceEventsPerClip} performance events.` })
  }
  if (new Set(eventIds).size !== eventIds.length) {
    context.addIssue({ code: 'custom', message: 'MIDI event IDs must be unique.' })
  }
  const mappingIds = (action.mappings ?? []).map((mapping) => mapping.id)
  if (new Set(mappingIds).size !== mappingIds.length) {
    context.addIssue({ code: 'custom', message: 'MIDI mapping IDs must be unique.' })
  }
}
const validateMidiSetActionIds = (
  action: {
    notes: Array<{ id?: string }>
    cc?: Array<{ id?: string }>
    pitchBends?: Array<{ id?: string }>
    channelPressure?: Array<{ id?: string }>
    polyPressure?: Array<{ id?: string }>
    mappings?: Array<{ id: string }>
  },
  context: z.RefinementCtx,
) => {
  const eventIds = [
    ...action.notes,
    ...(action.cc ?? []),
    ...(action.pitchBends ?? []),
    ...(action.channelPressure ?? []),
    ...(action.polyPressure ?? []),
  ].flatMap((event) => event.id === undefined ? [] : [event.id])
  if (new Set(eventIds).size !== eventIds.length) {
    context.addIssue({ code: 'custom', message: 'MIDI event IDs must be unique.' })
  }
  const mappingIds = (action.mappings ?? []).map((mapping) => mapping.id)
  if (new Set(mappingIds).size !== mappingIds.length) {
    context.addIssue({ code: 'custom', message: 'MIDI mapping IDs must be unique.' })
  }
}
const clipFadesSnapshotSchema = z.object({
  fadeInStartSec: secondsSchema.optional(),
  fadeInSec: secondsSchema,
  fadeOutSec: secondsSchema,
  fadeOutEndSec: secondsSchema.optional(),
  fadeInCurve: finiteNumberSchema,
  fadeOutCurve: finiteNumberSchema,
  fadeInCurvePosition: finiteNumberSchema.optional(),
  fadeOutCurvePosition: finiteNumberSchema.optional(),
}).strict()
const audioWarpSchema = z.object({
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
const clipCreateMidiActionSchema = z.object({
  kind: z.literal('clip.midi.create'),
  clientRef: clientRefValueSchema.optional(),
  track: trackRefSchemaV1,
  name: nameSchema.optional(),
  startSec: secondsSchema,
  duration: finiteNumberSchema.positive(),
  wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  notes: z.array(midiNoteSchema).max(controlLimitsV2.maxMidiEventsPerArray),
  gain: finiteNumberSchema.min(0).max(2).optional(),
  ...midiActionFields,
}).strict().superRefine(validateMidiActionIds)
const clipCreateAudioActionSchema = z.object({
  kind: z.literal('clip.audio.create'),
  clientRef: clientRefValueSchema.optional(),
  track: trackRefSchemaV1,
  asset: assetRefSchemaV1,
  name: nameSchema.optional(),
  startSec: secondsSchema.optional(),
  duration: finiteNumberSchema.positive().optional(),
  gain: finiteNumberSchema.min(0).max(2).optional(),
  color: trackColorSchema.optional(),
  leftPadSec: secondsSchema.optional(),
  bufferOffsetSec: secondsSchema.optional(),
  midiOffsetBeats: secondsSchema.optional(),
  fades: clipFadesSnapshotSchema.optional(),
  audioWarp: audioWarpSchema.optional(),
}).strict()
const clipSourceSetActionSchema = z.object({
  kind: z.literal('clip.source.set'), clip: clipRefSchemaV1, asset: assetRefSchemaV1,
}).strict()
const clipMidiSetActionSchema = z.object({
  kind: z.literal('clip.midi.set'),
  clip: clipRefSchemaV1,
  wave: z.string(),
  // Existing MIDI clips can carry finite historical note values that are no
  // longer legal writes. The resolver compares this read envelope to the
  // persisted clip before requiring changed values to meet strict write rules.
  notes: z.array(z.object({
    id: stableIdSchema.optional(),
    beat: finiteNumberSchema,
    length: finiteNumberSchema,
    pitch: finiteNumberSchema,
    velocity: finiteNumberSchema.optional(),
    channel: finiteNumberSchema.optional(),
  }).strict()),
  gain: finiteNumberSchema.optional(),
  ...midiActionFields,
}).strict().superRefine(validateMidiSetActionIds)
const clipFadesSetActionSchema = z.object({
  kind: z.literal('clip.fades.set'), clip: clipRefSchemaV1, fades: clipFadesSnapshotSchema,
}).strict()
const clipAudioWarpSetActionSchema = z.object({
  kind: z.literal('clip.audioWarp.set'), clip: clipRefSchemaV1, audioWarp: audioWarpSchema,
}).strict()
const clipColorSetActionSchema = z.object({
  kind: z.literal('clip.color.set'), clip: clipRefSchemaV1, color: clipColorSchema.nullable(),
}).strict()
const clipMoveActionSchema = z.object({
  kind: z.literal('clip.move'),
  clip: clipRefSchemaV1,
  track: trackRefSchemaV1,
  startSec: secondsSchema,
}).strict()
const clipTimingActionSchema = z.object({
  kind: z.literal('clip.timing.set'),
  clip: clipRefSchemaV1,
  duration: finiteNumberSchema.positive().optional(),
  gain: finiteNumberSchema.min(0).max(2).optional(),
  fadeInSec: secondsSchema.optional(),
  fadeOutSec: secondsSchema.optional(),
  leftPadSec: secondsSchema.optional(),
  bufferOffsetSec: secondsSchema.optional(),
  midiOffsetBeats: secondsSchema.optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Clip timing action must change a value.')
const clipNameActionSchema = z.object({
  kind: z.literal('clip.rename'),
  clip: clipRefSchemaV1,
  name: nameSchema,
}).strict()
const clipDeleteActionSchema = z.object({
  kind: z.literal('clip.delete'),
  clip: clipRefSchemaV1,
}).strict()
const timelineRangeDeleteActionSchema = z.object({
  kind: z.literal('timeline.range.delete'),
  tracks: z.array(trackRefSchemaV1).min(1).max(500),
  startSec: secondsSchema,
  endSec: secondsSchema,
}).strict().superRefine((action, context) => {
  if (action.endSec <= action.startSec) {
    context.addIssue({ code: 'custom', message: 'Range end must be greater than range start.', path: ['endSec'] })
  }
  const identifiers = action.tracks.map((track) => (
    track.source === 'persisted' ? `persisted:${track.id}` : `client:${track.clientRef}`
  ))
  if (new Set(identifiers).size !== identifiers.length) {
    context.addIssue({ code: 'custom', message: 'Range tracks must be unique.', path: ['tracks'] })
  }
})
const masterVolumeActionSchema = z.object({
  kind: z.literal('master.volume.set'),
  volume: finiteNumberSchema.min(0).max(2),
}).strict()
const audioEffectKindSchema = z.enum(['utility', 'eq', 'autofilter', 'gate', 'compressor', 'saturator', 'limiter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'delay', 'reverb', 'spectral'])
const effectUpsertActionSchema = z.object({
  kind: z.literal('effect.upsert'),
  target: processorTargetSchemaV1,
  effect: processorRefSchemaV1.optional(),
  clientRef: clientRefValueSchema.optional(),
  effectKind: audioEffectKindSchema,
  params: z.unknown().optional(),
}).strict().superRefine((action, context) => {
  if (action.effect !== undefined && action.clientRef !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'Effect upsert cannot provide both an existing effect ref and a creation client ref.',
      path: ['clientRef'],
    })
  }
  const result = audioEffectAddPayloadSchema.safeParse({
    effectKind: action.effectKind,
    ...(action.params === undefined ? {} : { params: action.params }),
  })
  if (!result.success) context.addIssue({ code: 'custom', message: result.error.message, path: ['params'] })
})
const effectRemoveActionSchema = z.object({
  kind: z.literal('effect.remove'),
  target: processorTargetSchemaV1,
  effectKind: audioEffectKindSchema,
  effect: z.object({ source: z.literal('persisted'), id: stableIdSchema }).strict(),
}).strict()
const externalPluginParametersSetActionSchema = z.object({
  kind: z.literal('external-plugin.parameters.set'),
  target: processorTargetSchemaV1,
  processor: z.object({ source: z.literal('persisted'), id: stableIdSchema }).strict(),
  changes: z.array(z.object({
    parameterId: z.number().int().min(0).max(0xffff_ffff),
    normalizedValue: finiteNumberSchema.min(0).max(1),
  }).strict()).min(1).max(256),
}).strict().superRefine((action, context) => {
  const parameterIds = action.changes.map((change) => change.parameterId)
  if (new Set(parameterIds).size !== parameterIds.length) {
    context.addIssue({ code: 'custom', message: 'External plugin parameter IDs must be unique.', path: ['changes'] })
  }
})
const effectReorderActionSchema = z.object({
  kind: z.literal('effect.reorder'),
  target: processorTargetSchemaV1,
  order: z.array(z.object({
    effect: processorRefSchemaV1,
    kind: audioEffectKindSchema,
  }).strict()).max(64),
}).strict()
const instrumentSetActionSchema = z.object({
  kind: z.literal('instrument.set'),
  target: trackProcessorTargetSchemaV1,
  instrumentKind: z.enum(['synth', 'drum-rack', 'sampler', 'granular']),
  params: z.unknown().optional(),
}).strict().superRefine((action, context) => {
  const result = instrumentAddPayloadSchema.safeParse({
    instrumentKind: action.instrumentKind,
    ...(action.params === undefined ? {} : { params: action.params }),
  })
  if (!result.success) context.addIssue({ code: 'custom', message: result.error.message, path: ['params'] })
})
const arpeggiatorSetActionSchema = z.object({
  kind: z.literal('arpeggiator.set'),
  target: trackProcessorTargetSchemaV1,
  params: arpeggiatorParamsSchema,
}).strict()
const instrumentRemoveActionSchema = z.object({
  kind: z.literal('instrument.remove'), target: trackProcessorTargetSchemaV1,
}).strict()
const arpeggiatorRemoveActionSchema = z.object({
  kind: z.literal('arpeggiator.remove'), target: trackProcessorTargetSchemaV1,
}).strict()
const automationPointSchema = z.object({
  id: stableIdSchema,
  timeSec: secondsSchema,
  value: finiteNumberSchema,
  interpolation: z.enum(['linear', 'hold']),
}).strict()
const automationSetActionSchema = z.object({
  kind: z.literal('automation.set'),
  target: processorTargetSchemaV1,
  effect: processorRefSchemaV1.optional(),
  parameterId: stableIdSchema,
  enabled: z.boolean(),
  points: z.array(automationPointSchema).max(controlLimitsV1.maxAutomationPointsPerCommit),
}).strict()
const automationDeleteActionSchema = z.object({
  kind: z.literal('automation.delete'),
  target: processorTargetSchemaV1,
  effect: processorRefSchemaV1.optional(),
  parameterId: stableIdSchema,
}).strict()
const sidechainSetActionSchema = z.object({
  kind: z.literal('sidechain.set'),
  source: sourceRefSchemaV1,
  target: targetRefSchemaV1,
  effect: processorRefSchemaV1,
}).strict()
const sidechainRemoveActionSchema = z.object({
  kind: z.literal('sidechain.remove'),
  target: targetRefSchemaV1,
  effect: processorRefSchemaV1,
}).strict()
const assetDeleteActionSchema = z.object({
  kind: z.literal('asset.delete'),
  asset: assetRefSchemaV1,
}).strict()
const recoveryRestoreActionSchema = z.object({
  kind: z.literal('recovery.restore'),
  recovery: z.object({ id: stableIdSchema }).strict(),
}).strict()

export const controlActionSchemaV1 = z.union([
  projectRenameActionSchema, projectSettingsActionSchema, trackCreateActionSchema,
  trackRenameActionSchema, trackMixActionSchema, trackRoutingActionSchema,
  trackReorderActionSchema, trackGroupActionSchema, trackDeleteActionSchema,
  trackCollapsedSetActionSchema, trackColorSetActionSchema, trackColorCascadeActionSchema, trackUngroupActionSchema,
  clipCreateMidiActionSchema, clipCreateAudioActionSchema, clipSourceSetActionSchema, clipMidiSetActionSchema,
  clipFadesSetActionSchema, clipAudioWarpSetActionSchema, clipColorSetActionSchema, clipMoveActionSchema, clipTimingActionSchema,
  clipNameActionSchema, clipDeleteActionSchema, timelineRangeDeleteActionSchema, masterVolumeActionSchema,
  effectUpsertActionSchema, effectRemoveActionSchema, effectReorderActionSchema,
  externalPluginParametersSetActionSchema,
  instrumentSetActionSchema, instrumentRemoveActionSchema, arpeggiatorSetActionSchema, arpeggiatorRemoveActionSchema,
  automationSetActionSchema, automationDeleteActionSchema, sidechainSetActionSchema, sidechainRemoveActionSchema,
  assetDeleteActionSchema, recoveryRestoreActionSchema,
])

const creationClientRef = (action: z.infer<typeof controlActionSchemaV1>): string | undefined => {
  if (
    action.kind === 'track.create'
    || action.kind === 'clip.midi.create'
    || action.kind === 'clip.audio.create'
    || action.kind === 'effect.upsert'
  ) return action.clientRef
  return undefined
}

export const findDuplicateCreationClientRefsV1 = (
  actions: readonly z.infer<typeof controlActionSchemaV1>[],
): string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const action of actions) {
    const clientRef = creationClientRef(action)
    if (clientRef === undefined) continue
    if (seen.has(clientRef)) duplicates.add(clientRef)
    seen.add(clientRef)
  }
  return [...duplicates].sort()
}

const addAggregateIssues = (
  request: { actions: z.infer<typeof controlActionSchemaV1>[] },
  context: z.RefinementCtx,
) => {
  let midiEvents = 0
  let automationPoints = 0
  for (const action of request.actions) {
    if (action.kind === 'clip.midi.create' || action.kind === 'clip.midi.set') {
      const events = action.notes.length
        + (action.cc?.length ?? 0)
        + (action.pitchBends?.length ?? 0)
        + (action.channelPressure?.length ?? 0)
        + (action.polyPressure?.length ?? 0)
      // Historical clips can legally be resubmitted unchanged above the
      // current write limit. The planner compares those sets to persisted
      // state before enforcing their resolved delta.
      if (action.kind === 'clip.midi.create' || events <= controlLimitsV2.maxMidiPerformanceEventsPerClip) {
        midiEvents += events
      }
    }
    if (action.kind === 'automation.set') automationPoints += action.points.length
  }
  if (midiEvents > controlLimitsV2.maxMidiPerformanceEventsPerCommit) {
    context.addIssue({
      code: 'custom',
      message: `Control request exceeds ${controlLimitsV2.maxMidiPerformanceEventsPerCommit} MIDI performance events.`,
      path: ['actions'],
    })
  }
  if (automationPoints > controlLimitsV1.maxAutomationPointsPerCommit) {
    context.addIssue({
      code: 'custom',
      message: `Control request exceeds ${controlLimitsV1.maxAutomationPointsPerCommit} automation points.`,
      path: ['actions'],
    })
  }
  const duplicateClientRefs = findDuplicateCreationClientRefsV1(request.actions)
  if (duplicateClientRefs.length > 0) {
    context.addIssue({
      code: 'custom',
      message: `Creation client refs must be unique: ${duplicateClientRefs.join(', ')}.`,
      path: ['actions'],
    })
  }
}

export const findDuplicateRecoveryActionIndexV1 = (
  actions: readonly z.infer<typeof controlActionSchemaV1>[],
) => {
  const recoveryIds = new Set<string>()
  for (const [actionIndex, action] of actions.entries()) {
    if (action.kind !== 'recovery.restore') continue
    if (recoveryIds.has(action.recovery.id)) return actionIndex
    recoveryIds.add(action.recovery.id)
  }
  return undefined
}

const requestBaseShape = {
  version: z.literal(CONTROL_API_VERSION_V1),
  projectId: projectIdSchema,
  expectedRevision: revisionSchema.optional(),
  actions: z.array(controlActionSchemaV1).min(1).max(controlLimitsV1.maxActions),
}

export const idempotencyKeySchemaV1 = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, 'Idempotency keys may contain only ASCII letters, digits, dot, underscore, tilde, and hyphen.')

export const controlCommitRequestSchemaV1 = z.object({
  ...requestBaseShape,
  idempotencyKey: idempotencyKeySchemaV1,
  approvalToken: approvalTokenSchemaV1.optional(),
}).strict().superRefine(addAggregateIssues)

export const controlErrorSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  code: z.enum([
    'invalid-request',
    'validation',
    'unsupported-action',
    'revision-conflict',
    'idempotency-conflict',
    'forbidden',
    'authorization',
    'not-found',
    'limit-exceeded',
    'approval-required',
    'internal',
  ]),
  message: z.string().min(1).max(1000),
  actionIndex: z.number().int().nonnegative().optional(),
  details: z.record(z.string().min(1).max(64), z.string().max(1000))
    .refine((details) => Object.keys(details).length <= controlLimitsV1.maxErrorDetails)
    .optional(),
}).strict()

export const controlPreviewRequestSchemaV1 = z.object(requestBaseShape)
  .strict()
  .superRefine(addAggregateIssues)

export const controlApprovalRequestSchemaV1 = z.object(requestBaseShape)
  .strict()
  .superRefine(addAggregateIssues)

const controlImpactSchemaV1 = z.object({
  tracks: z.number().int().nonnegative(),
  clips: z.number().int().nonnegative(),
  processors: z.number().int().nonnegative(),
  automation: z.number().int().nonnegative(),
  sidechains: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
  routingChanges: z.number().int().nonnegative(),
}).strict()
const controlApprovalRequirementSchemaV1 = z.object({
  required: z.boolean(),
  actionIndexes: z.array(z.number().int().nonnegative()).max(controlLimitsV1.maxActions),
  actionKinds: z.array(z.string().min(1).max(64)).max(controlLimitsV1.maxActions),
  impact: controlImpactSchemaV1,
  requestDigest: requestDigestSchema,
  baseRevision: revisionSchema,
  expiresInSeconds: z.literal(600),
}).strict()

export const resolvedRefSchemaV1 = z.object({
  entity: z.enum(['track', 'clip', 'effect']),
  clientRef: clientRefValueSchema,
  id: stableIdSchema,
  persisted: z.boolean(),
}).strict()
export const controlWarningSchemaV1 = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  actionIndex: z.number().int().nonnegative().optional(),
}).strict()
export const controlChangeSummaryEntrySchemaV1 = z.object({
  actionIndex: z.number().int().nonnegative(),
  kind: z.string().min(1).max(64),
  description: z.string().min(1).max(1000),
}).strict()
export const controlChangeSummarySchemaV1 = z.object({
  actionCount: z.number().int().nonnegative().max(controlLimitsV1.maxActions),
  changes: z.array(controlChangeSummaryEntrySchemaV1).max(controlLimitsV1.maxActions),
}).strict()
const recoveryDescriptorSchemaV1 = z.object({
  actionIndex: z.number().int().nonnegative(),
  id: stableIdSchema,
  kind: z.enum([
    'clip.delete', 'effect.remove', 'instrument.remove', 'arpeggiator.remove',
    'automation.delete', 'sidechain.remove', 'asset.delete', 'track.delete', 'track.ungroup',
    'timeline.range.delete',
  ]),
  expiresAt: z.number().int().nonnegative(),
}).strict()
const recoveryMappingEntitySchemaV1 = z.enum(['track', 'clip', 'effect', 'automation', 'sidechain', 'asset'])
const restoredMappingSchemaV1 = z.object({
  actionIndex: z.number().int().nonnegative(),
  recoveryId: stableIdSchema,
  entities: z.array(z.object({
    entity: recoveryMappingEntitySchemaV1,
    sourceId: stableIdSchema,
    restoredId: stableIdSchema,
  }).strict()).max(controlLimitsV1.maxRecoveryMappings),
}).strict()

const planningResultShape = {
  version: z.literal(CONTROL_API_VERSION_V1),
  projectId: projectIdSchema,
  priorRevision: revisionSchema,
  requestDigest: requestDigestSchema,
  resolvedRefs: z.array(resolvedRefSchemaV1).max(controlLimitsV1.maxActions),
  warnings: z.array(controlWarningSchemaV1).max(controlLimitsV1.maxActions),
  changeSummary: controlChangeSummarySchemaV1,
}

export const controlPreviewResultSchemaV1 = z.object({
  ...planningResultShape,
  revision: revisionSchema,
  applied: z.boolean(),
  approval: controlApprovalRequirementSchemaV1.optional(),
}).strict()
export const controlApprovalResultSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  approvalToken: approvalTokenSchemaV1,
  requestDigest: requestDigestSchema,
  baseRevision: revisionSchema,
  actionIndexes: z.array(z.number().int().nonnegative()).min(1).max(controlLimitsV1.maxActions),
  expiresAt: z.number().int().nonnegative(),
}).strict()
export const controlCommitResultSchemaV1 = z.object({
  ...planningResultShape,
  revision: revisionSchema,
  applied: z.boolean(),
  idempotencyReplay: z.boolean(),
  recoveries: z.array(recoveryDescriptorSchemaV1).max(controlLimitsV1.maxActions).default([]),
  restored: z.array(restoredMappingSchemaV1).max(controlLimitsV1.maxActions).default([]),
}).strict()

export const controlSnapshotQuerySchemaV1 = z.object({
  projectId: projectIdSchema,
}).strict()

export const controlHistoryQuerySchemaV1 = z.object({
  projectId: projectIdSchema,
  cursor: opaqueCursorSchema.optional(),
  limit: z.number()
    .int()
    .positive()
    .max(controlLimitsV1.maxHistoryPageSize)
    .default(controlLimitsV1.defaultHistoryPageSize),
}).strict()

export const controlHistoryEntrySchemaV1 = z.object({
  id: stableIdSchema,
  projectId: projectIdSchema,
  actorSubject: stableIdSchema,
  actorIssuer: stableIdSchema.optional(),
  actorTokenIdentifier: stableIdSchema.optional(),
  actorRole: z.enum(['owner', 'editor', 'viewer']),
  idempotencyKey: idempotencyKeySchemaV1,
  requestDigest: requestDigestSchema,
  priorRevision: revisionSchema,
  revision: revisionSchema,
  applied: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  recoveries: z.array(recoveryDescriptorSchemaV1).max(controlLimitsV1.maxActions).default([]),
  restored: z.array(restoredMappingSchemaV1).max(controlLimitsV1.maxActions).default([]),
}).strict()

export const controlHistoryResultSchemaV1 = z.object({
  entries: z.array(controlHistoryEntrySchemaV1).max(controlLimitsV1.maxHistoryPageSize),
  continueCursor: opaqueCursorSchema,
  isDone: z.boolean(),
}).strict()

export const controlRecoveriesQuerySchemaV1 = z.object({
  projectId: projectIdSchema,
  cursor: opaqueCursorSchema.optional(),
  limit: z.number().int().positive().max(controlLimitsV1.maxRecoveryPageSize).default(controlLimitsV1.defaultRecoveryPageSize),
}).strict()

export const controlRecoveriesResultSchemaV1 = z.object({
  entries: z.array(recoveryDescriptorSchemaV1).max(controlLimitsV1.maxRecoveryPageSize),
  continueCursor: opaqueCursorSchema,
  isDone: z.boolean(),
}).strict()

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
const assetMimeTypeSchema = z.enum([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/webm",
])
const assetSourceKindSchema = z.enum(["upload", "url", "recording"])
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

export type ControlActionV1 = z.infer<typeof controlActionSchemaV1>
export type ControlCommitRequestV1 = z.infer<typeof controlCommitRequestSchemaV1>
export type ControlPreviewRequestV1 = z.infer<typeof controlPreviewRequestSchemaV1>
export type ControlApprovalRequestV1 = z.infer<typeof controlApprovalRequestSchemaV1>
export type ControlPreviewResultV1 = z.infer<typeof controlPreviewResultSchemaV1>
export type ControlApprovalResultV1 = z.infer<typeof controlApprovalResultSchemaV1>
export type ControlCommitResultV1 = z.infer<typeof controlCommitResultSchemaV1>
export type ControlErrorV1 = z.infer<typeof controlErrorSchemaV1>
export type ControlSnapshotQueryV1 = z.infer<typeof controlSnapshotQuerySchemaV1>
export type ControlHistoryQueryV1 = z.infer<typeof controlHistoryQuerySchemaV1>
export type ControlHistoryEntryV1 = z.infer<typeof controlHistoryEntrySchemaV1>
export type ControlHistoryResultV1 = z.infer<typeof controlHistoryResultSchemaV1>
export type ControlRecoveriesQueryV1 = z.infer<typeof controlRecoveriesQuerySchemaV1>
export type ControlRecoveriesResultV1 = z.infer<typeof controlRecoveriesResultSchemaV1>
export type ContextualRefV1 = z.infer<typeof contextualRefSchemaV1>
export type TrackRefV1 = z.infer<typeof trackRefSchemaV1>
export type ClipRefV1 = z.infer<typeof clipRefSchemaV1>
export type ProcessorRefV1 = z.infer<typeof processorRefSchemaV1>
export type AssetRefV1 = z.infer<typeof assetRefSchemaV1>
export type GroupRefV1 = z.infer<typeof groupRefSchemaV1>
export type OutputRefV1 = z.infer<typeof outputRefSchemaV1>
export type SendRefV1 = z.infer<typeof sendRefSchemaV1>
export type SourceRefV1 = z.infer<typeof sourceRefSchemaV1>
export type TargetRefV1 = z.infer<typeof targetRefSchemaV1>
export type ProcessorTargetV1 = z.infer<typeof processorTargetSchemaV1>
export type TrackProcessorTargetV1 = z.infer<typeof trackProcessorTargetSchemaV1>
export type ResolvedRefV1 = z.infer<typeof resolvedRefSchemaV1>
export type ControlWarningV1 = z.infer<typeof controlWarningSchemaV1>
export type ControlChangeSummaryV1 = z.infer<typeof controlChangeSummarySchemaV1>
export type ProjectSnapshotV1 = z.infer<typeof projectSnapshotSchemaV1>
export type ControlCapabilitiesV1 = z.infer<typeof controlCapabilitiesSchemaV1>
export type ProjectSnapshotV2 = z.infer<typeof projectSnapshotSchemaV2>
export type ControlCapabilitiesV2 = z.infer<typeof controlCapabilitiesSchemaV2>
export type AssetSnapshotV1 = z.infer<typeof assetSnapshotSchemaV1>
export type AssetFolderV1 = z.infer<typeof assetFolderSchemaV1>
export type AssetUploadResultV1 = z.infer<typeof assetUploadResultSchemaV1>

const localOnlyControlActionKindsV1 = ['external-plugin.parameters.set']

export const controlCapabilitiesV1 = {
  version: CONTROL_API_VERSION_V1,
  executionTarget: 'cloud-project',
  actionKinds: [
    'project.rename', 'project.settings.set', 'track.create', 'track.rename',
    'track.mix.set', 'track.routing.set', 'track.reorder', 'track.group.set',
    'track.delete', 'clip.midi.create', 'clip.move', 'clip.timing.set',
    'clip.rename', 'clip.delete', 'master.volume.set',
    'timeline.range.delete',
    'effect.upsert', 'effect.remove', 'effect.reorder',
    'instrument.set', 'arpeggiator.set',
    'automation.set', 'automation.delete', 'sidechain.set', 'sidechain.remove',
    'clip.audio.create', 'clip.source.set', 'clip.midi.set', 'clip.fades.set',
    'clip.audioWarp.set', 'clip.color.set', 'track.collapsed.set', 'track.color.set',
    'track.color.cascade', 'track.ungroup', 'instrument.remove', 'arpeggiator.remove',
    'asset.delete', 'recovery.restore',
  ],
  approvals: {
    requiredForDestructiveActions: true,
    expiresInSeconds: 600,
    tool: 'control_request_approval',
  },
  recovery: {
    supportedKinds: [
      'clip.delete', 'effect.remove', 'instrument.remove', 'arpeggiator.remove',
      'automation.delete', 'sidechain.remove', 'asset.delete', 'track.delete', 'track.ungroup',
      'timeline.range.delete',
    ],
    unavailableKinds: [],
    expiresInSeconds: 7 * 24 * 60 * 60,
  },
  limits: controlLimitsV1,
} satisfies z.input<typeof controlCapabilitiesSchemaV1>
export const localControlCapabilitiesV1 = {
  ...controlCapabilitiesV1,
  executionTarget: 'local-project',
  actionKinds: [...controlCapabilitiesV1.actionKinds, ...localOnlyControlActionKindsV1],
} satisfies z.input<typeof controlCapabilitiesSchemaV1>
export const controlCapabilitiesV2 = {
  ...controlCapabilitiesV1,
  version: CONTROL_API_VERSION_V2,
  limits: controlLimitsV2,
} satisfies z.input<typeof controlCapabilitiesSchemaV2>
export const localControlCapabilitiesV2 = {
  ...localControlCapabilitiesV1,
  version: CONTROL_API_VERSION_V2,
  limits: controlLimitsV2,
  executionTarget: 'local-project',
} satisfies z.input<typeof controlCapabilitiesSchemaV2>

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export const canonicalJson = (value: unknown): string => {
  const canonicalize = (entry: unknown): string => {
    if (entry === null) return 'null'
    if (typeof entry === 'boolean') return entry ? 'true' : 'false'
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('Canonical JSON only supports finite numbers.')
      return JSON.stringify(entry)
    }
    if (typeof entry === 'string') return JSON.stringify(entry)
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        if (!(index in entry)) throw new Error('Canonical JSON does not support sparse arrays.')
      }
      return `[${entry.map(canonicalize).join(',')}]`
    }
    if (!isPlainObject(entry)) throw new Error('Canonical JSON only supports plain JSON objects.')
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(entry[key])}`).join(',')}}`
  }
  return canonicalize(value)
}

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
  effects: recoveryEffectBundleSchemaV1.shape.effects,
  automation: recoveryEffectBundleSchemaV1.shape.automation,
  sidechains: recoveryEffectBundleSchemaV1.shape.sidechains,
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
const recoveryTrackDeleteSchemaV1 = recoveryTrackEntityBundleSchemaV1.extend({
  rootTrackId: stableIdSchema,
  survivors: z.array(z.object({
    id: stableIdSchema,
    before: recoveryTrackStateSchemaV1,
    after: recoveryTrackStateSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
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
  children: z.array(z.object({
    id: stableIdSchema,
    before: recoveryTrackStateSchemaV1,
    after: recoveryTrackStateSchemaV1,
  }).strict()).max(controlLimitsV1.maxRecoveryEntities),
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
  survivors: recoveryTrackDeleteSchemaV1.shape.survivors,
}).strict()
const recoveryUngroupSchemaV2 = recoveryTrackEntityBundleSchemaV2.safeExtend({
  groupId: stableIdSchema,
  children: recoveryUngroupSchemaV1.shape.children,
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
  ...recoveryTrackEntityBundleSchemaV1.shape,
  clips: z.array(recoveryCapturedClipBundleSchemaV2).max(controlLimitsV1.maxRecoveryEntities),
}).strict().superRefine(validateCapturedRecoveryTrackEntityBundle)
const recoveryCapturedTrackDeleteSchemaV2 = recoveryCapturedTrackEntityBundleSchemaV2.extend({
  rootTrackId: stableIdSchema,
  survivors: recoveryTrackDeleteSchemaV1.shape.survivors,
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
  children: recoveryUngroupSchemaV1.shape.children,
}).strict().superRefine((data, context) => {
  if (data.tracks.length !== 1 || data.tracks[0]?.id !== data.groupId) {
    context.addIssue({ code: 'custom', message: 'Ungroup recovery must capture exactly its group.', path: ['groupId'] })
  }
  const ids = data.children.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Ungroup children must be unique.', path: ['children'] })
})
const recoveryCapturedRangeDataSchemaV2 = z.object({
  ...recoveryRangeDataSchemaV2.shape,
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

const normalizeRecoveryClipMidi = <Clip extends { midi?: unknown }>(
  clip: Clip,
  normalizeMidi: (value: unknown) => NormalizedMidiClip | NormalizedLegacyMidiClip,
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
  const parsed: unknown = JSON.parse(payload)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('version' in parsed)) {
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
  const parsed: unknown = JSON.parse(payload)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('version' in parsed) || parsed.version !== 2) {
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
  const parsed: unknown = JSON.parse(payload)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('version' in parsed)) {
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
const sha256Hex = (value: string) => (
  Array.from(sha256(new TextEncoder().encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('')
)
export const hashCanonicalJsonSyncV1 = (value: unknown) => sha256Hex(canonicalJson(value))
const timelineRangeRecoveryClipSemanticValueV2 = (clip: ProjectSnapshotV2['clips'][number]) => {
  const { id: _id, ...semantic } = clip
  return semantic
}
export const timelineRangeRecoveryClipDigestV2 = (clip: ProjectSnapshotV2['clips'][number]) => (
  hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(timelineRangeRecoveryClipSemanticValueV2(clip))))
)
export const timelineRangeRecoveryOwnershipDigestV2 = (ownership: RecoveryOwnershipV1) => (
  hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(ownership)))
)
export const timelineRangeRecoveryAutomationDigestV2 = (
  automation: ProjectSnapshotV2['automation'][number],
) => hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(automation)))
export const hashRecoveryPayloadSyncV1 = (payload: string) => sha256Hex(payload)
export const hashRecoveryPayloadV1 = async (payload: string) => hashRecoveryPayloadSyncV1(payload)

export const assertControlSerializedBodyV1 = <Value>(value: Value): Value => {
  const serialized = canonicalJson(value)
  if (new TextEncoder().encode(serialized).byteLength > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Control body exceeds the serialized body limit.')
  }
  return value
}

export const parseControlCommitRequestV1 = (input: unknown) => {
  assertControlSerializedBodyV1(input)
  return assertControlSerializedBodyV1(controlCommitRequestSchemaV1.parse(input))
}

export const parseControlPreviewRequestV1 = (input: unknown) => {
  assertControlSerializedBodyV1(input)
  return assertControlSerializedBodyV1(controlPreviewRequestSchemaV1.parse(input))
}
export const parseControlApprovalRequestV1 = (input: unknown) => {
  assertControlSerializedBodyV1(input)
  return assertControlSerializedBodyV1(controlApprovalRequestSchemaV1.parse(input))
}

export const parseControlSnapshotQueryV1 = (input: unknown) => (
  controlSnapshotQuerySchemaV1.parse(input)
)
export const parseControlSnapshotQueryV2 = (input: unknown) => (
  controlSnapshotQuerySchemaV1.parse(input)
)

export const parseControlHistoryQueryV1 = (input: unknown) => (
  controlHistoryQuerySchemaV1.parse(input)
)
export const parseControlRecoveriesQueryV1 = (input: unknown) => (
  controlRecoveriesQuerySchemaV1.parse(input)
)

export const controlRequestDigestInputV1 = (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => canonicalJson({
  version: request.version,
  projectId: request.projectId,
  ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
  actions: request.actions,
})

export const controlRequestDigestSyncV1 = (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => sha256Hex(controlRequestDigestInputV1(request))
export const controlRequestDigestV1 = async (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1 | ControlApprovalRequestV1,
) => controlRequestDigestSyncV1(request)

export {
  controlApprovalRequirementV1,
  destructiveControlActionKindsV1,
  planControlRequestV1,
  rebaseRecoveryAutomationParameterIdV1,
} from './planner'
export type {
  ControlPlanError,
  ControlPlanV1,
  PlannedControlActionV1,
} from './planner'
export {
  collectDeletedTrackIdsV1,
  collectTrackDeletionAffectedIdsV1,
} from './trackDeletion'
export {
  compareControlSnapshotText,
} from './projection'
export type { ControlProjectSnapshotInput }
export const projectControlSnapshotV1 = (input: ControlProjectSnapshotInput) => (
  projectControlSnapshotCoreV1(input, projectSnapshotSchemaV1.parse)
)
export const projectControlSnapshotV2 = (input: ControlProjectSnapshotInput) => (
  projectControlSnapshotCoreV2(input, projectSnapshotSchemaV2.parse)
)
