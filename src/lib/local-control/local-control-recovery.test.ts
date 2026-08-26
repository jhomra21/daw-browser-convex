import { expect, test } from 'bun:test'
import type {
  LocalExternalProcessorRecoveryBundle,
  LocalProjectExternalPluginArtifactRow,
} from '~/lib/local-project-db'
import {
  hashLocalExternalProcessorRecoveryBundles,
  localExternalRecoveryUsage,
  maxLocalProjectExternalRecoveryBytes,
  maxLocalRecoveryExternalArtifactBytes,
  maxLocalRecoveryExternalArtifactCount,
  localRecoveryArtifactsMatch,
  validateLocalProjectExternalRecoveryBytes,
} from './local-control-recovery'

const artifact = (id: string, byteLength: number, payload?: Uint8Array): LocalProjectExternalPluginArtifactRow => ({
  id,
  sha256: 'a'.repeat(64),
  byteLength,
  kind: 'plugin-state',
  ownerId: 'project',
  acl: 'owner',
  bucket: 'local',
  location: `plugin-artifacts/${id}`,
  payload,
  updatedAt: 0,
})

const bundle = (artifacts: LocalProjectExternalPluginArtifactRow[]): LocalExternalProcessorRecoveryBundle => ({
  version: 1,
  entity: { kind: 'external-plugin', id: 'external-plugin:processor', value: null, updatedAt: 0 },
  artifacts,
})

test('enforces exact per-recovery external artifact boundaries', () => {
  expect(localExternalRecoveryUsage([
    bundle(Array.from({ length: maxLocalRecoveryExternalArtifactCount }, (_, index) => artifact(`a-${index}`, 1))),
  ]).artifactCount).toBe(maxLocalRecoveryExternalArtifactCount)
  expect(() => localExternalRecoveryUsage([
    bundle(Array.from({ length: maxLocalRecoveryExternalArtifactCount + 1 }, (_, index) => artifact(`a-${index}`, 1))),
  ])).toThrow('limits exceeded')
  expect(localExternalRecoveryUsage([bundle([artifact('boundary', maxLocalRecoveryExternalArtifactBytes)])]).byteLength)
    .toBe(maxLocalRecoveryExternalArtifactBytes)
  expect(() => localExternalRecoveryUsage([bundle([artifact('over', maxLocalRecoveryExternalArtifactBytes + 1)])]))
    .toThrow('limits exceeded')
})

test('accounts aggregate project recovery bytes and hashes metadata without payload expansion', () => {
  const oneMiB = (prefix: string) => bundle([
    artifact(`${prefix}-a`, maxLocalRecoveryExternalArtifactBytes / 2),
    artifact(`${prefix}-b`, maxLocalRecoveryExternalArtifactBytes / 2),
  ])
  const retained = Array.from({ length: 8 }, (_, index) => oneMiB(`retained-${index}`))
  const retainedBytes = retained.reduce((total, value) => total + localExternalRecoveryUsage([value]).byteLength, 0)
  expect(retainedBytes).toBe(maxLocalProjectExternalRecoveryBytes)
  expect(() => validateLocalProjectExternalRecoveryBytes(retainedBytes)).not.toThrow()
  expect(() => validateLocalProjectExternalRecoveryBytes(retainedBytes + 1)).toThrow('exceeded')
  const withPayload = bundle([{ ...artifact('hash', 1), payload: new Uint8Array([1, 2, 3]) }])
  const withoutPayload = bundle([artifact('hash', 1)])
  expect(hashLocalExternalProcessorRecoveryBundles([withPayload]))
    .toBe(hashLocalExternalProcessorRecoveryBundles([withoutPayload]))
})

test('reuses only byte-for-byte identical shared local artifacts', () => {
  const existing = artifact('shared', 3, new Uint8Array([1, 2, 3]))
  expect(localRecoveryArtifactsMatch(existing, { ...existing, updatedAt: 10 })).toBe(true)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, payload: new Uint8Array([1, 2, 4]) })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, sha256: 'b'.repeat(64) })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, byteLength: 4 })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, ownerId: 'other' })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, acl: 'project-members' })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, bucket: 'r2-plugin-artifacts' })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, location: 'other' })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, kind: 'plugin-freeze' })).toBe(false)
  expect(localRecoveryArtifactsMatch(existing, { ...existing, payload: undefined })).toBe(false)
})
