import { isLocalId } from '@daw-browser/shared'
import {
  createLocalAssetFolder,
  deleteEmptyLocalAssetFolder,
  moveLocalAssetToFolder,
  renameLocalAssetFolder,
} from '~/lib/local-asset-folders'
import { convexApi, convexClient } from '~/lib/convex'

type AssetFolderBackend = {
  create: (name: string) => Promise<void>
  rename: (folderId: string, name: string) => Promise<void>
  deleteEmpty: (folderId: string) => Promise<void>
  moveSample: (assetKey: string, folderId: string | undefined) => Promise<void>
}

// Local folders are rows in the project's IndexedDB; their views are not live, so each write refreshes them.
const createLocalAssetFolderBackend = (
  projectId: string,
  views: { refreshFolders: () => void; refreshSamples: () => void },
): AssetFolderBackend => ({
  create: async (name) => {
    await createLocalAssetFolder(projectId, name)
    views.refreshFolders()
  },
  rename: async (folderId, name) => {
    await renameLocalAssetFolder(projectId, folderId, name)
    views.refreshFolders()
  },
  deleteEmpty: async (folderId) => {
    await deleteEmptyLocalAssetFolder(projectId, folderId)
    views.refreshFolders()
  },
  moveSample: async (assetKey, folderId) => {
    await moveLocalAssetToFolder(projectId, assetKey, folderId)
    views.refreshSamples()
  },
})

// Cloud folders are Convex mutations; their views are live queries, so nothing is refreshed.
const createCloudAssetFolderBackend = (projectId: string): AssetFolderBackend => ({
  create: async (name) => {
    await convexClient.mutation(convexApi.assetFolders.create, { projectId, name })
  },
  rename: async (folderId, name) => {
    await convexClient.mutation(convexApi.assetFolders.rename, { projectId, folderId, name })
  },
  deleteEmpty: async (folderId) => {
    await convexClient.mutation(convexApi.assetFolders.deleteEmpty, { projectId, folderId })
  },
  moveSample: async (assetKey, folderId) => {
    await convexClient.mutation(convexApi.samples.moveToFolder, { projectId, assetKey, folderId })
  },
})

export const createAssetFolderBackend = (
  projectId: string,
  views: { refreshFolders: () => void; refreshSamples: () => void },
): AssetFolderBackend => isLocalId('project', projectId)
  ? createLocalAssetFolderBackend(projectId, views)
  : createCloudAssetFolderBackend(projectId)
