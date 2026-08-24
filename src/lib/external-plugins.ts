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
import {
  localVstStateArtifactLocation,
  localVstStateOwnerId,
  validateLocalVstStateBytes,
  readLocalExternalPluginState,
} from '~/lib/external-plugin-artifacts'
import { maxVst3WorkerStateBytes, type OpaquePluginStateMetadata } from '@daw-browser/plugin-host-protocol'
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

export const pathFreeExternalProcessor = (processor: ExternalProcessor): ExternalProcessor => {
  const { discoveredPath: _discoveredPath, ...identity } = processor.manifest.identity
  return externalProcessorSchema.parse({
    ...processor,
    manifest: {
      ...processor.manifest,
      identity,
    },
  })
}

type ExternalProcessorEntityStore = {
  delete: (key: [string, string]) => void
  put: (row: LocalProjectEntityRow) => void
}

type ExternalProcessorArtifactStore = {
  delete: (key: string) => void
}

export type LocalExternalProcessorDeletionPlan = {
  entityKeys: readonly [string, string][]
  artifactIds: readonly string[]
  retainedRows: readonly LocalProjectEntityRow[]
}

const abortExternalProcessorTransaction = (tx: { abort: () => void; done: Promise<unknown> }) => {
  try {
    tx.abort()
  } catch {}
  void tx.done.catch(() => undefined)
}

export const planLocalExternalProcessorDeletion = (input: {
  selectedExternalRows: readonly LocalProjectEntityRow[]
  retainedMixedEffectRows: readonly LocalProjectEntityRow[]
}): LocalExternalProcessorDeletionPlan => {
  const deletedKeys = new Set(input.selectedExternalRows.map((row) => `${row.kind}\u0000${row.id}`))
  const retainedArtifactIds = new Set<string>()
  const retainedRows = normalizeMixedEffectEntityRows(jsonEntityRows(input.retainedMixedEffectRows)
    .filter((row) => !deletedKeys.has(`${row.kind}\u0000${row.id}`)))
  for (const row of retainedRows.filter((entry) => entry.kind === externalPluginEntityKind)) {
    const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
    if (!parsed.success) throw new Error(`External plugin row "${row.id}" is incompatible or corrupt.`)
    for (const metadata of [parsed.data.state, parsed.data.launchReference?.state]) {
      if (metadata?.bucket === 'local') retainedArtifactIds.add(metadata.artifactId)
    }
  }
  const artifactIds = new Set<string>()
  for (const row of input.selectedExternalRows) {
    if (row.kind !== externalPluginEntityKind) throw new Error(`Cannot delete non-external processor row "${row.id}".`)
    const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
    if (!parsed.success) continue
    for (const metadata of [parsed.data.state, parsed.data.launchReference?.state]) {
      if (
        metadata?.bucket === 'local'
        && metadata.artifactKind === 'plugin-state'
        && metadata.location === localVstStateArtifactLocation(metadata.artifactId)
        && metadata.byteLength <= maxVst3WorkerStateBytes
        && !retainedArtifactIds.has(metadata.artifactId)
      ) {
        artifactIds.add(metadata.artifactId)
      }
    }
  }
  return {
    entityKeys: input.selectedExternalRows.map((row) => [row.kind, row.id]),
    artifactIds: [...artifactIds],
    retainedRows,
  }
}

export const applyLocalExternalProcessorDeletionPlanToStores = (
  plan: LocalExternalProcessorDeletionPlan,
  stores: {
    entities: ExternalProcessorEntityStore
    externalPluginArtifacts: ExternalProcessorArtifactStore
  },
): void => {
  for (const key of plan.entityKeys) stores.entities.delete(key)
  for (const artifactId of plan.artifactIds) stores.externalPluginArtifacts.delete(artifactId)
  for (const row of plan.retainedRows) stores.entities.put(row)
}

export const applyLocalExternalProcessorDeletionPlanToLocalControl = (
  plan: LocalExternalProcessorDeletionPlan,
  writer: {
    deleteEntity: (kind: string, id: string) => void
    deleteArtifact: (id: string) => void
    putEntity: (row: LocalProjectEntityRow) => void
  },
): void => {
  for (const [kind, id] of plan.entityKeys) writer.deleteEntity(kind, id)
  for (const artifactId of plan.artifactIds) writer.deleteArtifact(artifactId)
  for (const row of plan.retainedRows) writer.putEntity(row)
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

export type CapturedLocalExternalProcessorState = {
  bytes: Uint8Array
  sha256: string
}

export const readLocalExternalProcessorState = async (
  projectId: string,
  processor: Pick<ExternalProcessor, 'instanceId' | 'state' | 'launchReference'>,
  ownerId?: string,
): Promise<{ bytes: Uint8Array; sha256: string } | undefined> => {
  const metadata = processor.state ?? processor.launchReference?.state
  if (!metadata) return undefined
  if (ownerId !== undefined && metadata.ownerId !== ownerId) {
    throw new Error(`Native VST state owner mismatch for "${processor.instanceId}".`)
  }
  return readLocalExternalPluginState(projectId, metadata, metadata.ownerId)
}

export const persistLocalExternalProcessorState = async (
  projectId: string,
  instanceId: string,
  capturedState: CapturedLocalExternalProcessorState,
  ownerId?: string,
): Promise<ExternalProcessor | undefined> => withExternalProcessorWriteLock(
  projectId,
  instanceId,
  async () => {
    const state = validateLocalVstStateBytes(capturedState.bytes, capturedState.sha256)
    if (state.bytes.byteLength > maxVst3WorkerStateBytes) {
      throw new Error('Native VST state exceeds the shared limit.')
    }
    const db = await openLocalProjectDb(projectId)
    const tx = db.transaction(['entities', 'externalPluginArtifacts'], 'readwrite')
    const rowId = externalProcessorRowId(instanceId)
    const row = await tx.objectStore('entities').get([externalPluginEntityKind, rowId])
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
    const priorState = previous.state ?? previous.launchReference?.state
    const resolvedOwnerId = priorState?.ownerId ?? localVstStateOwnerId(projectId, ownerId)
    const artifactId = priorState?.artifactId ?? crypto.randomUUID()
    const metadata: OpaquePluginStateMetadata = {
      artifactId,
      sha256: state.sha256,
      byteLength: state.bytes.byteLength,
      artifactKind: 'plugin-state',
      ownerId: resolvedOwnerId,
      acl: 'owner',
      bucket: 'local',
      location: localVstStateArtifactLocation(artifactId),
    }
    const updatedAt = Math.max(Date.now(), previous.updatedAt + 1)
    const launchReference = previous.launchReference
      ? { ...previous.launchReference, stateHash: metadata.sha256, state: metadata }
      : undefined
    const nextValue = launchReference
      ? { ...previous, state: metadata, launchReference, updatedAt }
      : { ...previous, state: metadata, updatedAt }
    const next = pathFreeExternalProcessor(externalProcessorSchema.parse(nextValue))
    await tx.objectStore('externalPluginArtifacts').put({
      id: metadata.artifactId,
      sha256: metadata.sha256,
      byteLength: metadata.byteLength,
      kind: metadata.artifactKind,
      ownerId: metadata.ownerId,
      acl: metadata.acl,
      bucket: metadata.bucket,
      location: metadata.location,
      payload: state.bytes,
      updatedAt,
    })
    await tx.objectStore('entities').put(createLocalProjectEntityRow(
      externalPluginEntityKind,
      rowId,
      next,
      updatedAt,
    ))
    await tx.done
    notifyLocalProjectChanged(projectId)
    return next
  },
)

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
    const tx = db.transaction(['entities', 'externalPluginArtifacts'], 'readwrite')
    const rows = await tx.objectStore('entities').getAll()
    const rowId = externalProcessorRowId(instanceId)
    const target = rows.find((row) => row.kind === externalPluginEntityKind && row.id === rowId)
    if (!target) {
      await tx.done
      return
    }
    try {
      const plan = planLocalExternalProcessorDeletion({
        selectedExternalRows: [target],
        retainedMixedEffectRows: rows.filter((row) => (
          row.kind === 'effect' || row.kind === externalPluginEntityKind
        )),
      })
      applyLocalExternalProcessorDeletionPlanToStores(plan, {
        entities: tx.objectStore('entities'),
        externalPluginArtifacts: tx.objectStore('externalPluginArtifacts'),
      })
      await tx.done
      notifyLocalProjectChanged(projectId)
    } catch (error) {
      abortExternalProcessorTransaction(tx)
      throw error
    }
  })
}
