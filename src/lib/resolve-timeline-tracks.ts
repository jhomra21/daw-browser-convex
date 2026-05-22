import type { FunctionReturnType } from 'convex/server'

import { convexApi } from '~/lib/convex'
import { sanitizeAudioSourceKind } from '~/lib/audio-source-rules'
import { isLocalId } from '~/lib/local-ids'
import { resolveTrackMixView } from '~/lib/timeline-mix-authority'
import type { PendingTrackMixState } from '~/lib/timeline-mixer-pending'
import type { TimelineSnapshot } from '~/lib/timeline-repository/types'
import { createTimelineTrackIndex } from '~/lib/timeline-track-index'
import type { LocalMixMap } from '~/lib/timeline-storage'
import { normalizeTrackRouting } from '~/lib/track-routing'
import type { Track, Clip, TrackRouting, TrackSend } from '~/types/timeline'

type FullTimelineView = FunctionReturnType<typeof convexApi.timeline.fullView>

type TimelineTrackLike<TTrackId extends string = Track['id']> = Omit<Track, 'id' | 'outputTargetId' | 'sends'> & {
  id: TTrackId
  outputTargetId?: TTrackId
  sends?: Array<Omit<TrackSend, 'targetId'> & { targetId: TTrackId }>
}

type TimelineViewLike<TTrackId extends string = Track['id']> = {
  tracks: Array<{ _id: TTrackId; lockedBy?: string | null }>
  clips: Array<{ _id: string; trackId: TTrackId; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number }>
}

export type ClipTimelinePatch<TTrackId extends string = Track['id']> = {
  trackId?: TTrackId
  startSec?: number
  duration?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  midiOffsetBeats?: number
}

export type PendingTrackEntry<TTrackId extends string = Track['id']> = {
  index: number
  track: TimelineTrackLike<TTrackId>
}

type TimelineRoutingState = {
  serverVolumes: Map<Track['id'], number>
  serverMuted: Map<Track['id'], boolean>
  serverSoloed: Map<Track['id'], boolean>
  serverRouting: Map<Track['id'], TrackRouting & { sends: TrackSend[] }>
}

type ResolveTimelineTracksOptions = {
  projectId?: string
  server: {
    data?: FullTimelineView
    localSnapshot?: TimelineSnapshot | null
    trackState?: TimelineRoutingState | null
  }
  client: {
    mix: {
      syncMix: boolean
      writableTrackIds: Set<string>
      localByTrackId: LocalMixMap
      pendingSharedTrackVolumes: Map<string, number>
      pendingSharedTrackRouting: Map<string, TrackRouting & { sends: TrackSend[] }>
      pendingSharedMixByTrackId: Map<string, PendingTrackMixState>
    }
    tracks: {
      pendingEntriesById: Map<Track['id'], PendingTrackEntry>
      removedIds: Set<Track['id']>
      pendingLocksById: Map<Track['id'], string | null>
      historyRefsById: Map<Track['id'], string>
      namesByHistoryRef: Map<string, string>
    }
    clips: {
      pendingCreatesById: Map<string, { trackId: Track['id']; clip: Clip }>
      removedIds: Set<string>
      committedEditsById: Map<string, ClipTimelinePatch>
      draftEditsById: Map<string, ClipTimelinePatch>
      previewByTrackId: Map<Track['id'], Clip[]>
      historyRefsById: Map<string, string>
    }
  }
  buffers: {
    audioBufferCache: Map<string, AudioBuffer>
    clipMediaStatus: Map<string, Clip['mediaStatus']>
  }
}

type ServerTimelineIndex<TTrackId extends string = Track['id']> = {
  trackIds: Set<TTrackId>
  clipIds: Set<string>
  clipRowsById: Map<string, { trackId: TTrackId; startSec: number; duration: number; leftPadSec: number; bufferOffsetSec: number; midiOffsetBeats: number }>
  trackLocksById: Map<TTrackId, string | null>
}

const MIDI_WAVES = ['sine', 'square', 'sawtooth', 'triangle'] as const

const nearlyEqual = (left: number | undefined, right: number | undefined) => {
  if (left === undefined || right === undefined) return left === right
  return Math.abs(left - right) < 1e-6
}

const normalizeTrackKind = (value: string | undefined): Track['kind'] => {
  if (value === 'audio' || value === 'instrument') return value
  return undefined
}

const normalizeChannelRole = (value: string | undefined): Track['channelRole'] => {
  if (value === 'track' || value === 'group' || value === 'return') return value
  return undefined
}

const normalizeSourceKind = (value: string | undefined): Clip['sourceKind'] => {
  return sanitizeAudioSourceKind(value)
}

const normalizeMidi = (value: FullTimelineView['clips'][number]['midi']): Clip['midi'] => {
  const wave = MIDI_WAVES.find((entry) => entry === value?.wave)
  if (!value || !wave) return undefined
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

const getWaveformAssetKey = (projectId: string | undefined, sourceAssetKey: string | undefined) => {
  if (!projectId || !sourceAssetKey) return sourceAssetKey
  return isLocalId('project', projectId) && isLocalId('asset', sourceAssetKey)
    ? `${projectId}:${sourceAssetKey}`
    : sourceAssetKey
}

const withWaveformAssetKey = (clip: Clip, projectId: string | undefined): Clip => ({
  ...clip,
  waveformAssetKey: getWaveformAssetKey(projectId, clip.sourceAssetKey),
})

const cloneClip = (clip: Clip): Clip => ({
  ...clip,
  midi: clip.midi
    ? {
        ...clip.midi,
        notes: clip.midi.notes.map((note) => ({ ...note })),
      }
    : undefined,
})

const cloneTrack = (track: Track): Track => ({
  ...track,
  clips: track.clips.map((clip) => cloneClip(clip)),
  sends: track.sends?.map((send) => ({ ...send })),
})

const sortTrackClips = (track: Track) => {
  track.clips.sort((left, right) => left.startSec - right.startSec)
}

const attachClipBuffer = (
  clip: Clip,
  projectId: string | undefined,
  audioBufferCache: Map<string, AudioBuffer>,
  clipMediaStatus: Map<string, Clip['mediaStatus']>,
): Clip => ({
  ...clip,
  buffer: audioBufferCache.get(clip.id) ?? clip.buffer ?? null,
  mediaStatus: clipMediaStatus.get(clip.id),
  waveformAssetKey: getWaveformAssetKey(projectId, clip.sourceAssetKey),
})

const resolveTrackName = (input: {
  historyRef: string
  explicitName?: string
  fallbackIndex: number
  namesByHistoryRef: Map<string, string>
}) => {
  const rememberedName = input.namesByHistoryRef.get(input.historyRef)
  if (rememberedName) return rememberedName
  if (input.explicitName) return input.explicitName
  return `Track ${input.fallbackIndex}`
}

const applyClipPatch = (clip: Clip, patch: ClipTimelinePatch | undefined): Clip => {
  if (!patch) return clip
  return {
    ...clip,
    startSec: patch.startSec ?? clip.startSec,
    duration: patch.duration ?? clip.duration,
    leftPadSec: patch.leftPadSec ?? clip.leftPadSec,
    bufferOffsetSec: patch.bufferOffsetSec ?? clip.bufferOffsetSec,
    midiOffsetBeats: patch.midiOffsetBeats ?? clip.midiOffsetBeats,
  }
}

const removeClipFromTrack = (track: Track | undefined, clipId: string) => {
  if (!track) return
  track.clips = track.clips.filter((clip) => clip.id !== clipId)
}

const pushClipToTrack = (track: Track | undefined, clip: Clip) => {
  if (!track) return
  track.clips.push(clip)
}

const applyTrackMix = (
  track: Track,
  options: ResolveTimelineTracksOptions,
  tracks: Track[],
) => {
  const localMixState = options.client.mix.localByTrackId[track.id]
  const canWriteSharedMix = options.client.mix.writableTrackIds.has(track.id)
  const serverState = options.server.trackState
  const serverVolume = serverState?.serverVolumes.get(track.id)
  const pendingRouting = options.client.mix.pendingSharedTrackRouting.get(track.id)
  const pendingMix = options.client.mix.pendingSharedMixByTrackId.get(track.id)
  const serverRouting = serverState?.serverRouting.get(track.id)
  const localRouting = localMixState?.sends !== undefined || localMixState?.outputTargetId !== undefined
    ? {
        sends: localMixState.sends ?? track.sends ?? [],
        outputTargetId: localMixState.outputTargetId ?? undefined,
      }
    : undefined
  const resolvedMix = resolveTrackMixView({
    canWriteSharedMix,
    syncMix: options.client.mix.syncMix,
    current: {
      volume: track.volume,
      muted: track.muted,
      soloed: track.soloed,
    },
    local: localMixState,
    server: {
      volume: serverVolume,
      muted: serverState?.serverMuted.get(track.id),
      soloed: serverState?.serverSoloed.get(track.id),
    },
    pendingShared: {
      volume: options.client.mix.pendingSharedTrackVolumes.get(track.id),
      muted: pendingMix?.muted,
      soloed: pendingMix?.soloed,
    },
  })

  track.volume = resolvedMix.volume ?? track.volume
  track.muted = resolvedMix.muted
  track.soloed = resolvedMix.soloed

  const routingSource = localRouting ?? (canWriteSharedMix && pendingRouting
    ? pendingRouting
    : serverRouting ?? { sends: track.sends ?? [], outputTargetId: track.outputTargetId })
  const normalizedRouting = normalizeTrackRouting(track, routingSource, tracks)
  track.sends = normalizedRouting.sends
  track.outputTargetId = normalizedRouting.outputTargetId
}

export function buildServerTimelineIndex<TTrackId extends string>(data: TimelineViewLike<TTrackId>): ServerTimelineIndex<TTrackId> {
  const trackIds = new Set<TTrackId>()
  const clipIds = new Set<string>()
  const clipRowsById = new Map<string, { trackId: TTrackId; startSec: number; duration: number; leftPadSec: number; bufferOffsetSec: number; midiOffsetBeats: number }>()
  const trackLocksById = new Map<TTrackId, string | null>()

  for (const track of data.tracks) {
    const trackId = track._id
    trackIds.add(trackId)
    trackLocksById.set(trackId, typeof track.lockedBy === 'string' ? track.lockedBy : null)
  }

  for (const clip of data.clips) {
    const clipId = String(clip._id)
    clipIds.add(clipId)
    clipRowsById.set(clipId, {
      trackId: clip.trackId,
      startSec: clip.startSec,
      duration: clip.duration,
      leftPadSec: clip.leftPadSec ?? 0,
      bufferOffsetSec: clip.bufferOffsetSec ?? 0,
      midiOffsetBeats: clip.midiOffsetBeats ?? 0,
    })
  }

  return {
    trackIds,
    clipIds,
    clipRowsById,
    trackLocksById,
  }
}

export function isClipPatchReflected<TTrackId extends string>(
  patch: ClipTimelinePatch<TTrackId>,
  serverClip: ServerTimelineIndex<TTrackId>['clipRowsById'] extends Map<string, infer TValue> ? TValue : never,
): boolean {
  if (patch.trackId !== undefined && patch.trackId !== serverClip.trackId) return false
  if (patch.startSec !== undefined && !nearlyEqual(patch.startSec, serverClip.startSec)) return false
  if (patch.duration !== undefined && !nearlyEqual(patch.duration, serverClip.duration)) return false
  if (patch.leftPadSec !== undefined && !nearlyEqual(patch.leftPadSec, serverClip.leftPadSec)) return false
  if (patch.bufferOffsetSec !== undefined && !nearlyEqual(patch.bufferOffsetSec, serverClip.bufferOffsetSec)) return false
  if (patch.midiOffsetBeats !== undefined && !nearlyEqual(patch.midiOffsetBeats, serverClip.midiOffsetBeats)) return false
  return true
}

export function resolveTimelineTracks(options: ResolveTimelineTracksOptions): Track[] {
  const projectedTracks: Track[] = []
  const projectedTrackIds = new Set<Track['id']>()
  const localSnapshot = options.server.localSnapshot
  const serverTracks = localSnapshot
    ? localSnapshot.tracks.map((track) => ({
        ...track,
        _id: track.id,
        lockedBy: null,
      }))
    : options.server.data?.tracks ?? []
  const serverClips = localSnapshot
    ? localSnapshot.clips.map((clip) => ({
        ...clip,
        _id: clip.id,
      }))
    : options.server.data?.clips ?? []

  for (let index = 0; index < serverTracks.length; index++) {
    const trackRow = serverTracks[index]
    const trackId = trackRow._id
    if (options.client.tracks.removedIds.has(trackId)) continue

    const localTrackRow = localSnapshot ? localSnapshot.tracks[index] : undefined
    const historyRef = options.client.tracks.historyRefsById.get(trackId) ?? localTrackRow?.historyRef ?? trackId
    const serverVolume = options.server.trackState?.serverVolumes.get(trackId)

    projectedTracks.push({
      id: trackId,
      historyRef,
      name: resolveTrackName({
        historyRef,
        explicitName: localTrackRow?.name,
        fallbackIndex: index + 1,
        namesByHistoryRef: options.client.tracks.namesByHistoryRef,
      }),
      volume: serverVolume ?? localTrackRow?.volume ?? 0.8,
      clips: [],
      muted: typeof trackRow.muted === 'boolean' ? trackRow.muted : false,
      soloed: typeof trackRow.soloed === 'boolean' ? trackRow.soloed : false,
      lockedBy: typeof trackRow.lockedBy === 'string' ? trackRow.lockedBy : null,
      kind: normalizeTrackKind(trackRow.kind) ?? 'audio',
      channelRole: normalizeChannelRole(trackRow.channelRole) ?? 'track',
      sends: localTrackRow?.sends ?? [],
      outputTargetId: localTrackRow?.outputTargetId,
    })
    projectedTrackIds.add(trackId)
  }

  const pendingTrackEntries = Array.from(options.client.tracks.pendingEntriesById.values())
    .filter((entry) => !options.client.tracks.removedIds.has(entry.track.id))
    .sort((left, right) => left.index - right.index)

  for (const entry of pendingTrackEntries) {
    if (projectedTrackIds.has(entry.track.id)) continue
    const insertIndex = Math.max(0, Math.min(projectedTracks.length, entry.index))
    const clonedTrack = cloneTrack(entry.track)
    const historyRef = clonedTrack.historyRef ?? clonedTrack.id
    clonedTrack.historyRef = historyRef
    clonedTrack.name = resolveTrackName({
      historyRef,
      explicitName: clonedTrack.name,
      fallbackIndex: insertIndex + 1,
      namesByHistoryRef: options.client.tracks.namesByHistoryRef,
    })
    projectedTracks.splice(insertIndex, 0, clonedTrack)
    projectedTrackIds.add(clonedTrack.id)
  }

  const trackIndex = createTimelineTrackIndex(projectedTracks)
  const trackById = trackIndex.trackById
  const clipById = trackIndex.clipById
  const clipTrackIdById = trackIndex.clipTrackIdById

  for (const clipRow of serverClips) {
    const trackId = clipRow.trackId
    const track = trackById.get(trackId)
    const clipId = String(clipRow._id)
    if (!track || options.client.clips.removedIds.has(clipId)) continue
    const clip: Clip = {
      id: clipId,
      historyRef: options.client.clips.historyRefsById.get(clipId) ?? clipId,
      name: clipRow.name ?? 'Clip',
      buffer: options.buffers.audioBufferCache.get(clipId) ?? null,
      mediaStatus: options.buffers.clipMediaStatus.get(clipId),
      startSec: clipRow.startSec,
      duration: clipRow.duration,
      sourceAssetKey: clipRow.sourceAssetKey,
      waveformAssetKey: getWaveformAssetKey(options.projectId, clipRow.sourceAssetKey),
      sourceKind: normalizeSourceKind(clipRow.sourceKind),
      sourceDurationSec: clipRow.sourceDurationSec,
      sourceSampleRate: clipRow.sourceSampleRate,
      sourceChannelCount: clipRow.sourceChannelCount,
      leftPadSec: clipRow.leftPadSec ?? 0,
      bufferOffsetSec: clipRow.bufferOffsetSec ?? 0,
      color: '#22c55e',
      sampleUrl: clipRow.sampleUrl,
      midi: normalizeMidi(clipRow.midi),
      midiOffsetBeats: clipRow.midiOffsetBeats ?? 0,
    }
    pushClipToTrack(track, clip)
    clipById.set(clip.id, clip)
    clipTrackIdById.set(clip.id, trackId)
  }

  for (const [clipId, pending] of options.client.clips.pendingCreatesById) {
    if (options.client.clips.removedIds.has(clipId) || clipById.has(clipId)) continue
    const track = trackById.get(pending.trackId)
    if (!track) continue
    const clip = attachClipBuffer(cloneClip(pending.clip), options.projectId, options.buffers.audioBufferCache, options.buffers.clipMediaStatus)
    pushClipToTrack(track, clip)
    clipById.set(clipId, clip)
    clipTrackIdById.set(clipId, pending.trackId)
  }

  const applyClipEdits = (edits: Map<string, ClipTimelinePatch>) => {
    const replacementsByTrack = new Map<Track, Map<string, Clip>>()
    for (const [clipId, patch] of edits) {
      const currentTrackId = clipTrackIdById.get(clipId)
      const currentTrack = currentTrackId ? trackById.get(currentTrackId) : undefined
      const currentClip = clipById.get(clipId)
      if (!currentClip) continue
      const nextTrackId = patch.trackId ?? currentTrackId
      const nextTrack = nextTrackId ? trackById.get(nextTrackId) : undefined
      if (!nextTrack || !currentTrackId || !currentTrack) continue
      const resolvedNextTrackId = nextTrack.id
      const nextClip = attachClipBuffer(applyClipPatch(currentClip, patch), options.projectId, options.buffers.audioBufferCache, options.buffers.clipMediaStatus)
      if (resolvedNextTrackId !== currentTrackId) {
        removeClipFromTrack(currentTrack, clipId)
        pushClipToTrack(nextTrack, nextClip)
        clipTrackIdById.set(clipId, resolvedNextTrackId)
      } else {
        const replacements = replacementsByTrack.get(currentTrack) ?? new Map<string, Clip>()
        replacements.set(clipId, nextClip)
        replacementsByTrack.set(currentTrack, replacements)
      }
      clipById.set(clipId, nextClip)
    }
    for (const [track, replacements] of replacementsByTrack) {
      track.clips = track.clips.map((clip) => replacements.get(clip.id) ?? clip)
    }
  }

  applyClipEdits(options.client.clips.committedEditsById)
  applyClipEdits(options.client.clips.draftEditsById)

  for (const [trackId, clips] of options.client.clips.previewByTrackId) {
    const track = trackById.get(trackId)
    if (!track) continue
    for (const clip of clips) {
      pushClipToTrack(track, attachClipBuffer(cloneClip(clip), options.projectId, options.buffers.audioBufferCache, options.buffers.clipMediaStatus))
    }
  }

  for (const track of projectedTracks) {
    if (options.client.tracks.pendingLocksById.has(track.id)) {
      track.lockedBy = options.client.tracks.pendingLocksById.get(track.id) ?? null
    }
    applyTrackMix(track, options, projectedTracks)
    track.clips = track.clips
      .filter((clip) => !options.client.clips.removedIds.has(clip.id))
      .map((clip) => attachClipBuffer(clip, options.projectId, options.buffers.audioBufferCache, options.buffers.clipMediaStatus))
      .map((clip) => withWaveformAssetKey(clip, options.projectId))
    sortTrackClips(track)
  }

  return projectedTracks
}
