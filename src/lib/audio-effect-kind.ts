import { isAudioEffectKind, type AudioEffectKind } from '@daw-browser/shared'

export const audioEffectKindFromLocalEffect = (
  effect: string,
): AudioEffectKind | undefined => {
  if (isAudioEffectKind(effect)) return effect
  if (!effect.startsWith('master-')) return undefined
  const kind = effect.slice('master-'.length)
  return isAudioEffectKind(kind) ? kind : undefined
}
