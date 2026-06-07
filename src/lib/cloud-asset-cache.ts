import { getLocalAsset, readLocalAssetBytes, writeLocalAssetFile } from '~/lib/local-assets'
import { assetCloudIdMappingKey, isCloudIdMappingValue } from '~/lib/local-cloud-id-map'
import { openLocalProjectDb } from '~/lib/local-project-db'
import { runWithConcurrency } from '~/lib/run-with-concurrency'

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
    db.get('syncState', assetCloudIdMappingKey(assetId)),
  ])
  if (typeof urlRow?.value === 'string') return { kind: 'url', value: urlRow.value }
  if (typeof sourceRow?.value === 'string') return { kind: 'key', value: sourceRow.value }
  if (isCloudIdMappingValue(mappingRow?.value)) return { kind: 'key', value: mappingRow.value.cloudId }
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
