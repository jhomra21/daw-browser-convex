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
    expect(SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS).toEqual([PROJECT_MANIFEST_SCHEMA_VERSION])
  })

  test('reads supported v1 manifests and is idempotent through one entry point', () => {
    const migrated = migrateProjectManifest(manifestV1)
    expect(migrated).toEqual(manifestV1)
    expect(migrateProjectManifest(migrated)).toEqual(migrated)
  })

  test('rejects unsupported writer versions', () => {
    expect(() => migrateProjectManifest({ ...manifestV1, schemaVersion: 2 })).toThrow(
      'Unsupported project manifest schema version 2.',
    )
    expect(() => migrateProjectManifest({ ...manifestV1, schemaVersion: 0 })).toThrow(
      'Unsupported project manifest schema version 0.',
    )
  })
})
