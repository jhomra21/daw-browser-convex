import 'fake-indexeddb/auto'
import { expect, test } from 'bun:test'
import { externalProcessorSchema } from '@daw-browser/external-plugins'
import { isJsonObject } from '@daw-browser/shared'
import { z } from 'zod'

import {
  LOCAL_CONTROL_PROJECT_METADATA_KEY,
  createLocalProject,
  getLocalProject,
  getProjectDbName,
  importLocalProject,
  listLocalProjects,
  openLocalProjectDb,
  renameLocalProject,
  replaceLocalProject,
  type LocalProjectEntry,
  type LocalProjectStoredValue,
} from './local-project-db'

const openNativeDb = (name: string, version?: number) => new Promise<IDBDatabase>((resolve, reject) => {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const completeProject = (id: string, name: string, timestamp: number): LocalProjectEntry => ({
  id,
  name,
  schemaVersion: 1,
  mode: 'local-only',
  storageKind: 'opfs',
  createdAt: timestamp,
  updatedAt: timestamp,
  lastOpenedAt: timestamp,
})

test('stores structured-clone values without reducing them to JSON', async () => {
  const projectId = `project:structured-clone-${crypto.randomUUID()}`
  const db = await openLocalProjectDb(projectId)
  const file = new File(['audio'], 'clip.wav', { type: 'audio/wav' })
  const blob = new Blob(['waveform'], { type: 'application/octet-stream' })
  const buffer = new Uint8Array([1, 2, 3]).buffer
  const bytes = new Uint8Array([4, 5, 6])
  const readonlyValues: readonly LocalProjectStoredValue[] = ['audio', undefined, bytes]
  const value = {
    file,
    blob,
    buffer,
    bytes,
    readonlyValues,
    optionalValue: undefined,
    nested: { omittedOptionalValue: undefined },
  } satisfies LocalProjectStoredValue

  await db.put('syncState', { key: 'structured-clone', value, updatedAt: 1 })

  expect((await db.get('syncState', 'structured-clone'))?.value).toEqual(value)
})

test('upgrades existing project databases additively and retains v1 rows', async () => {
  const projectId = `project:db-upgrade-${crypto.randomUUID()}`
  const request = indexedDB.open(getProjectDbName(projectId), 1)
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result
      const entities = db.createObjectStore('entities', { keyPath: ['kind', 'id'] })
      entities.createIndex('by-kind', 'kind')
      entities.createIndex('by-updated-at', 'updatedAt')
      const assets = db.createObjectStore('assets', { keyPath: 'id' })
      assets.createIndex('by-updated-at', 'updatedAt')
      db.createObjectStore('projectState', { keyPath: 'key' })
      db.createObjectStore('history', { keyPath: 'key' })
      db.createObjectStore('syncState', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = legacy.transaction('projectState', 'readwrite')
  transaction.objectStore('projectState').put({ key: 'legacy', value: 1, updatedAt: 1 })
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  const processor = externalProcessorSchema.parse({
    instanceId: '00000000-0000-4000-8000-000000000011',
    targetId: 'legacy-track',
    index: 0,
    manifest: {
      identity: {
        format: 'vst3',
        classId: 'legacy-class',
        vendor: 'Legacy Vendor',
        name: 'Legacy Plugin',
        version: '1',
        architecture: 'arm64',
        binaryFingerprint: 'a'.repeat(64),
      },
      role: 'effect',
      audioInputs: [{ name: 'Input', channels: 2, enabled: true }],
      audioOutputs: [{ name: 'Output', channels: 2, enabled: true }],
      sidechainInputs: [],
      parameters: [],
      latencyFrames: 0,
      tailFrames: 0,
      supportsBypass: true,
      supportsEditor: false,
      supportsState: true,
    },
    parameterOverrides: {},
    latencyFrames: 0,
    tailFrames: 0,
    bypassed: false,
    launchReference: {
      version: 1,
      classId: 'legacy-class',
      vendorId: 'Legacy Vendor',
      architecture: 'arm64',
      bundleFingerprint: 'b'.repeat(64),
      binaryFingerprint: 'a'.repeat(64),
      scannerCatalogVersion: 2,
    },
    health: { state: 'ready', updatedAt: 1 },
    updatedAt: 1,
  })
  const { index: _index, ...legacyProcessor } = processor
  const entityTransaction = legacy.transaction('entities', 'readwrite')
  entityTransaction.objectStore('entities').put({
    kind: 'external-plugin',
    id: `external-plugin:${processor.instanceId}`,
    value: { ...legacyProcessor, chainIndex: 0 },
    updatedAt: 1,
  })
  await new Promise<void>((resolve, reject) => {
    entityTransaction.oncomplete = () => resolve()
    entityTransaction.onerror = () => reject(entityTransaction.error)
  })
  legacy.close()

  const upgraded = await openLocalProjectDb(projectId)
  expect(await upgraded.get('projectState', 'legacy')).toEqual({ key: 'legacy', value: 1, updatedAt: 1 })
  const migrated = await upgraded.get('entities', ['external-plugin', `external-plugin:${processor.instanceId}`])
  expect(migrated?.value).toMatchObject({ index: 0 })
  const parsedMigratedValue = z.json().safeParse(migrated?.value)
  if (!parsedMigratedValue.success || !isJsonObject(parsedMigratedValue.data)) {
    throw new Error('Expected migrated external processor row.')
  }
  expect(Object.hasOwn(parsedMigratedValue.data, 'chainIndex')).toBeFalse()
  expect(upgraded.objectStoreNames.contains('controlState')).toBe(true)
  expect(upgraded.objectStoreNames.contains('controlCommits')).toBe(true)
  expect(upgraded.objectStoreNames.contains('controlApprovals')).toBe(true)
  expect(upgraded.objectStoreNames.contains('controlRecoveries')).toBe(true)
  expect(upgraded.objectStoreNames.contains('controlAssetGc')).toBe(true)
})

test('seeds canonical project metadata and makes rename authority canonical', async () => {
  const project = await createLocalProject(`Project ${crypto.randomUUID()}`)
  const db = await openLocalProjectDb(project.id)
  expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual(expect.objectContaining({
    value: expect.objectContaining({ name: project.name, timeSignature: { numerator: 4, denominator: 4 } }),
  }))
  const renamed = await renameLocalProject(project.id, 'Renamed')
  expect(renamed?.name).toBe('Renamed')
  expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual(expect.objectContaining({
    value: expect.objectContaining({ name: 'Renamed' }),
  }))
})

test('lazily seeds legacy metadata and reconciles stale global cache from its authority row', async () => {
  const timestamp = Date.now()
  const projectId = `project:legacy-${crypto.randomUUID()}`
  const global = await openNativeDb('daw-browser-projects')
  const globalTransaction = global.transaction('projects', 'readwrite')
  globalTransaction.objectStore('projects').put(completeProject(projectId, 'Legacy Global Name', timestamp))
  await new Promise<void>((resolve, reject) => {
    globalTransaction.oncomplete = () => resolve()
    globalTransaction.onerror = () => reject(globalTransaction.error)
  })
  global.close()

  const projectRequest = indexedDB.open(getProjectDbName(projectId), 1)
  const legacyProject = await new Promise<IDBDatabase>((resolve, reject) => {
    projectRequest.onupgradeneeded = () => {
      const db = projectRequest.result
      const entities = db.createObjectStore('entities', { keyPath: ['kind', 'id'] })
      entities.createIndex('by-kind', 'kind')
      entities.createIndex('by-updated-at', 'updatedAt')
      const assets = db.createObjectStore('assets', { keyPath: 'id' })
      assets.createIndex('by-updated-at', 'updatedAt')
      db.createObjectStore('projectState', { keyPath: 'key' })
      db.createObjectStore('history', { keyPath: 'key' })
      db.createObjectStore('syncState', { keyPath: 'key' })
    }
    projectRequest.onsuccess = () => resolve(projectRequest.result)
    projectRequest.onerror = () => reject(projectRequest.error)
  })
  legacyProject.close()

  const seeded = await getLocalProject(projectId)
  expect(seeded?.name).toBe('Legacy Global Name')
  const projectDb = await openLocalProjectDb(projectId)
  expect(await projectDb.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual({
    key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
    value: {
      version: 1,
      name: 'Legacy Global Name',
      updatedAt: timestamp,
      timeSignature: { numerator: 4, denominator: 4 },
    },
    updatedAt: timestamp,
  })

  const canonicalUpdatedAt = timestamp + 1
  const authority = await openNativeDb(getProjectDbName(projectId))
  const authorityTransaction = authority.transaction('projectState', 'readwrite')
  authorityTransaction.objectStore('projectState').put({
    key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
    value: {
      version: 1,
      name: 'Canonical Name',
      updatedAt: canonicalUpdatedAt,
      timeSignature: { numerator: 7, denominator: 8 },
    },
    updatedAt: canonicalUpdatedAt,
  })
  await new Promise<void>((resolve, reject) => {
    authorityTransaction.oncomplete = () => resolve()
    authorityTransaction.onerror = () => reject(authorityTransaction.error)
  })
  authority.close()

  const staleGlobal = await openNativeDb('daw-browser-projects')
  const staleTransaction = staleGlobal.transaction('projects', 'readwrite')
  staleTransaction.objectStore('projects').put(completeProject(projectId, 'Stale Cache Name', timestamp))
  await new Promise<void>((resolve, reject) => {
    staleTransaction.oncomplete = () => resolve()
    staleTransaction.onerror = () => reject(staleTransaction.error)
  })
  staleGlobal.close()

  expect((await listLocalProjects()).find((project) => project.id === projectId)).toEqual(expect.objectContaining({
    name: 'Canonical Name',
    updatedAt: canonicalUpdatedAt,
  }))

  const staleAgain = await openNativeDb('daw-browser-projects')
  const staleAgainTransaction = staleAgain.transaction('projects', 'readwrite')
  staleAgainTransaction.objectStore('projects').put(completeProject(projectId, 'Stale Again', timestamp))
  await new Promise<void>((resolve, reject) => {
    staleAgainTransaction.oncomplete = () => resolve()
    staleAgainTransaction.onerror = () => reject(staleAgainTransaction.error)
  })
  staleAgain.close()

  expect(await getLocalProject(projectId)).toEqual(expect.objectContaining({
    name: 'Canonical Name',
    updatedAt: canonicalUpdatedAt,
  }))
})

test('normalizes duplicated import and replacement metadata to the target project', async () => {
  const imported = completeProject(
    `project:duplicate-${crypto.randomUUID()}`,
    'Duplicated Project',
    100,
  )
  await importLocalProject(imported, {
    entities: [],
    assets: [],
    projectState: [
      { key: 'bpm', value: 128, updatedAt: 1 },
      {
        key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
        value: {
          version: 1,
          name: 'Source Project',
          updatedAt: 1,
          timeSignature: { numerator: 7, denominator: 8 },
        },
        updatedAt: 1,
      },
      {
        key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
        value: {
          version: 1,
          name: 'Duplicate Source',
          updatedAt: 2,
          timeSignature: { numerator: 3, denominator: 4 },
        },
        updatedAt: 2,
      },
    ],
    syncState: [],
  })
  const db = await openLocalProjectDb(imported.id)
  expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual({
    key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
    value: {
      version: 1,
      name: imported.name,
      updatedAt: imported.updatedAt,
      timeSignature: { numerator: 7, denominator: 8 },
    },
    updatedAt: imported.updatedAt,
  })

  const replacement = { ...imported, name: 'Replacement Project', updatedAt: 200 }
  await replaceLocalProject(replacement, {
    entities: [],
    assets: [],
    projectState: [{
      key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
      value: { version: 1, name: 'Malformed', updatedAt: 'bad' },
      updatedAt: 1,
    }],
    syncState: [],
  })
  expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual({
    key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
    value: {
      version: 1,
      name: replacement.name,
      updatedAt: replacement.updatedAt,
      timeSignature: { numerator: 4, denominator: 4 },
    },
    updatedAt: replacement.updatedAt,
  })
  expect((await getLocalProject(imported.id))?.name).toBe(replacement.name)
})

test('normalizes invalid imported and replacement time signatures to 4/4', async () => {
  for (const timeSignature of [
    { numerator: -1, denominator: 4 },
    { numerator: 4, denominator: 0 },
    { numerator: 3.5, denominator: 4 },
    { numerator: Number.NaN, denominator: 4 },
    { numerator: 4, denominator: Number.POSITIVE_INFINITY },
    { numerator: 33, denominator: 4 },
    { numerator: 4, denominator: 3 },
  ]) {
    const project = completeProject(
      `project:invalid-signature-${crypto.randomUUID()}`,
      'Invalid Signature',
      100,
    )
    await importLocalProject(project, {
      entities: [],
      assets: [],
      projectState: [{
        key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
        value: { version: 1, name: 'Source', updatedAt: 1, timeSignature },
        updatedAt: 1,
      }],
      syncState: [],
    })
    const db = await openLocalProjectDb(project.id)
    expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual(expect.objectContaining({
      value: expect.objectContaining({ timeSignature: { numerator: 4, denominator: 4 } }),
    }))

    await replaceLocalProject({ ...project, updatedAt: 200 }, {
      entities: [],
      assets: [],
      projectState: [{
        key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
        value: { version: 1, name: 'Source', updatedAt: 1, timeSignature },
        updatedAt: 1,
      }],
      syncState: [],
    })
    expect(await db.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)).toEqual(expect.objectContaining({
      value: expect.objectContaining({ timeSignature: { numerator: 4, denominator: 4 } }),
    }))
  }
})
