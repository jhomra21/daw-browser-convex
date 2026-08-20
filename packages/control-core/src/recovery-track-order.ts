export type RecoveryTrackOrderItemV1 = {
  id: string
  index: number
}

export const mergeRecoveryTrackOrderV1 = (
  currentTracks: readonly RecoveryTrackOrderItemV1[],
  recoveredTracks: readonly RecoveryTrackOrderItemV1[],
) => {
  const order = currentTracks
    .map((track) => ({ ...track, recovered: false }))
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
  const recovered = [...recoveredTracks].sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))

  for (const track of recovered) {
    const position = Math.min(Math.max(track.index, 0), order.length)
    order.splice(position, 0, { ...track, recovered: true })
  }

  return order.map((track, index) => ({ ...track, index }))
}
