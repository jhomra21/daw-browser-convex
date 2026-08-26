import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from '@daw-browser/shared'
import { parseExternalProcessorValue, type ExternalProcessor } from '@daw-browser/external-plugins'
import { audioEffectKindFromLocalEffect } from '~/lib/audio-effect-kind'
import { parseExternalPluginJsonValue } from '~/lib/external-plugin-json'

export type MixedEffectKind = 'builtin' | 'external'

export type MixedEffectOrderItem = {
  kind: MixedEffectKind
  instanceId: string
}

type EntityRow = {
  kind: string
  id: string
  value: JsonValue
  updatedAt: number
}

type EffectValue = {
  id?: string
  targetId: string
  effect: string
  params?: JsonValue
  instanceId?: string
  index?: number
}

const isBuiltinEffect = (row: EntityRow): row is EntityRow & { value: EffectValue } => (
  row.kind === 'effect'
  && isJsonObject(row.value)
  && isJsonString(row.value.targetId)
  && isJsonString(row.value.effect)
  && audioEffectKindFromLocalEffect(row.value.effect) !== undefined
)

const externalValue = (row: EntityRow): ExternalProcessor | undefined => {
  if (row.kind !== 'external-plugin') return undefined
  const parsed = parseExternalProcessorValue(parseExternalPluginJsonValue(row.value))
  if (parsed.success) {
    return parsed.data
  }
  if (!isJsonObject(row.value) || !isJsonString(row.value.instanceId)) {
    throw new Error(`External plugin row "${row.id}" is corrupt.`)
  }
  throw new Error(`External plugin row "${row.id}" is incompatible or corrupt.`)
}

const identity = (kind: MixedEffectKind, instanceId: string) => `${kind}:${instanceId}`

const orderedRowsForTarget = <Row extends EntityRow>(rows: readonly Row[], targetId: string) => {
  const candidates: Array<{
    row: Row
    kind: MixedEffectKind
    instanceId: string
    index: number | undefined
  }> = []
  const identities = new Set<string>()
  let externalInstrumentCount = 0
  for (const row of rows) {
    if (isBuiltinEffect(row) && row.value.targetId === targetId) {
      const instanceId = row.value.instanceId ?? `legacy:${row.id}`
      const key = instanceId
      if (identities.has(key)) throw new Error(`Duplicate effect identity "${row.value.instanceId}".`)
      identities.add(key)
      candidates.push({
        row,
        kind: 'builtin',
        instanceId,
        index: isJsonNumber(row.value.index) ? row.value.index : undefined,
      })
      continue
    }
    const processor = externalValue(row)
    if (!processor || processor.targetId !== targetId) continue
    if (processor.manifest.role === 'instrument') {
      externalInstrumentCount += 1
      continue
    }
    const key = processor.instanceId
    if (identities.has(key)) throw new Error(`Duplicate effect identity "${processor.instanceId}".`)
    identities.add(key)
    candidates.push({
      row,
      kind: 'external',
      instanceId: processor.instanceId,
      index: processor.index,
    })
  }
  if (externalInstrumentCount > 1) {
    throw new Error(`Target "${targetId}" has ambiguous external instruments.`)
  }
  candidates.sort((left, right) => (
    (left.index === undefined ? 1 : right.index === undefined ? -1 : left.index - right.index)
    || left.row.id.localeCompare(right.row.id)
  ))
  return candidates
}

const withoutLegacyOrderFields = (value: EffectValue, instanceId: string, index: number): EffectValue => {
  return {
    id: value.id ? value.id : undefined,
    targetId: value.targetId,
    effect: value.effect,
    params: value.params,
    instanceId,
    index,
  }
}

export const normalizeMixedEffectEntityRows = <Row extends EntityRow>(rows: readonly Row[]): Row[] => {
  const targets = new Set<string>()
  for (const row of rows) {
    if (isBuiltinEffect(row)) targets.add(row.value.targetId)
    const processor = externalValue(row)
    if (processor) targets.add(processor.targetId)
  }
  const normalized = rows.map((row) => {
    const processor = externalValue(row)
    return processor
      ? { ...row, value: { ...processor } }
      : { ...row }
  })
  for (const targetId of targets) {
    const ordered = orderedRowsForTarget(normalized, targetId)
    ordered.forEach((entry, index) => {
      const row = entry.row
      if (entry.kind === 'builtin' && isBuiltinEffect(row)) {
        row.value = withoutLegacyOrderFields(row.value, entry.instanceId, index)
        return
      }
      const processor = externalValue(row)
      if (!processor) return
      const next = { ...processor, index }
      row.value = next
    })
  }
  return normalized
}

export const mixedOrderFromRows = (
  rows: readonly EntityRow[],
  targetId: string,
): MixedEffectOrderItem[] => orderedRowsForTarget([...rows], targetId).map((entry) => ({
  kind: entry.kind,
  instanceId: entry.instanceId,
}))

export const assertExactMixedEffectOrder = (
  current: readonly MixedEffectOrderItem[],
  requested: readonly MixedEffectOrderItem[],
) => {
  if (requested.length !== current.length) throw new Error('Mixed effect reorder must include every effect exactly once.')
  const expected = new Set(current.map((entry) => identity(entry.kind, entry.instanceId)))
  const seen = new Set<string>()
  for (const entry of requested) {
    const key = identity(entry.kind, entry.instanceId)
    if (!expected.has(key) || seen.has(key)) throw new Error('Mixed effect reorder is not an exact permutation.')
    seen.add(key)
  }
}
