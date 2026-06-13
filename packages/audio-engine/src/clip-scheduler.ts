import { getAudioBufferPlaybackParams, getAudioClipTimeMap } from './audio-scheduling'
import type { StretchedAudioRender } from './audio-stretch-cache'
import type { SourceRegistry } from './source-registry'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

export type ScheduleOptions = {
  atCtxTime?: number
  preserveExisting?: boolean
  endLimitSec?: number
}

type ScheduledClipEntry = {
  track: RuntimeTrack
  clip: RuntimeClip
  startSec: number
  endSec: number
}

type ScheduleIndex = {
  byEnd: ScheduledClipEntry[]
}

type ClipSchedulerOptions = {
  getAudioContext: () => AudioContext | null
  getBpm: () => number
  timelineToCtxTime: (timelineSec: number) => number
  updateTrackGains: (tracks: RuntimeTrack[]) => void
  ensureTrackInput: (trackId: string) => GainNode
  stopClipSources: () => void
  stopSourcesForClip: (clipId: string) => void
  scheduleMidiClip: (track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, endLimitSec?: number) => boolean
  ensureStretchedClip: (clip: RuntimeClip) => void
  getStretchedClip: (clip: RuntimeClip) => StretchedAudioRender | null
  stretchRenderAheadSec?: number
  sources: SourceRegistry
}

const DEFAULT_STRETCH_RENDER_AHEAD_SEC = Number.POSITIVE_INFINITY

const findFirstScheduleEntryEndingAfter = (entries: ScheduledClipEntry[], playheadSec: number) => {
  let low = 0
  let high = entries.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (entries[mid].endSec <= playheadSec) low = mid + 1
    else high = mid
  }
  return low
}

export function createClipScheduler(options: ClipSchedulerOptions) {
  const scheduleIndexCache = new WeakMap<RuntimeTrack[], ScheduleIndex>()
  const stretchRenderAheadSec = Math.max(0, options.stretchRenderAheadSec ?? DEFAULT_STRETCH_RENDER_AHEAD_SEC)

  const getScheduleIndex = (tracks: RuntimeTrack[]) => {
    const cached = scheduleIndexCache.get(tracks)
    if (cached) return cached
    const entries: ScheduledClipEntry[] = []
    for (const track of tracks) {
      for (const clip of track.clips) {
        entries.push({
          track,
          clip,
          startSec: clip.startSec,
          endSec: clip.startSec + clip.duration,
        })
      }
    }
    entries.sort((left, right) => left.endSec - right.endSec)
    const index = { byEnd: entries }
    scheduleIndexCache.set(tracks, index)
    return index
  }

  const scheduleAudioClip = (clip: RuntimeClip, input: GainNode, playheadSec: number, nowCtx: number, endLimitSec?: number) => {
    const ctx = options.getAudioContext()
    if (!ctx || !clip.buffer) return
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: clip.buffer.duration,
      projectBpm: options.getBpm(),
      rangeStartSec: playheadSec,
      rangeEndSec: endLimitSec,
    })
    if (!map) return
    if (map.mode === 'stretch' && shouldEnsureStretchRender({
      playheadSec,
      renderAheadSec: stretchRenderAheadSec,
      endLimitSec,
      timelineStartSec: map.timelineStartSec,
      timelineDurationSec: map.timelineDurationSec,
    })) options.ensureStretchedClip(clip)

    const source = ctx.createBufferSource()
    const stretched = map.mode === 'stretch' ? options.getStretchedClip(clip) : null
    const playback = getAudioBufferPlaybackParams({
      sourceBuffer: clip.buffer,
      map,
      stretched: stretched ? { ...stretched, bufferDurationSec: stretched.buffer.duration } : null,
    })
    if (playback.durationSec <= 0) return
    source.buffer = playback.buffer
    source.playbackRate.value = playback.playbackRate
    source.connect(input)
    source.start(
      nowCtx + Math.max(0, map.timelineStartSec - playheadSec),
      playback.offsetSec,
      playback.durationSec,
    )
    source.onended = () => options.sources.remove(clip.id, source)
    options.sources.add(clip.id, source)
  }

  return {
    scheduleAllClipsFromPlayhead: (tracks: RuntimeTrack[], playheadSec: number, opts?: ScheduleOptions) => {
      if (!options.getAudioContext()) return
      if (!opts?.preserveExisting) options.stopClipSources()
      const now = typeof opts?.atCtxTime === 'number' ? opts.atCtxTime : options.timelineToCtxTime(playheadSec)
      options.updateTrackGains(tracks)

      const endLimitSec = opts?.endLimitSec
      const entries = getScheduleIndex(tracks).byEnd
      for (let index = findFirstScheduleEntryEndingAfter(entries, playheadSec); index < entries.length; index++) {
        const entry = entries[index]
        if (endLimitSec !== undefined && entry.startSec >= endLimitSec) continue
        if (options.scheduleMidiClip(entry.track, entry.clip, playheadSec, now, endLimitSec)) continue
        scheduleAudioClip(entry.clip, options.ensureTrackInput(entry.track.id), playheadSec, now, endLimitSec)
      }
    },
    rescheduleClipsAtPlayhead: (tracks: RuntimeTrack[], playheadSec: number, clipIds: string[], opts?: ScheduleOptions) => {
      if (!options.getAudioContext()) return
      if (!clipIds || clipIds.length === 0) return
      const idsSet = new Set<string>(clipIds)
      const now = options.timelineToCtxTime(playheadSec)
      options.updateTrackGains(tracks)
      for (const id of idsSet) options.stopSourcesForClip(id)

      for (const track of tracks) {
        const input = options.ensureTrackInput(track.id)
        for (const clip of track.clips) {
          if (!idsSet.has(clip.id)) continue
          if (options.scheduleMidiClip(track, clip, playheadSec, now, opts?.endLimitSec)) continue
          scheduleAudioClip(clip, input, playheadSec, now, opts?.endLimitSec)
        }
      }
    },
  }
}

const shouldEnsureStretchRender = (input: {
  playheadSec: number
  renderAheadSec: number
  endLimitSec?: number
  timelineStartSec: number
  timelineDurationSec: number
}) => {
  const renderEndSec = input.timelineStartSec + input.timelineDurationSec
  const horizonEndSec = Math.min(
    input.endLimitSec ?? Number.POSITIVE_INFINITY,
    input.playheadSec + Math.max(0, input.renderAheadSec),
  )
  return input.timelineStartSec < horizonEndSec && renderEndSec > input.playheadSec
}

export const clipSchedulerTestInternals = {
  defaultStretchRenderAheadSec: DEFAULT_STRETCH_RENDER_AHEAD_SEC,
  shouldEnsureStretchRender,
}
