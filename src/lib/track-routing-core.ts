export type RoutingClipKind = 'audio' | 'midi'

export type RoutingTrackLike<TTrackId extends string = string> = {
  id: TTrackId
  channelRole?: string
  kind?: string
}

export type RoutingSendLike<TTrackId extends string = string> = {
  targetId: TTrackId
  amount: number
}

export type RoutingTrackChannelRole = 'track' | 'group' | 'return'

export type NormalizeRoutingInput<TTrackId extends string = string> = {
  track: Pick<RoutingTrackLike<TTrackId>, 'id' | 'channelRole'> | null | undefined
  sends?: Array<RoutingSendLike<TTrackId>>
  outputTargetId?: TTrackId
  tracks: Array<Pick<RoutingTrackLike<TTrackId>, 'id' | 'channelRole'>>
}

export type NormalizedRouting<TTrackId extends string = string> = {
  sends: Array<RoutingSendLike<TTrackId>>
  outputTargetId?: TTrackId
}

export function normalizeTrackChannelRole(value: string | undefined): RoutingTrackChannelRole {
  if (value === 'return' || value === 'group') return value
  return 'track'
}

export function normalizeTrackSendAmount(value: number | undefined) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value as number))
}

export function getTrackAcceptedClipKind(
  track: Pick<RoutingTrackLike, 'channelRole' | 'kind'> | null | undefined,
): RoutingClipKind | null {
  if (normalizeTrackChannelRole(track?.channelRole) !== 'track') return null
  return (track?.kind ?? 'audio') === 'instrument' ? 'midi' : 'audio'
}

export function isClipKindCompatibleWithTrack(
  track: Pick<RoutingTrackLike, 'channelRole' | 'kind'> | null | undefined,
  clipKind: RoutingClipKind,
) {
  return getTrackAcceptedClipKind(track) === clipKind
}

export function canTrackReceiveAudioClipKind(
  track: Pick<RoutingTrackLike, 'channelRole' | 'kind'> | null | undefined,
) {
  return getTrackAcceptedClipKind(track) === 'audio'
}

function buildRoutingIndex<TTrackId extends string>(
  tracks: Array<Pick<RoutingTrackLike<TTrackId>, 'id' | 'channelRole'>>,
) {
  const groupIds = new Set<string>()
  const returnIds = new Set<string>()
  for (const track of tracks) {
    const role = normalizeTrackChannelRole(track.channelRole)
    const id = String(track.id)
    if (role === 'group') groupIds.add(id)
    if (role === 'return') returnIds.add(id)
  }
  return { groupIds, returnIds }
}

export function normalizeTrackRouting<TTrackId extends string>(
  input: NormalizeRoutingInput<TTrackId>,
): NormalizedRouting<TTrackId> {
  const { track, sends, outputTargetId, tracks } = input
  const sourceRole = normalizeTrackChannelRole(track?.channelRole)
  const sourceId = track ? String(track.id) : undefined
  const { groupIds, returnIds } = buildRoutingIndex(tracks)

  const normalizedSends = new Map<string, RoutingSendLike<TTrackId>>()
  if (track && sourceRole === 'track' && Array.isArray(sends)) {
    for (const send of sends) {
      if (!send?.targetId) continue
      const targetId = String(send.targetId)
      if (targetId === sourceId || !returnIds.has(targetId)) continue
      const amount = normalizeTrackSendAmount(send.amount)
      if (amount <= 0.0001) {
        normalizedSends.delete(targetId)
        continue
      }
      normalizedSends.set(targetId, { targetId: send.targetId, amount })
    }
  }

  const normalizedOutputTargetId = !track
    || !outputTargetId
    || sourceRole === 'group'
    || String(outputTargetId) === sourceId
    || !groupIds.has(String(outputTargetId))
      ? undefined
      : outputTargetId

  return {
    sends: Array.from(normalizedSends.values()).sort((left, right) => String(left.targetId).localeCompare(String(right.targetId))),
    outputTargetId: normalizedOutputTargetId,
  }
}
