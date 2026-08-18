import { describe, expect, test } from 'bun:test'
import {
  assertProjectManifestPublishIntegrity,
  normalizeProjectManifest,
  parseProjectManifest,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS,
  type ProjectManifest,
} from './project-manifest-contract'

const manifestV1: ProjectManifest = {
  schemaVersion: 1,
  projectId: 'project-1',
  name: 'Fixture',
  mode: 'backup',
  updatedAt: 100,
  entityCount: 1,
  assetCount: 0,
  entities: [{ kind: 'track', id: 'track-1', value: { name: 'Track' }, updatedAt: 100 }],
  assets: [],
  projectState: [],
  syncState: [],
  externalPluginArtifacts: [],
}

describe('project format boundaries', () => {
  test('reports the current manifest schema version', () => {
    expect(SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS).toEqual([1, 2, 3, PROJECT_MANIFEST_SCHEMA_VERSION])
  })

  test('reads the current manifest schema without migration', () => {
    const manifest = { ...manifestV1, schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION }
    expect(normalizeProjectManifest(manifest)).toEqual(manifest)
    expect(parseProjectManifest(JSON.stringify(manifest))).toEqual(manifest)
  })

  test('migrates legacy manifests idempotently', () => {
    const legacy = { ...manifestV1, schemaVersion: 1 }
    const migrated = normalizeProjectManifest(legacy)
    expect(migrated.schemaVersion).toBe(PROJECT_MANIFEST_SCHEMA_VERSION)
    expect(migrated.externalPluginArtifacts).toEqual([])
    expect(normalizeProjectManifest(migrated)).toEqual(migrated)
  })

  test('rejects unsupported writer versions', () => {
    expect(() => normalizeProjectManifest({ ...manifestV1, schemaVersion: 5 })).toThrow(
      'Unsupported project manifest schema version 5.',
    )
    expect(() => normalizeProjectManifest({ ...manifestV1, schemaVersion: 0 })).toThrow(
      'Unsupported project manifest schema version 0.',
    )
  })

  test('preserves external plugin artifact metadata without state payloads', () => {
    const manifest: ProjectManifest = {
      ...manifestV1,
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      externalPluginArtifacts: [{
        id: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
        sha256: 'a'.repeat(64),
        byteLength: 12,
        kind: 'plugin-state',
        ownerId: 'user-1',
        acl: 'owner',
        bucket: 'local',
        location: 'plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
      }],
    }
    expect(normalizeProjectManifest(manifest).externalPluginArtifacts).toEqual(manifest.externalPluginArtifacts)
  })

  test('rejects invalid external plugin artifact metadata', () => {
    const artifact = {
      id: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
      sha256: 'a'.repeat(64),
      byteLength: 12,
      kind: 'plugin-state',
      ownerId: 'user-1',
      acl: 'owner',
      bucket: 'local',
      location: 'plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
    }
    const manifest = {
      ...manifestV1,
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      externalPluginArtifacts: [artifact],
    }
    expect(() => normalizeProjectManifest({
      ...manifest,
      externalPluginArtifacts: [{ ...artifact, id: 'not-a-uuid' }],
    })).toThrow('artifact id')
    expect(() => normalizeProjectManifest({
      ...manifest,
      externalPluginArtifacts: [{ ...artifact, sha256: 'A'.repeat(64) }],
    })).toThrow('artifact hash')
    expect(() => normalizeProjectManifest({
      ...manifest,
      externalPluginArtifacts: [{ ...artifact, byteLength: 0 }],
    })).toThrow('byte length')
    expect(() => normalizeProjectManifest({
      ...manifest,
      externalPluginArtifacts: [{ ...artifact, ownerId: '' }],
    })).toThrow('ownerId')
    expect(() => normalizeProjectManifest({
      ...manifest,
      externalPluginArtifacts: [{ ...artifact, location: 'x'.repeat(1025) }],
    })).toThrow('artifact metadata')
  })

  test('rejects plugin artifact R2 locations from generic backup publishing', () => {
    const manifest: ProjectManifest = {
      ...manifestV1,
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      externalPluginArtifacts: [{
        id: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
        sha256: 'a'.repeat(64),
        byteLength: 12,
        kind: 'plugin-state',
        ownerId: 'user-1',
        acl: 'owner',
        bucket: 'r2-plugin-artifacts',
        location: 'projects/project-1/plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
      }],
    }
    expect(() => assertProjectManifestPublishIntegrity(manifest)).toThrow(
      'external plugin artifacts cannot be published',
    )
  })

  test('preserves current effect entity values without migration', () => {
    const manifest: ProjectManifest = {
      ...manifestV1,
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      entityCount: 3,
      entities: [
        { kind: 'effect', id: 'utility-1', value: { effect: 'utility', params: { gainDb: 3 } }, updatedAt: 100 },
        { kind: 'effect', id: 'gate-1', value: { effect: 'gate', params: { version: 1, state: { thresholdDb: -30 } } }, updatedAt: 100 },
        manifestV1.entities[0],
      ],
    }
    const normalized = normalizeProjectManifest(manifest)
    expect(normalized.entities[0]?.value).toEqual(manifest.entities[0]?.value)
    expect(normalized.entities[1]).toEqual(manifest.entities[1])
    expect(normalized.entities[2]).toEqual(manifestV1.entities[0])
  })

  test('roundtrips structured automation targets and opaque keys in generic entities', () => {
    const targetKey = 'automation:v2:["track","track:colon","delay:instance:colon","delay.feedback"]'
    const manifest: ProjectManifest = {
      ...manifestV1,
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      entities: [{
        kind: 'automation-envelope',
        id: targetKey,
        value: {
          target: {
            kind: 'track',
            trackId: 'track:colon',
            effectInstanceId: 'delay:instance:colon',
          },
          targetKey,
          parameterId: 'delay.feedback',
        },
        updatedAt: 100,
      }],
    }

    const roundtripped = normalizeProjectManifest(JSON.parse(JSON.stringify(manifest)))
    expect(roundtripped.entities[0]).toEqual(manifest.entities[0])
  })
})
