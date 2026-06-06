import type { AudioSourceKind } from './audio-source-rules'
import { resolveClipSampleUrl } from './audio-source-rules'
import type { AudioSourceMetadata } from './audio-source-metadata'
import type { SharedTimelineClipCreatePayload } from './shared-timeline-operations'
import type { SynthWave } from './effects-params'

export type ClipTimingSnapshot = {
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export type ClipCreateSnapshot = {
  historyRef?: string
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  source?: AudioSourceMetadata
  sourceAssetKey?: string
  sourceKind?: AudioSourceKind
  midi?: {
    wave: SynthWave
    gain?: number
    notes: Array<{ beat: number; length: number; pitch: number; velocity?: number }>
  }
  timing?: ClipTimingSnapshot
}

type BuildClipCreatePayloadInput<TTrackId extends string = string> = {
  projectId: string
  trackId: TTrackId
  clip: ClipCreateSnapshot
}

type CompleteAudioClipCreateSnapshot = ClipCreateSnapshot & {
  source: AudioSourceMetadata & {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
  sourceAssetKey: string
  sourceKind: AudioSourceKind
}

export type ClipCreatePayload<TTrackId extends string = string> = Omit<SharedTimelineClipCreatePayload, 'trackId'> & {
  projectId: string
  trackId: TTrackId
}

const hasCompleteAudioClipMetadata = (clip: ClipCreateSnapshot): clip is CompleteAudioClipCreateSnapshot => (
  Boolean(
    clip.sourceAssetKey
    && clip.sourceKind
    && clip.source
    && clip.source.durationSec !== undefined
    && clip.source.sampleRate !== undefined
    && clip.source.channelCount !== undefined,
  )
)

const buildAudioClipMetadataPayloadFields = <TTrackId extends string>(
  input: BuildClipCreatePayloadInput<TTrackId>,
): Omit<SharedTimelineClipCreatePayload, 'trackId'> & { trackId: TTrackId } => {
  const { trackId, clip } = input
  if (!hasCompleteAudioClipMetadata(clip)) {
    throw new Error('Audio clips require complete source metadata')
  }

  return {
    trackId,
    startSec: clip.startSec,
    duration: clip.duration,
    name: clip.name,
    sampleUrl: resolveClipSampleUrl(clip),
    assetKey: clip.sourceAssetKey,
    sourceKind: clip.sourceKind,
    durationSec: clip.source.durationSec,
    sampleRate: clip.source.sampleRate,
    channelCount: clip.source.channelCount,
    clipKind: 'audio',
    leftPadSec: clip.timing?.leftPadSec,
    bufferOffsetSec: clip.timing?.bufferOffsetSec,
    midiOffsetBeats: clip.timing?.midiOffsetBeats,
  }
}

export function buildQueuedAudioClipCreatePayload<TTrackId extends string>(
  input: BuildClipCreatePayloadInput<TTrackId> & { operationId: string },
) {
  return {
    ...buildAudioClipMetadataPayloadFields(input),
    operationId: input.operationId,
  }
}

const buildAudioClipCreatePayloadFields = (
  input: BuildClipCreatePayloadInput,
): SharedTimelineClipCreatePayload => {
  const payload = buildAudioClipMetadataPayloadFields(input)
  if (!payload.sampleUrl) {
    throw new Error('Audio clips require complete source metadata')
  }

  return payload
}

export function buildClipCreatePayload<TTrackId extends string>(
  input: BuildClipCreatePayloadInput<TTrackId>,
): ClipCreatePayload<TTrackId> {
  const { projectId, trackId, clip } = input
  if (!clip.midi) {
    return {
      projectId,
      ...buildAudioClipCreatePayloadFields(input),
      trackId,
    }
  }

  return {
    projectId,
    trackId,
    startSec: clip.startSec,
    duration: clip.duration,
    name: clip.name,
    clipKind: 'midi',
    midi: clip.midi,
    leftPadSec: clip.timing?.leftPadSec,
    bufferOffsetSec: clip.timing?.bufferOffsetSec,
    midiOffsetBeats: clip.timing?.midiOffsetBeats,
  }
}
