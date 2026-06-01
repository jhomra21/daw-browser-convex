import type { TimelineClipRow, TimelineTrackRow } from '~/lib/timeline-repository/types'
import type { Clip, Track } from '~/types/timeline'

export const toLocalTimelineClip = (row: TimelineClipRow): Clip => ({
  id: row.id,
  historyRef: row.historyRef,
  name: row.name,
  buffer: null,
  startSec: row.startSec,
  duration: row.duration,
  sourceAssetKey: row.sourceAssetKey,
  sourceKind: row.sourceKind,
  sourceDurationSec: row.sourceDurationSec,
  sourceSampleRate: row.sourceSampleRate,
  sourceChannelCount: row.sourceChannelCount,
  leftPadSec: row.leftPadSec,
  bufferOffsetSec: row.bufferOffsetSec,
  color: row.color,
  sampleUrl: row.sampleUrl,
  midi: row.midi,
  midiOffsetBeats: row.midiOffsetBeats,
})

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
