import { AUDIO_EFFECT_KINDS, type AudioEffectKind } from '@daw-browser/shared'

type AudioEffectOrderEntry = {
  targetId: string
  kind: AudioEffectKind | 'spectral'
  instanceId?: string
  index?: number
}

const getAudioEffectOrderSortIndex = (entry: Pick<AudioEffectOrderEntry, 'kind' | 'index'>) => (
  entry.index ?? (entry.kind === 'spectral' ? AUDIO_EFFECT_KINDS.length : AUDIO_EFFECT_KINDS.indexOf(entry.kind))
)

export const compareAudioEffectOrderEntries = (
  left: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
  right: Pick<AudioEffectOrderEntry, 'kind' | 'index'>,
) => (
  (left.index === undefined && right.index !== undefined ? 1 : 0)
  || (left.index !== undefined && right.index === undefined ? -1 : 0)
  || getAudioEffectOrderSortIndex(left) - getAudioEffectOrderSortIndex(right)
)
