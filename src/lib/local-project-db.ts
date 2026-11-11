import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  createLocalProjectId,
  createLocalTrackId,
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
  type ProjectManifestPluginArtifact,
} from '@daw-browser/shared'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { withLocalProjectAssetLock, withLocalProjectAssetLockIfAvailable, withLocalStorageRootLock, withLocalProjectCleanupRunner } from '~/lib/local-project-asset-lock'
import { buildTimelineTrackRow } from '~/lib/timeline-repository/track-row-builder'
import { normalizeMixedEffectEntityRows } from '~/lib/mixed-effect-order'
import { z } from 'zod'

export const LOCAL_PROJECT_SCHEMA_VERSION = 2
export const LOCAL_CONTROL_PROJECT_METADATA_KEY = 'control-project-metadata'

const GLOBAL_DB_NAME = 'daw-browser-projects'
const GLOBAL_DB_VERSION = 2
const PROJECT_DB_VERSION = 6
const PROJECT_DB_PREFIX = 'daw-browser-project-'

export type LocalProjectMode = 'local-only' | 'backup'
export type LocalProjectStorageKind = 'opfs' | 'directory'

export type LocalProjectEntry = {
  id: string
  name: string
  schemaVersion: number
  mode: LocalProjectMode
  storageKind: LocalProjectStorageKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export type LocalProjectDirectoryEntry = {
  projectId: string
  handle: FileSystemDirectoryHandle
  copyingTo?: FileSystemDirectoryHandle
  updatedAt: number
}

export type LocalProjectStoredValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | Date
  | RegExp
  | File
  | Blob
  | ArrayBuffer
  | ArrayBufferView<ArrayBufferLike>
  | ReadonlyMap<LocalProjectStoredValue, LocalProjectStoredValue>
  | ReadonlySet<LocalProjectStoredValue>
  | readonly LocalProjectStoredValue[]
  | { readonly [key: string]: LocalProjectStoredValue }

export type LocalProjectEntityRow = {
  kind: string
  id: string
  value: LocalProjectStoredValue
  updatedAt: number
}

export const createLocalProjectEntityRow = (
  kind: string,
  id: string,
  value: LocalProjectStoredValue,
  updatedAt = Date.now(),
): LocalProjectEntityRow => ({ kind, id, value, updatedAt })

export type LocalProjectAssetRow = {
  id: string
  name: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  missing?: boolean
  originalFileName?: string
  originalLastModified?: number
  contentHash?: string
  sourceKind?: 'upload' | 'url' | 'recording'
  durationSec?: number
  sampleRate?: number
  channelCount?: number
  folderId?: string
  createdAt: number
  updatedAt: number
}

export type LocalProjectStateRow = {
  key: string
  value: LocalProjectStoredValue
  updatedAt: number
}

export type LocalProjectHistoryRow = {
  key: string
  value: LocalProjectStoredValue
  updatedAt: number
}

export type LocalProjectSyncStateRow = {
  key: string
  value: LocalProjectStoredValue
  updatedAt: number
}
export type LocalProjectExternalPluginArtifactRow = ProjectManifestPluginArtifact & {
  payload?: Uint8Array
  updatedAt: number
}
export type LocalExternalProcessorRecoveryBundle = {
  version: 1
  entity: LocalProjectEntityRow
  artifacts: LocalProjectExternalPluginArtifactRow[]
}
export type LocalControlStateRow = LocalProjectStateRow
export type LocalControlCommitRow = {
  id: string
  version: 1
  projectId: string
  createdAt: number
  actorSubject: string
  actorIssuer?: string
  actorTokenIdentifier?: string
  actorRole: 'owner'
  idempotencyKey: string
  requestDigest: string
  result: JsonValue
  priorRevision: number
  revision: number
  applied: boolean
  status: 'completed'
}
export type LocalControlApprovalRow = {
  id: string
  version: 1
  projectId: string
  expiresAt: number
  createdAt: number
  actorSubject: string
  requestDigest: string
  baseRevision: number
  actionIndexes: number[]
  tokenHash: string
  consumedAt?: number
}
export type LocalControlRecoveryRow = {
  id: string
  version: 1
  projectId: string
  expiresAt: number
  createdAt: number
  actorSubject: string
  sourceActionIndex: number
  sourceCommitId?: string
  kind: string
  payload: string
  payloadHash: string
  externalProcessors?: LocalExternalProcessorRecoveryBundle[]
  externalProcessorsHash?: string
  localSampleUrls?: Record<string, string>
  consumedAt?: number
}
export type LocalControlAssetGcRow = {
  id: string
  version: 1
  projectId: string
  assetId: string
  eligibleAt: number
  storagePath: string
  recoveryId: string
  cloudAssetKey?: string
  claimToken?: string
  claimedAt?: number
}
export type LocalControlProjectMetadata = {
  version: 1
  name: string
  updatedAt: number
  timeSignature: { numerator: number; denominator: number }
}

type GlobalProjectsDB = DBSchema & {
  projectDeletions: {
    key: string
    value: {
      projectId: string
      assetPaths: string[]
      directoryHandle?: FileSystemDirectoryHandle
      lastAttemptAt?: number
      attemptCount?: number
    }
  }
  projects: {
    key: string
    value: LocalProjectEntry
    indexes: {
      'by-last-opened': number
      'by-updated-at': number
    }
  }
  directoryHandles: {
    key: string
    value: LocalProjectDirectoryEntry
  }
}

type ProjectDB = DBSchema & {
  entities: {
    key: [string, string]
    value: LocalProjectEntityRow
    indexes: {
      'by-kind': string
      'by-updated-at': number
    }
  }
  assets: {
    key: string
    value: LocalProjectAssetRow
    indexes: {
      'by-updated-at': number
    }
  }
  projectState: {
    key: string
    value: LocalProjectStateRow
  }
  history: {
    key: string
    value: LocalProjectHistoryRow
  }
  syncState: {
    key: string
    value: LocalProjectSyncStateRow
  }
  externalPluginArtifacts: {
    key: string
    value: LocalProjectExternalPluginArtifactRow
    indexes: {
      'by-updated-at': number
    }
  }
  controlState: { key: string; value: LocalControlStateRow }
  controlCommits: {
    key: string; value: LocalControlCommitRow
    indexes: { 'by-created-at': number; 'by-actor-idempotency': [string, string] }
  }
  controlApprovals: {
    key: string; value: LocalControlApprovalRow
    indexes: { 'by-expires-at': number; 'by-created-at': number; 'by-actor': string }
  }
  controlRecoveries: {
    key: string; value: LocalControlRecoveryRow
    indexes: { 'by-created-at': number; 'by-expires-at': number; 'by-actor': string }
  }
  controlAssetGc: {
    key: string; value: LocalControlAssetGcRow
    indexes: { 'by-eligible-at': number; 'by-storage-path': string }
  }
}

export const createProjectId = createLocalProjectId
export const getProjectDbName = (projectId: string) => `${PROJECT_DB_PREFIX}${projectId}`

const now = () => Date.now()
// Connection and runner caches are process-local; Web Locks coordinate storage across tabs.
let globalDbPromise: Promise<IDBPDatabase<GlobalProjectsDB>> | undefined
let deletionCleanupPromise: Promise<void> | undefined
const MAX_DELETION_CLEANUPS_PER_RUN = 8
const projectDbPromises = new Map<string, Promise<IDBPDatabase<ProjectDB>>>()
const normalizeStoredEntityRows = (
  rows: readonly LocalProjectEntityRow[],
): LocalProjectEntityRow[] => {
  const jsonRows = rows.flatMap((row) => {
    const parsed = z.json().safeParse(row.value)
    return parsed.success ? [{ ...row, value: parsed.data }] : []
  })
  const normalizedByKey = new Map(
    normalizeMixedEffectEntityRows(jsonRows).map((row) => [`${row.kind}\u0000${row.id}`, row]),
  )
  return rows.map((row) => normalizedByKey.get(`${row.kind}\u0000${row.id}`) ?? row)
}
const isPositiveInteger = (value: JsonValue): value is number => (
  isJsonNumber(value) && Number.isFinite(value) && Number.isInteger(value) && value > 0
)
export const isCanonicalLocalControlTimeSignature = (
  value: JsonValue,
): value is LocalControlProjectMetadata['timeSignature'] => (
  isJsonObject(value)
  && isPositiveInteger(value.numerator)
  && value.numerator <= 32
  && (
    value.denominator === 1
    || value.denominator === 2
    || value.denominator === 4
    || value.denominator === 8
    || value.denominator === 16
    || value.denominator === 32
  )
)

const readControlProjectMetadata = (storedValue: LocalProjectStoredValue): LocalControlProjectMetadata | undefined => {
  const parsed = z.json().safeParse(storedValue)
  if (!parsed.success) return undefined
  const value = parsed.data
  if (!isJsonObject(value)) return undefined
  const record = value
  const timeSignature = record.timeSignature
  if (
    record.version !== 1
    || !isJsonString(record.name)
    || !isJsonNumber(record.updatedAt)
    || !isCanonicalLocalControlTimeSignature(timeSignature)
  ) return undefined
  return {
    version: 1,
    name: record.name,
    updatedAt: record.updatedAt,
    timeSignature: { numerator: timeSignature.numerator, denominator: timeSignature.denominator },
  }
}

const metadataRowFor = (project: LocalProjectEntry): LocalProjectStateRow => ({
  key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
  value: {
    version: 1,
    name: project.name,
    updatedAt: project.updatedAt,
    timeSignature: { numerator: 4, denominator: 4 },
  } satisfies LocalControlProjectMetadata,
  updatedAt: project.updatedAt,
})

const normalizedProjectState = (
  project: LocalProjectEntry,
  projectState: LocalProjectStateRow[],
): LocalProjectStateRow[] => {
  const incoming = projectState.find((row) => row.key === LOCAL_CONTROL_PROJECT_METADATA_KEY)
  const timeSignature = (incoming === undefined ? undefined : readControlProjectMetadata(incoming.value))?.timeSignature
    ?? { numerator: 4, denominator: 4 }
  return [
    ...projectState.filter((row) => row.key !== LOCAL_CONTROL_PROJECT_METADATA_KEY),
    {
      key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
      value: {
        version: 1,
        name: project.name,
        updatedAt: project.updatedAt,
        timeSignature,
      } satisfies LocalControlProjectMetadata,
      updatedAt: project.updatedAt,
    },
  ]
}

const ensureControlProjectMetadata = async (project: LocalProjectEntry) => {
  const projectDb = await openLocalProjectDb(project.id)
  const existing = await projectDb.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)
  const metadata = existing === undefined ? undefined : readControlProjectMetadata(existing.value)
  if (metadata) return metadata
  const seeded = metadataRowFor(project)
  await projectDb.put('projectState', seeded)
  return readControlProjectMetadata(seeded.value)
}

const reconcileProjectCache = async (project: LocalProjectEntry) => {
  const metadata = await ensureControlProjectMetadata(project)
  if (!metadata || (project.name === metadata.name && project.updatedAt === metadata.updatedAt)) return project
  const db = await openGlobalProjectsDb()
  const next = { ...project, name: metadata.name, updatedAt: metadata.updatedAt }
  await db.put('projects', next)
  return next
}

export class LocalProjectCatalogVersionError extends Error {
  constructor() {
    super('Local projects were saved by a newer version of this app. Update or reload the app, then retry. Your projects have not been changed.')
    this.name = 'LocalProjectCatalogVersionError'
  }
}

export class LocalProjectCatalogBlockedError extends Error {
  constructor() {
    super('Local projects could not be loaded. Close or reload other tabs using this app, then retry.')
    this.name = 'LocalProjectCatalogBlockedError'
  }
}

export const isLocalProjectCatalogOpenError = (error: Error): error is
  LocalProjectCatalogVersionError | LocalProjectCatalogBlockedError => (
  error instanceof LocalProjectCatalogVersionError || error instanceof LocalProjectCatalogBlockedError
)

export const localProjectCatalogOpenError = (error: Error): Error => {
  if (error instanceof DOMException && error.name === 'VersionError') {
    return new LocalProjectCatalogVersionError()
  }
  return error
}

const openGlobalProjectsDb = () => {
  if (globalDbPromise) return globalDbPromise
  const promise = new Promise<IDBPDatabase<GlobalProjectsDB>>((resolve, reject) => {
    let blocked = false
    void openDB<GlobalProjectsDB>(GLOBAL_DB_NAME, GLOBAL_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          const projects = db.createObjectStore('projects', { keyPath: 'id' })
          projects.createIndex('by-last-opened', 'lastOpenedAt')
          projects.createIndex('by-updated-at', 'updatedAt')
        }
        if (!db.objectStoreNames.contains('directoryHandles')) {
          db.createObjectStore('directoryHandles', { keyPath: 'projectId' })
        }
        if (!db.objectStoreNames.contains('projectDeletions')) {
          db.createObjectStore('projectDeletions', { keyPath: 'projectId' })
        }
      },
      blocked() {
        blocked = true
        reject(new LocalProjectCatalogBlockedError())
      },
      blocking(_currentVersion, _blockedVersion, event) {
        if (globalDbPromise === promise) globalDbPromise = undefined
        const target = event.target
        if (target instanceof IDBDatabase) target.close()
      },
    }).then((db) => {
      // IndexedDB cannot cancel a blocked open request. Close its eventual
      // connection so a failed attempt cannot block a later retry or upgrade.
      if (blocked) db.close()
      else resolve(db)
    }, (error: Error) => reject(localProjectCatalogOpenError(error)))
  })
  globalDbPromise = promise
  void promise.catch(() => {
    if (globalDbPromise === promise) globalDbPromise = undefined
  })
  return promise
}

export const openLocalProjectDb = (projectId: string): Promise<IDBPDatabase<ProjectDB>> => {
  const dbName = getProjectDbName(projectId)
  const cached = projectDbPromises.get(dbName)
  if (cached) return cached
  const promise = openDB<ProjectDB>(dbName, PROJECT_DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains('entities')) {
        const entities = db.createObjectStore('entities', { keyPath: ['kind', 'id'] })
        entities.createIndex('by-kind', 'kind')
        entities.createIndex('by-updated-at', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('assets')) {
        const assets = db.createObjectStore('assets', { keyPath: 'id' })
        assets.createIndex('by-updated-at', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('projectState')) {
        db.createObjectStore('projectState', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('history')) {
        db.createObjectStore('history', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('syncState')) {
        db.createObjectStore('syncState', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('externalPluginArtifacts')) {
        const artifacts = db.createObjectStore('externalPluginArtifacts', { keyPath: 'id' })
        artifacts.createIndex('by-updated-at', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('controlState')) db.createObjectStore('controlState', { keyPath: 'key' })
      if (!db.objectStoreNames.contains('controlCommits')) {
        const store = db.createObjectStore('controlCommits', { keyPath: 'id' })
        store.createIndex('by-created-at', 'createdAt')
        store.createIndex('by-actor-idempotency', ['actorSubject', 'idempotencyKey'])
      }
      if (!db.objectStoreNames.contains('controlApprovals')) {
        const store = db.createObjectStore('controlApprovals', { keyPath: 'id' })
        store.createIndex('by-expires-at', 'expiresAt')
        store.createIndex('by-created-at', 'createdAt')
        store.createIndex('by-actor', 'actorSubject')
      }
      if (!db.objectStoreNames.contains('controlRecoveries')) {
        const store = db.createObjectStore('controlRecoveries', { keyPath: 'id' })
        store.createIndex('by-created-at', 'createdAt')
        store.createIndex('by-expires-at', 'expiresAt')
        store.createIndex('by-actor', 'actorSubject')
      }
      if (!db.objectStoreNames.contains('controlAssetGc')) {
        const store = db.createObjectStore('controlAssetGc', { keyPath: 'id' })
        store.createIndex('by-eligible-at', 'eligibleAt')
        store.createIndex('by-storage-path', 'storagePath')
      }
      if (oldVersion < 6) {
        const store = transaction.objectStore('entities')
        void store.getAll().then((rows) => {
          const normalized = normalizeStoredEntityRows(rows)
          for (const row of normalized) store.put(row)
        })
      }
    },
    blocking(_currentVersion, _blockedVersion, event) {
      projectDbPromises.delete(dbName)
      const target = event.target
      if (target instanceof IDBDatabase) target.close()
    },
  })
  projectDbPromises.set(dbName, promise)
  void promise.catch(() => {
    projectDbPromises.delete(dbName)
  })
  return promise
}

export const listLocalProjects = async (): Promise<LocalProjectEntry[]> => {
  const db = await openGlobalProjectsDb()
  startLocalProjectDeletionCleanup(db)
  const projects = await db.getAllFromIndex('projects', 'by-last-opened')
  return (await Promise.all(projects.map(reconcileProjectCache))).reverse()
}

export const getLocalProject = async (projectId: string): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
  startLocalProjectDeletionCleanup(db)
  const project = await db.get('projects', projectId)
  return project ? reconcileProjectCache(project) : undefined
}

export const createLocalProject = async (name: string): Promise<LocalProjectEntry> => {
  const db = await openGlobalProjectsDb()
  const timestamp = now()
  const trackId = createLocalTrackId()
  const project: LocalProjectEntry = {
    id: createProjectId(),
    name: name.trim() || 'Untitled',
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    mode: 'local-only',
    storageKind: 'opfs',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  }
  await db.put('projects', project)
  const projectDb = await openLocalProjectDb(project.id)
  const tx = projectDb.transaction(['entities', 'projectState'], 'readwrite')
  await Promise.all([
    tx.objectStore('entities').put(createLocalProjectEntityRow(
      'track',
      trackId,
      buildTimelineTrackRow({ id: trackId, index: 0, timestamp }),
      timestamp,
    )),
    tx.objectStore('projectState').put({
      key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
      value: {
        version: 1, name: project.name, updatedAt: timestamp,
        timeSignature: { numerator: 4, denominator: 4 },
      } satisfies LocalControlProjectMetadata,
      updatedAt: timestamp,
    }),
    tx.done,
  ])
  return project
}

export const markLocalProjectOpened = async (projectId: string): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
  startLocalProjectDeletionCleanup(db)
  const project = await db.get('projects', projectId)
  if (!project) return undefined
  const next = { ...project, lastOpenedAt: now() }
  await db.put('projects', next)
  return next
}

export const renameLocalProject = async (
  projectId: string,
  name: string,
): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
  const project = await db.get('projects', projectId)
  if (!project) return undefined
  const timestamp = now()
  const next = {
    ...project,
    name: name.trim() || 'Untitled',
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  }
  const projectDb = await openLocalProjectDb(projectId)
  const metadataRow = await projectDb.get('projectState', LOCAL_CONTROL_PROJECT_METADATA_KEY)
  const metadata = metadataRow === undefined ? undefined : readControlProjectMetadata(metadataRow.value)
  await projectDb.put('projectState', {
    key: LOCAL_CONTROL_PROJECT_METADATA_KEY,
    value: {
      version: 1,
      name: next.name,
      updatedAt: timestamp,
      timeSignature: metadata?.timeSignature ?? { numerator: 4, denominator: 4 },
    } satisfies LocalControlProjectMetadata,
    updatedAt: timestamp,
  })
  await db.put('projects', next)
  notifyLocalProjectChanged(projectId)
  return next
}

export const setLocalProjectMode = async (
  projectId: string,
  mode: LocalProjectMode,
): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
  const project = await db.get('projects', projectId)
  if (!project) return undefined
  if (project.mode === mode) return project
  const timestamp = now()
  const next = {
    ...project,
    mode,
    lastOpenedAt: timestamp,
  }
  await db.put('projects', next)
  notifyLocalProjectChanged(projectId)
  return next
}

export const importLocalProjectUnlocked = async (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
    externalPluginArtifacts?: LocalProjectExternalPluginArtifactRow[]
  },
): Promise<void> => {
  const projectDb = await openLocalProjectDb(project.id)
  const entities = normalizeStoredEntityRows(rows.entities)
  const projectState = normalizedProjectState(project, rows.projectState)
  // The caller owns the project lock. Only reference publication takes root;
  // archive decoding and file materialization stay outside this critical section.
  await withLocalStorageRootLock(async () => {
    const tx = projectDb.transaction(['entities', 'assets', 'projectState', 'syncState', 'externalPluginArtifacts'], 'readwrite')
    await Promise.all([
      ...entities.map((row) => tx.objectStore('entities').put(row)),
      ...rows.assets.map((row) => tx.objectStore('assets').put(row)),
      ...projectState.map((row) => tx.objectStore('projectState').put(row)),
      ...rows.syncState.map((row) => tx.objectStore('syncState').put(row)),
      ...(rows.externalPluginArtifacts ?? []).map((row) => tx.objectStore('externalPluginArtifacts').put(row)),
      tx.done,
    ])
    const globalDb = await openGlobalProjectsDb()
    await globalDb.put('projects', project)
  })
}

export const importLocalProject = (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
    externalPluginArtifacts?: LocalProjectExternalPluginArtifactRow[]
  },
): Promise<void> => withLocalProjectAssetLock(project.id, () => importLocalProjectUnlocked(project, rows))

const replaceLocalProjectUnlocked = async (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
    externalPluginArtifacts?: LocalProjectExternalPluginArtifactRow[]
  },
): Promise<void> => {
  const globalDb = await openGlobalProjectsDb()
  const directoryEntry = await globalDb.get('directoryHandles', project.id)
  const projectDb = await openLocalProjectDb(project.id)
  const previousAssetPaths = (await projectDb.getAll('assets')).map((asset) => asset.storagePath)
  const nextAssetPaths = new Set(rows.assets.map((asset) => asset.storagePath))
  const staleAssetPaths = previousAssetPaths.filter((path) => !nextAssetPaths.has(path))
  const projectState = normalizedProjectState(project, rows.projectState)
  const entities = normalizeStoredEntityRows(rows.entities)
  await withLocalStorageRootLock(async () => {
    const tx = projectDb.transaction(['entities', 'assets', 'projectState', 'history', 'syncState', 'externalPluginArtifacts', 'controlState', 'controlCommits', 'controlApprovals', 'controlRecoveries', 'controlAssetGc'], 'readwrite')
    await Promise.all([
      tx.objectStore('entities').clear(),
      tx.objectStore('assets').clear(),
      tx.objectStore('projectState').clear(),
      tx.objectStore('history').clear(),
      tx.objectStore('syncState').clear(),
      tx.objectStore('externalPluginArtifacts').clear(),
      tx.objectStore('controlState').clear(),
      tx.objectStore('controlCommits').clear(),
      tx.objectStore('controlApprovals').clear(),
      tx.objectStore('controlRecoveries').clear(),
      tx.objectStore('controlAssetGc').clear(),
      ...entities.map((row) => tx.objectStore('entities').put(row)),
      ...rows.assets.map((row) => tx.objectStore('assets').put(row)),
      ...projectState.map((row) => tx.objectStore('projectState').put(row)),
      ...rows.syncState.map((row) => tx.objectStore('syncState').put(row)),
      ...(rows.externalPluginArtifacts ?? []).map((row) => tx.objectStore('externalPluginArtifacts').put(row)),
      tx.done,
    ])
    await globalDb.put('projects', project)
  })
  notifyLocalProjectChanged(project.id)
  await deleteLocalProjectAssetFiles(project.id, directoryEntry?.handle, staleAssetPaths)
}

export const replaceLocalProject = (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
    externalPluginArtifacts?: LocalProjectExternalPluginArtifactRow[]
  },
): Promise<void> => withLocalProjectAssetLock(project.id, () => replaceLocalProjectUnlocked(project, rows))

export const exportLocalProjectRows = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const [entities, assets, projectState, syncState, externalPluginArtifacts] = await Promise.all([
    db.getAll('entities'),
    db.getAll('assets'),
    db.getAll('projectState'),
    db.getAll('syncState'),
    db.getAll('externalPluginArtifacts'),
  ])
  return { entities, assets, projectState, syncState, externalPluginArtifacts }
}

const deleteLocalProjectAssetFiles = async (
  projectId: string,
  directoryHandle: FileSystemDirectoryHandle | undefined,
  assetPaths: string[],
): Promise<void> => {
  if (assetPaths.length === 0) return
  const projectDir = await (async () => {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle(projectId)
  })().catch(() => undefined)
  for (const directory of [projectDir, directoryHandle]) {
    if (!directory) continue
    await withLocalStorageRootLock(async () => {
      try {
        const retained = await retainedAssetPaths(directory)
        const assetsDir = await directory.getDirectoryHandle('assets')
        for (const path of assetPaths) {
          if (!retained.has(path)) await assetsDir.removeEntry(path).catch(ignoreMissingFile)
        }
      } catch {}
    })
  }
}

export const deleteLocalProjectUnlocked = async (projectId: string): Promise<void> => {
  const db = await openGlobalProjectsDb()
  if (await db.get('projectDeletions', projectId) && !await db.get('projects', projectId)) {
    await finishLocalProjectDeletion(projectId)
    return
  }
  const directoryEntry = await db.get('directoryHandles', projectId)
  const projectDb = await openLocalProjectDb(projectId)
  const assetPaths = [
    ...(await projectDb.getAll('assets')).map((asset) => asset.storagePath),
    ...(await projectDb.getAll('controlAssetGc')).map((asset) => asset.storagePath),
  ]
  // Catalog removal and the durable cleanup job must commit before touching files.
  await withLocalStorageRootLock(async () => {
    const tx = db.transaction(['projects', 'directoryHandles', 'projectDeletions'], 'readwrite')
    await Promise.all([
      tx.objectStore('projects').delete(projectId),
      tx.objectStore('directoryHandles').delete(projectId),
      tx.objectStore('projectDeletions').put({
        projectId, assetPaths, directoryHandle: directoryEntry?.handle,
      }),
      tx.done,
    ])
  })
  await finishLocalProjectDeletion(projectId)
}

const ignoreMissingFile = (error: Error) => {
  if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
}

const startLocalProjectDeletionCleanup = (db: IDBPDatabase<GlobalProjectsDB>): void => {
  if (deletionCleanupPromise) return
  // A list/open starts one bounded pass. Failed jobs wait for the next user
  // operation, never an automatic retry loop, and cannot reject the listing.
  deletionCleanupPromise = withLocalProjectCleanupRunner(async () => {
    await recoverAbandonedDirectoryCopies(db)
    const jobs = (await db.getAll('projectDeletions'))
      .sort((left, right) => (left.lastAttemptAt ?? 0) - (right.lastAttemptAt ?? 0)
        || left.projectId.localeCompare(right.projectId))
      .slice(0, MAX_DELETION_CLEANUPS_PER_RUN)
    for (const { projectId } of jobs) {
      const acquired = await withLocalProjectAssetLockIfAvailable(projectId, () => finishLocalProjectDeletion(projectId))
      if (!acquired) {
        const job = await db.get('projectDeletions', projectId)
        if (job) await db.put('projectDeletions', { ...job, lastAttemptAt: now() })
      }
    }
  }).catch((error: Error) => {
    console.warn('Local project cleanup could not be completed.', error)
  }).finally(() => { deletionCleanupPromise = undefined })
}

const recoverAbandonedDirectoryCopies = async (db: IDBPDatabase<GlobalProjectsDB>): Promise<void> => {
  const reservations = (await db.getAll('directoryHandles')).filter((entry) => entry.copyingTo)
  for (const { projectId } of reservations) {
    // Copies hold their owner lock until every file settles. Web Locks release
    // on realm death; skip a live owner rather than delaying this cleanup pass.
    await withLocalProjectAssetLockIfAvailable(projectId, () => withLocalStorageRootLock(async () => {
      const current = await db.get('directoryHandles', projectId)
      if (!current?.copyingTo) return
      const root = await navigator.storage.getDirectory()
      const opfs = await root.getDirectoryHandle(projectId).catch((error: Error) => {
        ignoreMissingFile(error)
        return undefined
      })
      // OPFS copies temporarily publish their source root as a directory entry.
      // Restore implicit OPFS storage, or retain the original chosen folder.
      const handle = opfs && await opfs.isSameEntry(current.handle) ? undefined : current.handle
      await saveProjectDirectoryHandleUnlocked(projectId, handle)
    }))
  }
}

/** Caller holds the project asset lock. Recheck root ownership under the global lock. */
const finishLocalProjectDeletion = async (projectId: string): Promise<void> => {
  try {
    const db = await openGlobalProjectsDb()
    const job = await db.get('projectDeletions', projectId)
    if (!job) return
    // Persist before attempting I/O, including failures and interrupted passes.
    await db.put('projectDeletions', {
      ...job, lastAttemptAt: now(), attemptCount: (job.attemptCount ?? 0) + 1,
    })
    const filesRemoved = await withLocalStorageRootLock(() => removeDeletedProjectFiles(projectId))
    if (!filesRemoved) return
    // Database teardown needs only the project lock, not the storage-root lock.
    const dbName = getProjectDbName(projectId)
    const cached = await projectDbPromises.get(dbName)
    cached?.close()
    projectDbPromises.delete(dbName)
    // Another tab can hold an old connection. Leave the durable job in place
    // instead of keeping an already committed deletion waiting.
    const deleted = await new Promise<boolean>((resolve, reject) => {
      void deleteDB(dbName, { blocked: () => resolve(false) }).then(() => resolve(true), reject)
    })
    if (!deleted) return
    await db.delete('projectDeletions', projectId)
  } catch (error) {
    // Logical deletion already succeeded. Retain the durable job for another pass.
    console.warn('Local project cleanup could not be completed.', error)
  }
}

/** Caller holds root, so the atomic reference snapshots stay valid until removal. */
export const retainedAssetPaths = async (
  directory: FileSystemDirectoryHandle | undefined,
  owner?: { projectId: string; excludingAssetGcId?: string },
): Promise<Set<string>> => {
  const db = await openGlobalProjectsDb()
  const handles = await db.getAll('directoryHandles')
  const retained = new Set<string>()
  const projectIds = new Set<string>(owner ? [owner.projectId] : [])
  // Resolve implicit OPFS only when other directory references need comparison.
  const root = directory ?? (handles.length > 0 && owner ? await getProjectOpfsRoot(owner.projectId) : undefined)
  if (root) {
    const path = await (await navigator.storage.getDirectory()).resolve(root)
    const implicitProjectId = path?.length === 1 ? path[0] : undefined
    if (implicitProjectId && !handles.some((entry) => entry.projectId === implicitProjectId)
      && await db.get('projects', implicitProjectId)) projectIds.add(implicitProjectId)
  }
  for (const entry of handles) {
    if (root && (await root.isSameEntry(entry.handle)
      || entry.copyingTo && await root.isSameEntry(entry.copyingTo))) projectIds.add(entry.projectId)
  }
  for (const projectId of projectIds) {
    const otherDb = await openLocalProjectDb(projectId)
    // A recovery moves GC retention into assets. Observe both stores at the
    // same IDB revision, never the gap between two independent transactions.
    const tx = otherDb.transaction(['assets', 'controlAssetGc'], 'readonly')
    const [live, gc] = await Promise.all([
      tx.objectStore('assets').getAll(),
      tx.objectStore('controlAssetGc').getAll(),
    ])
    await tx.done
    for (const asset of live) retained.add(asset.storagePath)
    for (const asset of gc) {
      if (projectId !== owner?.projectId || asset.id !== owner.excludingAssetGcId) retained.add(asset.storagePath)
    }
  }
  return retained
}

const removeDeletedProjectFiles = async (projectId: string): Promise<boolean> => {
  const db = await openGlobalProjectsDb()
  const job = await db.get('projectDeletions', projectId)
  if (!job) return false
  // An explicitly restored project must never be removed by an older cleanup job.
  if (await db.get('projects', projectId)) {
    await db.delete('projectDeletions', projectId)
    return false
  }
  const root = await navigator.storage.getDirectory()
  const handles = await db.getAll('directoryHandles')
  const roots = handles.flatMap((entry) => entry.copyingTo ? [entry.handle, entry.copyingTo] : [entry.handle])
  const projectRoot = await root.getDirectoryHandle(projectId).catch((error: Error) => {
    ignoreMissingFile(error)
    return undefined
  })
  if (projectRoot) {
    for (const handle of roots) {
      // A chosen folder can even point inside another project's OPFS root.
      // Retain that root while it is in use rather than deleting shared bytes.
      if (await projectRoot.resolve(handle) !== null) return false
    }
  }
  await root.removeEntry(projectId, { recursive: true }).catch(ignoreMissingFile)
  if (job.directoryHandle) {
    const directoryHandle = job.directoryHandle
    // Directory-backed projects may share a folder. OPFS roots are project-scoped.
    const retainedPaths = await retainedAssetPaths(directoryHandle)
    try {
      const assets = await directoryHandle.getDirectoryHandle('assets')
      for (const path of job.assetPaths) {
        // All publishers honor the root lock held throughout this snapshot and
        // removal. Recheck each path immediately before deleting its bytes.
        if (!retainedPaths.has(path)) await assets.removeEntry(path).catch(ignoreMissingFile)
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
    }
  }
  return true
}

export const deleteLocalProject = (projectId: string): Promise<void> => (
  withLocalProjectAssetLock(projectId, () => deleteLocalProjectUnlocked(projectId))
)

export const purgeLocalProjectCache = async (projectId: string): Promise<void> => {
  const db = await openGlobalProjectsDb()
  const project = await db.get('projects', projectId)
  if (project) {
    await deleteLocalProject(projectId)
    return
  }
  const dbName = getProjectDbName(projectId)
  const cached = await projectDbPromises.get(dbName)?.catch(() => undefined)
  cached?.close()
  projectDbPromises.delete(dbName)
  await deleteDB(dbName)
}

/** Caller holds project, then storage-root lock for reference publication. */
export const saveProjectDirectoryHandleUnlocked = async (
  projectId: string,
  handle: FileSystemDirectoryHandle | undefined,
  copyingTo?: FileSystemDirectoryHandle,
): Promise<void> => {
  const db = await openGlobalProjectsDb()
  if (handle) await db.put('directoryHandles', { projectId, handle, copyingTo, updatedAt: now() })
  else await db.delete('directoryHandles', projectId)
}

export const getProjectDirectoryHandle = async (
  projectId: string,
): Promise<FileSystemDirectoryHandle | undefined> => {
  const db = await openGlobalProjectsDb()
  const entry = await db.get('directoryHandles', projectId)
  return entry?.handle
}

export const getProjectOpfsRoot = async (projectId: string): Promise<FileSystemDirectoryHandle> => {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(projectId, { create: true })
}

export const queryFileSystemHandlePermission = async (
  handle: FileSystemHandle,
  mode: FileSystemPermissionMode = 'readwrite',
): Promise<PermissionState> => {
  if (!handle.queryPermission) return 'prompt'
  return handle.queryPermission({ mode })
}

export const requestFileSystemHandlePermission = async (
  handle: FileSystemHandle,
  mode: FileSystemPermissionMode = 'readwrite',
): Promise<PermissionState> => {
  if (!handle.requestPermission) return queryFileSystemHandlePermission(handle, mode)
  return handle.requestPermission({ mode })
}
