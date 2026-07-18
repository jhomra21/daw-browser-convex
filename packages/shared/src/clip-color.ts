export type ClipColorToken = 'clip-audio' | 'clip-midi' | 'clip-recording'
export type TrackColor = string

export const isClipColorToken = (color: string): color is ClipColorToken =>
  color === 'clip-audio' || color === 'clip-midi' || color === 'clip-recording'

export const isHexColor = (color: string): boolean =>
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)

const expandHexColor = (color: string) => (
  color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color
)

export const normalizeTrackColor = (color: string | undefined): TrackColor | undefined =>
  color && isHexColor(color) ? expandHexColor(color).toLowerCase() : undefined

export const normalizeClipColor = (color: string | undefined): ClipColorToken | TrackColor | undefined =>
  color && (isClipColorToken(color) ? color : normalizeTrackColor(color))
