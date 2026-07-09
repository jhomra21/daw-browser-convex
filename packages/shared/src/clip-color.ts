export type ClipColorToken = 'clip-audio' | 'clip-midi' | 'clip-recording'

export const isClipColorToken = (color: string): color is ClipColorToken =>
  color === 'clip-audio' || color === 'clip-midi' || color === 'clip-recording'

export const isHexColor = (color: string): boolean =>
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)

export const normalizeClipColor = (color: string | undefined): ClipColorToken | string | undefined =>
  color && (isClipColorToken(color) || isHexColor(color)) ? color : undefined
