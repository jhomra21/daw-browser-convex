export const TRACK_KINDS = ['audio', 'instrument'] as const

export type TrackKind = typeof TRACK_KINDS[number]

export const TRACK_CHANNEL_ROLES = ['track', 'group', 'return'] as const

export type TrackChannelRole = typeof TRACK_CHANNEL_ROLES[number]

export const CLIP_KINDS = ['audio', 'midi'] as const

export type ClipKind = typeof CLIP_KINDS[number]

export const isTrackKind = (value: unknown): value is TrackKind => TRACK_KINDS.some((kind) => kind === value)

export const isTrackChannelRole = (value: unknown): value is TrackChannelRole => TRACK_CHANNEL_ROLES.some((role) => role === value)
