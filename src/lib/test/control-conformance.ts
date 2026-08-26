import { expect } from 'bun:test'
import { z } from 'zod'
import {
  UnsupportedControlTargetError,
  controlErrorSchemaV1,
  type ControlOperationId,
  type ControlOperationIdInput,
  type ControlOperationInput,
  type ControlErrorV1,
  type ControlOutput,
  type ControlOperationTarget,
  type ControlPreviewRequestV1,
} from '@daw-browser/control'

export type ControlConformanceInvoker = (
  operation: ControlOperationIdInput,
  input: ControlOperationInput,
  target: ControlOperationTarget,
) => Promise<ControlOutput<ControlOperationId>>

export const normalizeControlError = <Input>(error: Input): ControlErrorV1 | undefined => {
  const direct = controlErrorSchemaV1.safeParse(error)
  if (direct.success) return direct.data
  const envelope = z.object({ data: z.unknown() }).safeParse(error)
  if (envelope.success) {
    const serialized = z.string().safeParse(envelope.data.data)
    const parsedValue = serialized.success
      ? (() => {
          try {
            return JSON.parse(serialized.data)
          } catch {
            return undefined
          }
        })()
      : envelope.data.data
    const parsed = controlErrorSchemaV1.safeParse(parsedValue)
    if (parsed.success) return parsed.data
  }
  return undefined
}

const expectErrorCode = async (
  invoke: ControlConformanceInvoker,
  operation: ControlOperationIdInput,
  request: ControlOperationInput,
  target: ControlOperationTarget,
  expected: readonly string[],
) => {
  let failure: ControlErrorV1 | undefined
  try {
    await invoke(operation, request, target)
  } catch (error) {
    failure = normalizeControlError(error)
  }
  expect(failure).toBeDefined()
  const normalized = controlErrorSchemaV1.safeParse(failure)
  expect(normalized.success).toBe(true)
  if (!normalized.success) return
  expect(expected.includes(normalized.data.code)).toBe(true)
  expect(normalized.data.version).toBe('v1')
}

export const runControlConformance = async (input: {
  invoke: ControlConformanceInvoker
  projectId: string
  target: ControlOperationTarget
  missingProjectErrorCode: ControlErrorV1['code']
  destructiveRequest: ControlPreviewRequestV1
}) => {
  const initial = await input.invoke('control.snapshot', { projectId: input.projectId }, input.target)
  expect(initial).toMatchObject({ version: 'v2', project: { id: input.projectId } })

  const listed = await input.invoke('project.list', {}, input.target)
  const listedProjects = z.object({
    projects: z.array(z.object({ projectId: z.string() })),
  }).parse(listed).projects
  expect(listedProjects.some((project) => project.projectId === input.projectId)).toBe(true)
  expect(await input.invoke('control.capabilities', {}, input.target)).toMatchObject({
    version: 'v2',
    executionTarget: expect.any(String),
  })

  const renameRequest = {
    version: 'v1',
    projectId: input.projectId,
    actions: [{ kind: 'project.rename', name: 'Conformance rename' }],
  } satisfies ControlPreviewRequestV1
  const beforePreview = JSON.stringify(initial)
  const preview = await input.invoke('control.preview', renameRequest, input.target)
  expect(preview).toMatchObject({ projectId: input.projectId, applied: true })
  expect(JSON.stringify(await input.invoke('control.snapshot', { projectId: input.projectId }, input.target)))
    .toBe(beforePreview)

  await expectErrorCode(input.invoke, 'control.commit', {
    ...input.destructiveRequest,
    idempotencyKey: 'conformance-approval-required',
  }, input.target, ['approval-required'])
  const approval = await input.invoke('control.requestApproval', input.destructiveRequest, input.target)
  expect(approval).toMatchObject({ version: 'v1', requestDigest: expect.any(String) })
  const commitRequest = {
    ...input.destructiveRequest,
    idempotencyKey: 'conformance-commit',
    approvalToken: z.object({ approvalToken: z.string() }).parse(approval).approvalToken,
  }
  const committed = await input.invoke('control.commit', commitRequest, input.target)
  expect(committed).toMatchObject({ applied: true, idempotencyReplay: false })
  expect(await input.invoke('control.commit', commitRequest, input.target))
    .toMatchObject({ idempotencyReplay: true })

  await expectErrorCode(input.invoke, 'control.commit', {
    ...commitRequest,
    actions: [{ kind: 'project.rename', name: 'Different request' }],
  }, input.target, ['idempotency-conflict'])
  await expectErrorCode(input.invoke, 'control.commit', {
    ...commitRequest,
    idempotencyKey: 'conformance-revision-conflict',
    expectedRevision: 0,
  }, input.target, ['revision-conflict'])

  const history = await input.invoke('control.history', { projectId: input.projectId, limit: 10 }, input.target)
  expect(history).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ projectId: input.projectId })]) })
  const recoveries = await input.invoke('control.recoveries', { projectId: input.projectId, limit: 10 }, input.target)
  expect(recoveries).toMatchObject({ entries: expect.any(Array) })

  await expect(input.invoke('control.preview', { projectId: input.projectId, unexpected: true }, input.target))
    .rejects.toThrow()
  if (input.target === 'desktop') {
    await expect(input.invoke('project.current', {}, 'cloud')).rejects.toBeInstanceOf(UnsupportedControlTargetError)
  }
  await expectErrorCode(input.invoke, 'control.snapshot', { projectId: 'missing-project' }, input.target, [
    input.missingProjectErrorCode,
  ])

}
