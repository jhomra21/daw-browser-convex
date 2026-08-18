import {
  externalPluginEntityKind,
  externalProcessorSchema,
  parseExternalProcessorValue,
  type ExternalProcessor,
  type ExternalPluginJsonValue,
} from '@daw-browser/external-plugins'
import { parseExternalPluginJsonValue } from '~/lib/external-plugin-json'
import { createLocalProjectEntityRow, openLocalProjectDb, type LocalProjectEntityRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { mixedOrderFromRows, normalizeMixedEffectEntityRows } from '~/lib/mixed-effect-order'
import { z } from 'zod'

const externalProcessorRowId = (instanceId: string) => `external-plugin:${instanceId}`
const externalProjectWriteChains = new Map<string, Promise<void>>()
const externalProcessorWriteChains = new Map<string, Promise<void>>()

const jsonEntityRows = (rows: readonly LocalProjectEntityRow[]) => rows.flatMap((row) => {
  const parsed = z.json().safeParse(row.value)
  return parsed.success ? [{ ...row, value: parsed.data }] : []
})

const withWriteChain = async <Value>(
  chains: Map<string, Promise<void>>,
  key: string,
  callback: () => Promise<Value>,
): Promise<Value> => {
  const previous = chains.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => { release = resolve })
  const next = previous.then(() => current, () => current)
  chains.set(key, next)
  await previous
  try {
    return await callback()
  } finally {
    release()
    if (chains.get(key) === next) chains.delete(key)
  }
}

export const withExternalProcessorProjectWriteLock = <Value>(
  projectId: string,
  callback: () => Promise<Value>,
): Promise<Value> => withWriteChain(externalProjectWriteChains, projectId, callback)

const withExternalProcessorWriteLock = async <Value>(
  projectId: string,
  instanceId: string,
  callback: () => Promise<Value>,
): Promise<Value> => withExternalProcessorProjectWriteLock(projectId, () => (
  withWriteChain(externalProcessorWriteChains, `${projectId}:${instanceId}`, callback)
))

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

const parseExternalProcessor = (value: ExternalPluginJsonValue, rowId: string): ExternalProcessor => {
  const parsed = parseExternalProcessorValue(value)
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
    const current = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
    if (!current.success || current.data.instanceId !== instanceId) {
      await tx.done
      return undefined
    }
    const previous = current.data
    const updates = patch(previous)
    if (!updates) {
      if (current.migrated) {
        await tx.store.put(createLocalProjectEntityRow(
          externalPluginEntityKind,
          row.id,
          previous,
          row.updatedAt,
        ))
        await tx.done
        notifyLocalProjectChanged(projectId)
        return undefined
      }
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
  return rows.map((row) => parseExternalProcessor(parseExternalPluginJsonValue(row.value), row.id))
}

export const getLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
): Promise<ExternalProcessor | undefined> => {
  const db = await openLocalProjectDb(projectId)
  const row = await db.get('entities', [externalPluginEntityKind, externalProcessorRowId(instanceId)])
  return row ? parseExternalProcessor(parseExternalPluginJsonValue(row.value), row.id) : undefined
}

export const setLocalExternalProcessor = async (
  projectId: string,
  processor: ExternalProcessor,
): Promise<ExternalProcessor> => {
  const parsed = pathFreeExternalProcessor(externalProcessorSchema.parse(processor))
  return withExternalProcessorWriteLock(projectId, parsed.instanceId, async () => {
    const db = await openLocalProjectDb(projectId)
    const existing = await db.get('entities', [externalPluginEntityKind, externalProcessorRowId(parsed.instanceId)])
    const prior = existing ? parseExternalProcessorValue(parseExternalPluginJsonValue(existing.value)) : undefined
    const next = pathFreeExternalProcessor(externalProcessorSchema.parse({
      ...parsed,
      index: parsed.manifest.role === 'instrument'
        ? 0
        : prior?.success ? prior.data.index : parsed.index,
    }))
    await db.put('entities', createLocalProjectEntityRow(
      externalPluginEntityKind,
      externalProcessorRowId(next.instanceId),
      next,
      next.updatedAt,
    ))
    notifyLocalProjectChanged(projectId)
    return next
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
  patchLocalExternalProcessor(projectId, instanceId, () => ({ bypassed }))
)

export const appendLocalExternalProcessor = async (
  projectId: string,
  processor: Omit<ExternalProcessor, 'index'>,
): Promise<ExternalProcessor> => {
  const parsed = externalProcessorSchema.omit({ index: true }).parse(processor)
  return withExternalProcessorWriteLock(projectId, parsed.instanceId, async () => {
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const [targetRow, allRows] = await Promise.all([
      parsed.targetId === 'master' ? Promise.resolve(undefined) : tx.store.get(['track', parsed.targetId]),
      tx.store.getAll(),
    ])
    if (parsed.targetId !== 'master' && !targetRow) {
      await tx.done
      throw new LocalExternalProcessorPersistenceError(
        'target-not-found',
        'Failed to insert external plugin because the target track was not found.',
      )
    }
    let normalizedRows: ReturnType<typeof jsonEntityRows>
    try {
      normalizedRows = normalizeMixedEffectEntityRows(jsonEntityRows(allRows))
    } catch (error) {
      await tx.done
      const reason = error instanceof Error ? error.message : 'Existing external plugin data is invalid.'
      throw new LocalExternalProcessorPersistenceError('corrupt-row', reason)
    }
    const currentOrder = mixedOrderFromRows(normalizedRows, parsed.targetId)
    const index = currentOrder.length
    const next = pathFreeExternalProcessor(externalProcessorSchema.parse({
      ...parsed,
      index: parsed.manifest.role === 'instrument' ? 0 : index,
    }))
    for (const row of normalizedRows) await tx.store.put(row)
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

export type LocalExternalProcessorPersistenceCode = 'target-not-found' | 'corrupt-row' | 'write-failed'

export class LocalExternalProcessorPersistenceError extends Error {
  readonly code: LocalExternalProcessorPersistenceCode

  constructor(code: LocalExternalProcessorPersistenceCode, message: string) {
    super(message)
    this.name = 'LocalExternalProcessorPersistenceError'
    this.code = code
  }
}

export const deleteLocalExternalProcessor = async (
  projectId: string,
  instanceId: string,
): Promise<void> => {
  await withExternalProcessorWriteLock(projectId, instanceId, async () => {
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction('entities', 'readwrite')
    const rows = await tx.store.getAll()
    const rowId = externalProcessorRowId(instanceId)
    const target = rows.find((row) => row.kind === externalPluginEntityKind && row.id === rowId)
    if (!target) {
      await tx.done
      return
    }
    parseExternalProcessor(parseExternalPluginJsonValue(target.value), target.id)
    await tx.store.delete([externalPluginEntityKind, rowId])
    const normalized = normalizeMixedEffectEntityRows(jsonEntityRows(rows.filter((row) => (
      row.kind !== externalPluginEntityKind || row.id !== rowId
    ))))
    for (const row of normalized) await tx.store.put(row)
    await tx.done
    notifyLocalProjectChanged(projectId)
  })
}
