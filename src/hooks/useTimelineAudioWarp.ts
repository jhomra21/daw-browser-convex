import { createMemo, type Accessor } from 'solid-js'
import { audioWarpEqual, createDefaultAudioWarp, isLocalId, normalizeAudioWarp } from '@daw-browser/shared'
import type { AudioWarp, Clip, Track } from '@daw-browser/timeline-core/types'
import { createBpmDetectionService } from '~/lib/bpm-detection-service'
import { createTimelineClipWriteAdapter } from '~/lib/timeline-clip-write-adapter'
import { getClipHistoryRef } from '~/lib/undo/refs'
import type { HistoryEntry } from '~/lib/undo/types'

type TimelineProjectionAudioWarp = {
  commitClipAudioWarp: (clipId: string, audioWarp: AudioWarp) => void
}

type UseTimelineAudioWarpOptions = {
  projectId: Accessor<string>
  userId: Accessor<string | undefined>
  bpm: Accessor<number>
  tracks: Accessor<Track[]>
  selectedClip: Accessor<{ trackId: Track['id']; clipId: string } | null>
  canWriteClip: (clipId: string) => boolean
  projection: TimelineProjectionAudioWarp
  pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  rescheduleChangedClips: (clipIds: string[]) => void
}

export function useTimelineAudioWarp(options: UseTimelineAudioWarpOptions) {
  const bpmDetection = createBpmDetectionService()
  const selectedAudioClip = createMemo(() => {
    const selected = options.selectedClip()
    if (!selected) return undefined
    const track = options.tracks().find((entry) => entry.id === selected.trackId)
    const clip = track?.clips.find((entry) => entry.id === selected.clipId)
    return clip && !clip.midi ? clip : undefined
  })

  const buildClipAudioWarpSnapshot = (clip: Clip) => ({
    audioWarp: normalizeAudioWarp(clip.audioWarp) ?? createDefaultAudioWarp(options.bpm()),
  })

  const changeAudioWarp = async (clip: Clip, audioWarp: AudioWarp) => {
    const projectId = options.projectId()
    const userId = options.userId()
    if (!projectId || (!isLocalId('project', projectId) && !userId) || !options.canWriteClip(clip.id)) return false

    const nextAudioWarp = normalizeAudioWarp(audioWarp)
    if (!nextAudioWarp) return false
    const previous = buildClipAudioWarpSnapshot(clip)
    if (audioWarpEqual(previous.audioWarp, nextAudioWarp)) return true

    const applied = await createTimelineClipWriteAdapter({ projectId, userId }).setAudioWarp(clip.id, nextAudioWarp)
    if (!applied) return false

    options.projection.commitClipAudioWarp(clip.id, nextAudioWarp)
    options.rescheduleChangedClips([clip.id])
    options.pushHistory({
      type: 'clip-audio-warp',
      projectId,
      data: {
        clipRef: getClipHistoryRef(clip),
        from: previous,
        to: { audioWarp: nextAudioWarp },
      },
    })
    return true
  }

  return {
    bpmDetection,
    selectedAudioClip,
    changeAudioWarp,
  }
}
