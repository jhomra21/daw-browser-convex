import type { AutomationEnvelope } from '@daw-browser/shared'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const AUTOMATION_KIND = 'automation-envelope'

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isLocalAutomationEnvelope = (value: unknown): value is AutomationEnvelope => (
  isObject(value)
  && typeof value.id === 'string'
  && typeof value.projectId === 'string'
  && isObject(value.target)
  && typeof value.targetKey === 'string'
  && typeof value.parameterId === 'string'
  && typeof value.enabled === 'boolean'
  && Array.isArray(value.points)
  && typeof value.updatedAt === 'number'
)

export const loadLocalAutomationEnvelopes = async (projectId: string): Promise<AutomationEnvelope[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', AUTOMATION_KIND)
  return rows.flatMap((row) => isLocalAutomationEnvelope(row.value) ? [row.value] : [])
}

export const setLocalAutomationEnvelope = async (
  projectId: string,
  envelope: AutomationEnvelope,
): Promise<AutomationEnvelope> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, envelope.targetKey, envelope, envelope.updatedAt))
  await tx.done
  notifyLocalProjectChanged(projectId)
  return envelope
}

export const deleteLocalAutomationEnvelope = async (
  projectId: string,
  targetKey: string,
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  await tx.store.delete([AUTOMATION_KIND, targetKey])
  await tx.done
  notifyLocalProjectChanged(projectId)
}

export const replaceLocalAutomationEnvelopes = async (
  projectId: string,
  envelopes: AutomationEnvelope[],
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const rows = await tx.store.index('by-kind').getAll(AUTOMATION_KIND)
  for (const row of rows) await tx.store.delete([AUTOMATION_KIND, row.id])
  for (const envelope of envelopes) {
    await tx.store.put(createLocalProjectEntityRow(AUTOMATION_KIND, envelope.targetKey, envelope, envelope.updatedAt))
  }
  await tx.done
  notifyLocalProjectChanged(projectId)
}
