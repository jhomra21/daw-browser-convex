import { automationTargetKey, valueAtAutomationTime, type AutomationEnvelope, type AutomationInterpolation, type AutomationTarget, type ClipCreateSnapshot } from '@daw-browser/shared'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { clipFadesForFragment } from '@daw-browser/timeline-core/clip-fades'
import { calculateAudioTimelineTrimOffsets } from '~/lib/audio-left-resize-timing'
import { buildClipCreateSnapshot } from '~/lib/clip-create'
import { secondsToBeats, type TimelineTimeRange } from '~/lib/timeline-range-selection'

type TimelineSection = {
  range: TimelineTimeRange
  trackIds: Track['id'][]
}

export type SectionClipFragment = {
  sourceClipId: string
  sourceTrackId: Track['id']
  targetTrackId: Track['id']
  startOffsetSec: number
  duration: number
  clip: ClipCreateSnapshot
  buffer: AudioBuffer | null
}

export type SectionAutomationFragment = {
  sourceTargetKey: string
  targetTrackId: Track['id']
  parameterId: string
  enabled: boolean
  points: Array<{
    id: string
    timeOffsetSec: number
    value: number
    interpolation: AutomationInterpolation
  }>
}

const clipEndSec = (clip: Pick<Clip, 'startSec' | 'duration'>) => clip.startSec + clip.duration

const intersectsRange = (
  item: { startSec: number; endSec: number },
  range: TimelineTimeRange,
) => item.startSec < range.endSec && item.endSec > range.startSec

const shiftClipOffsets = (
  clip: Pick<Clip<AudioBuffer>, 'startSec' | 'duration' | 'buffer' | 'leftPadSec' | 'bufferOffsetSec' | 'midiOffsetBeats' | 'midi' | 'sourceDurationSec' | 'audioWarp'>,
  shiftSec: number,
  bpm: number,
) => {
  if (shiftSec <= 0) {
    return {
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      midiOffsetBeats: clip.midiOffsetBeats,
      audioWarp: clip.audioWarp,
    }
  }

  if (clip.midi) {
    return {
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      midiOffsetBeats: (clip.midiOffsetBeats ?? 0) + secondsToBeats(shiftSec, bpm),
      audioWarp: clip.audioWarp,
    }
  }

  const bufferDurationSec = clip.buffer?.duration
    ?? clip.sourceDurationSec
    ?? Math.max(0, (clip.bufferOffsetSec ?? 0) + Math.max(0, clip.duration - (clip.leftPadSec ?? 0)))

  const offsets = calculateAudioTimelineTrimOffsets({
    clip,
    bufferDurationSec,
    timelineTrimSec: shiftSec,
    projectBpm: bpm,
  })

  return {
    leftPadSec: offsets.leftPadSec,
    bufferOffsetSec: offsets.bufferOffsetSec,
    midiOffsetBeats: clip.midiOffsetBeats == null ? undefined : clip.midiOffsetBeats + secondsToBeats(shiftSec, bpm),
    audioWarp: offsets.audioWarp ?? clip.audioWarp,
  }
}

const buildTrimmedClipCreateSnapshot = (
  clip: Clip,
  input: { startSec: number; endSec: number; bpm: number; preserveHistoryRef?: boolean },
): ClipCreateSnapshot => {
  const trimStart = Math.max(clip.startSec, input.startSec)
  const trimEnd = Math.min(clipEndSec(clip), input.endSec)
  const sourceOffsetSec = Math.max(0, trimStart - clip.startSec)
  const offsets = shiftClipOffsets(clip, sourceOffsetSec, input.bpm)
  const duration = Math.max(0, trimEnd - trimStart)

  return {
    ...buildClipCreateSnapshot(clip, { preserveHistoryRef: input.preserveHistoryRef ?? false }),
    startSec: trimStart,
    duration,
    fades: clip.fades
      ? clipFadesForFragment(
        clip.fades,
        clip.duration,
        duration,
        trimStart > clip.startSec,
        trimEnd < clipEndSec(clip),
      )
      : undefined,
    timing: {
      leftPadSec: offsets.leftPadSec,
      bufferOffsetSec: offsets.bufferOffsetSec,
      midiOffsetBeats: offsets.midiOffsetBeats,
    },
    audioWarp: offsets.audioWarp,
  }
}

export const buildSectionClipFragments = (input: {
  tracks: Track<AudioBuffer>[]
  section: TimelineSection
  bpm: number
}): SectionClipFragment[] => {
  const selectedTrackIds = new Set(input.section.trackIds)

  return input.tracks
    .filter((track) => selectedTrackIds.has(track.id))
    .flatMap((track) => track.clips.flatMap((clip) => {
      if (!intersectsRange({ startSec: clip.startSec, endSec: clipEndSec(clip) }, input.section.range)) return []
      const snapshot = buildTrimmedClipCreateSnapshot(clip, { ...input.section.range, bpm: input.bpm })

      return [{
        sourceClipId: clip.id,
        sourceTrackId: track.id,
        targetTrackId: track.id,
        startOffsetSec: snapshot.startSec - input.section.range.startSec,
        duration: snapshot.duration,
        clip: {
          ...snapshot,
          startSec: snapshot.startSec - input.section.range.startSec,
        },
        buffer: clip.buffer ?? null,
      }]
    }))
}

const valueAtTime = (envelope: AutomationEnvelope, timeSec: number) => (
  valueAtAutomationTime(envelope.points, timeSec, envelope.points[0]?.value ?? 0)
)

export const buildAutomationFragment = (
  envelope: AutomationEnvelope,
  range: TimelineTimeRange,
): SectionAutomationFragment | null => {
  if (envelope.target.kind !== 'track') return null
  const interior = envelope.points.filter((point) => point.timeSec > range.startSec && point.timeSec < range.endSec)

  if (interior.length === 0 && envelope.points.length === 0) return null

  return {
    sourceTargetKey: envelope.targetKey,
    targetTrackId: envelope.target.trackId,
    parameterId: envelope.parameterId,
    enabled: envelope.enabled,
    points: [
      { id: `${envelope.id}:start`, timeOffsetSec: 0, value: valueAtTime(envelope, range.startSec), interpolation: 'linear' },
      ...interior.map((point) => ({
        id: point.id,
        timeOffsetSec: point.timeSec - range.startSec,
        value: point.value,
        interpolation: point.interpolation,
      })),
      { id: `${envelope.id}:end`, timeOffsetSec: range.endSec - range.startSec, value: valueAtTime(envelope, range.endSec), interpolation: 'linear' },
    ],
  }
}

export const pasteAutomationFragment = (input: {
  envelope: AutomationEnvelope | undefined
  fragment: SectionAutomationFragment
  projectId: string
  destinationStartSec: number
  updatedAt: number
}): AutomationEnvelope => {
  const target: AutomationTarget = { kind: 'track', trackId: input.fragment.targetTrackId }
  const targetKey = automationTargetKey(target, input.fragment.parameterId)
  const destinationEndSec = input.destinationStartSec + Math.max(...input.fragment.points.map((point) => point.timeOffsetSec))

  const preserved = input.envelope?.points.filter((point) => (
    point.timeSec < input.destinationStartSec || point.timeSec > destinationEndSec
  )) ?? []

  return {
    id: input.envelope?.id ?? targetKey,
    projectId: input.projectId,
    target,
    targetKey,
    parameterId: input.fragment.parameterId,
    enabled: input.fragment.enabled,
    points: [
      ...preserved,
      ...input.fragment.points.map((point) => ({
        id: `${point.id}:paste:${input.destinationStartSec}`,
        timeSec: input.destinationStartSec + point.timeOffsetSec,
        value: point.value,
        interpolation: point.interpolation,
      })),
    ].sort((left, right) => left.timeSec - right.timeSec),
    updatedAt: input.updatedAt,
  }
}
