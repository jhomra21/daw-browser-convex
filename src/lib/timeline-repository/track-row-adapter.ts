import type { TimelineTrackRow } from '~/lib/timeline-repository/types'
import type { Track } from '~/types/timeline'

export const toLocalTimelineTrack = (row: TimelineTrackRow): Track => ({
  id: row.id as Track['id'],
  historyRef: row.historyRef,
  name: row.name,
  volume: row.volume,
  clips: [],
  muted: row.muted,
  soloed: row.soloed,
  kind: row.kind,
  channelRole: row.channelRole,
  outputTargetId: row.outputTargetId as Track['outputTargetId'],
  sends: row.sends.map((send) => ({
    targetId: send.targetId as Track['id'],
    amount: send.amount,
  })),
})
