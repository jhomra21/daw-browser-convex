import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
} from '~/lib/local-project-db'
import { flushLocalTimelineWrites } from '~/lib/timeline-repository/local-timeline-repository'
import {
  normalizeProjectManifest,
  type ProjectManifest,
} from '~/lib/project-manifest-contract'

const PROJECT_MANIFEST_SCHEMA_VERSION = 1

const latestLocalProjectUpdate = (
  projectUpdatedAt: number,
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>,
) => Math.max(
  projectUpdatedAt,
  ...rows.entities.map((row) => row.updatedAt),
  ...rows.assets.map((row) => row.updatedAt),
  ...rows.projectState.map((row) => row.updatedAt),
)

export const buildProjectManifest = async (
  projectId: string,
  mode: 'backup' | 'shared' = 'backup',
): Promise<ProjectManifest> => {
  const project = await getLocalProject(projectId)
  if (!project) throw new Error('Local project not found.')
  await flushLocalTimelineWrites()
  const rows = await exportLocalProjectRows(projectId)
  const updatedAt = latestLocalProjectUpdate(project.updatedAt, rows)
  return {
    schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
    projectId,
    name: project.name,
    mode,
    updatedAt,
    entityCount: rows.entities.length,
    assetCount: rows.assets.length,
    entities: rows.entities,
    assets: rows.assets,
    projectState: rows.projectState,
    syncState: rows.syncState,
  }
}

export const migrateProjectManifest = (manifest: unknown): ProjectManifest => normalizeProjectManifest(manifest)

export const createRestoredProjectEntry = (manifest: ProjectManifest, name = manifest.name) => {
  const timestamp = Date.now()
  return {
    id: manifest.projectId,
    name: name.trim() || manifest.name || 'Untitled',
    schemaVersion: LOCAL_PROJECT_SCHEMA_VERSION,
    mode: 'local-only' as const,
    storageKind: 'opfs' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
  }
}
