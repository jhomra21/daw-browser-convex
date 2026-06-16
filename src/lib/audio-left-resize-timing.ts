import { getAudioClipTimeMap, type AudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import type { Clip } from '@daw-browser/timeline-core/types'

const getResizeAudioClipTimeMap = (input: {
  clip: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceDurationSec' | 'audioWarp'>
  bufferDurationSec: number
  projectBpm: number
}) => getAudioClipTimeMap({
  clip: input.clip,
  bufferDurationSec: input.bufferDurationSec,
  projectBpm: input.projectBpm,
  rangeStartSec: input.clip.startSec,
  rangeEndSec: input.clip.startSec + input.clip.duration,
})

const getSourceOffsetAfterTimelineTrim = (input: {
  clip: Pick<Clip, 'startSec' | 'leftPadSec' | 'bufferOffsetSec'>
  bufferDurationSec: number
  timelineTrimSec: number
  map: AudioClipTimeMap | null
}) => {
  const map = input.map
  if (!map) return Math.max(0, (input.clip.bufferOffsetSec ?? 0) + input.timelineTrimSec)
  const audioStartSec = input.clip.startSec + Math.max(0, input.clip.leftPadSec ?? 0)
  const oldTimelineSec = Math.max(map.timelineStartSec, audioStartSec)
  const newTimelineSec = Math.min(map.timelineEndSec, oldTimelineSec + input.timelineTrimSec)
  return Math.max(0, Math.min(input.bufferDurationSec, map.timelineToSourceSec(newTimelineSec)))
}

const getSourceOffsetBeforeTimelineTrim = (input: {
  clip: Pick<Clip, 'bufferOffsetSec'>
  bufferDurationSec: number
  timelineRestoreSec: number
  map: AudioClipTimeMap | null
}) => {
  const currentOffset = Math.max(0, input.clip.bufferOffsetSec ?? 0)
  const map = input.map
  if (!map) return Math.max(0, currentOffset - input.timelineRestoreSec)
  const targetTimelineSec = map.sourceToTimelineSec(currentOffset) - input.timelineRestoreSec
  let low = 0
  let high = currentOffset
  for (let index = 0; index < 32; index++) {
    const mid = (low + high) / 2
    if (map.sourceToTimelineSec(mid) < targetTimelineSec) low = mid
    else high = mid
  }
  return Math.max(0, Math.min(input.bufferDurationSec, high))
}

const mapRestoredTimelineSec = (input: {
  fromOffsetSec: number
  toOffsetSec: number
  map: AudioClipTimeMap | null
}) => {
  const map = input.map
  if (!map) return Math.max(0, input.fromOffsetSec - input.toOffsetSec)
  return Math.max(0, map.sourceToTimelineSec(input.fromOffsetSec) - map.sourceToTimelineSec(input.toOffsetSec))
}

export function calculateAudioLeftResizeTiming(input: {
  baselineClip: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceDurationSec' | 'audioWarp'>
  fixedRightSec: number
  newStartSec: number
  bufferDurationSec: number
  projectBpm: number
}): { startSec: number; duration: number; leftPadSec: number; bufferOffsetSec: number } {
  const delta = input.newStartSec - input.baselineClip.startSec
  let nextLeftPad = Math.max(0, input.baselineClip.leftPadSec ?? 0)
  let nextBufOffset = Math.max(0, input.baselineClip.bufferOffsetSec ?? 0)
  const map = getResizeAudioClipTimeMap({
    clip: input.baselineClip,
    bufferDurationSec: input.bufferDurationSec,
    projectBpm: input.projectBpm,
  })
  if (delta >= 0) {
    const consumePad = Math.min(nextLeftPad, delta)
    nextLeftPad = Math.max(0, nextLeftPad - consumePad)
    const remaining = delta - consumePad
    if (remaining > 0) {
      nextBufOffset = getSourceOffsetAfterTimelineTrim({
        clip: input.baselineClip,
        bufferDurationSec: input.bufferDurationSec,
        timelineTrimSec: remaining,
        map,
      })
    }
  } else {
    const supply = -delta
    const restoredOffset = getSourceOffsetBeforeTimelineTrim({
      clip: input.baselineClip,
      bufferDurationSec: input.bufferDurationSec,
      timelineRestoreSec: supply,
      map,
    })
    const restoredTimelineSec = mapRestoredTimelineSec({
      fromOffsetSec: nextBufOffset,
      toOffsetSec: restoredOffset,
      map,
    })
    nextBufOffset = restoredOffset
    const leftover = supply - restoredTimelineSec
    nextLeftPad = Math.max(0, nextLeftPad + Math.max(0, leftover))
  }
  return {
    startSec: input.newStartSec,
    duration: Math.max(0, input.fixedRightSec - input.newStartSec),
    leftPadSec: nextLeftPad,
    bufferOffsetSec: nextBufOffset,
  }
}
