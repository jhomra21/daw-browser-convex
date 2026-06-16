import { normalizeAudioWarp } from '@daw-browser/shared'
import type { TimelineClipRow, TimelineTrackRow } from '~/lib/timeline-repository/types'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { RuntimeClip } from '~/lib/timeline-runtime-types'

export const toLocalTimelineClip = (row: TimelineClipRow): RuntimeClip => ({
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
  gain: row.gain,
  leftPadSec: row.leftPadSec,
  bufferOffsetSec: row.bufferOffsetSec,
  audioWarp: normalizeAudioWarp(row.audioWarp),
  color: row.color,
  sampleUrl: row.sampleUrl,
  midi: row.midi,
  midiOffsetBeats: row.midiOffsetBeats,
})

export const toLocalTimelineTrack = (row: TimelineTrackRow): Track => ({
  id: row.id,
  historyRef: row.historyRef,
  name: row.name,
  volume: row.volume,
  clips: [],
  muted: row.muted,
  soloed: row.soloed,
  kind: row.kind,
  channelRole: row.channelRole,
  outputTargetId: row.outputTargetId,
  sends: row.sends.map((send) => ({
    targetId: send.targetId,
    amount: send.amount,
  })),
})
