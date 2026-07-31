import {
  externalPluginEntityKind,
  externalProcessorSchema,
  type ExternalProcessor,
} from '@daw-browser/external-plugins'
import { createLocalProjectEntityRow, openLocalProjectDb } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'

const externalProcessorRowId = (instanceId: string) => `external-plugin:${instanceId}`
const externalProcessorWriteChains = new Map<string, Promise<void>>()

const withExternalProcessorWriteLock = async <Value>(
  projectId: string,
  instanceId: string,
  callback: () => Promise<Value>,
): Promise<Value> => {
  const key = `${projectId}:${instanceId}`
  const previous = externalProcessorWriteChains.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const next = previous.then(() => current, () => current)
  externalProcessorWriteChains.set(key, next)
  await previous
  try {
    return await callback()
  } finally {
    release()
    if (externalProcessorWriteChains.get(key) === next) externalProcessorWriteChains.delete(key)
  }
}

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

export type LocalExternalProcessorCommit = {
  previous: ExternalProcessor
  current: ExternalProcessor
}

type ExternalProcessorPatch = Partial<Pick<ExternalProcessor, 'parameterOverrides' | 'bypassed'>>

const patchLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
  patch: (processor: ExternalProcessor) => ExternalProcessorPatch | undefined,
): Promise<LocalExternalProcessorCommit | undefined> => withExternalProcessorWriteLock(
  projectId,
  instanceId,
  async () => {
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const row = await tx.store.get([externalPluginEntityKind, externalProcessorRowId(instanceId)])
    if (!row) {
      await tx.done
      return undefined
    }
    const current = externalProcessorSchema.safeParse(row.value)
    if (!current.success || current.data.instanceId !== instanceId) {
      await tx.done
      return undefined
    }
    const previous = current.data
    const updates = patch(previous)
    if (!updates) {
      await tx.done
      return undefined
    }
    const next = pathFreeExternalProcessor(externalProcessorSchema.parse({
      ...previous,
      ...updates,
      updatedAt: Math.max(Date.now(), previous.updatedAt + 1),
    }))
    await tx.store.put(createLocalProjectEntityRow(
      externalPluginEntityKind,
      externalProcessorRowId(instanceId),
      next,
      next.updatedAt,
    ))
    await tx.done
    notifyLocalProjectChanged(projectId)
    return { previous, current: next }
  },
)

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
  return withExternalProcessorWriteLock(projectId, parsed.instanceId, async () => {
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
  })
}

export const mergeLocalExternalProcessorParameterOverride = async (
  projectId: string,
  instanceId: string,
  parameterId: number,
  normalizedValue: number,
): Promise<LocalExternalProcessorCommit | undefined> => mergeLocalExternalProcessorParameterOverrides(
  projectId,
  instanceId,
  [{ parameterId, normalizedValue }],
)

export const mergeLocalExternalProcessorParameterOverrides = async (
  projectId: string,
  instanceId: string,
  changes: readonly { parameterId: number; normalizedValue: number }[],
): Promise<LocalExternalProcessorCommit | undefined> => {
  if (
    changes.length === 0
    || changes.some(({ parameterId, normalizedValue }) => (
      !Number.isSafeInteger(parameterId) || parameterId < 0 || parameterId > 0xffff_ffff
      || !Number.isFinite(normalizedValue) || normalizedValue < 0 || normalizedValue > 1
    ))
    || new Set(changes.map(({ parameterId }) => parameterId)).size !== changes.length
  ) return undefined
  return patchLocalExternalProcessor(projectId, instanceId, (previous) => {
    const parameterOverrides = { ...previous.parameterOverrides }
    for (const { parameterId, normalizedValue } of changes) {
      const descriptor = previous.manifest.parameters.find((parameter) => parameter.id === parameterId)
      if (!descriptor || descriptor.readOnly) return undefined
      parameterOverrides[String(parameterId)] = normalizedValue
    }
    return { parameterOverrides }
  })
}

export const setLocalExternalProcessorBypassed = async (
  projectId: string,
  instanceId: string,
  bypassed: boolean,
): Promise<LocalExternalProcessorCommit | undefined> => (
  typeof bypassed === 'boolean'
    ? patchLocalExternalProcessor(projectId, instanceId, () => ({ bypassed }))
    : undefined
)

export const appendLocalExternalProcessor = async (
  projectId: string,
  processor: Omit<ExternalProcessor, 'chainIndex'>,
): Promise<ExternalProcessor> => {
  const parsed = externalProcessorSchema.omit({ chainIndex: true }).parse(processor)
  return withExternalProcessorWriteLock(projectId, parsed.instanceId, async () => {
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
  })
}

export const deleteLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
): Promise<void> => {
  await withExternalProcessorWriteLock(projectId, instanceId, async () => {
    const db = await openLocalProjectDb(projectId)
    await db.delete('entities', [externalPluginEntityKind, externalProcessorRowId(instanceId)])
    notifyLocalProjectChanged(projectId)
  })
}
