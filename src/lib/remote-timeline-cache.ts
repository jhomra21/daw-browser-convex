import type { FunctionReturnType } from 'convex/server'

import { convexApi } from '~/lib/convex'
import { normalizeAudioWarp, sanitizeAudioSourceKind } from '@daw-browser/shared'
import { createLocalProjectEntityRow, openLocalProjectDb, type LocalProjectAssetRow } from '~/lib/local-project-db'
import { notifyLocalProjectChanged } from '~/lib/local-project-changes'
import { normalizeTrackChannelRole } from '@daw-browser/shared'
import { normalizeProjectMixState } from '~/lib/project-mix-state'
import type { TimelineClipRow, TimelineTrackRow } from '~/lib/timeline-repository/types'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>

const TRACK_KIND = 'track'
const CLIP_KIND = 'clip'
const REMOTE_CACHE_KEY = 'remote-timeline-cache'
const MIME_TYPE = 'audio/*'

const now = () => Date.now()

const sanitizeStoragePath = (assetKey: string) => assetKey.replace(/[/\\:]/g, '-')

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readSignature = (value: unknown, key: string) => (
  isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
)

const normalizeTrackKind = (value: string | undefined): TimelineTrackRow['kind'] => (
  value === 'instrument' ? 'instrument' : 'audio'
)

const normalizeMidi = (value: FullTimelineView['clips'][number]['midi']): TimelineClipRow['midi'] => {
  if (!value) return undefined
  const wave = value.wave
  if (wave !== 'sine' && wave !== 'square' && wave !== 'sawtooth' && wave !== 'triangle') return undefined
  return {
    wave,
    gain: value.gain,
    notes: value.notes.map((note) => ({
      beat: note.beat,
      length: note.length,
      pitch: note.pitch,
      velocity: note.velocity,
    })),
  }
}

const toTrackRow = (track: FullTimelineView['tracks'][number], index: number, updatedAt: number): TimelineTrackRow => {
  const trackId = String(track._id)
  return {
    id: trackId,
    historyRef: trackId,
    name: `Track ${index + 1}`,
    index: track.index ?? index,
    volume: track.volume,
    muted: track.muted ?? false,
    soloed: track.soloed ?? false,
    kind: normalizeTrackKind(track.kind),
    channelRole: normalizeTrackChannelRole(track.channelRole),
    outputTargetId: track.outputTargetId ? String(track.outputTargetId) : undefined,
    sends: track.sends.map((send) => ({
      targetId: String(send.targetId),
      amount: send.amount,
    })),
    createdAt: updatedAt,
    updatedAt,
  }
}

const toClipRow = (clip: FullTimelineView['clips'][number], updatedAt: number): TimelineClipRow => {
  const clipId = String(clip._id)
  return {
    id: clipId,
    trackId: String(clip.trackId),
    historyRef: clipId,
    name: clip.name ?? 'Clip',
    startSec: clip.startSec,
    duration: clip.duration,
    color: 'clip-audio',
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind: sanitizeAudioSourceKind(clip.sourceKind),
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
    leftPadSec: clip.leftPadSec ?? 0,
    bufferOffsetSec: clip.bufferOffsetSec ?? 0,
    audioWarp: normalizeAudioWarp(clip.audioWarp),
    gain: clip.gain,
    sampleUrl: clip.sampleUrl,
    midi: normalizeMidi(clip.midi),
    midiOffsetBeats: clip.midiOffsetBeats ?? 0,
    createdAt: updatedAt,
    updatedAt,
  }
}

const toAssetRows = (clips: TimelineClipRow[], updatedAt: number): LocalProjectAssetRow[] => {
  const rowsById = new Map<string, LocalProjectAssetRow>()
  for (const clip of clips) {
    if (!clip.sourceAssetKey) continue
    rowsById.set(clip.sourceAssetKey, {
      id: clip.sourceAssetKey,
      name: clip.name || clip.sourceAssetKey,
      mimeType: MIME_TYPE,
      sizeBytes: 0,
      storagePath: sanitizeStoragePath(clip.sourceAssetKey),
      missing: true,
      durationSec: clip.sourceDurationSec,
      sampleRate: clip.sourceSampleRate,
      createdAt: updatedAt,
      updatedAt,
    })
  }
  return [...rowsById.values()]
}

const timelineCacheSignature = (input: {
  tracks: TimelineTrackRow[]
  clips: TimelineClipRow[]
  assets: LocalProjectAssetRow[]
}) => JSON.stringify(input)

export const cacheRemoteTimelineSnapshot = async (
  projectId: string,
  data: FullTimelineView,
): Promise<void> => {
  const timestamp = now()
  const tracks = data.tracks.map((track, index) => toTrackRow(track, index, timestamp))
  const clips = data.clips.map((clip) => toClipRow(clip, timestamp))
  const trackIds = new Set(tracks.map((track) => track.id))
  const clipsWithExistingTracks = clips.filter((clip) => trackIds.has(clip.trackId))
  const assets = toAssetRows(clipsWithExistingTracks, timestamp)
  const signatureTimestamp = 0
  const nextTracksSignature = timelineCacheSignature({
    tracks: data.tracks.map((track, index) => toTrackRow(track, index, signatureTimestamp)),
    clips: [],
    assets: [],
  })
  const nextClipsSignature = timelineCacheSignature({
    tracks: [],
    clips: data.clips.map((clip) => toClipRow(clip, signatureTimestamp)).filter((clip) => trackIds.has(clip.trackId)),
    assets: [],
  })
  const nextAssetsSignature = timelineCacheSignature({
    tracks: [],
    clips: [],
    assets: toAssetRows(clipsWithExistingTracks.map((clip) => ({ ...clip, createdAt: signatureTimestamp, updatedAt: signatureTimestamp })), signatureTimestamp),
  })
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction(['entities', 'assets', 'projectState', 'syncState'], 'readwrite')
  const cachedSummary = await tx.objectStore('syncState').get(REMOTE_CACHE_KEY)
  const cacheValue = cachedSummary?.value
  const shouldRewriteTimelineCache =
    readSignature(cacheValue, 'tracksSignature') !== nextTracksSignature ||
    readSignature(cacheValue, 'clipsSignature') !== nextClipsSignature ||
    readSignature(cacheValue, 'assetsSignature') !== nextAssetsSignature
  const timelineWrites = shouldRewriteTimelineCache
    ? await Promise.all([
        tx.objectStore('entities').index('by-kind').getAll(TRACK_KIND),
        tx.objectStore('entities').index('by-kind').getAll(CLIP_KIND),
      ]).then(([cachedTracks, cachedClips]) => [
        ...cachedTracks.map((row) => tx.objectStore('entities').delete([row.kind, row.id])),
        ...cachedClips.map((row) => tx.objectStore('entities').delete([row.kind, row.id])),
        ...tracks.map((track) => tx.objectStore('entities').put(createLocalProjectEntityRow(TRACK_KIND, track.id, track, timestamp))),
        ...clipsWithExistingTracks.map((clip) => tx.objectStore('entities').put(createLocalProjectEntityRow(CLIP_KIND, clip.id, clip, timestamp))),
        ...assets.map((asset) => tx.objectStore('assets').put(asset)),
        ...clipsWithExistingTracks.flatMap((clip) => clip.sourceAssetKey && clip.sampleUrl
      ? [tx.objectStore('syncState').put({
          key: `cloud-url:asset:${clip.sourceAssetKey}`,
          value: clip.sampleUrl,
          updatedAt: timestamp,
        })]
      : []),
      ])
    : []
  await Promise.all([
    ...timelineWrites,
    tx.objectStore('projectState').put({
      key: 'projectMix',
      value: normalizeProjectMixState(data.mixerSettings),
      updatedAt: timestamp,
    }),
    tx.objectStore('syncState').put({
      key: REMOTE_CACHE_KEY,
      value: {
        cachedAt: timestamp,
        trackCount: tracks.length,
        clipCount: clipsWithExistingTracks.length,
        assetCount: assets.length,
        tracksSignature: nextTracksSignature,
        clipsSignature: nextClipsSignature,
        assetsSignature: nextAssetsSignature,
      },
      updatedAt: timestamp,
    }),
    tx.done,
  ])
  notifyLocalProjectChanged(projectId)
}
