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
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

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
const MAX_ASSET_EXTENSION_LENGTH = 16

const isPermissionError = (error: unknown) => (
  error instanceof DOMException
  && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
)

const now = () => Date.now()

const getAssetFileName = (assetId: string, fileName: string) => {
  const safeName = fileName.trim().replace(/[/\\:]/g, '-')
  const extensionStart = safeName.lastIndexOf('.')
  const extension = extensionStart > 0 ? safeName.slice(extensionStart) : ''
  return `${assetId}${extension.length <= MAX_ASSET_EXTENSION_LENGTH ? extension : ''}`
}

const requireWritableDirectory = async (root: FileSystemDirectoryHandle) => {
  const permission = await queryFileSystemHandlePermission(root)
  if (permission === 'granted') return
  if (await requestFileSystemHandlePermission(root) === 'granted') return
  throw new LocalAssetWriteError('permission-denied', 'Project storage permission is required.')
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

const removeFileIfPresent = async (
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<void> => {
  try {
    const assetsDir = await root.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
    await assetsDir.removeEntry(path)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return
    throw error
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
  try {
    await db.put('assets', row)
  } catch (error) {
    await removeFileIfPresent(root, storagePath).catch(() => null)
    throw error
  }
  notifyLocalProjectChanged(input.projectId)
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
  const rows = await listLocalAssets(projectId)
  await requireWritableDirectory(nextRoot)
  const previousRoot = await getWritableProjectRoot(projectId)
  if (rows.length === 0) {
    await saveProjectDirectoryHandle(projectId, nextRoot)
    return
  }
  if (!previousRoot) {
    throw new LocalAssetWriteError('permission-denied', 'Project storage permission is required before changing folders.')
  }

  try {
    const previousAssetsDir = await previousRoot.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
    await Promise.all(rows.map(async (row) => {
      const previousFileHandle = await previousAssetsDir.getFileHandle(row.storagePath)
      await writeFile(nextRoot, row.storagePath, await previousFileHandle.getFile())
    }))
  } catch (error) {
    if (error instanceof LocalAssetWriteError) throw error
    throw new LocalAssetWriteError('write-failed', 'Existing project audio could not be copied to the new folder.')
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

  try {
    if (directoryHandle) {
      const permission = await queryFileSystemHandlePermission(directoryHandle, 'read')
      const readable = permission === 'granted'
        || await requestFileSystemHandlePermission(directoryHandle, 'read') === 'granted'
      if (!readable) return { status: 'permission-denied' }
    }
    const assetsDir = await root.getDirectoryHandle(ASSETS_DIRECTORY_NAME)
    const fileHandle = await assetsDir.getFileHandle(row.storagePath)
    return { status: 'ready', file: await fileHandle.getFile() }
  } catch (error) {
    if (isPermissionError(error)) return { status: 'permission-denied' }
    return { status: 'missing' }
  }
}

export const deleteLocalAsset = async (
  projectId: string,
  assetId: string,
): Promise<void> => {
  const row = await getLocalAsset(projectId, assetId)
  const db = await openLocalProjectDb(projectId)
  if (row) {
    const root = await getWritableProjectRoot(projectId)
    if (!root) {
      throw new LocalAssetWriteError('permission-denied', 'Project storage permission is required.')
    }
    await removeFileIfPresent(root, row.storagePath)
  }
  await db.delete('assets', assetId)
  notifyLocalProjectChanged(projectId)
}
