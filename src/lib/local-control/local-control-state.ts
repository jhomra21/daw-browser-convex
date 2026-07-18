import {
  hashCanonicalJsonSyncV1,
  type ProjectSnapshotV1,
} from '@daw-browser/control'
import { flushLocalProjectPendingWrites } from '~/lib/local-project-pending-writes'
import {
  getLocalProject,
  openLocalProjectDb,
  type LocalControlProjectMetadata,
} from '~/lib/local-project-db'
import { projectLocalControlSnapshotV1 } from './local-control-projector'

const CONTROL_SNAPSHOT_STATE_KEY = 'snapshot'
const chains = new Map<string, Promise<void>>()
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

type LocalControlSnapshotState = {
  revision: number
  digest: string
  updatedAt: number
}

type LocalControlTransactionResult = {
  snapshot: ProjectSnapshotV1
  state: LocalControlSnapshotState
}

const controlState = (value: unknown): LocalControlSnapshotState | undefined => {
  if (
    !isRecord(value)
    || typeof value.revision !== 'number'
    || typeof value.digest !== 'string'
    || typeof value.updatedAt !== 'number'
  ) return undefined
  return { revision: value.revision, digest: value.digest, updatedAt: value.updatedAt }
}

const semanticSnapshotDigest = (snapshot: ProjectSnapshotV1) => {
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

const metadataFor = (project: { name: string; updatedAt: number }): LocalControlProjectMetadata => ({
  version: 1,
  name: project.name,
  updatedAt: project.updatedAt,
  timeSignature: { numerator: 4, denominator: 4 },
})

const isThenable = (value: unknown): value is PromiseLike<unknown> => (
  (typeof value === 'object' && value !== null || typeof value === 'function')
  && typeof Reflect.get(value, 'then') === 'function'
)

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
  await flushLocalProjectPendingWrites(projectId)
  const project = await getLocalProject(projectId)
  if (!project) throw new Error('Local project not found.')
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction(['entities', 'assets', 'projectState', 'controlState'], 'readwrite')
  const [entities, assets, projectState, currentRow] = await Promise.all([
    tx.objectStore('entities').getAll(),
    tx.objectStore('assets').getAll(),
    tx.objectStore('projectState').getAll(),
    tx.objectStore('controlState').get(CONTROL_SNAPSHOT_STATE_KEY),
  ])
  const current = controlState(currentRow?.value)
  const initialRevision = current?.revision ?? 0
  let snapshot = projectLocalControlSnapshotV1({
    projectId,
    fallbackMetadata: metadataFor(project),
    entities,
    assets,
    projectState,
    revision: initialRevision,
  })
  const digest = semanticSnapshotDigest(snapshot)
  const drifted = current !== undefined && current.digest !== digest
  const updatedAt = drifted ? Date.now() : current?.updatedAt ?? snapshot.project.updatedAt
  const state: LocalControlSnapshotState = {
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
    snapshot = projectLocalControlSnapshotV1({
      projectId,
      fallbackMetadata: metadataFor(project),
      entities,
      assets,
      projectState: projectedProjectState,
      revision: state.revision,
    })
  }
  if (current === undefined || drifted) {
    await tx.objectStore('controlState').put({
      key: CONTROL_SNAPSHOT_STATE_KEY,
      value: state,
      updatedAt: state.updatedAt,
    })
  }
  let result: Value
  try {
    result = callback({ snapshot, state })
    if (isThenable(result)) throw new Error('Local control transactions require synchronous callbacks.')
  } catch (error) {
    abortLocalControlTransaction(tx)
    throw error
  }
  await tx.done
  return result
}

export const withLocalControlTransaction = <Value>(
  projectId: string,
  _mode: 'readonly' | 'readwrite',
  callback: (result: LocalControlTransactionResult) => Value,
  ..._thenableIsInvalid: ThenableCallbackArgument<Value>
): Promise<Value> => {
  const previous = chains.get(projectId) ?? Promise.resolve()
  const run = () => runLocalControlTransaction(projectId, callback)
  const next = previous.then(run, run)
  chains.set(projectId, next.then(() => undefined, () => undefined))
  return next
}
