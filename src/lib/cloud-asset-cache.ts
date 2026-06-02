import { getLocalAsset, readLocalAssetBytes, writeLocalAssetFile } from '~/lib/local-assets'
import { openLocalProjectDb } from '~/lib/local-project-db'

type CloudAssetReadResult =
  | { status: 'ready'; file: File; source: 'local' | 'cloud' }
  | { status: 'missing' }
  | { status: 'permission-denied' }

type CloudAssetReference =
  | { kind: 'key'; value: string }
  | { kind: 'url'; value: string }

const readCloudAssetReference = async (
  projectId: string,
  assetId: string,
): Promise<CloudAssetReference | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const [urlRow, sourceRow, mappingRow] = await Promise.all([
    db.get('syncState', `cloud-url:asset:${assetId}`),
    db.get('syncState', `cloud-source:asset:${assetId}`),
    db.get('syncState', `cloud-id:asset:${assetId}`),
  ])
  if (typeof urlRow?.value === 'string') return { kind: 'url', value: urlRow.value }
  if (typeof sourceRow?.value === 'string') return { kind: 'key', value: sourceRow.value }
  const mapping = mappingRow?.value
  if (typeof mapping === 'object' && mapping !== null && !Array.isArray(mapping) && 'cloudId' in mapping) {
    return typeof mapping.cloudId === 'string' ? { kind: 'key', value: mapping.cloudId } : undefined
  }
  return undefined
}

const parseCloudAssetKey = (key: string) => {
  const match = /^projects\/([^/]+)\/assets\/([^/]+)\//.exec(key)
  if (!match) return null
  return { projectId: match[1], assetId: match[2] }
}

const readCloudAssetFile = async (
  projectId: string,
  assetId: string,
  metadata?: { name?: string; mimeType?: string },
): Promise<CloudAssetReadResult> => {
  const cloudRef = await readCloudAssetReference(projectId, assetId)
  if (!cloudRef) return { status: 'missing' }
  let url = cloudRef.value
  if (cloudRef.kind === 'key') {
    const parsed = parseCloudAssetKey(cloudRef.value)
    if (!parsed) return { status: 'missing' }
    url = `/api/samples/${encodeURIComponent(parsed.projectId)}/${encodeURIComponent(parsed.assetId)}?key=${encodeURIComponent(cloudRef.value)}`
  }

  const response = await fetch(url)
  if (response.status === 403 || response.status === 401) return { status: 'permission-denied' }
  if (!response.ok) return { status: 'missing' }

  const row = metadata ?? await getLocalAsset(projectId, assetId)
  const blob = await response.blob()
  return {
    status: 'ready',
    file: new File([blob], row?.name ?? assetId, { type: row?.mimeType || blob.type || 'application/octet-stream' }),
    source: 'cloud',
  }
}

export const readLocalOrCloudAssetFile = async (
  projectId: string,
  assetId: string,
): Promise<CloudAssetReadResult> => {
  const local = await readLocalAssetBytes(projectId, assetId)
  if (local.status === 'ready') {
    return { status: 'ready', file: local.file, source: 'local' }
  }

  const cloud = await readCloudAssetFile(projectId, assetId)
  return cloud.status === 'missing' ? local : cloud
}

const cacheCloudAssetForOffline = async (
  projectId: string,
  assetId: string,
): Promise<void> => {
  const row = await getLocalAsset(projectId, assetId)
  if (!row) throw new Error('Asset metadata is missing.')
  const result = await readCloudAssetFile(projectId, assetId, row)
  if (result.status !== 'ready') throw new Error('Cloud asset could not be downloaded.')
  await writeLocalAssetFile(projectId, row.storagePath, result.file)
}

const runWithConcurrency = async <T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await worker(item)
    }
  }))
}

export const downloadCloudAssetsForOffline = async (
  projectId: string,
): Promise<number> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAll('assets')
  let downloaded = 0
  await runWithConcurrency(rows, 3, async (asset) => {
    const before = await readLocalAssetBytes(projectId, asset.id)
    if (before.status === 'ready') return
    await cacheCloudAssetForOffline(projectId, asset.id)
    downloaded += 1
  })
  return downloaded
}
