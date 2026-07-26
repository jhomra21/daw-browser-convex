import {
  externalPluginEntityKind,
  externalProcessorSchema,
  type ExternalProcessor,
} from '@daw-browser/external-plugins'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const externalProcessorRowId = (instanceId: string) => `external-plugin:${instanceId}`

const pathFreeExternalProcessor = (processor: ExternalProcessor): ExternalProcessor => {
  const { discoveredPath: _discoveredPath, ...identity } = processor.manifest.identity
  return externalProcessorSchema.parse({
    ...processor,
    manifest: {
      ...processor.manifest,
      identity,
    },
  })
}

const parseExternalProcessor = (value: unknown, rowId: string): ExternalProcessor => {
  const parsed = externalProcessorSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new Error(`External plugin row "${rowId}" is incompatible or corrupt: ${parsed.error.issues[0]?.message ?? 'invalid processor data'}.`)
}

export const listLocalExternalProcessors = async (projectId: string): Promise<ExternalProcessor[]> => {
  const db = await openLocalProjectDb(projectId)
  const rows = await db.getAllFromIndex('entities', 'by-kind', externalPluginEntityKind)
  return rows.map((row) => parseExternalProcessor(row.value, row.id))
}

export const getLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
): Promise<ExternalProcessor | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [externalPluginEntityKind, externalProcessorRowId(instanceId)])
  return row ? parseExternalProcessor(row.value, row.id) : undefined
}

export const setLocalExternalProcessor = async (
  projectId: string,
  processor: ExternalProcessor,
): Promise<ExternalProcessor> => {
  const parsed = pathFreeExternalProcessor(externalProcessorSchema.parse(processor))
  const db = await openLocalProjectDb(projectId)
  await db.put(
    'entities',
    createLocalProjectEntityRow(
      externalPluginEntityKind,
      externalProcessorRowId(parsed.instanceId),
      parsed,
      parsed.updatedAt,
    ),
  )
  notifyLocalProjectChanged(projectId)
  return parsed
}

export const appendLocalExternalProcessor = async (
  projectId: string,
  processor: Omit<ExternalProcessor, 'chainIndex'>,
): Promise<ExternalProcessor> => {
  const parsed = externalProcessorSchema.omit({ chainIndex: true }).parse(processor)
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction('entities', 'readwrite')
  const [rows, targetRow] = await Promise.all([
    tx.store.index('by-kind').getAll(externalPluginEntityKind),
    parsed.targetId === 'master' ? Promise.resolve(undefined) : tx.store.get(['track', parsed.targetId]),
  ])
  if (parsed.targetId !== 'master' && !targetRow) {
    await tx.done
    throw new Error('Failed to insert external plugin because the target track was not found.')
  }
  const chainIndex = rows.reduce((nextIndex, row) => {
    const existing = parseExternalProcessor(row.value, row.id)
    return existing.targetId === parsed.targetId ? Math.max(nextIndex, existing.chainIndex + 1) : nextIndex
  }, 0)
  const next = pathFreeExternalProcessor(externalProcessorSchema.parse({ ...parsed, chainIndex }))
  await tx.store.put(createLocalProjectEntityRow(
    externalPluginEntityKind,
    externalProcessorRowId(next.instanceId),
    next,
    next.updatedAt,
  ))
  await tx.done
  notifyLocalProjectChanged(projectId)
  return next
}

export const deleteLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
): Promise<void> => {
  const db = await openLocalProjectDb(projectId)
  await db.delete('entities', [externalPluginEntityKind, externalProcessorRowId(instanceId)])
  notifyLocalProjectChanged(projectId)
}
