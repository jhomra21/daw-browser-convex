import { openLocalProjectDb, type LocalProjectStateRow } from '~/lib/local-project-db'
import { notifyLocalProjectStateChanged } from '~/lib/local-project-changes'
import { z } from 'zod'

const now = () => Date.now()
type PendingProjectStateLoad = {
  token: symbol
  promise: Promise<Map<string, LocalProjectStateRow>>
}

const pendingProjectStateLoads = new Map<string, PendingProjectStateLoad>()
const projectStateRevisions = new Map<string, number>()

const loadProjectStateRows = (projectId: string): Promise<Map<string, LocalProjectStateRow>> => {
  const pending = pendingProjectStateLoads.get(projectId)?.promise
  if (pending) return pending

  const token = Symbol('project-state-load')
  const revision = projectStateRevisions.get(projectId) ?? 0
  const promise: Promise<Map<string, LocalProjectStateRow>> = (async () => {
    const db = await openLocalProjectDb(projectId)
    const rows = await db.getAll('projectState')
    if ((projectStateRevisions.get(projectId) ?? 0) !== revision) {
      if (pendingProjectStateLoads.get(projectId)?.token === token) {
        pendingProjectStateLoads.delete(projectId)
      }
      return loadProjectStateRows(projectId)
    }
    return new Map(rows.map((row) => [row.key, row]))
  })()
  pendingProjectStateLoads.set(projectId, { token, promise })
  void promise.then(
    () => {
      if (pendingProjectStateLoads.get(projectId)?.token === token) {
        pendingProjectStateLoads.delete(projectId)
      }
    },
    () => {
      if (pendingProjectStateLoads.get(projectId)?.token === token) {
        pendingProjectStateLoads.delete(projectId)
      }
    },
  )
  return promise
}

export const loadLocalProjectState = async <TValue>(
  projectId: string,
  key: string,
): Promise<TValue | undefined> => {
  const row = (await loadProjectStateRows(projectId)).get(key)
  // SAFETY: callers provide the owner type for this key's persisted JSON value.
  return row?.value as TValue | undefined
}

export const saveLocalProjectState = async <TValue>(
  projectId: string,
  key: string,
  value: TValue,
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  await db.put('projectState', {
    key,
    value: z.json().parse(value),
    updatedAt: now(),
  })
  projectStateRevisions.set(projectId, (projectStateRevisions.get(projectId) ?? 0) + 1)
  pendingProjectStateLoads.delete(projectId)
  notifyLocalProjectStateChanged(projectId)
}
