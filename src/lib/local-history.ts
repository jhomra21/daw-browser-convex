import { openLocalProjectDb } from '~/lib/local-project-db'
import type { PersistedHistory } from '~/lib/undo/types'

const HISTORY_KEY = 'timeline'
const now = () => Date.now()

const isHistory = (value: unknown): value is PersistedHistory => (
  typeof value === 'object'
  && value !== null
  && Array.isArray((value as PersistedHistory).undo)
  && Array.isArray((value as PersistedHistory).redo)
)

export const loadLocalHistory = async (projectId: string): Promise<PersistedHistory | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('history', HISTORY_KEY)
  return isHistory(row?.value) ? row.value : undefined
}

export const saveLocalHistory = async (projectId: string, state: PersistedHistory): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  await db.put('history', {
    key: HISTORY_KEY,
    value: state,
    updatedAt: now(),
  })
}
