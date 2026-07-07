import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { openLocalProjectDb, type LocalProjectAssetRow } from '~/lib/local-project-db'

type LocalAssetFolderRow = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

const FOLDER_KEY_PREFIX = 'asset-folder:'

const now = () => Date.now()
const folderKey = (folderId: string) => `${FOLDER_KEY_PREFIX}${folderId}`
const createFolderId = () => `asset-folder:${crypto.randomUUID()}`

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const normalizeFolderName = (name: string) => name.trim() || 'Folder'

const readFolderRow = (value: unknown): LocalAssetFolderRow | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return undefined
  if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return undefined
  return {
    id: value.id,
    name: value.name,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

const sortFoldersByName = (folders: LocalAssetFolderRow[]) => (
  [...folders].sort((left, right) => left.name.localeCompare(right.name))
)

export const listLocalAssetFolders = async (projectId: string): Promise<LocalAssetFolderRow[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAll('projectState')
  const folders: LocalAssetFolderRow[] = []
  for (const row of rows) {
    if (!row.key.startsWith(FOLDER_KEY_PREFIX)) continue
    const folder = readFolderRow(row.value)
    if (folder) folders.push(folder)
  }
  return sortFoldersByName(folders)
}

export const createLocalAssetFolder = async (
  projectId: string,
  name: string,
): Promise<LocalAssetFolderRow> => {
  const timestamp = now()
  const row: LocalAssetFolderRow = {
    id: createFolderId(),
    name: normalizeFolderName(name),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const db = await openLocalProjectDb(projectId)
  await db.put('projectState', {
    key: folderKey(row.id),
    value: row,
    updatedAt: timestamp,
  })
  notifyLocalProjectChanged(projectId)
  return row
}

export const renameLocalAssetFolder = async (
  projectId: string,
  folderId: string,
  name: string,
): Promise<LocalAssetFolderRow | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const stateRow = await db.get('projectState', folderKey(folderId))
  const folder = readFolderRow(stateRow?.value)
  if (!folder) return undefined
  const timestamp = now()
  const next = {
    ...folder,
    name: normalizeFolderName(name),
    updatedAt: timestamp,
  }
  await db.put('projectState', {
    key: folderKey(folderId),
    value: next,
    updatedAt: timestamp,
  })
  notifyLocalProjectChanged(projectId)
  return next
}

export const deleteEmptyLocalAssetFolder = async (
  projectId: string,
  folderId: string,
): Promise<boolean> => {
  const db = await openLocalProjectDb(projectId)
  const assets = await db.getAll('assets')
  if (assets.some((asset) => asset.folderId === folderId)) return false
  await db.delete('projectState', folderKey(folderId))
  notifyLocalProjectChanged(projectId)
  return true
}

export const moveLocalAssetToFolder = async (
  projectId: string,
  assetId: string,
  folderId: string | undefined,
): Promise<LocalProjectAssetRow | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const asset = await db.get('assets', assetId)
  if (!asset) return undefined
  if (folderId) {
    const folder = readFolderRow((await db.get('projectState', folderKey(folderId)))?.value)
    if (!folder) return undefined
  }
  const timestamp = now()
  const next: LocalProjectAssetRow = {
    ...asset,
    folderId,
    updatedAt: timestamp,
  }
  await db.put('assets', next)
  notifyLocalProjectChanged(projectId)
  return next
}
