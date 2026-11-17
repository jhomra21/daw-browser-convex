import type { DBSchema } from 'idb'
import type {
  LocalControlApprovalRow,
  LocalControlAssetGcRow,
  LocalControlCommitRow,
  LocalControlRecoveryRow,
  LocalControlStateRow,
  LocalProjectAssetRow,
  LocalProjectDirectoryEntry,
  LocalProjectEntityRow,
  LocalProjectEntry,
  LocalProjectExternalPluginArtifactRow,
  LocalProjectHistoryRow,
  LocalProjectStateRow,
  LocalProjectSyncStateRow,
} from './local-project-db'

export type GlobalProjectsDB = DBSchema & {
  projectDeletions: {
    key: string
    value: {
      projectId: string
      assetPaths: string[]
      directoryHandle?: FileSystemDirectoryHandle
      lastAttemptAt?: number
      attemptCount?: number
    }
  }
  projects: {
    key: string
    value: LocalProjectEntry
    indexes: {
      'by-last-opened': number
      'by-updated-at': number
    }
  }
  directoryHandles: {
    key: string
    value: LocalProjectDirectoryEntry
  }
}

export type ProjectDB = DBSchema & {
  entities: {
    key: [string, string]
    value: LocalProjectEntityRow
    indexes: {
      'by-kind': string
      'by-updated-at': number
    }
  }
  assets: {
    key: string
    value: LocalProjectAssetRow
    indexes: {
      'by-updated-at': number
    }
  }
  projectState: {
    key: string
    value: LocalProjectStateRow
  }
  history: {
    key: string
    value: LocalProjectHistoryRow
  }
  syncState: {
    key: string
    value: LocalProjectSyncStateRow
  }
  externalPluginArtifacts: {
    key: string
    value: LocalProjectExternalPluginArtifactRow
    indexes: {
      'by-updated-at': number
    }
  }
  controlState: { key: string; value: LocalControlStateRow }
  controlCommits: {
    key: string; value: LocalControlCommitRow
    indexes: { 'by-created-at': number; 'by-actor-idempotency': [string, string] }
  }
  controlApprovals: {
    key: string; value: LocalControlApprovalRow
    indexes: { 'by-expires-at': number; 'by-created-at': number; 'by-actor': string }
  }
  controlRecoveries: {
    key: string; value: LocalControlRecoveryRow
    indexes: { 'by-created-at': number; 'by-expires-at': number; 'by-actor': string }
  }
  controlAssetGc: {
    key: string; value: LocalControlAssetGcRow
    indexes: { 'by-eligible-at': number; 'by-storage-path': string }
  }
}
