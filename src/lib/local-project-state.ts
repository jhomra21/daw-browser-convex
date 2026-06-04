import { openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const now = () => Date.now()

export const loadLocalProjectState = async <TValue>(
  projectId: string,
  key: string,
): Promise<TValue | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('projectState', key)
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
    value,
    updatedAt: now(),
  })
  notifyLocalProjectChanged(projectId)
}
