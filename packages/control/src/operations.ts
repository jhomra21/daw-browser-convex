import { z } from 'zod'

import {
  canonicalControlCapabilitiesQuerySchema,
  canonicalControlCapabilitiesSchema,
} from './versions'
import {
  controlApprovalRequestSchemaV1,
  controlApprovalResultSchemaV1,
  controlCommitRequestSchemaV1,
  controlCommitResultSchemaV1,
  controlHistoryQuerySchemaV1,
  controlHistoryResultSchemaV1,
  controlRecoveriesQuerySchemaV1,
  controlRecoveriesResultSchemaV1,
  controlPreviewRequestSchemaV1,
  controlPreviewResultSchemaV1,
  canonicalControlSnapshotQuerySchema,
} from './actions'
import { canonicalProjectSnapshotSchema } from './snapshots'
import { nameSchema, projectIdSchema } from './primitives'

export const controlOperationTargetSchema = z.enum(['cloud', 'desktop'])
export type ControlOperationTarget = z.infer<typeof controlOperationTargetSchema>

export const controlOperationEffectSchema = z.enum(['read', 'preview', 'write', 'runtime'])
export type ControlOperationEffect = z.infer<typeof controlOperationEffectSchema>

export const controlOperationIdempotencySchema = z.enum(['safe', 'keyed', 'none'])
export type ControlOperationIdempotency = z.infer<typeof controlOperationIdempotencySchema>

export const controlOperationApprovalSchema = z.enum(['never', 'conditional'])
export type ControlOperationApproval = z.infer<typeof controlOperationApprovalSchema>

export const projectDiscoveryEntrySchema = z.object({
  projectId: projectIdSchema,
  name: nameSchema.optional(),
}).strict()
export type ProjectDiscoveryEntry = z.infer<typeof projectDiscoveryEntrySchema>

export const projectListInputSchema = z.object({}).strict()
export type ProjectListInput = z.infer<typeof projectListInputSchema>

export const maxProjectDiscoveryResults = 1_000
export const projectListResultSchema = z.object({
  projects: z.array(projectDiscoveryEntrySchema)
    .max(maxProjectDiscoveryResults)
    .readonly(),
}).strict()
export type ProjectListResult = z.infer<typeof projectListResultSchema>

export const projectCurrentInputSchema = z.object({}).strict()
export type ProjectCurrentInput = z.infer<typeof projectCurrentInputSchema>

const currentProjectSchema = projectDiscoveryEntrySchema
export const projectCurrentResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('present'),
    project: currentProjectSchema,
  }).strict(),
  z.object({
    status: z.literal('absent'),
  }).strict(),
])
export type ProjectCurrentResult = z.infer<typeof projectCurrentResultSchema>

type ControlOperationSchema = z.ZodTypeAny

export type ControlOperationDescriptor<
  Id extends string = string,
  InputSchema extends ControlOperationSchema = ControlOperationSchema,
  OutputSchema extends ControlOperationSchema = ControlOperationSchema,
> = {
  readonly id: Id
  readonly input: InputSchema
  readonly output: OutputSchema
  readonly effect: ControlOperationEffect
  readonly idempotency: ControlOperationIdempotency
  readonly targets: readonly ControlOperationTarget[]
  readonly approval: ControlOperationApproval
}

const defineControlOperationCatalog = <
  Catalog extends Record<string, ControlOperationDescriptor>,
>(catalog: Catalog): Readonly<Catalog> => {
  for (const [operationId, descriptor] of Object.entries(catalog)) {
    if (operationId !== descriptor.id) {
      throw new Error(`Control operation descriptor ID does not match catalog key: ${operationId}.`)
    }
    Object.freeze(descriptor.targets)
    Object.freeze(descriptor)
  }
  return Object.freeze(catalog)
}

export const controlOperationCatalog = defineControlOperationCatalog({
  'project.list': {
    id: 'project.list',
    input: projectListInputSchema,
    output: projectListResultSchema,
    effect: 'read',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'project.current': {
    id: 'project.current',
    input: projectCurrentInputSchema,
    output: projectCurrentResultSchema,
    effect: 'read',
    idempotency: 'safe',
    targets: ['desktop'],
    approval: 'never',
  },
  'control.capabilities': {
    id: 'control.capabilities',
    input: canonicalControlCapabilitiesQuerySchema,
    output: canonicalControlCapabilitiesSchema,
    effect: 'read',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'control.snapshot': {
    id: 'control.snapshot',
    input: canonicalControlSnapshotQuerySchema,
    output: canonicalProjectSnapshotSchema,
    effect: 'read',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'control.preview': {
    id: 'control.preview',
    input: controlPreviewRequestSchemaV1,
    output: controlPreviewResultSchemaV1,
    effect: 'preview',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'control.requestApproval': {
    id: 'control.requestApproval',
    input: controlApprovalRequestSchemaV1,
    output: controlApprovalResultSchemaV1,
    effect: 'write',
    idempotency: 'none',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'control.commit': {
    id: 'control.commit',
    input: controlCommitRequestSchemaV1,
    output: controlCommitResultSchemaV1,
    effect: 'write',
    idempotency: 'keyed',
    targets: ['cloud', 'desktop'],
    approval: 'conditional',
  },
  'control.history': {
    id: 'control.history',
    input: controlHistoryQuerySchemaV1,
    output: controlHistoryResultSchemaV1,
    effect: 'read',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
  'control.recoveries': {
    id: 'control.recoveries',
    input: controlRecoveriesQuerySchemaV1,
    output: controlRecoveriesResultSchemaV1,
    effect: 'read',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  },
})

export type ControlOperationId = keyof typeof controlOperationCatalog

export type ControlOperationMap = {
  [Id in ControlOperationId]: {
    input: z.output<typeof controlOperationCatalog[Id]['input']>
    output: z.output<typeof controlOperationCatalog[Id]['output']>
  }
}

export type ControlInput<Id extends ControlOperationId> = ControlOperationMap[Id]['input']
export type ControlOutput<Id extends ControlOperationId> = ControlOperationMap[Id]['output']

export const controlOperationIdSchema = z.string().refine(
  (operationId): operationId is ControlOperationId => Object.hasOwn(controlOperationCatalog, operationId),
  'Unknown control operation.',
)

export const parseControlOperationId = <Input>(input: Input): ControlOperationId => (
  controlOperationIdSchema.parse(input)
)

export const listControlOperationDescriptors = (): readonly ControlOperationDescriptor[] => (
  Object.freeze(Object.values(controlOperationCatalog))
)

export const getControlOperationDescriptor = (
  operationId: unknown,
): ControlOperationDescriptor => {
  const parsedOperationId = parseControlOperationId(operationId)
  return controlOperationCatalog[parsedOperationId]
}

export const supportsControlOperation = (
  operationId: unknown,
  target: ControlOperationTarget,
): boolean => {
  const parsedOperationId = controlOperationIdSchema.safeParse(operationId)
  if (!parsedOperationId.success) return false
  return controlOperationCatalog[parsedOperationId.data].targets.some((candidate) => candidate === target)
}

export class UnsupportedControlTargetError extends Error {
  readonly operationId: ControlOperationId
  readonly target: ControlOperationTarget

  constructor(operationId: ControlOperationId, target: ControlOperationTarget) {
    super(`Control operation ${operationId} is not supported on the ${target} target.`)
    this.name = 'UnsupportedControlTargetError'
    this.operationId = operationId
    this.target = target
  }
}

export const assertControlOperationSupported = (
  operationId: unknown,
  target: ControlOperationTarget,
): ControlOperationId => {
  const parsedOperationId = parseControlOperationId(operationId)
  if (!controlOperationCatalog[parsedOperationId].targets.some((candidate) => candidate === target)) {
    throw new UnsupportedControlTargetError(parsedOperationId, target)
  }
  return parsedOperationId
}

export type ControlRequestContext = {
  readonly target: ControlOperationTarget
  readonly principal?: {
    readonly subject: string
    readonly issuer?: string
    readonly tokenIdentifier?: string
  }
}

export type ControlHandler<Id extends ControlOperationId> = (
  input: ControlInput<Id>,
  context: ControlRequestContext,
) => ControlOutput<Id> | PromiseLike<ControlOutput<Id>>

export type ControlOperationHandlers = {
  [Id in ControlOperationId]: ControlHandler<Id>
}

const invokeControlOperation = async (
  handlers: ControlOperationHandlers,
  operationId: ControlOperationId,
  input: unknown,
  context: ControlRequestContext,
): Promise<ControlOutput<ControlOperationId>> => {
  switch (operationId) {
    case 'project.list':
      return projectListResultSchema.parse(await handlers[operationId](
        projectListInputSchema.parse(input),
        context,
      ))
    case 'project.current':
      return projectCurrentResultSchema.parse(await handlers[operationId](
        projectCurrentInputSchema.parse(input),
        context,
      ))
    case 'control.capabilities':
      return canonicalControlCapabilitiesSchema.parse(await handlers[operationId](
        canonicalControlCapabilitiesQuerySchema.parse(input),
        context,
      ))
    case 'control.snapshot':
      return canonicalProjectSnapshotSchema.parse(await handlers[operationId](
        canonicalControlSnapshotQuerySchema.parse(input),
        context,
      ))
    case 'control.preview':
      return controlPreviewResultSchemaV1.parse(await handlers[operationId](
        controlPreviewRequestSchemaV1.parse(input),
        context,
      ))
    case 'control.requestApproval':
      return controlApprovalResultSchemaV1.parse(await handlers[operationId](
        controlApprovalRequestSchemaV1.parse(input),
        context,
      ))
    case 'control.commit':
      return controlCommitResultSchemaV1.parse(await handlers[operationId](
        controlCommitRequestSchemaV1.parse(input),
        context,
      ))
    case 'control.history':
      return controlHistoryResultSchemaV1.parse(await handlers[operationId](
        controlHistoryQuerySchemaV1.parse(input),
        context,
      ))
    case 'control.recoveries':
      return controlRecoveriesResultSchemaV1.parse(await handlers[operationId](
        controlRecoveriesQuerySchemaV1.parse(input),
        context,
      ))
  }
}

export function dispatchControlOperation<Id extends ControlOperationId>(
  handlers: ControlOperationHandlers,
  operationId: Id,
  input: unknown,
  context: ControlRequestContext,
): Promise<ControlOutput<Id>>
export function dispatchControlOperation(
  handlers: ControlOperationHandlers,
  operationId: unknown,
  input: unknown,
  context: ControlRequestContext,
): Promise<ControlOutput<ControlOperationId>>
export function dispatchControlOperation(
  handlers: ControlOperationHandlers,
  operationId: unknown,
  input: unknown,
  context: ControlRequestContext,
): Promise<ControlOutput<ControlOperationId>> {
  const parsedOperationId = assertControlOperationSupported(operationId, context.target)
  return invokeControlOperation(handlers, parsedOperationId, input, context)
}
