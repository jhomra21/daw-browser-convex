import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { createLocalProjectId, createLocalTrackId } from '~/lib/local-ids'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

export const LOCAL_PROJECT_SCHEMA_VERSION = 1

const GLOBAL_DB_NAME = 'daw-browser-projects'
const GLOBAL_DB_VERSION = 1
const PROJECT_DB_VERSION = 1
const PROJECT_DB_PREFIX = 'daw-browser-project-'

export type LocalProjectMode = 'local-only' | 'backup' | 'shared'
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
  updatedAt: number
}

export type LocalProjectEntityRow = {
  kind: string
  id: string
  value: unknown
  updatedAt: number
}

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
  durationSec?: number
  sampleRate?: number
  createdAt: number
  updatedAt: number
}

export type LocalProjectStateRow = {
  key: string
  value: unknown
  updatedAt: number
}

export type LocalProjectHistoryRow = {
  key: string
  value: unknown
  updatedAt: number
}

export type LocalProjectSyncStateRow = {
  key: string
  value: unknown
  updatedAt: number
}

type GlobalProjectsDB = DBSchema & {
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
}

export const createProjectId = createLocalProjectId
export const getProjectDbName = (projectId: string) => `${PROJECT_DB_PREFIX}${projectId}`

const now = () => Date.now()
let globalDbPromise: Promise<IDBPDatabase<GlobalProjectsDB>> | undefined
const projectDbPromises = new Map<string, Promise<IDBPDatabase<ProjectDB>>>()

const openGlobalProjectsDb = () => {
  if (globalDbPromise) return globalDbPromise
  const promise = openDB<GlobalProjectsDB>(GLOBAL_DB_NAME, GLOBAL_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('projects')) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' })
        projects.createIndex('by-last-opened', 'lastOpenedAt')
        projects.createIndex('by-updated-at', 'updatedAt')
      }
      if (!db.objectStoreNames.contains('directoryHandles')) {
        db.createObjectStore('directoryHandles', { keyPath: 'projectId' })
      }
    },
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
    upgrade(db) {
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
  const projects = await db.getAllFromIndex('projects', 'by-last-opened')
  return projects.reverse()
}

export const getLocalProject = async (projectId: string): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
  return db.get('projects', projectId)
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
  await projectDb.put('entities', {
    kind: 'track',
    id: trackId,
    value: {
      id: trackId,
      historyRef: trackId,
      name: 'Track 1',
      index: 0,
      volume: 0.8,
      muted: false,
      soloed: false,
      kind: 'audio',
      channelRole: 'track',
      sends: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    updatedAt: timestamp,
  })
  return project
}

export const markLocalProjectOpened = async (projectId: string): Promise<LocalProjectEntry | undefined> => {
  const db = await openGlobalProjectsDb()
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

export const importLocalProject = async (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
  },
): Promise<void> => {
  const projectDb = await openLocalProjectDb(project.id)
  const tx = projectDb.transaction(['entities', 'assets', 'projectState', 'syncState'], 'readwrite')
  await Promise.all([
    ...rows.entities.map((row) => tx.objectStore('entities').put(row)),
    ...rows.assets.map((row) => tx.objectStore('assets').put(row)),
    ...rows.projectState.map((row) => tx.objectStore('projectState').put(row)),
    ...rows.syncState.map((row) => tx.objectStore('syncState').put(row)),
    tx.done,
  ])
  const globalDb = await openGlobalProjectsDb()
  await globalDb.put('projects', project)
}

export const replaceLocalProject = async (
  project: LocalProjectEntry,
  rows: {
    entities: LocalProjectEntityRow[]
    assets: LocalProjectAssetRow[]
    projectState: LocalProjectStateRow[]
    syncState: LocalProjectSyncStateRow[]
  },
): Promise<void> => {
  const globalDb = await openGlobalProjectsDb()
  const directoryEntry = await globalDb.get('directoryHandles', project.id)
  const projectDb = await openLocalProjectDb(project.id)
  const previousAssetPaths = (await projectDb.getAll('assets')).map((asset) => asset.storagePath)
  const nextAssetPaths = new Set(rows.assets.map((asset) => asset.storagePath))
  const staleAssetPaths = previousAssetPaths.filter((path) => !nextAssetPaths.has(path))
  const tx = projectDb.transaction(['entities', 'assets', 'projectState', 'history', 'syncState'], 'readwrite')
  await Promise.all([
    tx.objectStore('entities').clear(),
    tx.objectStore('assets').clear(),
    tx.objectStore('projectState').clear(),
    tx.objectStore('history').clear(),
    tx.objectStore('syncState').clear(),
    ...rows.entities.map((row) => tx.objectStore('entities').put(row)),
    ...rows.assets.map((row) => tx.objectStore('assets').put(row)),
    ...rows.projectState.map((row) => tx.objectStore('projectState').put(row)),
    ...rows.syncState.map((row) => tx.objectStore('syncState').put(row)),
    tx.done,
  ])
  await globalDb.put('projects', project)
  notifyLocalProjectChanged(project.id)
  await deleteLocalProjectAssetFiles(project.id, directoryEntry?.handle, staleAssetPaths)
}

export const exportLocalProjectRows = async (projectId: string) => {
  const db = await openLocalProjectDb(projectId)
  const [entities, assets, projectState, syncState] = await Promise.all([
    db.getAll('entities'),
    db.getAll('assets'),
    db.getAll('projectState'),
    db.getAll('syncState'),
  ])
  return { entities, assets, projectState, syncState }
}

const deleteLocalProjectAssetFiles = async (
  projectId: string,
  directoryHandle: FileSystemDirectoryHandle | undefined,
  assetPaths: string[],
  options: { removeProjectRoot?: boolean } = {},
): Promise<void> => {
  await Promise.all([
    (async () => {
      try {
        const root = await navigator.storage.getDirectory()
        if (options.removeProjectRoot) {
          await root.removeEntry(projectId, { recursive: true })
          return
        }
        const projectDir = await root.getDirectoryHandle(projectId)
        const assetsDir = await projectDir.getDirectoryHandle('assets')
        await Promise.all(assetPaths.map((path) => assetsDir.removeEntry(path).catch(() => undefined)))
      } catch {}
    })(),
    (async () => {
      if (!directoryHandle) return
      try {
        const assetsDir = await directoryHandle.getDirectoryHandle('assets')
        await Promise.all(assetPaths.map((path) => assetsDir.removeEntry(path).catch(() => undefined)))
      } catch {}
    })(),
  ])
}

export const deleteLocalProject = async (projectId: string): Promise<void> => {
  const db = await openGlobalProjectsDb()
  const directoryEntry = await db.get('directoryHandles', projectId)
  const dbName = getProjectDbName(projectId)
  const projectDb = await openLocalProjectDb(projectId)
  try {
    const assetPaths = (await projectDb.getAll('assets')).map((asset) => asset.storagePath)
    await deleteLocalProjectAssetFiles(projectId, directoryEntry?.handle, assetPaths, { removeProjectRoot: true })
    const tx = db.transaction(['projects', 'directoryHandles'], 'readwrite')
    await Promise.all([
      tx.objectStore('projects').delete(projectId),
      tx.objectStore('directoryHandles').delete(projectId),
      tx.done,
    ])
  } finally {
    projectDb.close()
    projectDbPromises.delete(dbName)
  }
  await deleteDB(dbName)
}

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

export const saveProjectDirectoryHandle = async (
  projectId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> => {
  const db = await openGlobalProjectsDb()
  await db.put('directoryHandles', { projectId, handle, updatedAt: now() })
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
