import { deleteDB, type IDBPDatabase } from 'idb'
import type { GlobalProjectsDB, ProjectDB } from './local-project-db-schema'
import {
  withLocalProjectAssetLockIfAvailable,
  withLocalProjectCleanupRunner,
  withLocalStorageRootLock,
} from './local-project-asset-lock'

const MAX_DELETION_CLEANUPS_PER_RUN = 8
let deletionCleanupPromise: Promise<void> | undefined

export type LocalProjectDeletionDependencies = {
  catalog: IDBPDatabase<GlobalProjectsDB>
  openProjectDb: (projectId: string) => Promise<IDBPDatabase<ProjectDB>>
  /** Closes this realm's cached connection and returns the database name to delete. */
  closeProjectConnection: (projectId: string) => Promise<string>
  rootReference: () => Promise<FileSystemDirectoryHandle>
  projectOpfsRoot: (projectId: string) => Promise<FileSystemDirectoryHandle>
  /** Caller holds project, then storage-root lock. */
  saveDirectoryReference: (projectId: string, handle: FileSystemDirectoryHandle | undefined) => Promise<void>
}

const ignoreMissingFile = (error: Error) => {
  if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
}

export const deleteLocalProjectAssetFiles = async (
  dependencies: LocalProjectDeletionDependencies,
  projectId: string,
  directoryHandle: FileSystemDirectoryHandle | undefined,
  assetPaths: string[],
): Promise<void> => {
  if (assetPaths.length === 0) return

  const projectDir = await (async () => {
    const root = await dependencies.rootReference()

    return root.getDirectoryHandle(projectId)
  })().catch(() => undefined)

  for (const directory of [projectDir, directoryHandle]) {
    if (!directory) continue
    await withLocalStorageRootLock(async () => {
      try {
        const retained = await retainedAssetPathsIn(dependencies, directory)
        const assetsDir = await directory.getDirectoryHandle('assets')

        for (const path of assetPaths) {
          if (!retained.has(path)) await assetsDir.removeEntry(path).catch(ignoreMissingFile)
        }
      } catch {}
    })
  }
}

export const startLocalProjectDeletionCleanup = (dependencies: LocalProjectDeletionDependencies): void => {
  if (deletionCleanupPromise) return
  const { catalog } = dependencies
  // A list/open starts one bounded pass. Failed jobs wait for the next user
  // operation, never an automatic retry loop, and cannot reject the listing.
  deletionCleanupPromise = withLocalProjectCleanupRunner(async () => {
    await recoverAbandonedDirectoryCopies(dependencies)

    const jobs = (await catalog.getAll('projectDeletions'))
      .sort((left, right) => (left.lastAttemptAt ?? 0) - (right.lastAttemptAt ?? 0)
        || left.projectId.localeCompare(right.projectId))
      .slice(0, MAX_DELETION_CLEANUPS_PER_RUN)

    for (const { projectId } of jobs) {
      const acquired = await withLocalProjectAssetLockIfAvailable(projectId, () => finishLocalProjectDeletion(dependencies, projectId))

      if (!acquired) {
        const job = await catalog.get('projectDeletions', projectId)

        if (job) await catalog.put('projectDeletions', { ...job, lastAttemptAt: Date.now() })
      }
    }
  }).catch((error: Error) => {
    console.warn('Local project cleanup could not be completed.', error)
  }).finally(() => { deletionCleanupPromise = undefined })
}

const recoverAbandonedDirectoryCopies = async (dependencies: LocalProjectDeletionDependencies): Promise<void> => {
  const { catalog } = dependencies
  const reservations = (await catalog.getAll('directoryHandles')).filter((entry) => entry.copyingTo)

  for (const { projectId } of reservations) {
    // Copies hold their owner lock until every file settles. Web Locks release
    // on realm death; skip a live owner rather than delaying this cleanup pass.
    await withLocalProjectAssetLockIfAvailable(projectId, () => withLocalStorageRootLock(async () => {
      const current = await catalog.get('directoryHandles', projectId)

      if (!current?.copyingTo) return
      const root = await dependencies.rootReference()

      const opfs = await root.getDirectoryHandle(projectId).catch((error: Error) => {
        ignoreMissingFile(error)

        return undefined
      })

      // OPFS copies temporarily publish their source root as a directory entry.
      // Restore implicit OPFS storage, or retain the original chosen folder.
      const handle = opfs && await opfs.isSameEntry(current.handle) ? undefined : current.handle
      await dependencies.saveDirectoryReference(projectId, handle)
    }))
  }
}

/** Caller holds the project asset lock. Recheck root ownership under the global lock. */
export const finishLocalProjectDeletion = async (
  dependencies: LocalProjectDeletionDependencies,
  projectId: string,
): Promise<void> => {
  const { catalog } = dependencies

  try {
    const job = await catalog.get('projectDeletions', projectId)

    if (!job) return
    // Persist before attempting I/O, including failures and interrupted passes.
    await catalog.put('projectDeletions', {
      ...job, lastAttemptAt: Date.now(), attemptCount: (job.attemptCount ?? 0) + 1,
    })
    const filesRemoved = await withLocalStorageRootLock(() => removeDeletedProjectFiles(dependencies, projectId))

    if (!filesRemoved) return
    // Database teardown needs only the project lock, not the storage-root lock.
    const dbName = await dependencies.closeProjectConnection(projectId)

    // Another tab can hold an old connection. Leave the durable job in place
    // instead of keeping an already committed deletion waiting.
    const deleted = await new Promise<boolean>((resolve, reject) => {
      void deleteDB(dbName, { blocked: () => resolve(false) }).then(() => resolve(true), reject)
    })

    if (!deleted) return
    await catalog.delete('projectDeletions', projectId)
  } catch (error) {
    // Logical deletion already succeeded. Retain the durable job for another pass.
    console.warn('Local project cleanup could not be completed.', error)
  }
}

/** Caller holds root, so the atomic reference snapshots stay valid until removal. */
export const retainedAssetPathsIn = async (
  dependencies: LocalProjectDeletionDependencies,
  directory: FileSystemDirectoryHandle | undefined,
  owner?: { projectId: string; excludingAssetGcId?: string },
): Promise<Set<string>> => {
  const { catalog } = dependencies
  const handles = await catalog.getAll('directoryHandles')
  const retained = new Set<string>()
  const projectIds = new Set<string>(owner ? [owner.projectId] : [])
  // Resolve implicit OPFS only when other directory references need comparison.
  const root = directory ?? (handles.length > 0 && owner ? await dependencies.projectOpfsRoot(owner.projectId) : undefined)

  if (root) {
    const path = await (await dependencies.rootReference()).resolve(root)
    const implicitProjectId = path?.length === 1 ? path[0] : undefined

    if (implicitProjectId && !handles.some((entry) => entry.projectId === implicitProjectId)
      && await catalog.get('projects', implicitProjectId)) projectIds.add(implicitProjectId)
  }

  for (const entry of handles) {
    if (root && (await root.isSameEntry(entry.handle)
      || entry.copyingTo && await root.isSameEntry(entry.copyingTo))) projectIds.add(entry.projectId)
  }

  for (const projectId of projectIds) {
    const otherDb = await dependencies.openProjectDb(projectId)
    // A recovery moves GC retention into assets. Observe both stores at the
    // same IDB revision, never the gap between two independent transactions.
    const tx = otherDb.transaction(['assets', 'controlAssetGc'], 'readonly')

    const [live, gc] = await Promise.all([
      tx.objectStore('assets').getAll(),
      tx.objectStore('controlAssetGc').getAll(),
    ])

    await tx.done

    for (const asset of live) retained.add(asset.storagePath)

    for (const asset of gc) {
      if (projectId !== owner?.projectId || asset.id !== owner.excludingAssetGcId) retained.add(asset.storagePath)
    }
  }

  return retained
}

const removeDeletedProjectFiles = async (
  dependencies: LocalProjectDeletionDependencies,
  projectId: string,
): Promise<boolean> => {
  const { catalog } = dependencies
  const job = await catalog.get('projectDeletions', projectId)

  if (!job) return false

  // An explicitly restored project must never be removed by an older cleanup job.
  if (await catalog.get('projects', projectId)) {
    await catalog.delete('projectDeletions', projectId)

    return false
  }

  const root = await dependencies.rootReference()
  const handles = await catalog.getAll('directoryHandles')
  const roots = handles.flatMap((entry) => entry.copyingTo ? [entry.handle, entry.copyingTo] : [entry.handle])

  const projectRoot = await root.getDirectoryHandle(projectId).catch((error: Error) => {
    ignoreMissingFile(error)

    return undefined
  })

  if (projectRoot) {
    for (const handle of roots) {
      // A chosen folder can even point inside another project's OPFS root.
      // Retain that root while it is in use rather than deleting shared bytes.
      if (await projectRoot.resolve(handle) !== null) return false
    }
  }

  await root.removeEntry(projectId, { recursive: true }).catch(ignoreMissingFile)

  if (job.directoryHandle) {
    const directoryHandle = job.directoryHandle
    // Directory-backed projects may share a folder. OPFS roots are project-scoped.
    const retainedPaths = await retainedAssetPathsIn(dependencies, directoryHandle)

    try {
      const assets = await directoryHandle.getDirectoryHandle('assets')

      for (const path of job.assetPaths) {
        // All publishers honor the root lock held throughout this snapshot and
        // removal. Recheck each path immediately before deleting its bytes.
        if (!retainedPaths.has(path)) await assets.removeEntry(path).catch(ignoreMissingFile)
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error
    }
  }

  return true
}
