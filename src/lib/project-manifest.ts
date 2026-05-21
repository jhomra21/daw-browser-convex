import {
  exportLocalProjectRows,
  getLocalProject,
  LOCAL_PROJECT_SCHEMA_VERSION,
  type LocalProjectAssetRow,
  type LocalProjectEntityRow,
  type LocalProjectStateRow,
} from '~/lib/local-project-db'

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
}

export const buildProjectManifest = async (
  projectId: string,
  mode: 'backup' | 'shared' = 'backup',
): Promise<ProjectManifest> => {
  const project = await getLocalProject(projectId)
  if (!project) throw new Error('Local project not found.')
  const rows = await exportLocalProjectRows(projectId)
  const updatedAt = Date.now()
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
  }
}

export const assertSupportedProjectManifest = (manifest: ProjectManifest): void => {
  if (manifest.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported project manifest schema version ${manifest.schemaVersion}.`)
  }
  if (!manifest.projectId || !manifest.name) {
    throw new Error('Project manifest is missing required identity fields.')
  }
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
