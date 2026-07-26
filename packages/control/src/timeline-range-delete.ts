import {
  clipFadesForFragment,
  transformClipFadesForDuration,
} from '@daw-browser/timeline-core/clip-fades'
import { calculateAudioTimelineTrimOffsets } from '@daw-browser/timeline-core/audio-timeline-trim'
import { valueAtAutomationTime } from '@daw-browser/shared'
import type { ProjectSnapshotV2 } from './index'

type SnapshotClip = ProjectSnapshotV2['clips'][number]
type SnapshotAutomation = ProjectSnapshotV2['automation'][number]

export type TimelineRangeDeletePatchV1 = {
  trackIds: string[]
  clipDeletes: Array<{ clipId: string; before: SnapshotClip }>
  clipUpdates: Array<{ clipId: string; before: SnapshotClip; after: SnapshotClip }>
  clipCreates: Array<{ placeholderId: string; sourceClipId: string; after: SnapshotClip }>
  automationUpdates: Array<{
    identity: { target: SnapshotAutomation['target']; effectInstanceId?: string; parameterId: string }
    before: SnapshotAutomation
    after: SnapshotAutomation
  }>
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const endSec = (clip: SnapshotClip) => clip.startSec + clip.duration

const trimStart = (clip: SnapshotClip, startSec: number, tempoBpm: number): SnapshotClip => {
  const shiftSec = startSec - clip.startSec
  const duration = endSec(clip) - startSec
  const audioTiming = clip.midi ? undefined : calculateAudioTimelineTrimOffsets({
    clip: {
      startSec: clip.startSec,
      duration: clip.duration,
      leftPadSec: clip.leftPadSec,
      bufferOffsetSec: clip.bufferOffsetSec,
      sourceDurationSec: clip.source?.durationSec,
      audioWarp: clip.audioWarp,
    },
    bufferDurationSec: clip.source?.durationSec
      ?? Math.max(0, clip.bufferOffsetSec + Math.max(0, clip.duration - clip.leftPadSec)),
    timelineTrimSec: shiftSec,
    projectBpm: tempoBpm,
  })
  return {
    ...clip,
    startSec,
    duration,
    leftPadSec: audioTiming?.leftPadSec ?? clip.leftPadSec,
    bufferOffsetSec: audioTiming?.bufferOffsetSec ?? clip.bufferOffsetSec,
    midiOffsetBeats: clip.midiOffsetBeats + shiftSec * tempoBpm / 60,
    ...(clip.fades === undefined ? {} : {
      fades: transformClipFadesForDuration(clip.fades, clip.duration, duration, shiftSec),
    }),
    ...(audioTiming?.audioWarp === undefined ? {} : { audioWarp: audioTiming.audioWarp }),
  }
}

const trimEnd = (clip: SnapshotClip, end: number): SnapshotClip => {
  const duration = end - clip.startSec
  return {
    ...clip,
    duration,
    ...(clip.fades === undefined ? {} : {
      fades: clipFadesForFragment(clip.fades, clip.duration, duration, false, true),
    }),
  }
}

const boundaryPoint = (
  id: string,
  timeSec: number,
  value: number,
  interpolation: SnapshotAutomation['points'][number]['interpolation'],
): SnapshotAutomation['points'][number] => ({ id, timeSec, value, interpolation })

const interpolationAtBoundary = (
  points: readonly SnapshotAutomation['points'][number][],
  timeSec: number,
) => {
  let interpolation: SnapshotAutomation['points'][number]['interpolation'] = 'linear'
  for (const point of points) {
    if (point.timeSec > timeSec) break
    interpolation = point.interpolation
  }
  return interpolation
}

export const buildTimelineRangeDeletePatchV1 = (
  snapshot: Omit<ProjectSnapshotV2, 'version'>,
  trackIds: readonly string[],
  startSec: number,
  rangeEndSec: number,
  actionIndex: number,
): TimelineRangeDeletePatchV1 => {
  const selected = new Set(trackIds)
  const patch: TimelineRangeDeletePatchV1 = {
    trackIds: [...selected].sort(),
    clipDeletes: [],
    clipUpdates: [],
    clipCreates: [],
    automationUpdates: [],
  }
  let fragmentIndex = 0
  for (const clip of snapshot.clips) {
    if (!selected.has(clip.trackId) || clip.startSec >= rangeEndSec || endSec(clip) <= startSec) continue
    if (clip.startSec >= startSec && endSec(clip) <= rangeEndSec) {
      patch.clipDeletes.push({ clipId: clip.id, before: clip })
    } else if (clip.startSec < startSec && endSec(clip) > rangeEndSec) {
      const left = trimEnd(clip, startSec)
      const right = trimStart(clip, rangeEndSec, snapshot.project.tempoBpm)
      patch.clipUpdates.push({ clipId: clip.id, before: clip, after: left })
      patch.clipCreates.push({
        placeholderId: `control:clip:range:${actionIndex}:${fragmentIndex}`,
        sourceClipId: clip.id,
        after: { ...right, id: `control:clip:range:${actionIndex}:${fragmentIndex++}` },
      })
    } else if (clip.startSec < startSec) {
      patch.clipUpdates.push({ clipId: clip.id, before: clip, after: trimEnd(clip, startSec) })
    } else {
      patch.clipUpdates.push({
        clipId: clip.id,
        before: clip,
        after: trimStart(clip, rangeEndSec, snapshot.project.tempoBpm),
      })
    }
  }
  for (const envelope of snapshot.automation) {
    if (!('trackId' in envelope.target) || !selected.has(envelope.target.trackId)) continue
    if (!envelope.points.some((point) => point.timeSec >= startSec && point.timeSec <= rangeEndSec)) continue
    const after = {
      ...envelope,
      points: [
        ...envelope.points.filter((point) => point.timeSec < startSec || point.timeSec > rangeEndSec),
        boundaryPoint(
          `${envelope.parameterId}:delete-start:${startSec}`,
          startSec,
          valueAtAutomationTime(envelope.points, startSec, envelope.points[0]?.value ?? 0),
          interpolationAtBoundary(envelope.points, startSec),
        ),
        boundaryPoint(
          `${envelope.parameterId}:delete-end:${rangeEndSec}`,
          rangeEndSec,
          valueAtAutomationTime(envelope.points, rangeEndSec, envelope.points[0]?.value ?? 0),
          interpolationAtBoundary(envelope.points, rangeEndSec),
        ),
      ].sort((left, right) => left.timeSec - right.timeSec || left.id.localeCompare(right.id)),
    }
    if (!same(envelope, after)) {
      patch.automationUpdates.push({
        identity: { target: envelope.target, effectInstanceId: envelope.effectInstanceId, parameterId: envelope.parameterId },
        before: envelope,
        after,
      })
    }
  }
  return patch
}
