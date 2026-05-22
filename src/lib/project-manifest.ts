import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
  type LocalProjectAssetRow,
  type LocalProjectEntityRow,
  type LocalProjectStateRow,
  type LocalProjectSyncStateRow,
} from '~/lib/local-project-db'
import { flushLocalTimelineWrites } from '~/lib/timeline-repository/local-timeline-repository'

const PROJECT_MANIFEST_SCHEMA_VERSION = 1

export type ProjectManifestAsset = LocalProjectAssetRow & {
  cloudKey?: string
}

export type ProjectManifest = {
  schemaVersion: number
  projectId: string
  name: string
  mode: 'backup' | 'shared'
  updatedAt: number
  entityCount: number
  assetCount: number
  entities: LocalProjectEntityRow[]
  assets: ProjectManifestAsset[]
  projectState: LocalProjectStateRow[]
  syncState: LocalProjectSyncStateRow[]
}

const latestLocalProjectUpdate = (
  projectUpdatedAt: number,
  rows: Awaited<ReturnType<typeof exportLocalProjectRows>>,
) => Math.max(
  projectUpdatedAt,
  ...rows.entities.map((row) => row.updatedAt),
  ...rows.assets.map((row) => row.updatedAt),
  ...rows.projectState.map((row) => row.updatedAt),
  ...rows.syncState.map((row) => row.updatedAt),
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

const assertSupportedProjectManifest = (manifest: ProjectManifest): void => {
  if (manifest.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported project manifest schema version ${manifest.schemaVersion}.`)
  }
  if (!manifest.projectId || !manifest.name) {
    throw new Error('Project manifest is missing required identity fields.')
  }
}

export const migrateProjectManifest = (manifest: ProjectManifest): ProjectManifest => {
  assertSupportedProjectManifest(manifest)
  return manifest
}

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
