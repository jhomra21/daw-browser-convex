import { applyArpeggiatorToNotes } from './effects/dsp'
import { mapSourceBeatToTimelineBeat, mapTimelineBeatToSourceBeat } from '@daw-browser/shared'
import type { ArpParams } from '@daw-browser/shared'
import type { Clip } from '@daw-browser/timeline-core/types'

type MidiNote = {
  beat: number
  length: number
  pitch: number
  velocity?: number
}

type ScheduledMidiEvent = {
  startSec: number
  endSec: number
  pitch: number
  velocity?: number
}

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

const arpeggiatedNotesCache = new WeakMap<MidiNote[], Map<string, MidiNote[]>>()
const MAX_ARPEGGIATOR_CACHE_ENTRIES = 4

function getArpeggiatorCacheKey(params: ArpParams, clipDurationBeats: number) {
  return [
    params.enabled ? 1 : 0,
    params.rate,
    params.pattern,
    params.octaves,
    params.gate,
    params.hold ? 1 : 0,
    clipDurationBeats,
  ].join('|')
}

function getArpeggiatedNotes(notes: MidiNote[], params: ArpParams, clipDurationBeats: number) {
  const key = getArpeggiatorCacheKey(params, clipDurationBeats)
  let cache = arpeggiatedNotesCache.get(notes)
  if (!cache) {
    cache = new Map<string, MidiNote[]>()
    arpeggiatedNotesCache.set(notes, cache)
  }
  const cached = cache.get(key)
  if (cached) return cached
  const next = applyArpeggiatorToNotes(notes, params, clipDurationBeats)
  if (cache.size >= MAX_ARPEGGIATOR_CACHE_ENTRIES) {
    for (const oldestKey of cache.keys()) {
      cache.delete(oldestKey)
      break
    }
  }
  cache.set(key, next)
  return next
}

export function getScheduledMidiEvents(input: {
  clip: Pick<Clip, 'startSec' | 'duration' | 'midiOffsetBeats'>
  bpm: number
  notes: MidiNote[]
  rangeStartSec: number
  rangeEndSec?: number
  arp?: ArpParams
}): ScheduledMidiEvent[] {
  const secondsPerBeat = 60 / Math.max(1, input.bpm || 120)
  const clipStart = input.clip.startSec
  const clipEndRaw = input.clip.startSec + input.clip.duration
  const clipEnd = typeof input.rangeEndSec === 'number' ? Math.min(clipEndRaw, input.rangeEndSec) : clipEndRaw
  const clipDurationBeats = input.clip.duration / secondsPerBeat
  const midiOffsetBeats = Math.max(0, input.clip.midiOffsetBeats ?? 0)

  let notesToSchedule = input.notes
  if (input.arp?.enabled) {
    notesToSchedule = getArpeggiatedNotes(notesToSchedule, input.arp, clipDurationBeats)
  }

  const events: ScheduledMidiEvent[] = []
  for (const note of notesToSchedule) {
    const noteBeatRaw = note.beat || 0
    const trimmedBeats = Math.max(0, midiOffsetBeats - noteBeatRaw)
    const effectiveLength = Math.max(0, (note.length || 0) - trimmedBeats)
    if (effectiveLength <= 0) continue

    const noteBeatEff = Math.max(0, noteBeatRaw - midiOffsetBeats)
    const noteStartTimeline = clipStart + noteBeatEff * secondsPerBeat
    const noteEndTimeline = noteStartTimeline + effectiveLength * secondsPerBeat
    const startSec = Math.max(noteStartTimeline, clipStart, input.rangeStartSec)
    const endSec = Math.min(noteEndTimeline, clipEnd)
    if (endSec <= startSec) continue

    events.push({
      startSec,
      endSec,
      pitch: note.pitch,
      velocity: note.velocity,
    })
  }

  return events
}

const resolveWarpBpm = (value: number | undefined, fallback: number) => (
  Number.isFinite(value) && value !== undefined && value > 0 ? value : fallback
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

export function getAudioBufferPlaybackDurationSec(input: {
  map: Pick<AudioClipTimeMap, 'sourceDurationSec'>
  stretchedDurationSec?: number | null
}) {
  return input.stretchedDurationSec ?? input.map.sourceDurationSec
}

export function connectSourceWithClipGain(
  context: BaseAudioContext,
  source: AudioNode,
  destination: AudioNode,
  gain: number | undefined,
) {
  if (gain === undefined || gain === 1) {
    source.connect(destination)
    return
  }
  const clipGain = context.createGain()
  clipGain.gain.value = Math.min(2, Math.max(0, gain))
  source.connect(clipGain)
  clipGain.connect(destination)
}

export function getAudioBufferPlaybackParams<TBuffer>(input: {
  sourceBuffer: TBuffer
  map: Pick<AudioClipTimeMap, 'mode' | 'playbackRate' | 'sourceStartSec' | 'sourceDurationSec' | 'timelineStartSec' | 'timelineDurationSec'>
  stretched?: {
    buffer: TBuffer
    timelineStartSec: number
    sourceStartSec: number
    bufferDurationSec: number
  } | null
}) {
  const stretched = input.stretched ?? null
  const stretchedOffsetSec = stretched ? Math.max(0, input.map.timelineStartSec - stretched.timelineStartSec) : 0
  const stretchedDurationSec = stretched
    ? Math.min(input.map.timelineDurationSec, Math.max(0, stretched.bufferDurationSec - stretchedOffsetSec))
    : null
  const durationSec = getAudioBufferPlaybackDurationSec({
    map: input.map,
    stretchedDurationSec,
  })
  return {
    buffer: stretched?.buffer ?? input.sourceBuffer,
    offsetSec: stretched ? stretched.sourceStartSec + stretchedOffsetSec : input.map.sourceStartSec,
    durationSec,
    playbackRate: input.map.mode !== 'raw' && !stretched ? input.map.playbackRate : 1,
  }
}