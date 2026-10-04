import { createLocalProjectId, normalizeProjectManifest } from '@daw-browser/shared'
import { listLocalAssets, readLocalAssetBytes, writeLocalAssetFileUnlocked } from '~/lib/local-assets'
import { deleteLocalProjectUnlocked, importLocalProjectUnlocked } from '~/lib/local-project-db'
import { withLocalProjectAssetLock } from '~/lib/local-project-asset-lock'
import {
  buildProjectManifest,
  createRestoredProjectEntry,
} from '~/lib/project-manifest'
import { readStoredZipEntries, writeStoredZip } from '~/lib/project-archive-stream'

/** Bounded archive writer; the callback owns the destination. */
export const exportDawProjectArchiveStreamed = async (
  projectId: string,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<void> => {
  const manifest = await buildProjectManifest(projectId, 'backup')
  const entries: { name: string; file: Blob }[] = [
    { name: 'manifest.json', file: new Blob([JSON.stringify(manifest)]) },
  ]
  for (const asset of await listLocalAssets(projectId)) {
    const result = await readLocalAssetBytes(projectId, asset.id)
    if (result.status !== 'ready') {
      throw new Error(`Archive export failed because "${asset.name}" is not readable.`)
    }
    entries.push({ name: `assets/${asset.id}/${asset.storagePath}`, file: result.file })
  }
  await writeStoredZip(entries, write)
}

export const exportDawProjectArchive = async (projectId: string): Promise<Blob> => {
  const chunks: ArrayBuffer[] = []
  await exportDawProjectArchiveStreamed(projectId, (chunk) => {
    const bytes = new Uint8Array(chunk.byteLength)
    bytes.set(chunk)
    chunks.push(bytes.buffer)
  })
  return new Blob(chunks, { type: 'application/vnd.dawproject' })
}

/** The archive is validated before any project data is written. */
const importStoredDawProjectArchive = async (file: File): Promise<string> => {
  const entries = new Map<string, Blob>()
  for await (const entry of readStoredZipEntries(file)) entries.set(entry.name, entry.file)
  const manifestFile = entries.get('manifest.json')
  if (!manifestFile) throw new Error('Archive is missing manifest.json.')
  const manifest = normalizeProjectManifest(JSON.parse(await manifestFile.text()))
  const expectedNames = new Set(['manifest.json'])
  for (const asset of manifest.assets) {
    const name = `assets/${asset.id}/${asset.storagePath}`
    if (!entries.has(name)) throw new Error(`Archive is missing asset bytes for "${asset.name}".`)
    expectedNames.add(name)
  }
  if (expectedNames.size !== entries.size) throw new Error('Archive contains unexpected entries.')

  const projectId = createLocalProjectId()
  const project = createRestoredProjectEntry({ ...manifest, projectId }, manifest.name)
  const localAssets = manifest.assets.map(({ cloudKey: _cloudKey, ...asset }) => asset)
  try {
    await withLocalProjectAssetLock(projectId, async () => {
      for (const asset of manifest.assets) {
        const blob = entries.get(`assets/${asset.id}/${asset.storagePath}`)
        if (!blob) throw new Error(`Archive is missing asset bytes for "${asset.name}".`)
        await writeLocalAssetFileUnlocked(projectId, asset.storagePath, new File([blob], asset.name, { type: asset.mimeType }))
      }
      await importLocalProjectUnlocked(project, {
        entities: manifest.entities,
        assets: localAssets,
        projectState: manifest.projectState,
        syncState: [],
        externalPluginArtifacts: manifest.externalPluginArtifacts.map((artifact) => ({
          ...artifact,
          updatedAt: Date.now(),
        })),
      })
    })
  } catch (error) {
    await withLocalProjectAssetLock(projectId, () => deleteLocalProjectUnlocked(projectId))
    throw error
  }
  return projectId
}

export const importDawProjectArchive = importStoredDawProjectArchive
export const importDawProjectArchiveStreamed = importStoredDawProjectArchive
