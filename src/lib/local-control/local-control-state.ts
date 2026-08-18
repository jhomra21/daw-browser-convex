import {
  hashCanonicalJsonSyncV1,
  type ProjectSnapshotV1,
  type ProjectSnapshotV2,
} from '@daw-browser/control'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import type { PendingWriteKind } from '~/lib/local-project-write-flushers'
import {
  type LocalControlApprovalRow,
  type LocalControlAssetGcRow,
  type LocalControlCommitRow,
  type LocalControlRecoveryRow,
  getLocalProject,
  openLocalProjectDb,
  type LocalControlProjectMetadata,
  type LocalProjectAssetRow,
  type LocalProjectEntityRow,
  type LocalProjectStateRow,
  type LocalProjectStoredValue,
  type LocalProjectSyncStateRow,
} from '~/lib/local-project-db'
import { isJsonNumber, isJsonObject, isJsonString } from '@daw-browser/shared'
import { projectLocalControlSnapshotV1, projectLocalControlSnapshotV2 } from './local-control-projector'
import { parseLocalProjectStoredJsonValue } from './local-control-model'

const CONTROL_SNAPSHOT_STATE_KEY = 'snapshot'
const chains = new Map<string, Promise<void>>()
type LocalControlSnapshotState = {
  version: 1 | 2
  revision: number
  digest: string
  updatedAt: number
}

export class LocalControlTransactionError extends Error {
  readonly kind: 'not-found' | 'limit-exceeded' | 'corruption'

  constructor(kind: 'not-found' | 'limit-exceeded' | 'corruption') {
    super(kind)
    this.name = 'LocalControlTransactionError'
    this.kind = kind
  }
}

export type LocalControlTransactionResult = {
  snapshot: ProjectSnapshotV2
  state: LocalControlSnapshotState
  rows: {
    entities: readonly LocalProjectEntityRow[]
    assets: readonly LocalProjectAssetRow[]
    projectState: readonly LocalProjectStateRow[]
    syncState: readonly LocalProjectSyncStateRow[]
    commits: readonly LocalControlCommitRow[]
    approvals: readonly LocalControlApprovalRow[]
    recoveries: readonly LocalControlRecoveryRow[]
    assetGc: readonly LocalControlAssetGcRow[]
  }
  write: {
    controlState: (state: LocalControlSnapshotState) => void
    entity: (row: LocalProjectEntityRow) => void
    asset: (row: LocalProjectAssetRow) => void
    projectState: (row: LocalProjectStateRow) => void
    syncState: (row: LocalProjectSyncStateRow) => void
    commit: (row: LocalControlCommitRow) => void
    approval: (row: LocalControlApprovalRow) => void
    recovery: (row: LocalControlRecoveryRow) => void
    assetGc: (row: LocalControlAssetGcRow) => void
  }
  remove: {
    entity: (kind: string, id: string) => void
    asset: (id: string) => void
    projectState: (key: string) => void
    syncState: (key: string) => void
    commit: (id: string) => void
    approval: (id: string) => void
    recovery: (id: string) => void
    assetGc: (id: string) => void
  }
}

const controlState = (storedValue: LocalProjectStoredValue): LocalControlSnapshotState | undefined => {
  const value = parseLocalProjectStoredJsonValue(storedValue)
  if (
    !isJsonObject(value)
    || (value.version !== 1 && value.version !== 2)
    || !isJsonNumber(value.revision)
    || !Number.isInteger(value.revision)
    || value.revision < 0
    || !isJsonString(value.digest)
    || !/^[0-9a-f]{64}$/u.test(value.digest)
    || !isJsonNumber(value.updatedAt)
    || !Number.isInteger(value.updatedAt)
    || value.updatedAt < 0
  ) return undefined
  return { version: value.version, revision: value.revision, digest: value.digest, updatedAt: value.updatedAt }
}

const semanticSnapshotDigest = (snapshot: ProjectSnapshotV2) => {
  const {
    revision: _revision,
    updatedAt: _updatedAt,
    ...project
  } = snapshot.project
  const content = {
    project,
    tracks: snapshot.tracks,
    clips: snapshot.clips,
    processors: snapshot.processors,
    automation: snapshot.automation,
    sidechains: snapshot.sidechains,
    assets: snapshot.assets,
    assetFolders: snapshot.assetFolders,
  }
  return hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify(content)))
}

const legacySemanticSnapshotDigest = (snapshot: ProjectSnapshotV1) => {
  const {
    revision: _revision,
    updatedAt: _updatedAt,
    ...project
  } = snapshot.project
  return hashCanonicalJsonSyncV1(JSON.parse(JSON.stringify({
    project,
    tracks: snapshot.tracks,
    clips: snapshot.clips,
    processors: snapshot.processors,
    automation: snapshot.automation,
    sidechains: snapshot.sidechains,
    assets: snapshot.assets,
    assetFolders: snapshot.assetFolders,
  })))
}

const metadataFor = (project: { name: string; updatedAt: number }): LocalControlProjectMetadata => ({
  version: 1,
  name: project.name,
  updatedAt: project.updatedAt,
  timeSignature: { numerator: 4, denominator: 4 },
})

const isThenable = <Value>(value: Value | PromiseLike<Value>): value is PromiseLike<Value> => (
  Object(value).then instanceof Function
)

type LocalControlTransactionOptions = {
  excludePendingWriteKinds?: readonly PendingWriteKind[]
  flushPendingWrites?: boolean
  pendingWritesFlushedUnderAssetLock?: boolean
}

const abortLocalControlTransaction = (tx: { abort: () => void; done: Promise<unknown> }) => {
  tx.abort()
  void tx.done.catch(() => undefined)
}

type ThenableCallbackArgument<Value> = [Value] extends [never]
  ? []
  : Value extends PromiseLike<unknown>
    ? ['Local control transaction callbacks must be synchronous.']
    : []

const runLocalControlTransaction = async <Value>(
  projectId: string,
  callback: (result: LocalControlTransactionResult) => Value,
): Promise<Value> => {
  const project = await getLocalProject(projectId)
  if (!project) throw new LocalControlTransactionError('not-found')
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction(['entities', 'assets', 'projectState', 'syncState', 'controlState', 'controlCommits', 'controlApprovals', 'controlRecoveries', 'controlAssetGc'], 'readwrite')
  const [entities, assets, projectState, syncState, currentRow, commits, approvals, recoveries, assetGc] = await Promise.all([
    tx.objectStore('entities').getAll(),
    tx.objectStore('assets').getAll(),
    tx.objectStore('projectState').getAll(),
    tx.objectStore('syncState').getAll(),
    tx.objectStore('controlState').get(CONTROL_SNAPSHOT_STATE_KEY),
    tx.objectStore('controlCommits').getAll(),
    tx.objectStore('controlApprovals').getAll(),
    tx.objectStore('controlRecoveries').getAll(),
    tx.objectStore('controlAssetGc').getAll(),
  ])
  if (commits.length > 2049 || recoveries.length > 2049 || approvals.length > 129 || assetGc.length > 1001) {
    abortLocalControlTransaction(tx)
    throw new LocalControlTransactionError('limit-exceeded')
  }
  const current = currentRow === undefined ? undefined : controlState(currentRow.value)
  if (currentRow !== undefined && current === undefined) {
    abortLocalControlTransaction(tx)
    throw new LocalControlTransactionError('corruption')
  }
  const initialRevision = current?.revision ?? 0
  let snapshot = projectLocalControlSnapshotV2({
    projectId,
    fallbackMetadata: metadataFor(project),
    entities,
    assets,
    projectState,
    revision: initialRevision,
  })
  const legacySnapshot = projectLocalControlSnapshotV1({
    projectId,
    fallbackMetadata: metadataFor(project),
    entities,
    assets,
    projectState,
    revision: initialRevision,
  })
  const digest = semanticSnapshotDigest(snapshot)
  const migrated = current?.version === 1 && current.digest === legacySemanticSnapshotDigest(legacySnapshot)
  const drifted = current !== undefined && !migrated && current.digest !== digest
  const updatedAt = drifted ? Date.now() : current?.updatedAt ?? snapshot.project.updatedAt
  const state: LocalControlSnapshotState = {
    version: 2,
    revision: current === undefined ? 0 : drifted ? current.revision + 1 : current.revision,
    digest,
    updatedAt,
  }
  const metadataRow = projectState.find((row) => row.key === 'control-project-metadata')
  const projectedProjectState = drifted
    ? projectState.map((row) => row.key === 'control-project-metadata'
      ? {
        ...row,
        value: {
          version: 1,
          name: snapshot.project.name,
          updatedAt,
          timeSignature: snapshot.project.timeSignature,
        },
        updatedAt,
      }
      : row)
    : projectState
  if (drifted && metadataRow) {
    await tx.objectStore('projectState').put({
      key: metadataRow.key,
      value: {
        version: 1,
        name: snapshot.project.name,
        updatedAt,
        timeSignature: snapshot.project.timeSignature,
      },
      updatedAt,
    })
  }
  if (snapshot.project.revision !== state.revision) {
    snapshot = projectLocalControlSnapshotV2({
      projectId,
      fallbackMetadata: metadataFor(project),
      entities,
      assets,
      projectState: projectedProjectState,
      revision: state.revision,
    })
  }
  if (current === undefined || drifted || migrated) {
    await tx.objectStore('controlState').put({
      key: CONTROL_SNAPSHOT_STATE_KEY,
      value: state,
      updatedAt: state.updatedAt,
    })
  }
  const writes: Array<() => void> = []
  const removals: Array<() => void> = []
  const context: LocalControlTransactionResult = {
    snapshot,
    state,
    rows: { entities, assets, projectState: projectedProjectState, syncState, commits, approvals, recoveries, assetGc },
    write: {
      controlState: (nextState) => { writes.push(() => { tx.objectStore('controlState').put({
        key: CONTROL_SNAPSHOT_STATE_KEY,
        value: nextState,
        updatedAt: nextState.updatedAt,
      }) }) },
      entity: (row) => { writes.push(() => { tx.objectStore('entities').put(row) }) },
      asset: (row) => { writes.push(() => { tx.objectStore('assets').put(row) }) },
      projectState: (row) => { writes.push(() => { tx.objectStore('projectState').put(row) }) },
      syncState: (row) => { writes.push(() => { tx.objectStore('syncState').put(row) }) },
      commit: (row) => { writes.push(() => { tx.objectStore('controlCommits').put(row) }) },
      approval: (row) => { writes.push(() => { tx.objectStore('controlApprovals').put(row) }) },
      recovery: (row) => { writes.push(() => { tx.objectStore('controlRecoveries').put(row) }) },
      assetGc: (row) => { writes.push(() => { tx.objectStore('controlAssetGc').put(row) }) },
    },
    remove: {
      entity: (kind, id) => { removals.push(() => { tx.objectStore('entities').delete([kind, id]) }) },
      asset: (id) => { removals.push(() => { tx.objectStore('assets').delete(id) }) },
      projectState: (key) => { removals.push(() => { tx.objectStore('projectState').delete(key) }) },
      syncState: (key) => { removals.push(() => { tx.objectStore('syncState').delete(key) }) },
      commit: (id) => { removals.push(() => { tx.objectStore('controlCommits').delete(id) }) },
      approval: (id) => { removals.push(() => { tx.objectStore('controlApprovals').delete(id) }) },
      recovery: (id) => { removals.push(() => { tx.objectStore('controlRecoveries').delete(id) }) },
      assetGc: (id) => { removals.push(() => { tx.objectStore('controlAssetGc').delete(id) }) },
    },
  }
  let result: Value
  try {
    result = callback(context)
    if (isThenable(result)) throw new Error('Local control transactions require synchronous callbacks.')
  } catch (error) {
    abortLocalControlTransaction(tx)
    throw error
  }
  for (const remove of removals) remove()
  for (const write of writes) write()
  await tx.done
  return result
}

export const withLocalControlTransaction = <Value>(
  projectId: string,
  _mode: 'readonly' | 'readwrite',
  callback: (result: LocalControlTransactionResult) => Value,
  ..._thenableIsInvalid: ThenableCallbackArgument<Value>
): Promise<Value> => {
  return queueLocalControlTransaction(projectId, callback)
}

const queueLocalControlTransaction = <Value>(
  projectId: string,
  callback: (result: LocalControlTransactionResult) => Value,
  options?: LocalControlTransactionOptions,
): Promise<Value> => (async () => {
  if (options?.pendingWritesFlushedUnderAssetLock !== true && options?.flushPendingWrites !== false) {
    await flushLocalProjectPendingWrites(projectId, { excludeKinds: options?.excludePendingWriteKinds })
  }
  const previous = chains.get(projectId) ?? Promise.resolve()
  const run = () => runLocalControlTransaction(projectId, callback)
  const next = previous.then(run, run)
  chains.set(projectId, next.then(() => undefined, () => undefined))
  return next
})()

export const withLocalControlTransactionOptions = <Value>(
  projectId: string,
  callback: (result: LocalControlTransactionResult) => Value,
  options?: LocalControlTransactionOptions,
): Promise<Value> => queueLocalControlTransaction(projectId, callback, options)
