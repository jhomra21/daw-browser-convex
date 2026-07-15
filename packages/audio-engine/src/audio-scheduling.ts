import { applyArpeggiatorToNotes } from './effects/dsp'
import { normalizeClipGain, type ArpParams } from '@daw-browser/shared'
import type { AudioClipTimeMap } from '@daw-browser/timeline-core/audio-clip-time-map'
import { fadeGainAtClipTime, normalizeClipFades, type ClipFades } from '@daw-browser/timeline-core/clip-fades'
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
  fade?: {
    fades: Partial<ClipFades> | undefined
    clipStartSec: number
    clipDurationSec: number
    timelineStartSec: number
    timelineEndSec: number
    contextStartTime: number
  },
) {
  const normalizedGain = normalizeClipGain(gain ?? 1)
  const normalizedFades = fade
    ? normalizeClipFades(fade.fades, fade.clipDurationSec)
    : normalizeClipFades(undefined, 0)
  if (normalizedGain === 1 && normalizedFades.fadeInSec === 0 && normalizedFades.fadeOutSec === 0) {
    source.connect(destination)
    return
  }
  const clipGain = context.createGain()
  if (!fade) {
    clipGain.gain.value = normalizedGain
  } else {
    scheduleClipFadeGain(clipGain.gain, {
      ...fade,
      fades: normalizedFades,
      gain: normalizedGain,
    })
  }
  source.connect(clipGain)
  clipGain.connect(destination)
}

export const getClipFadeSchedulePlan = (input: {
  fades: Partial<ClipFades> | undefined
  clipStartSec: number
  clipDurationSec: number
  timelineStartSec: number
  timelineEndSec: number
  contextStartTime: number
  gain: number
}) => {
  const fades = normalizeClipFades(input.fades, input.clipDurationSec)
  const start = Math.max(input.clipStartSec, input.timelineStartSec)
  const end = Math.min(input.clipStartSec + input.clipDurationSec, input.timelineEndSec)
  if (end <= start) return []
  const points = new Set([start, end])
  const fadeInStart = input.clipStartSec + fades.fadeInStartSec
  const fadeInEnd = input.clipStartSec + fades.fadeInSec
  const fadeOutStart = input.clipStartSec + input.clipDurationSec - fades.fadeOutSec
  const fadeOutEnd = input.clipStartSec + input.clipDurationSec - fades.fadeOutEndSec
  const sampleFade = (fadeStart: number, fadeEnd: number) => {
    const visibleStart = Math.max(start, fadeStart)
    const visibleEnd = Math.min(end, fadeEnd)
    if (visibleEnd <= visibleStart) return
    const samples = 16
    for (let index = 0; index <= samples; index += 1) {
      points.add(visibleStart + ((visibleEnd - visibleStart) * index) / samples)
    }
  }
  sampleFade(fadeInStart, fadeInEnd)
  sampleFade(fadeOutStart, fadeOutEnd)
  return Array.from(points).sort((left, right) => left - right).map((timelineSec) => ({
    time: input.contextStartTime + Math.max(0, timelineSec - input.timelineStartSec),
    gain: input.gain * fadeGainAtClipTime(
      fades,
      input.clipDurationSec,
      timelineSec - input.clipStartSec,
    ),
  }))
}

const scheduleClipFadeGain = (
  parameter: AudioParam,
  input: {
    fades: ClipFades
    clipStartSec: number
    clipDurationSec: number
    timelineStartSec: number
    timelineEndSec: number
    contextStartTime: number
    gain: number
  },
) => {
  const plan = getClipFadeSchedulePlan(input)
  const first = plan[0]
  if (!first) return
  parameter.setValueAtTime(first.gain, first.time)
  for (let index = 1; index < plan.length; index += 1) {
    const point = plan[index]
    parameter.linearRampToValueAtTime(point.gain, point.time)
  }
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