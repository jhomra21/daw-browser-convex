import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  readLocalExternalPluginState,
  setLocalExternalPluginArtifact,
  validateLocalVstStateBytes,
  writeLocalExternalPluginState,
} from '~/lib/external-plugin-artifacts'
import { createLocalProject } from '~/lib/local-project-db'
import { buildProjectManifest } from '~/lib/project-manifest'

test('persists external plugin artifact metadata into project manifests without payloads', async () => {
  const project = await createLocalProject(`Plugin artifact ${crypto.randomUUID()}`)
  await setLocalExternalPluginArtifact(project.id, {
    id: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    sha256: 'a'.repeat(64),
    byteLength: 12,
    kind: 'plugin-state',
    ownerId: 'user-1',
    acl: 'owner',
    bucket: 'local',
    location: 'plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
  }, 10)

  const manifest = await buildProjectManifest(project.id)

  expect(manifest.externalPluginArtifacts).toEqual([{
    id: 'a7a0b9ac-7884-492c-8b68-80f15802442c',
    sha256: 'a'.repeat(64),
    byteLength: 12,
    kind: 'plugin-state',
    ownerId: 'user-1',
    acl: 'owner',
    bucket: 'local',
    location: 'plugin-artifacts/a7a0b9ac-7884-492c-8b68-80f15802442c',
  }])
})

test('round trips bounded VST state bytes and rejects hash or size mismatches', async () => {
  const project = await createLocalProject(`VST state ${crypto.randomUUID()}`)
  const bytes = new Uint8Array([0, 1, 2, 255])
  const sha256Hex = Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const metadata = {
    artifactId: crypto.randomUUID(),
    sha256: sha256Hex,
    byteLength: bytes.byteLength,
    artifactKind: 'plugin-state' as const,
    ownerId: 'user-1',
    acl: 'owner' as const,
    bucket: 'local' as const,
    location: '',
  }
  const completeMetadata = {
    ...metadata,
    location: `plugin-artifacts/${metadata.artifactId}`,
  }

  await writeLocalExternalPluginState(project.id, completeMetadata, bytes)

  expect(await readLocalExternalPluginState(project.id, completeMetadata, 'user-1')).toEqual({
    bytes,
    sha256: sha256Hex,
  })
  expect(() => validateLocalVstStateBytes(bytes, '0'.repeat(64))).toThrow()
  expect(() => validateLocalVstStateBytes(new Uint8Array(512 * 1024 + 1), sha256Hex)).toThrow()
})
