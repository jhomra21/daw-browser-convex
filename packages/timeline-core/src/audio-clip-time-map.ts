import { mapSourceBeatToTimelineBeat, mapTimelineBeatToSourceBeat } from '@daw-browser/shared'
import type { Clip } from './types'

type AudioClipTimeMapInput = {
  clip: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceDurationSec' | 'audioWarp'>
  bufferDurationSec: number
  projectBpm: number
  rangeStartSec: number
  rangeEndSec?: number
}

export type AudioClipTimeMap = {
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
  timelineDurationSec: number
  sourceDurationSec: number
  sourceSecondsPerTimelineSecond: number
  timelineSecondsPerSourceSecond: number
  playbackRate: number
  mode: 'raw' | 'repitch' | 'stretch'
  timelineToSourceSec: (timelineSec: number) => number
  sourceToTimelineSec: (sourceSec: number) => number
}

export type MarkerWarpTimelineSegment = {
  timelineStartSec: number
  timelineEndSec: number
  sourceStartSec: number
  sourceEndSec: number
}

const resolveWarpBpm = (value: number | undefined, fallback: number) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
)

const resolveSourceBeatOffsetSec = (input: {
  warpEnabled: boolean
  sourceBeatOffset?: number
  sourceBpm: number
}) => input.warpEnabled ? (input.sourceBeatOffset ?? 0) * (60 / input.sourceBpm) : 0

export function getAudioClipTimeMap(input: AudioClipTimeMapInput): AudioClipTimeMap | null {
  const leftPad = Math.max(0, input.clip.leftPadSec ?? 0)
  const bufferOffsetRaw = Math.max(0, input.clip.bufferOffsetSec ?? 0)
  const clipStart = input.clip.startSec
  const clipEndRaw = input.clip.startSec + input.clip.duration
  const clipEnd = typeof input.rangeEndSec === 'number' ? Math.min(clipEndRaw, input.rangeEndSec) : clipEndRaw
  const audioStart = clipStart + leftPad
  const bufferDuration = Math.max(0, input.bufferDurationSec)
  const bufferOffset = Math.min(bufferDuration, bufferOffsetRaw)
  const projectBpm = resolveWarpBpm(input.projectBpm, 120)
  const sourceBpm = resolveWarpBpm(input.clip.audioWarp?.sourceBpm, projectBpm)
  const warpEnabled = input.clip.audioWarp?.enabled === true
  const warpMarkers = warpEnabled && input.clip.audioWarp?.mode === 'stretch'
    ? input.clip.audioWarp.markers ?? []
    : []
  const markerWarpEnabled = warpMarkers.length >= 2
  const playbackRate = warpEnabled ? projectBpm / sourceBpm : 1
  const sourceSecondsPerTimelineSecond = playbackRate
  const timelineSecondsPerSourceSecond = 1 / playbackRate
  const sourceBeatOffsetSec = resolveSourceBeatOffsetSec({
    warpEnabled,
    sourceBeatOffset: input.clip.audioWarp?.sourceBeatOffset,
    sourceBpm,
  })
  const sourceBaseSec = bufferOffset - sourceBeatOffsetSec
  if (markerWarpEnabled) {
    const projectSecondsPerBeat = 60 / projectBpm
    const sourceSecondsPerBeat = 60 / sourceBpm
    const clipTimelineBeat = (timelineSec: number) => Math.max(0, (timelineSec - audioStart) / projectSecondsPerBeat)
    const clipSourceBeatToSec = (sourceBeat: number) => bufferOffset + sourceBeat * sourceSecondsPerBeat
    const timelineBeatToSec = (timelineBeat: number) => audioStart + timelineBeat * projectSecondsPerBeat
    const timelineToSourceSec = (timelineSec: number) => clipSourceBeatToSec(mapTimelineBeatToSourceBeat(warpMarkers, clipTimelineBeat(timelineSec)))
    const sourceToTimelineSec = (sourceSec: number) => timelineBeatToSec(mapSourceBeatToTimelineBeat(warpMarkers, (sourceSec - bufferOffset) / sourceSecondsPerBeat))
    const audioStartSec = Math.max(audioStart, sourceToTimelineSec(bufferOffset))
    const audioEnd = Math.min(clipEnd, sourceToTimelineSec(bufferDuration))
    if (input.rangeStartSec >= audioEnd) return null
    const timelineStartSec = Math.max(input.rangeStartSec, audioStartSec)
    const sourceStartSec = Math.max(bufferOffset, timelineToSourceSec(timelineStartSec))
    if (sourceStartSec >= bufferDuration) return null
    const timelineDurationSec = Math.max(0, audioEnd - timelineStartSec)
    if (timelineDurationSec <= 0) return null
    const sourceEndSec = Math.min(bufferDuration, timelineToSourceSec(timelineStartSec + timelineDurationSec))
    return {
      timelineStartSec,
      timelineEndSec: timelineStartSec + timelineDurationSec,
      sourceStartSec,
      sourceEndSec,
      timelineDurationSec,
      sourceDurationSec: Math.max(0, sourceEndSec - sourceStartSec),
      sourceSecondsPerTimelineSecond: playbackRate,
      timelineSecondsPerSourceSecond: 1 / playbackRate,
      playbackRate,
      mode: 'stretch',
      timelineToSourceSec,
      sourceToTimelineSec,
    }
  }
  const leadingTimelineSilenceSec = Math.max(0, bufferOffset - sourceBaseSec) * timelineSecondsPerSourceSecond
  const effectiveSourceStartSec = Math.max(bufferOffset, sourceBaseSec)
  const audioTimelineDuration = Math.max(0, bufferDuration - effectiveSourceStartSec) * timelineSecondsPerSourceSecond
  const audioStartSec = audioStart + leadingTimelineSilenceSec
  const audioEnd = Math.min(clipEnd, audioStartSec + audioTimelineDuration)

  if (input.rangeStartSec >= audioEnd) return null

  const timelineStartSec = Math.max(input.rangeStartSec, audioStartSec)
  const sourceStartAtTimeline = sourceBaseSec + Math.max(0, timelineStartSec - audioStart) * sourceSecondsPerTimelineSecond
  const sourceStartSec = Math.max(bufferOffset, sourceStartAtTimeline)
  if (sourceStartSec >= bufferDuration) return null

  const timelineDurationSec = Math.min(
    Math.max(0, (bufferDuration - sourceStartSec) * timelineSecondsPerSourceSecond),
    Math.max(0, audioEnd - timelineStartSec),
  )
  if (timelineDurationSec <= 0) return null

  const sourceDurationSec = timelineDurationSec * sourceSecondsPerTimelineSecond
  const sourceEndSec = Math.min(bufferDuration, sourceStartSec + sourceDurationSec)

  return {
    timelineStartSec,
    timelineEndSec: timelineStartSec + timelineDurationSec,
    sourceStartSec,
    sourceEndSec,
    timelineDurationSec,
    sourceDurationSec: Math.max(0, sourceEndSec - sourceStartSec),
    sourceSecondsPerTimelineSecond,
    timelineSecondsPerSourceSecond,
    playbackRate,
    mode: warpEnabled ? input.clip.audioWarp?.mode ?? 'repitch' : 'raw',
    timelineToSourceSec: (timelineSec) => sourceBaseSec + Math.max(0, timelineSec - audioStart) * sourceSecondsPerTimelineSecond,
    sourceToTimelineSec: (sourceSec) => audioStart + (sourceSec - sourceBaseSec) * timelineSecondsPerSourceSecond,
  }
}

export function getMarkerWarpTimelineSegments(input: {
  clip: Pick<Clip, 'startSec' | 'leftPadSec' | 'audioWarp'>
  map: AudioClipTimeMap
  projectBpm: number
  timelineEndSec: number
}): MarkerWarpTimelineSegment[] {
  if (input.map.mode !== 'stretch') return []
  const markers = input.clip.audioWarp?.markers ?? []
  const audioStartSec = input.clip.startSec + Math.max(0, input.clip.leftPadSec ?? 0)
  const secondsPerBeat = 60 / resolveWarpBpm(input.projectBpm, 120)
  const markerBoundaries = markers
    .map((marker) => audioStartSec + marker.timelineBeat * secondsPerBeat)
    .filter((timelineSec) => timelineSec > input.map.timelineStartSec + 1e-6 && timelineSec < input.map.timelineEndSec - 1e-6)
  const timelineBoundaries = [
    input.map.timelineStartSec,
    ...markerBoundaries,
    Math.min(input.map.timelineEndSec, input.timelineEndSec),
  ]
  return timelineBoundaries.slice(0, -1).flatMap((timelineStartSec, index) => {
    const timelineEndSec = timelineBoundaries[index + 1]
    if (timelineEndSec <= timelineStartSec) return []
    return [{
      timelineStartSec,
      timelineEndSec,
      sourceStartSec: input.map.timelineToSourceSec(timelineStartSec),
      sourceEndSec: input.map.timelineToSourceSec(timelineEndSec),
    }]
  })
}
