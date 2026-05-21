import {
  getProjectDirectoryHandle,
  getProjectOpfsRoot,
  openLocalProjectDb,
  queryFileSystemHandlePermission,
  requestFileSystemHandlePermission,
  saveProjectDirectoryHandle,
  type LocalProjectAssetRow,
} from '~/lib/local-project-db'
import { createLocalAssetId } from '~/lib/local-ids'

type LocalAssetMetadata = {
  durationSec?: number
  sampleRate?: number
  contentHash?: string
  originalFileName?: string
  originalLastModified?: number
}

type CreateLocalAssetInput = {
  projectId: string
  file: File
  metadata?: LocalAssetMetadata
}

type LocalAssetWriteErrorKind = 'permission-denied' | 'quota-exceeded' | 'unsupported' | 'write-failed'

export class LocalAssetWriteError extends Error {
  kind: LocalAssetWriteErrorKind

  constructor(kind: LocalAssetWriteErrorKind, message: string) {
    super(message)
    this.name = 'LocalAssetWriteError'
    this.kind = kind
  }
}

type LocalAssetBytesResult =
  | { status: 'ready'; file: File }
  | { status: 'missing' }
  | { status: 'permission-denied' }

const ASSETS_DIRECTORY_NAME = 'assets'

const now = () => Date.now()

const getAssetFileName = (assetId: string, fileName: string) => {
  const safeName = fileName.trim().replace(/[/\\:]/g, '-')
  return `${assetId}-${safeName || 'audio'}`
}

const getWritableProjectRoot = async (projectId: string) => {
  const directoryHandle = await getProjectDirectoryHandle(projectId)
  if (!directoryHandle) return getProjectOpfsRoot(projectId)
  const permission = await queryFileSystemHandlePermission(directoryHandle)
  if (permission === 'granted') return directoryHandle
  const requested = await requestFileSystemHandlePermission(directoryHandle)
  if (requested === 'granted') return directoryHandle
  return null
}

const writeFile = async (
  root: FileSystemDirectoryHandle,
  path: string,
  file: File,
) => {
  let writable: FileSystemWritableFileStream | undefined
  try {
    const assetsDir = await root.getDirectoryHandle(ASSETS_DIRECTORY_NAME, { create: true })
    const fileHandle = await assetsDir.getFileHandle(path, { create: true })
    writable = await fileHandle.createWritable?.()
    if (!writable) {
      throw new LocalAssetWriteError('unsupported', 'Writable file streams are not supported.')
    }
    await writable.write(file)
    await writable.close()
  } catch (error) {
    try {
      await writable?.abort()
    } catch {}
    if (error instanceof LocalAssetWriteError) throw error
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new LocalAssetWriteError('quota-exceeded', 'Not enough browser storage is available for this audio file.')
    }
    throw new LocalAssetWriteError('write-failed', 'Audio could not be saved to local project storage.')
  }
}

export const writeLocalAssetFile = async (
  projectId: string,
  path: string,
  file: File,
): Promise<void> => {
  const root = await getWritableProjectRoot(projectId)
  if (!root) {
    throw new LocalAssetWriteError('permission-denied', 'Project storage permission is required.')
  }
  await writeFile(root, path, file)
}

export const createLocalAsset = async (input: CreateLocalAssetInput): Promise<LocalProjectAssetRow> => {
  const root = await getWritableProjectRoot(input.projectId)
  if (!root) {
    throw new LocalAssetWriteError('permission-denied', 'Project storage permission is required.')
  }

  const timestamp = now()
  const id = createLocalAssetId()
  const storagePath = getAssetFileName(id, input.file.name)
  await writeFile(root, storagePath, input.file)

  const row: LocalProjectAssetRow = {
    id,
    name: input.file.name || 'audio',
    mimeType: input.file.type || 'application/octet-stream',
    sizeBytes: input.file.size,
    storagePath,
    originalFileName: input.metadata?.originalFileName ?? input.file.name,
    originalLastModified: input.metadata?.originalLastModified ?? input.file.lastModified,
    contentHash: input.metadata?.contentHash,
    durationSec: input.metadata?.durationSec,
    sampleRate: input.metadata?.sampleRate,
    createdAt: timestamp,
    updatedAt: timestamp,
  }

  const db = await openLocalProjectDb(input.projectId)
  await db.put('assets', row)
  return row
}

export const getLocalAsset = async (
  projectId: string,
  assetId: string,
): Promise<LocalProjectAssetRow | undefined> => {
  const db = await openLocalProjectDb(projectId)
  return db.get('assets', assetId)
}

export const listLocalAssets = async (projectId: string): Promise<LocalProjectAssetRow[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('assets', 'by-updated-at')
  return rows.reverse()
}

export const setLocalProjectAssetDirectory = async (
  projectId: string,
  nextRoot: FileSystemDirectoryHandle,
): Promise<void> => {
  const previousRoot = await getWritableProjectRoot(projectId)
  if (previousRoot) {
    const rows = await listLocalAssets(projectId)
    try {
      const previousAssetsDir = await previousRoot.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
      await Promise.all(rows.map(async (row) => {
        try {
          const previousFileHandle = await previousAssetsDir.getFileHandle(row.storagePath)
          await writeFile(nextRoot, row.storagePath, await previousFileHandle.getFile())
        } catch {}
      }))
    } catch {}
  }
  await saveProjectDirectoryHandle(projectId, nextRoot)
}

export const readLocalAssetBytes = async (
  projectId: string,
  assetId: string,
): Promise<LocalAssetBytesResult> => {
  const row = await getLocalAsset(projectId, assetId)
  if (!row) return { status: 'missing' }

  const directoryHandle = await getProjectDirectoryHandle(projectId)
  const root = directoryHandle ?? await getProjectOpfsRoot(projectId)
  if (directoryHandle) {
    const permission = await queryFileSystemHandlePermission(directoryHandle, 'read')
    if (permission !== 'granted') return { status: 'permission-denied' }
  }

  try {
    const assetsDir = await root.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
    const fileHandle = await assetsDir.getFileHandle(row.storagePath)
    return { status: 'ready', file: await fileHandle.getFile() }
  } catch {
    return { status: 'missing' }
  }
}

export const deleteLocalAsset = async (
  projectId: string,
  assetId: string,
): Promise<void> => {
  const row = await getLocalAsset(projectId, assetId)
  const db = await openLocalProjectDb(projectId)
  await db.delete('assets', assetId)
  if (!row) return

  try {
    const directoryHandle = await getProjectDirectoryHandle(projectId)
    const root = directoryHandle ?? await getProjectOpfsRoot(projectId)
    const assetsDir = await root.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
    await assetsDir.removeEntry(row.storagePath)
  } catch {}
}
