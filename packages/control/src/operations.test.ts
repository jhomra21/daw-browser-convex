import { expect, test } from 'bun:test'

import {
  assertControlOperationSupported,
  canonicalControlCapabilities,
  controlOperationCatalog,
  dispatchControlOperation,
  getControlOperationDescriptor,
  listControlOperationDescriptors,
  parseControlOperationId,
  projectCurrentResultSchema,
  projectListInputSchema,
  projectListResultSchema,
  supportsControlOperation,
  UnsupportedControlTargetError,
  type ControlOperationHandlers,
  type ControlOutput,
  type ControlRequestContext,
} from '@daw-browser/control'

const snapshot = {
  version: 'v2',
  project: {
    id: 'project-1',
    name: 'Project',
    revision: 1,
    tempoBpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    loop: { enabled: false, startSec: 0, endSec: 8 },
    masterVolume: 0.8,
    updatedAt: 1,
  },
  tracks: [],
  clips: [],
  processors: [],
  automation: [],
  sidechains: [],
  assets: [],
  assetFolders: [],
} satisfies ControlOutput<'control.snapshot'>

const handlers = {
  'project.list': () => ({ projects: [{ projectId: 'project-1', name: 'Project' }] }),
  'project.current': () => ({ status: 'present', project: { projectId: 'project-1' } }),
  'control.capabilities': () => canonicalControlCapabilities,
  'control.snapshot': () => snapshot,
  'control.preview': () => ({
    version: 'v1',
    projectId: 'project-1',
    priorRevision: 1,
    revision: 1,
    applied: false,
    requestDigest: '0'.repeat(64),
    resolvedRefs: [],
    warnings: [],
    changeSummary: { actionCount: 0, changes: [] },
  }),
  'control.requestApproval': () => ({
    version: 'v1',
    approvalToken: 'a'.repeat(32),
    requestDigest: '0'.repeat(64),
    baseRevision: 1,
    actionIndexes: [0],
    expiresAt: 1,
  }),
  'control.commit': () => ({
    version: 'v1',
    projectId: 'project-1',
    priorRevision: 1,
    revision: 1,
    applied: false,
    idempotencyReplay: false,
    requestDigest: '0'.repeat(64),
    resolvedRefs: [],
    warnings: [],
    changeSummary: { actionCount: 0, changes: [] },
    recoveries: [],
    restored: [],
  }),
  'control.history': () => ({ entries: [], continueCursor: 'cursor', isDone: true }),
  'control.recoveries': () => ({ entries: [], continueCursor: 'cursor', isDone: true }),
} satisfies ControlOperationHandlers

test('defines exactly the canonical operation IDs once', () => {
  expect(Object.keys(controlOperationCatalog)).toEqual([
    'project.list',
    'project.current',
    'control.capabilities',
    'control.snapshot',
    'control.preview',
    'control.requestApproval',
    'control.commit',
    'control.history',
    'control.recoveries',
  ])
  expect(listControlOperationDescriptors()).toHaveLength(9)
  expect(getControlOperationDescriptor('control.snapshot').id).toBe('control.snapshot')
})

test('exposes truthful target, effect, idempotency, and approval metadata', () => {
  expect(controlOperationCatalog['project.current']).toMatchObject({
    effect: 'read',
    idempotency: 'safe',
    targets: ['desktop'],
    approval: 'never',
  })
  expect(controlOperationCatalog['project.list'].targets).toEqual(['cloud', 'desktop'])
  expect(controlOperationCatalog['control.preview']).toMatchObject({
    effect: 'preview',
    idempotency: 'safe',
    targets: ['cloud', 'desktop'],
    approval: 'never',
  })
  expect(controlOperationCatalog['control.commit']).toMatchObject({
    effect: 'write',
    idempotency: 'keyed',
    targets: ['cloud', 'desktop'],
    approval: 'conditional',
  })
})

test('keeps project discovery inputs strict and results bounded', () => {
  expect(projectListInputSchema.parse({})).toEqual({})
  expect(() => projectListInputSchema.parse({ projectId: 'project-1' })).toThrow()
  expect(projectListResultSchema.parse({ projects: [{ projectId: 'project-1' }] })).toEqual({
    projects: [{ projectId: 'project-1' }],
  })
  expect(() => projectListResultSchema.parse({
    projects: Array.from({ length: 1_001 }, (_, index) => ({ projectId: `project-${index}` })),
  })).toThrow()
  expect(projectCurrentResultSchema.parse({ status: 'absent' })).toEqual({ status: 'absent' })
  expect(() => projectCurrentResultSchema.parse({ status: 'present' })).toThrow()
})

test('validates both dispatch inputs and outputs through the catalog', async () => {
  const context: ControlRequestContext = { target: 'desktop', principal: { subject: 'user-1' } }
  await expect(dispatchControlOperation(handlers, 'project.list', {}, context)).resolves.toEqual({
    projects: [{ projectId: 'project-1', name: 'Project' }],
  })
  await expect(dispatchControlOperation(handlers, 'control.capabilities', {}, context)).resolves.toEqual(
    canonicalControlCapabilities,
  )
  await expect(dispatchControlOperation(handlers, 'project.list', { unexpected: true }, context)).rejects.toThrow()
  await expect(dispatchControlOperation({
    ...handlers,
    'project.list': () => ({ projects: [{ projectId: 'project-1', extra: true }] }),
  }, 'project.list', {}, context)).rejects.toThrow()
})

test('rejects unknown operations and unsupported targets before dispatch', () => {
  expect(() => parseControlOperationId('control.unknown')).toThrow()
  expect(supportsControlOperation('project.current', 'desktop')).toBe(true)
  expect(supportsControlOperation('project.current', 'cloud')).toBe(false)
  expect(() => assertControlOperationSupported('project.current', 'cloud')).toThrow(UnsupportedControlTargetError)
  expect(() => dispatchControlOperation(handlers, 'project.current', {}, { target: 'cloud' })).toThrow(
    'not supported on the cloud target',
  )
})
