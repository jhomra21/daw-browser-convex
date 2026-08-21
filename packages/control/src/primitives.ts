import { z } from 'zod'

export const stableIdSchema = z.string().min(1).max(256).describe('Opaque identifier returned by the control API.')
const hasAsciiControlCharacter = (value: string) => (
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
)
export const projectIdSchema = stableIdSchema.refine(
  (projectId) => (
    projectId !== '.'
    && projectId !== '..'
    && !hasAsciiControlCharacter(projectId)
    && !/[/\\?#]|%(?:[01][0-9a-f]|7f|2f|5c|3f|23)/i.test(projectId)
  ),
  'Project IDs must be opaque URL-safe identifiers.',
).describe('Project identifier returned by project discovery or a project snapshot.')
export const clientRefValueSchema = z.string().min(1).max(256).describe('Client reference used to address an entity created in the same request.')
export const nameSchema = z.string().trim().min(1).max(120).describe('Non-empty display name.')
export const finiteNumberSchema = z.number().finite()
export const secondsSchema = finiteNumberSchema.min(0)
export const trackColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
export const clipColorSchema = z.union([
  trackColorSchema,
  z.literal('clip-audio'),
  z.literal('clip-midi'),
  z.literal('clip-recording'),
])
export const trackRoleSchema = z.enum(['track', 'group', 'return'])
export const revisionSchema = z.number().int().nonnegative().describe('Project revision returned by the latest snapshot or preview.')
export const requestDigestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Request digest must be a lowercase SHA-256 hex digest.')
export const approvalTokenSchemaV1 = z.string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Approval tokens must be URL-safe opaque values.')
  .describe('One-time token returned by control_request_approval for the exact destructive request.')
export const opaqueCursorSchema = z.string()
  .min(1)
  .max(2_048)
  .regex(/^[\x20-\x7e]+$/, 'Cursor must contain printable ASCII characters only.')

export const stableIdSchemaV1 = stableIdSchema
export const projectIdSchemaV1 = projectIdSchema
export const clientRefSchemaV1 = clientRefValueSchema
export const contextualRefSchemaV1 = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('persisted').describe('Address an entity already present in the snapshot.'),
    id: stableIdSchema.describe('Entity ID from the latest snapshot.'),
  }).strict(),
  z.object({
    source: z.literal('client').describe('Address an entity created earlier in this request.'),
    clientRef: clientRefValueSchema,
  }).strict(),
]).describe('Reference by persisted snapshot ID or same-request client reference.')
export const trackRefSchemaV1 = contextualRefSchemaV1.describe('Track reference: use {source:"persisted",id:"<id from snapshot>"} for an existing track.')
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
export const clipFadesSnapshotSchema = z.object({
  fadeInStartSec: secondsSchema.optional(),
  fadeInSec: secondsSchema,
  fadeOutSec: secondsSchema,
  fadeOutEndSec: secondsSchema.optional(),
  fadeInCurve: finiteNumberSchema,
  fadeOutCurve: finiteNumberSchema,
  fadeInCurvePosition: finiteNumberSchema.optional(),
  fadeOutCurvePosition: finiteNumberSchema.optional(),
}).strict()
export const audioWarpSchema = z.object({
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
export const automationPointSchema = z.object({
  id: stableIdSchema,
  timeSec: secondsSchema,
  value: finiteNumberSchema,
  interpolation: z.enum(['linear', 'hold']),
}).strict()

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
