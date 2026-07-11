import { describe, expect, test } from 'bun:test'
import {
  migrateProjectManifest,
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
}

describe('project format boundaries', () => {
  test('reports the schema version handled by migration dispatch', () => {
    expect(SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS).toEqual([1, PROJECT_MANIFEST_SCHEMA_VERSION])
  })

  test('reads supported v1 manifests and is idempotent through one entry point', () => {
    const migrated = migrateProjectManifest(manifestV1)
    expect(migrated).toEqual({ ...manifestV1, schemaVersion: 2 })
    expect(migrateProjectManifest(migrated)).toEqual(migrated)
  })

  test('rejects unsupported writer versions', () => {
    expect(() => migrateProjectManifest({ ...manifestV1, schemaVersion: 3 })).toThrow(
      'Unsupported project manifest schema version 3.',
    )
    expect(() => migrateProjectManifest({ ...manifestV1, schemaVersion: 0 })).toThrow(
      'Unsupported project manifest schema version 0.',
    )
  })

  test('migrates utility and gate rows to versioned state envelopes without changing other rows', () => {
    const manifest = {
      ...manifestV1,
      entityCount: 3,
      entities: [
        { kind: 'effect', id: 'utility-1', value: { effect: 'utility', params: { gainDb: 3 } }, updatedAt: 100 },
        { kind: 'effect', id: 'gate-1', value: { effect: 'gate', params: { version: 1, state: { thresholdDb: -30 } } }, updatedAt: 100 },
        manifestV1.entities[0],
      ],
    }
    const migrated = migrateProjectManifest(manifest)
    expect(migrated.entities[0]?.value).toEqual({ effect: 'utility', params: { version: 1, state: { gainDb: 3 } } })
    expect(migrated.entities[1]).toEqual(manifest.entities[1])
    expect(migrated.entities[2]).toEqual(manifestV1.entities[0])
    expect(migrateProjectManifest(migrated)).toEqual(migrated)
  })

  test('roundtrips structured automation targets and opaque keys in generic entities', () => {
    const targetKey = 'automation:v2:["track","track:colon","delay:instance:colon","delay.feedback"]'
    const manifest: ProjectManifest = {
      ...manifestV1,
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

    const roundtripped = migrateProjectManifest(JSON.parse(JSON.stringify(manifest)))
    expect(roundtripped.entities[0]).toEqual(manifest.entities[0])
  })
})
