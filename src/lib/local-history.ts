import { openLocalProjectDb } from '~/lib/local-project-db'
import { normalizePersistedHistory, serializePersistedHistory } from '~/lib/undo/persisted-history'
import type { PersistedHistory } from '~/lib/undo/types'

const HISTORY_KEY = 'timeline'
const now = () => Date.now()

export const loadLocalHistory = async (projectId: string): Promise<PersistedHistory | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('history', HISTORY_KEY)
  return row ? normalizePersistedHistory(row.value) : undefined
}

export const saveLocalHistory = async (projectId: string, state: PersistedHistory): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  await db.put('history', {
    key: HISTORY_KEY,
    value: serializePersistedHistory(state),
    updatedAt: now(),
  })
}
