import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { setLocalExternalPluginArtifact } from '~/lib/external-plugin-artifacts'
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
