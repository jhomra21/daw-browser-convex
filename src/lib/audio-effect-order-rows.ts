import { AUDIO_EFFECT_ORDER, normalizeAudioEffectInstanceOrder, normalizeAudioEffectOrder, type AudioEffectInstance, type AudioEffectKind } from '@daw-browser/shared'

export type AudioEffectOrderEntry = {
  targetId: string
  kind: AudioEffectKind | 'spectral'
  instanceId?: string
  index?: number
}

const getAudioEffectOrderSortIndex = (entry: Pick<AudioEffectOrderEntry, 'kind' | 'index'>) => (
  entry.index ?? (entry.kind === 'spectral' ? AUDIO_EFFECT_ORDER.length : AUDIO_EFFECT_ORDER.indexOf(entry.kind))
)

export const compareAudioEffectOrderEntries = (
  left: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
  right: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
) => (
  (left.index === undefined && right.index !== undefined ? 1 : 0)
  || (left.index !== undefined && right.index === undefined ? -1 : 0)
  || getAudioEffectOrderSortIndex(left) - getAudioEffectOrderSortIndex(right)
  || getAudioEffectOrderSortIndex(left) - getAudioEffectOrderSortIndex(right)
)

export const collectAudioEffectOrders = (entries: Iterable<AudioEffectOrderEntry>) => {
  const masterRows: AudioEffectOrderEntry[] = []
  const trackRows = new Map<string, AudioEffectOrderEntry[]>()

  for (const entry of entries) {
    if (entry.targetId === 'master') {
      masterRows.push(entry)
      continue
    }
    const rows = trackRows.get(entry.targetId)
    if (rows) rows.push(entry)
    else trackRows.set(entry.targetId, [entry])
  }

  const toOrder = (rows: AudioEffectOrderEntry[]) => {
    const order = rows
      .sort(compareAudioEffectOrderEntries)
      .flatMap((entry) => entry.kind === 'spectral' ? [] : [entry.kind])
    return normalizeAudioEffectOrder(order, order)
  }

  return {
    master: toOrder(masterRows),
    tracks: new Map([...trackRows].map(([trackId, rows]) => [trackId, toOrder(rows)])),
  }
}

export const collectAudioEffectInstances = (entries: Iterable<AudioEffectOrderEntry>) => {
  const masterRows: AudioEffectOrderEntry[] = []
  const trackRows = new Map<string, AudioEffectOrderEntry[]>()

  for (const entry of entries) {
    if (entry.targetId === 'master') {
      masterRows.push(entry)
      continue
    }
    const rows = trackRows.get(entry.targetId)
    if (rows) rows.push(entry)
    else trackRows.set(entry.targetId, [entry])
  }

  const toInstances = (rows: AudioEffectOrderEntry[]) => {
    const instances = rows
      .sort(compareAudioEffectOrderEntries)
      .map((entry) => ({ id: entry.instanceId ?? entry.kind, kind: entry.kind }))
    const regular = instances.filter((instance): instance is AudioEffectInstance => instance.kind !== 'spectral')
    const normalized = normalizeAudioEffectInstanceOrder(regular, regular)
    const normalizedById = new Map(normalized.map((instance) => [instance.id, instance]))
    return instances.flatMap((instance) => {
      if (instance.kind === 'spectral') return [instance]
      const normalizedInstance = normalizedById.get(instance.id)
      return normalizedInstance ? [normalizedInstance] : []
    })
  }

  return {
    master: toInstances(masterRows),
    tracks: new Map([...trackRows].map(([trackId, rows]) => [trackId, toInstances(rows)])),
  }
}
