import { normalizeSourceBeatOffsetValue } from '@daw-browser/shared'
import { getAudioClipTimeMap, type AudioClipTimeMap } from './audio-clip-time-map'
import type { AudioWarp, Clip } from './types'

const sourceOffsetAfterTimelineTrim = (input: {
  clip: Pick<Clip, 'startSec' | 'leftPadSec' | 'bufferOffsetSec'>
  bufferDurationSec: number
  timelineTrimSec: number
  map: AudioClipTimeMap | null
}) => {
  if (!input.map) return Math.max(0, (input.clip.bufferOffsetSec ?? 0) + input.timelineTrimSec)
  const audioStartSec = input.clip.startSec + Math.max(0, input.clip.leftPadSec ?? 0)
  const oldTimelineSec = Math.max(input.map.timelineStartSec, audioStartSec)
  const newTimelineSec = Math.min(input.map.timelineEndSec, oldTimelineSec + input.timelineTrimSec)
  return Math.max(0, Math.min(input.bufferDurationSec, input.map.timelineToSourceSec(newTimelineSec)))
}

const consumeWarpLeadingSilence = (input: {
  audioWarp: AudioWarp | undefined
  projectBpm: number
  timelineTrimSec: number
}) => {
  const sourceBeatOffset = input.audioWarp?.enabled === true
    ? Math.max(0, input.audioWarp.sourceBeatOffset ?? 0)
    : 0
  if (!input.audioWarp || sourceBeatOffset <= 0) {
    return { audioWarp: input.audioWarp, consumedTimelineSec: 0, changed: false }
  }
  const secondsPerBeat = 60 / Math.max(1e-6, input.projectBpm || 120)
  const consumedBeats = Math.min(sourceBeatOffset, input.timelineTrimSec / secondsPerBeat)
  const nextOffset = normalizeSourceBeatOffsetValue(sourceBeatOffset - consumedBeats)
  return {
    audioWarp: {
      ...input.audioWarp,
      ...(nextOffset === 0 ? { sourceBeatOffset: undefined } : { sourceBeatOffset: nextOffset }),
    },
    consumedTimelineSec: consumedBeats * secondsPerBeat,
    changed: consumedBeats > 0,
  }
}

export const calculateAudioTimelineTrimOffsets = (input: {
  clip: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec' | 'sourceDurationSec' | 'audioWarp'>
  bufferDurationSec: number
  timelineTrimSec: number
  projectBpm: number
}): { leftPadSec: number; bufferOffsetSec: number; audioWarp?: AudioWarp } => {
  let leftPadSec = Math.max(0, input.clip.leftPadSec ?? 0)
  let bufferOffsetSec = Math.max(0, input.clip.bufferOffsetSec ?? 0)
  let audioWarp: AudioWarp | undefined
  const consumedPad = Math.min(leftPadSec, input.timelineTrimSec)
  leftPadSec -= consumedPad
  const remaining = input.timelineTrimSec - consumedPad
  if (remaining > 0) {
    const warpTrim = consumeWarpLeadingSilence({
      audioWarp: input.clip.audioWarp,
      projectBpm: input.projectBpm,
      timelineTrimSec: remaining,
    })
    const sourceTrimSec = remaining - warpTrim.consumedTimelineSec
    if (warpTrim.changed) audioWarp = warpTrim.audioWarp
    if (sourceTrimSec > 0) {
      const baseline = {
        ...input.clip,
        startSec: input.clip.startSec + warpTrim.consumedTimelineSec,
        leftPadSec: 0,
        audioWarp: warpTrim.audioWarp,
      }
      const map = getAudioClipTimeMap({
        clip: baseline,
        bufferDurationSec: input.bufferDurationSec,
        projectBpm: input.projectBpm,
        rangeStartSec: baseline.startSec,
        rangeEndSec: baseline.startSec + baseline.duration,
      })
      bufferOffsetSec = sourceOffsetAfterTimelineTrim({
        clip: baseline,
        bufferDurationSec: input.bufferDurationSec,
        timelineTrimSec: sourceTrimSec,
        map,
      })
    }
  }
  return { leftPadSec, bufferOffsetSec, audioWarp }
}
