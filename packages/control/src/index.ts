import { z } from 'zod'

export const CONTROL_API_VERSION_V1 = 'v1'

const stableIdSchema = z.string().min(1).max(256)
const nameSchema = z.string().trim().min(1).max(120)
const finiteNumberSchema = z.number().finite()
const secondsSchema = finiteNumberSchema.min(0)
const trackRoleSchema = z.enum(['track', 'group', 'return'])
const trackReferenceSchema = z.object({ trackId: stableIdSchema }).strict()

export const controlLimitsV1 = {
  maxActions: 100,
  maxSerializedBodyBytes: 256 * 1024,
  maxMidiNotesPerCommit: 500,
}

export const stableIdSchemaV1 = stableIdSchema
export const clientReferenceSchemaV1 = z.object({
  clientId: stableIdSchema,
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
  }).strict(),
}).strict()

const projectRenameActionSchema = z.object({
  kind: z.literal('project.rename'),
  projectId: stableIdSchema,
  name: nameSchema,
}).strict()
const projectSettingsActionSchema = z.object({
  kind: z.literal('project.settings.set'),
  projectId: stableIdSchema,
  tempoBpm: finiteNumberSchema.int().min(30).max(300).optional(),
  timeSignatureNumerator: finiteNumberSchema.int().min(1).max(32).optional(),
  timeSignatureDenominator: z.union([
    z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16), z.literal(32),
  ]).optional(),
  loopEnabled: z.boolean().optional(),
  loopStartSec: secondsSchema.optional(),
  loopEndSec: secondsSchema.optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Project settings action must change a setting.')
const trackCreateActionSchema = z.object({
  kind: z.literal('track.create'),
  projectId: stableIdSchema,
  client: clientReferenceSchemaV1.optional(),
  name: nameSchema.optional(),
  index: z.number().int().nonnegative().optional(),
  trackKind: z.enum(['audio', 'instrument']).optional(),
  channelRole: trackRoleSchema.optional(),
  color: z.string().max(64).optional(),
}).strict()
const trackRenameActionSchema = z.object({
  kind: z.literal('track.rename'),
  ...trackReferenceSchema.shape,
  name: nameSchema,
}).strict()
const trackMixActionSchema = z.object({
  kind: z.literal('track.mix.set'),
  ...trackReferenceSchema.shape,
  volume: finiteNumberSchema.min(0).max(2).optional(),
  muted: z.boolean().optional(),
  soloed: z.boolean().optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Track mix action must change a value.')
const trackRoutingActionSchema = z.object({
  kind: z.literal('track.routing.set'),
  ...trackReferenceSchema.shape,
  outputTargetTrackId: stableIdSchema.nullable().optional(),
  sends: z.array(z.object({
    targetTrackId: stableIdSchema,
    amount: finiteNumberSchema.min(0).max(2),
    tap: z.enum(['pre-fx', 'pre-fader', 'post-fader']).optional(),
  }).strict()).max(64).optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Track routing action must change routing.')
const trackReorderActionSchema = z.object({
  kind: z.literal('track.reorder'),
  projectId: stableIdSchema,
  tracks: z.array(z.object({
    trackId: stableIdSchema,
    index: z.number().int().nonnegative(),
    groupId: stableIdSchema.nullable(),
  }).strict()).min(1).max(500),
}).strict()
const trackGroupActionSchema = z.object({
  kind: z.literal('track.group.set'),
  ...trackReferenceSchema.shape,
  groupId: stableIdSchema.nullable(),
}).strict()
const trackDeleteActionSchema = z.object({ kind: z.literal('track.delete'), ...trackReferenceSchema.shape }).strict()
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
  client: clientReferenceSchemaV1.optional(),
  trackId: stableIdSchema,
  name: nameSchema.optional(),
  startSec: secondsSchema,
  duration: finiteNumberSchema.positive(),
  wave: z.enum(['sine', 'square', 'sawtooth', 'triangle']),
  notes: z.array(midiNoteSchema).max(controlLimitsV1.maxMidiNotesPerCommit),
  gain: finiteNumberSchema.min(0).max(2).optional(),
}).strict()
const clipMoveActionSchema = z.object({
  kind: z.literal('clip.move'),
  clipId: stableIdSchema,
  trackId: stableIdSchema,
  startSec: secondsSchema,
}).strict()
const clipTimingActionSchema = z.object({
  kind: z.literal('clip.timing.set'),
  clipId: stableIdSchema,
  duration: finiteNumberSchema.positive().optional(),
  gain: finiteNumberSchema.min(0).max(2).optional(),
  fadeInSec: secondsSchema.optional(),
  fadeOutSec: secondsSchema.optional(),
  leftPadSec: secondsSchema.optional(),
  bufferOffsetSec: secondsSchema.optional(),
  midiOffsetBeats: secondsSchema.optional(),
}).strict().refine((action) => Object.keys(action).length > 2, 'Clip timing action must change a value.')
const clipNameActionSchema = z.object({ kind: z.literal('clip.rename'), clipId: stableIdSchema, name: nameSchema }).strict()
const clipDeleteActionSchema = z.object({ kind: z.literal('clip.delete'), clipId: stableIdSchema }).strict()
const masterVolumeActionSchema = z.object({
  kind: z.literal('master.volume.set'),
  projectId: stableIdSchema,
  volume: finiteNumberSchema.min(0).max(2),
}).strict()

export const controlActionSchemaV1 = z.union([
  projectRenameActionSchema, projectSettingsActionSchema, trackCreateActionSchema,
  trackRenameActionSchema, trackMixActionSchema, trackRoutingActionSchema,
  trackReorderActionSchema, trackGroupActionSchema, trackDeleteActionSchema,
  clipCreateMidiActionSchema, clipMoveActionSchema, clipTimingActionSchema,
  clipNameActionSchema, clipDeleteActionSchema, masterVolumeActionSchema,
])

export const controlCommitRequestSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: stableIdSchema,
  actions: z.array(controlActionSchemaV1).min(1).max(controlLimitsV1.maxActions),
}).strict().superRefine((request, context) => {
  let midiNotes = 0
  for (const action of request.actions) {
    if (action.kind === 'clip.midi.create') midiNotes += action.notes.length
  }
  if (midiNotes > controlLimitsV1.maxMidiNotesPerCommit) {
    context.addIssue({
      code: 'custom',
      message: `Control commit exceeds ${controlLimitsV1.maxMidiNotesPerCommit} MIDI notes.`,
      path: ['actions'],
    })
  }
})

export const controlErrorSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  code: z.enum(['invalid-request', 'unsupported-action', 'revision-conflict', 'forbidden', 'not-found', 'limit-exceeded', 'internal']),
  message: z.string().min(1),
  actionIndex: z.number().int().nonnegative().optional(),
}).strict()

export const controlPreviewRequestSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  expectedRevision: z.number().int().nonnegative(),
  actions: z.array(controlActionSchemaV1).min(1).max(controlLimitsV1.maxActions),
}).strict()
export const controlPreviewResultSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  accepted: z.boolean(),
  errors: z.array(controlErrorSchemaV1),
}).strict()
export const controlCommitResultSchemaV1 = z.object({
  version: z.literal(CONTROL_API_VERSION_V1),
  revision: z.number().int().nonnegative(),
  appliedActionCount: z.number().int().nonnegative(),
}).strict()

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
    id: stableIdSchema,
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
}).strict()

export type ControlActionV1 = z.infer<typeof controlActionSchemaV1>
export type ControlCommitRequestV1 = z.infer<typeof controlCommitRequestSchemaV1>
export type ControlErrorV1 = z.infer<typeof controlErrorSchemaV1>
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

export const parseControlCommitRequestV1 = (input: unknown) => {
  const request = controlCommitRequestSchemaV1.parse(input)
  const serialized = canonicalJson(request)
  if (new TextEncoder().encode(serialized).byteLength > controlLimitsV1.maxSerializedBodyBytes) {
    throw new Error('Control request exceeds the serialized body limit.')
  }
  return request
}

export const controlRequestDigestInputV1 = (request: ControlCommitRequestV1) => canonicalJson(request)
