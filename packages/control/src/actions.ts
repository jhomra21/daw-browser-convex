import { z } from 'zod'
import {
  audioEffectAddPayloadSchema,
  arpeggiatorParamsSchema,
  instrumentAddPayloadSchema,
  midiClipReadSchema,
  midiNoteSchema,
} from '@daw-browser/shared'
import {
  CONTROL_API_VERSION_V1,
  controlLimitsV1,
  controlLimitsV2,
} from './versions'
import {
  clientRefValueSchema,
  approvalTokenSchemaV1,
  audioWarpSchema,
  automationPointSchema,
  clipColorSchema,
  clipFadesSnapshotSchema,
  clipRefSchemaV1,
  finiteNumberSchema,
  groupRefSchemaV1,
  nameSchema,
  opaqueCursorSchema,
  processorRefSchemaV1,
  processorTargetSchemaV1,
  projectIdSchema,
  requestDigestSchema,
  revisionSchema,
  secondsSchema,
  sendRefSchemaV1,
  sourceRefSchemaV1,
  stableIdSchema,
  targetRefSchemaV1,
  trackColorSchema,
  trackRoleSchema,
  trackProcessorTargetSchemaV1,
  trackRefSchemaV1,
  outputRefSchemaV1,
  assetRefSchemaV1,
} from './primitives'

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
  name: nameSchema.describe('New track name.'),
}).strict().describe('Rename a track. Existing tracks use {source:"persisted",id:"<id from snapshot>"}.')
const trackMixActionSchema = z.object({
  kind: z.literal('track.mix.set'),
  track: trackRefSchemaV1,
  volume: finiteNumberSchema.min(0).max(2).optional().describe('Optional linear volume, from 0 through 2.'),
  muted: z.boolean().optional().describe('Optional mute state.'),
  soloed: z.boolean().optional().describe('Optional solo state.'),
}).strict().refine((action) => Object.keys(action).length > 2, 'Track mix action must change a value.')
  .describe('Set one or more track mix values; provide at least one of volume, muted, or soloed.')
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
}).strict().describe('Destructively delete a track; preview reports whether approval is required.')
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
const midiActionFields = {
  inputChannel: midiClipReadSchema['shape'].inputChannel.nullable(),
  cc: midiClipReadSchema['shape'].cc,
  pitchBends: midiClipReadSchema['shape'].pitchBends,
  channelPressure: midiClipReadSchema['shape'].channelPressure,
  polyPressure: midiClipReadSchema['shape'].polyPressure,
  mappings: midiClipReadSchema['shape'].mappings,
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
    params: action.params,
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
    params: action.params,
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
  recovery: z.object({
    id: stableIdSchema.describe('Recovery ID returned by control_recoveries or a prior commit.'),
  }).strict(),
}).strict().describe('Restore a recovery by ID returned from the project recoveries list.')

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

const requestBaseFields = {
  version: z.literal(CONTROL_API_VERSION_V1).describe('Control request version; use "v1".'),
  projectId: projectIdSchema.describe('Project ID from project_list or the canonical V2 snapshot.'),
  expectedRevision: revisionSchema.optional().describe('Revision observed in the latest canonical V2 snapshot.'),
  actions: z.array(controlActionSchemaV1).min(1).max(controlLimitsV1.maxActions)
    .describe('Ordered control actions to preview or apply, such as track.rename.'),
}

export const idempotencyKeySchemaV1 = z.string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, 'Idempotency keys may contain only ASCII letters, digits, dot, underscore, tilde, and hyphen.')

export const controlCommitRequestSchemaV1 = z.object({
  ...requestBaseFields,
  idempotencyKey: idempotencyKeySchemaV1.describe('Stable key reused when retrying this exact commit request.'),
  approvalToken: approvalTokenSchemaV1.optional().describe('Approval token returned by control_request_approval when preview requires approval.'),
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

export const controlPreviewRequestSchemaV1 = z.object(requestBaseFields)
  .strict()
  .superRefine(addAggregateIssues)

export const controlApprovalRequestSchemaV1 = z.object(requestBaseFields)
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

const planningResultFields = {
  version: z.literal(CONTROL_API_VERSION_V1),
  projectId: projectIdSchema,
  priorRevision: revisionSchema,
  requestDigest: requestDigestSchema,
  resolvedRefs: z.array(resolvedRefSchemaV1).max(controlLimitsV1.maxActions),
  warnings: z.array(controlWarningSchemaV1).max(controlLimitsV1.maxActions),
  changeSummary: controlChangeSummarySchemaV1,
}

export const controlPreviewResultSchemaV1 = z.object({
  ...planningResultFields,
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
  ...planningResultFields,
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

export const controlSnapshotQuerySchemaV2 = controlSnapshotQuerySchemaV1
export const canonicalControlSnapshotQuerySchema = controlSnapshotQuerySchemaV2
export const controlSnapshotQuerySchema = canonicalControlSnapshotQuerySchema
export type CanonicalControlSnapshotQuery = ControlSnapshotQueryV1
export type ControlSnapshotQuery = CanonicalControlSnapshotQuery
export type ResolvedRefV1 = z.infer<typeof resolvedRefSchemaV1>
export type ControlWarningV1 = z.infer<typeof controlWarningSchemaV1>
export type ControlChangeSummaryV1 = z.infer<typeof controlChangeSummarySchemaV1>
