import { getPersistableAudioSourceMetadata } from '~/lib/audio-source'
import { normalizeAudioWarp, resolveClipSampleUrl, type ClipCreateSnapshot } from '@daw-browser/shared'
import type { Clip } from '@daw-browser/timeline-core/types'
import { getClipHistoryRef } from '~/lib/undo/refs'
import type { HistoryClipSnapshot } from '~/lib/undo/types'

const buildClipSnapshotFields = (clip: Clip): Omit<ClipCreateSnapshot, 'historyRef'> => ({
  startSec: clip.startSec,
  duration: clip.duration,
  name: clip.name,
  gain: clip.gain,
  fades: clip.fades,
  sampleUrl: resolveClipSampleUrl(clip),
  source: getPersistableAudioSourceMetadata({
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
  }),
  sourceAssetKey: clip.sourceAssetKey,
  sourceKind: clip.sourceKind,
  color: clip.color,
  midi: clip.midi,
  audioWarp: normalizeAudioWarp(clip.audioWarp),
  timing: {
    leftPadSec: clip.leftPadSec,
    bufferOffsetSec: clip.bufferOffsetSec,
    midiOffsetBeats: clip.midiOffsetBeats,
  },
})

export const buildClipCreateSnapshot = (
  clip: Clip,
  options?: { preserveHistoryRef?: boolean },
): ClipCreateSnapshot => ({
  ...buildClipSnapshotFields(clip),
  historyRef: options?.preserveHistoryRef === false ? undefined : getClipHistoryRef(clip),
})

export const buildClipHistorySnapshot = (clip: Clip): HistoryClipSnapshot => ({
  clipRef: getClipHistoryRef(clip),
  ...buildClipSnapshotFields(clip),
})
