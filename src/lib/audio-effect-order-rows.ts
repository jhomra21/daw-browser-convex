import { AUDIO_EFFECT_ORDER, normalizeAudioEffectOrder, type AudioEffectKind } from '@daw-browser/shared'

export type AudioEffectOrderEntry = {
  targetId: string
  kind: AudioEffectKind
  index?: number
}

const getAudioEffectOrderSortIndex = (entry: Pick<AudioEffectOrderEntry, 'kind' | 'index'>) => (
  entry.index ?? AUDIO_EFFECT_ORDER.indexOf(entry.kind)
)

export const compareAudioEffectOrderEntries = (
  left: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
  right: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
) => (
  (left.index === undefined && right.index !== undefined ? 1 : 0)
  || (left.index !== undefined && right.index === undefined ? -1 : 0)
  || getAudioEffectOrderSortIndex(left) - getAudioEffectOrderSortIndex(right)
  || AUDIO_EFFECT_ORDER.indexOf(left.kind) - AUDIO_EFFECT_ORDER.indexOf(right.kind)
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
      .map((entry) => entry.kind)
    return normalizeAudioEffectOrder(order, order)
  }

  return {
    master: toOrder(masterRows),
    tracks: new Map([...trackRows].map(([trackId, rows]) => [trackId, toOrder(rows)])),
  }
}
