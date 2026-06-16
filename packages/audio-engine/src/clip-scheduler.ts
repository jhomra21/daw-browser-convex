import { getAudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { connectSourceWithClipGain, getAudioBufferPlaybackParams } from './audio-scheduling'
import type { StretchedAudioRender } from './audio-stretch-cache'
import type { SourceRegistry } from './source-registry'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type RuntimeClip = Clip<AudioBuffer>
type RuntimeTrack = Track<AudioBuffer>

export type ScheduleOptions = {
  atCtxTime?: number
  preserveExisting?: boolean
  startLimitSec?: number
  endLimitSec?: number
  clipIds?: string[]
}

export type DeferredStretchWindow = {
  clipId: string
  startSec: number
  endSec: number
  replaceExistingSource?: boolean
}

export type ScheduleResult = {
  deferredStretchWindows: DeferredStretchWindow[]
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
  scheduleMidiClip: (track: RuntimeTrack, clip: RuntimeClip, playheadSec: number, nowCtx: number, startLimitSec?: number, endLimitSec?: number) => boolean
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

const shouldScheduleEntryInRange = (
  entry: Pick<ScheduledClipEntry, 'startSec' | 'endSec'>,
  startLimitSec: number,
  endLimitSec?: number,
) => (
  entry.endSec > startLimitSec
  && (endLimitSec === undefined || entry.startSec < endLimitSec)
)

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

  const createScheduleResult = (): ScheduleResult => ({ deferredStretchWindows: [] })

  const scheduleAudioClip = (clip: RuntimeClip, input: GainNode, playheadSec: number, nowCtx: number, startLimitSec?: number, endLimitSec?: number): DeferredStretchWindow | null => {
    const ctx = options.getAudioContext()
    if (!ctx || !clip.buffer) return null
    const map = getAudioClipTimeMap({
      clip,
      bufferDurationSec: clip.buffer.duration,
      projectBpm: options.getBpm(),
      rangeStartSec: startLimitSec ?? playheadSec,
      rangeEndSec: endLimitSec,
    })
    if (!map) return null
    const stretchInHorizon = map.mode === 'stretch' && shouldScheduleStretchSource({
      playheadSec,
      renderAheadSec: stretchRenderAheadSec,
      endLimitSec,
      timelineStartSec: map.timelineStartSec,
      timelineDurationSec: map.timelineDurationSec,
    })
    if (map.mode === 'stretch' && !stretchInHorizon) return null
    if (stretchInHorizon) options.ensureStretchedClip(clip)

    const stretched = map.mode === 'stretch' ? options.getStretchedClip(clip) : null
    let deferredFallbackWindow: DeferredStretchWindow | null = null
    if (map.mode === 'stretch' && !stretched) {
      const deferredWindow = { clipId: clip.id, startSec: map.timelineStartSec, endSec: map.timelineEndSec }
      if (!canFallbackToRepitchStretch({
        playheadSec,
        timelineStartSec: map.timelineStartSec,
        timelineEndSec: map.timelineEndSec,
      })) return deferredWindow
      deferredFallbackWindow = { ...deferredWindow, replaceExistingSource: true }
    }

    const source = ctx.createBufferSource()
    const playback = getAudioBufferPlaybackParams({
      sourceBuffer: clip.buffer,
      map,
      stretched: stretched ? { ...stretched, bufferDurationSec: stretched.buffer.duration } : null,
    })
    if (playback.durationSec <= 0) return null
    source.buffer = playback.buffer
    source.playbackRate.value = playback.playbackRate
    connectSourceWithClipGain(ctx, source, input, clip.gain)
    source.start(
      nowCtx + Math.max(0, map.timelineStartSec - playheadSec),
      playback.offsetSec,
      playback.durationSec,
    )
    source.onended = () => options.sources.remove(clip.id, source)
    options.sources.add(clip.id, source)
    return deferredFallbackWindow
  }

  return {
    scheduleAllClipsFromPlayhead: (tracks: RuntimeTrack[], playheadSec: number, opts?: ScheduleOptions) => {
      const result = createScheduleResult()
      if (!options.getAudioContext()) return result
      if (!opts?.preserveExisting) options.stopClipSources()
      const now = typeof opts?.atCtxTime === 'number' ? opts.atCtxTime : options.timelineToCtxTime(playheadSec)
      options.updateTrackGains(tracks)

      const startLimitSec = opts?.startLimitSec
      const endLimitSec = opts?.endLimitSec
      const clipIds = opts?.clipIds ? new Set(opts.clipIds) : null
      const entries = getScheduleIndex(tracks).byEnd
      const scheduleStartSec = startLimitSec ?? playheadSec
      for (let index = findFirstScheduleEntryEndingAfter(entries, scheduleStartSec); index < entries.length; index++) {
        const entry = entries[index]
        if (clipIds && !clipIds.has(entry.clip.id)) continue
        if (!shouldScheduleEntryInRange(entry, scheduleStartSec, endLimitSec)) continue
        if (options.scheduleMidiClip(entry.track, entry.clip, playheadSec, now, startLimitSec, endLimitSec)) continue
        const deferred = scheduleAudioClip(entry.clip, options.ensureTrackInput(entry.track.id), playheadSec, now, startLimitSec, endLimitSec)
        if (deferred) result.deferredStretchWindows.push(deferred)
      }
      return result
    },
    rescheduleClipsAtPlayhead: (tracks: RuntimeTrack[], playheadSec: number, clipIds: string[], opts?: ScheduleOptions) => {
      const result = createScheduleResult()
      if (!options.getAudioContext()) return result
      if (!clipIds || clipIds.length === 0) return result
      const idsSet = new Set<string>(clipIds)
      const now = options.timelineToCtxTime(playheadSec)
      options.updateTrackGains(tracks)
      for (const id of idsSet) options.stopSourcesForClip(id)

      for (const track of tracks) {
        const input = options.ensureTrackInput(track.id)
        for (const clip of track.clips) {
          if (!idsSet.has(clip.id)) continue
          if (options.scheduleMidiClip(track, clip, playheadSec, now, opts?.startLimitSec, opts?.endLimitSec)) continue
          const deferred = scheduleAudioClip(clip, input, playheadSec, now, opts?.startLimitSec, opts?.endLimitSec)
          if (deferred) result.deferredStretchWindows.push(deferred)
        }
      }
      return result
    },
  }
}

const shouldScheduleStretchSource = (input: {
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

export const STRETCH_REPITCH_FALLBACK_IMMINENT_SEC = 1

export const canFallbackToRepitchStretch = (input: {
  playheadSec: number
  timelineStartSec: number
  timelineEndSec: number
}) => (
  input.timelineEndSec > input.playheadSec
  && input.timelineStartSec <= input.playheadSec + STRETCH_REPITCH_FALLBACK_IMMINENT_SEC
)

export const clipSchedulerTestInternals = {
  defaultStretchRenderAheadSec: DEFAULT_STRETCH_RENDER_AHEAD_SEC,
  shouldEnsureStretchRender: shouldScheduleStretchSource,
  shouldScheduleStretchSource,
  shouldScheduleEntryInRange,
  canFallbackToRepitchStretch,
}
