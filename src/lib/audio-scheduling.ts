import { applyArpeggiatorToNotes } from '~/lib/effects/dsp'
import type { ArpParams } from '~/lib/effects/params'
import type { Clip } from '~/types/timeline'

type MidiNote = {
  beat: number
  length: number
  pitch: number
  velocity?: number
}

export type ScheduledMidiEvent = {
  startSec: number
  endSec: number
  pitch: number
  velocity?: number
}

export type PlayableAudioWindow = {
  startSec: number
  offsetSec: number
  durationSec: number
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
    notesToSchedule = applyArpeggiatorToNotes(notesToSchedule, input.arp, clipDurationBeats)
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

export function getPlayableAudioWindow(input: {
  clip: Pick<Clip, 'startSec' | 'duration' | 'leftPadSec' | 'bufferOffsetSec'>
  bufferDurationSec: number
  rangeStartSec: number
  rangeEndSec?: number
}): PlayableAudioWindow | null {
  const leftPad = Math.max(0, input.clip.leftPadSec ?? 0)
  const bufferOffsetRaw = Math.max(0, input.clip.bufferOffsetSec ?? 0)
  const windowStart = input.clip.startSec
  const windowEndRaw = input.clip.startSec + input.clip.duration
  const windowEnd = typeof input.rangeEndSec === 'number' ? Math.min(windowEndRaw, input.rangeEndSec) : windowEndRaw
  const audioStart = windowStart + leftPad
  const bufferOffset = Math.min(input.bufferDurationSec, bufferOffsetRaw)
  const bufferDurRemain = Math.max(0, input.bufferDurationSec - bufferOffset)
  const audioEnd = Math.min(windowEnd, audioStart + bufferDurRemain)

  if (input.rangeStartSec >= audioEnd) return null

  const startSec = Math.max(input.rangeStartSec, audioStart)
  const offsetNoBase = Math.max(0, startSec - audioStart)
  if (offsetNoBase >= bufferDurRemain) return null

  const durationSec = Math.min(
    Math.max(0, bufferDurRemain - offsetNoBase),
    Math.max(0, audioEnd - startSec),
  )
  if (durationSec <= 0) return null

  return {
    startSec,
    offsetSec: bufferOffset + offsetNoBase,
    durationSec,
  }
}
