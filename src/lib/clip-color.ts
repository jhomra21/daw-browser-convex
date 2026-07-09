import type { Clip } from '@daw-browser/timeline-core/types'
import { parseHexColor } from '~/lib/color'
import type { ResolvedThemeTokens } from '~/lib/theme/theme-resolver'

type ClipThemeTokens = Pick<ResolvedThemeTokens, 'clip-audio' | 'clip-midi' | 'clip-recording'>

export const getDefaultClipColor = (clip: Pick<Clip, 'sourceKind' | 'midi'>) => {
  if (clip.sourceKind === 'recording') return 'clip-recording'
  return clip.midi ? 'clip-midi' : 'clip-audio'
}

export const trackColorForClip = (color: string | undefined) =>
  parseHexColor(color, '') || undefined

export const resolveClipColor = (color: string | undefined, tokens: ClipThemeTokens) => {
  if (color === 'clip-audio') return tokens['clip-audio']
  if (color === 'clip-midi') return tokens['clip-midi']
  if (color === 'clip-recording') return tokens['clip-recording']
  return parseHexColor(color, tokens['clip-audio'])
}

export const createClipVisualColors = (color: string, selected: boolean, ghost: boolean) => {
  const backgroundPercent = ghost ? 20 : selected ? 30 : 20
  const borderPercent = ghost ? 60 : selected ? 85 : 60
  return {
    'background-color': `color-mix(in srgb, ${color} ${backgroundPercent}%, transparent)`,
    'border-color': `color-mix(in srgb, ${color} ${borderPercent}%, transparent)`,
  }
}
