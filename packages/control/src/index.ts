import { z } from 'zod'
import {
  audioEffectAddPayloadSchema,
  arpeggiatorParamsSchema,
  instrumentAddPayloadSchema,
  persistedProcessorSnapshotSchema,
} from '@daw-browser/shared'

export const CONTROL_API_VERSION_V1 = 'v1'

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
const trackRoleSchema = z.enum(['track', 'group', 'return'])
const revisionSchema = z.number().int().nonnegative()
const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Request digest must be a lowercase SHA-256 hex digest.')
const opaqueCursorSchema = z.string()
  .min(1)
  .max(2_048)
  .regex(/^[\x20-\x7e]+$/, 'Cursor must contain printable ASCII characters only.')

export const controlLimitsV1 = {
  maxActions: 100,
  maxSerializedBodyBytes: 256 * 1024,
  maxMidiNotesPerCommit: 500,
  maxAutomationPointsPerCommit: 1000,
  maxErrorDetails: 16,
  defaultHistoryPageSize: 50,
  maxHistoryPageSize: 100,
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
  limits: z.object({
    maxActions: z.number().int().positive(),
    maxSerializedBodyBytes: z.number().int().positive(),
    maxMidiNotesPerCommit: z.number().int().positive(),
    maxAutomationPointsPerCommit: z.number().int().positive(),
    maxErrorDetails: z.number().int().positive(),
    defaultHistoryPageSize: z.number().int().positive(),
    maxHistoryPageSize: z.number().int().positive(),
  }).strict(),
}).strict()

export const controlCapabilitiesQuerySchemaV1 = z.object({}).strict()

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
  color: z.string().max(64).optional(),
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
const midiNoteSchema = z.object({
  beat: finiteNumberSchema,
  length: finiteNumberSchema.positive(),
  pitch: z.number().int().min(0).max(127),
  velocity: finiteNumberSchema.min(0).max(1).optional(),
}).strict()
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
const clipCreateMidiActionSchema = z.object({
  kind: z.literal('clip.midi.create'),
  clientRef: clientRefValueSchema.optional(),
  track: trackRefSchemaV1,
  name: nameSchema.optional(),
  startSec: secondsSchema,
  duration: finiteNumberSchema.positive(),
  wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  notes: z.array(midiNoteSchema).max(controlLimitsV1.maxMidiNotesPerCommit),
  gain: finiteNumberSchema.min(0).max(2).optional(),
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

export const controlActionSchemaV1 = z.union([
  projectRenameActionSchema, projectSettingsActionSchema, trackCreateActionSchema,
  trackRenameActionSchema, trackMixActionSchema, trackRoutingActionSchema,
  trackReorderActionSchema, trackGroupActionSchema, trackDeleteActionSchema,
  clipCreateMidiActionSchema, clipMoveActionSchema, clipTimingActionSchema,
  clipNameActionSchema, clipDeleteActionSchema, masterVolumeActionSchema,
  effectUpsertActionSchema, effectRemoveActionSchema, effectReorderActionSchema,
  instrumentSetActionSchema, arpeggiatorSetActionSchema,
  automationSetActionSchema, automationDeleteActionSchema, sidechainSetActionSchema, sidechainRemoveActionSchema,
])

const creationClientRef = (action: z.infer<typeof controlActionSchemaV1>): string | undefined => {
  if (
    action.kind === 'track.create'
    || action.kind === 'clip.midi.create'
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
  let midiNotes = 0
  let automationPoints = 0
  for (const action of request.actions) {
    if (action.kind === 'clip.midi.create') midiNotes += action.notes.length
    if (action.kind === 'automation.set') automationPoints += action.points.length
  }
  if (midiNotes > controlLimitsV1.maxMidiNotesPerCommit) {
    context.addIssue({
      code: 'custom',
      message: `Control request exceeds ${controlLimitsV1.maxMidiNotesPerCommit} MIDI notes.`,
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
}).strict()
export const controlCommitResultSchemaV1 = z.object({
  ...planningResultShape,
  revision: revisionSchema,
  applied: z.boolean(),
  idempotencyReplay: z.boolean(),
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
}).strict()

export const controlHistoryResultSchemaV1 = z.object({
  entries: z.array(controlHistoryEntrySchemaV1).max(controlLimitsV1.maxHistoryPageSize),
  continueCursor: opaqueCursorSchema,
  isDone: z.boolean(),
}).strict()

const persistedProcessorTargetSchema = z.union([
  z.object({ trackId: stableIdSchema }).strict(),
  z.object({ master: z.literal(true) }).strict(),
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
  clips: z.array(z.object({
    id: stableIdSchema, trackId: stableIdSchema, name: nameSchema, startSec: secondsSchema,
    duration: finiteNumberSchema.positive(), gain: finiteNumberSchema.optional(),
    leftPadSec: secondsSchema,
    bufferOffsetSec: secondsSchema,
    midiOffsetBeats: secondsSchema,
    fades: clipFadesSnapshotSchema.optional(),
    midi: z.object({
      wave: z.string(),
      gain: finiteNumberSchema.optional(),
      notes: z.array(midiNoteSchema),
    }).strict().optional(),
  }).strict()),
  processors: z.array(z.object({
    id: stableIdSchema,
    target: persistedProcessorTargetSchema,
    instanceId: stableIdSchema.optional(),
    index: z.number().int().nonnegative(),
    processor: persistedProcessorSnapshotSchema,
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
}).strict()

export type ControlActionV1 = z.infer<typeof controlActionSchemaV1>
export type ControlCommitRequestV1 = z.infer<typeof controlCommitRequestSchemaV1>
export type ControlPreviewRequestV1 = z.infer<typeof controlPreviewRequestSchemaV1>
export type ControlPreviewResultV1 = z.infer<typeof controlPreviewResultSchemaV1>
export type ControlCommitResultV1 = z.infer<typeof controlCommitResultSchemaV1>
export type ControlErrorV1 = z.infer<typeof controlErrorSchemaV1>
export type ControlSnapshotQueryV1 = z.infer<typeof controlSnapshotQuerySchemaV1>
export type ControlHistoryQueryV1 = z.infer<typeof controlHistoryQuerySchemaV1>
export type ControlHistoryEntryV1 = z.infer<typeof controlHistoryEntrySchemaV1>
export type ControlHistoryResultV1 = z.infer<typeof controlHistoryResultSchemaV1>
export type ContextualRefV1 = z.infer<typeof contextualRefSchemaV1>
export type TrackRefV1 = z.infer<typeof trackRefSchemaV1>
export type ClipRefV1 = z.infer<typeof clipRefSchemaV1>
export type ProcessorRefV1 = z.infer<typeof processorRefSchemaV1>
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

export const controlCapabilitiesV1 = {
  version: CONTROL_API_VERSION_V1,
  executionTarget: 'cloud-project',
  actionKinds: [
    'project.rename', 'project.settings.set', 'track.create', 'track.rename',
    'track.mix.set', 'track.routing.set', 'track.reorder', 'track.group.set',
    'track.delete', 'clip.midi.create', 'clip.move', 'clip.timing.set',
    'clip.rename', 'clip.delete', 'master.volume.set',
    'effect.upsert', 'effect.remove', 'effect.reorder',
    'instrument.set', 'arpeggiator.set',
    'automation.set', 'automation.delete', 'sidechain.set', 'sidechain.remove',
  ],
  limits: controlLimitsV1,
} satisfies z.input<typeof controlCapabilitiesSchemaV1>

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

export const parseControlSnapshotQueryV1 = (input: unknown) => (
  controlSnapshotQuerySchemaV1.parse(input)
)

export const parseControlHistoryQueryV1 = (input: unknown) => (
  controlHistoryQuerySchemaV1.parse(input)
)

export const controlRequestDigestInputV1 = (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1,
) => canonicalJson({
  version: request.version,
  projectId: request.projectId,
  ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
  actions: request.actions,
})

export const controlRequestDigestV1 = async (
  request: ControlCommitRequestV1 | ControlPreviewRequestV1,
) => {
  const bytes = new TextEncoder().encode(controlRequestDigestInputV1(request))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export { planControlRequestV1 } from './planner'
export type { ControlPlanError, ControlPlanV1, PlannedControlActionV1 } from './planner'
export {
  collectDeletedTrackIdsV1,
  collectTrackDeletionAffectedIdsV1,
} from './trackDeletion'
