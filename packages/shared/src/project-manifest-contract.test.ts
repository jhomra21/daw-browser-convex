import { describe, expect, test } from 'bun:test'
import {
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
}

describe('project format boundaries', () => {
  test('reports the current manifest schema version', () => {
    expect(SUPPORTED_PROJECT_MANIFEST_SCHEMA_VERSIONS).toEqual([PROJECT_MANIFEST_SCHEMA_VERSION])
  })

  test('reads the current manifest schema without migration', () => {
    const manifest = { ...manifestV1, schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION }
    expect(normalizeProjectManifest(manifest)).toEqual(manifest)
    expect(parseProjectManifest(JSON.stringify(manifest))).toEqual(manifest)
  })

  test('rejects unsupported writer versions', () => {
    expect(() => normalizeProjectManifest({ ...manifestV1, schemaVersion: 1 })).toThrow(
      'Unsupported project manifest schema version 1.',
    )
    expect(() => normalizeProjectManifest({ ...manifestV1, schemaVersion: 3 })).toThrow(
      'Unsupported project manifest schema version 3.',
    )
    expect(() => normalizeProjectManifest({ ...manifestV1, schemaVersion: 0 })).toThrow(
      'Unsupported project manifest schema version 0.',
    )
  })

  test('preserves current effect entity values without migration', () => {
    const manifest = {
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
