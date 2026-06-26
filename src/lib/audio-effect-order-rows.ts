import { normalizeAudioEffectOrder, type AudioEffectKind } from '@daw-browser/shared'

export type AudioEffectOrderEntry = {
  targetId: string
  kind: AudioEffectKind
  index?: number
}

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
    const order = rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((entry) => entry.kind)
    return normalizeAudioEffectOrder(order, order)
  }

  return {
    master: toOrder(masterRows),
    tracks: new Map([...trackRows].map(([trackId, rows]) => [trackId, toOrder(rows)])),
  }
}
