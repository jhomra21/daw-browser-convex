import {
  normalizeProjectManifestPluginArtifact,
  type ProjectManifestPluginArtifact,
} from '@daw-browser/shared'
import { openLocalProjectDb, type LocalProjectExternalPluginArtifactRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

export const setLocalExternalPluginArtifact = async (
  projectId: string,
  artifact: ProjectManifestPluginArtifact,
  updatedAt = Date.now(),
): Promise<LocalProjectExternalPluginArtifactRow> => {
  const parsed = normalizeProjectManifestPluginArtifact(artifact)
  const row = { ...parsed, updatedAt }
  const db = await openLocalProjectDb(projectId)
  await db.put('externalPluginArtifacts', row)
  notifyLocalProjectChanged(projectId)
  return row
}