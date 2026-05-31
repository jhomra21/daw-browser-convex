import type { z } from 'zod'
import type { ConvexHttpClient } from 'convex/browser'
import { api as generatedConvexApi } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import {
  AddMidiClipCommandSchema,
  AddSampleClipsCommandSchema,
  CopyClipsCommandSchema,
  CreateTrackCommandSchema,
  DeleteTrackCommandSchema,
  MoveClipCommandSchema,
  MoveClipsCommandSchema,
  RemoveClipCommandSchema,
  RemoveManyCommandSchema,
  SetEqParamsCommandSchema,
  SetArpeggiatorParamsCommandSchema,
  SetMuteCommandSchema,
  SetReverbParamsCommandSchema,
  SetSoloCommandSchema,
  SetSynthParamsCommandSchema,
  SetTimingCommandSchema,
  SetTrackRoutingCommandSchema,
  SetTrackVolumeCommandSchema,
} from '../src/lib/agent-commands'
import { buildClipCreatePayload } from '../src/lib/clip-create'
import { getPersistableAudioSourceMetadata } from '../src/lib/audio-source'
import { sanitizeAudioSourceKind } from '../src/lib/audio-source-rules'
import { normalizeSynthParams } from '../src/lib/effects/params'
import type { Clip, Track } from '../src/types/timeline'
import { getClipKindFromClip, getClipTargetError } from './clip-targets'
import { listSortedClipsForTrack, resolveTrackClip, selectTrackClips, trackAtIndex as trackAtIndexImpl } from './indexing'
import { resolveAgentMixTargetIndices } from '../src/lib/agent-command-targets'

type CreateTrackInput = z.infer<typeof CreateTrackCommandSchema>
type SetTrackRoutingInput = z.infer<typeof SetTrackRoutingCommandSchema>
type SetTrackVolumeInput = z.infer<typeof SetTrackVolumeCommandSchema>
type AddMidiClipInput = z.infer<typeof AddMidiClipCommandSchema>
type SetEqParamsInput = z.infer<typeof SetEqParamsCommandSchema>
type SetReverbParamsInput = z.infer<typeof SetReverbParamsCommandSchema>
type SetSynthParamsInput = z.infer<typeof SetSynthParamsCommandSchema>
type DeleteTrackInput = z.infer<typeof DeleteTrackCommandSchema>
type MoveClipInput = z.infer<typeof MoveClipCommandSchema>
type RemoveClipInput = z.infer<typeof RemoveClipCommandSchema>
type SetArpeggiatorParamsInput = z.infer<typeof SetArpeggiatorParamsCommandSchema>
type SetTimingInput = z.infer<typeof SetTimingCommandSchema>
type RemoveManyInput = z.infer<typeof RemoveManyCommandSchema>
type MoveClipsInput = z.infer<typeof MoveClipsCommandSchema>
type CopyClipsInput = z.infer<typeof CopyClipsCommandSchema>
type SetMuteInput = z.infer<typeof SetMuteCommandSchema>
type SetSoloInput = z.infer<typeof SetSoloCommandSchema>
type AddSampleClipsInput = z.infer<typeof AddSampleClipsCommandSchema>

type TrackDoc = {
  _id: Id<'tracks'>
  kind?: string
  channelRole?: string
}

type SampleDoc = {
  _id: string
  name?: string
  url?: string
  duration?: number
  assetKey?: string
  sourceKind?: string
  sampleRate?: number
  channelCount?: number
}

type ConvexClientLike = {
  query: ConvexHttpClient['query']
  mutation: ConvexHttpClient['mutation']
}

type ConvexApi = typeof generatedConvexApi
type AgentEffectParams =
  | { enabled: boolean; bands: SetEqParamsInput['bands'] }
  | {
    enabled: boolean
    wet: number
    decaySec: number
    preDelayMs: number
  }

type AgentActionContext = {
  convex: ConvexClientLike
  convexApi: ConvexApi
  projectId: string
  userId: string
  getTracks: () => Promise<TrackDoc[]>
  refreshTracks: () => Promise<TrackDoc[]>
}

const SAMPLE_QUERY_STOP_WORDS = new Set(['sample', 'samples', 'the', 'a', 'some', 'beat', 'pattern', 'with', 'using', 'in', 'on', 'of'])

function normalizeText(value: string | undefined) {
  return (value || '').trim().toLowerCase()
}

function scoreSampleMatch(query: string, sample: SampleDoc) {
  const tokens = query
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token && !SAMPLE_QUERY_STOP_WORDS.has(token))
  const haystack = `${normalizeText(sample.name)} ${normalizeText(sample.url)}`
  if (tokens.length === 0) return haystack.includes(query) ? 1 : 0
  let score = 0
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1
  }
  return score
}

function pickMatchingSample(query: string, samples: SampleDoc[]) {
  let best: SampleDoc | null = null
  let bestScore = -1
  for (const sample of samples) {
    const score = scoreSampleMatch(query, sample)
    if (score > bestScore) {
      best = sample
      bestScore = score
    }
  }
  return bestScore > 0 ? best : null
}

function normalizeClipMidi(midi: {
  wave: string
  gain?: number
  notes: NonNullable<Clip['midi']>['notes']
} | undefined): Clip['midi'] | undefined {
  if (!midi) return undefined
  const wave = midi.wave === 'sine' || midi.wave === 'square' || midi.wave === 'sawtooth' || midi.wave === 'triangle'
    ? midi.wave
    : 'sawtooth'
  return {
    wave,
    gain: midi.gain,
    notes: midi.notes,
  }
}

function buildAgentSampleClipPayload(input: {
  projectId: string
  userId: string
  trackId: Track['id']
  startSec: number
  duration: number
  sample: SampleDoc
}) {
  const source = getPersistableAudioSourceMetadata({
    sourceDurationSec: input.sample.duration,
    sourceSampleRate: input.sample.sampleRate,
    sourceChannelCount: input.sample.channelCount,
  })

  return buildClipCreatePayload({
    projectId: input.projectId,
    userId: input.userId,
    trackId: input.trackId,
    clip: {
      startSec: input.startSec,
      duration: input.duration,
      name: input.sample.name ?? 'Sample',
      sampleUrl: input.sample.url,
      source,
      sourceAssetKey: input.sample.assetKey,
      sourceKind: sanitizeAudioSourceKind(input.sample.sourceKind),
    },
  })
}

export function createAgentActions(context: AgentActionContext) {
  const trackAtIndex = async (value: number | undefined) => trackAtIndexImpl(await context.getTracks(), value)

  const trackIndices = async (
    input: { trackIndex?: number; trackIndices?: number[] },
    fallback: 'last-track' | 'all-tracks' | 'none',
  ) => {
    const trackList = await context.getTracks()
    return resolveAgentMixTargetIndices({
      trackCount: trackList.length,
      trackIndex: input.trackIndex,
      trackIndices: input.trackIndices,
      fallback,
    })
  }


  const mutateEffectTarget = async (input: {
    target: number | 'master'
    params: AgentEffectParams
  }) => {
    if (input.target === 'master') {
      if ('bands' in input.params) {
        await context.convex.mutation(context.convexApi.effects.setMasterEqParams, {
          projectId: context.projectId,
          userId: context.userId,
          params: input.params,
        })
      } else {
        await context.convex.mutation(context.convexApi.effects.setMasterReverbParams, {
          projectId: context.projectId,
          userId: context.userId,
          params: input.params,
        })
      }
      return { ok: true } as const
    }

    const track = await trackAtIndex(input.target)
    if (!track) return { error: `No track at index ${input.target}` } as const
    const result = 'bands' in input.params
      ? await context.convex.mutation(context.convexApi.effects.setEqParams, {
          projectId: context.projectId,
          trackId: track._id,
          userId: context.userId,
          params: input.params,
        })
      : await context.convex.mutation(context.convexApi.effects.setReverbParams, {
          projectId: context.projectId,
          trackId: track._id,
          userId: context.userId,
          params: input.params,
        })
    return result ? { ok: true } as const : { error: 'Effect update did not apply' } as const
  }

  const setTrackMixFlag = async (input: {
    trackList: TrackDoc[]
    indices: number[]
    key: 'muted' | 'soloed'
    value: boolean
    skipIndex?: number
  }) => {
    const appliedIndices: number[] = []
    for (const index of input.indices) {
      if (typeof input.skipIndex === 'number' && index === input.skipIndex) continue
      const track = input.trackList[index]
      if (!track) continue
      const result = await context.convex.mutation(context.convexApi.tracks.setMix, {
        trackId: track._id,
        [input.key]: input.value,
        userId: context.userId,
      })
      if (result?.status === 'applied') {
        appliedIndices.push(index)
      }
    }
    return {
      updated: appliedIndices.length,
      appliedIndices,
    }
  }
  const toTrackRoutingPayload = async (input: SetTrackRoutingInput) => {
    const trackList = await context.getTracks()
    const track = trackAtIndexImpl(trackList, input.trackIndex)
    if (!track) return { error: `No track at index ${input.trackIndex}` } as const

    const hasOutputTrackIndex = Object.prototype.hasOwnProperty.call(input, 'outputTrackIndex')
    const outputTrack = input.outputTrackIndex == null ? null : trackAtIndexImpl(trackList, input.outputTrackIndex)
    if (hasOutputTrackIndex && input.outputTrackIndex != null && !outputTrack) {
      return { error: `No track at index ${input.outputTrackIndex}` } as const
    }

    const sends = Array.isArray(input.sends)
      ? (() => {
          const resolved = []
          for (const send of input.sends) {
            const targetTrack = trackAtIndexImpl(trackList, send.targetTrackIndex)
            if (!targetTrack) {
              return { error: 'No track at index ' + send.targetTrackIndex } as const
            }
            resolved.push({ targetId: targetTrack._id, amount: Number(send.amount ?? 0) })
          }
          return resolved
        })()
      : undefined
    if (sends && 'error' in sends) return sends

    return {
      track,
      payload: {
        trackId: track._id,
        userId: context.userId,
        outputTargetId: hasOutputTrackIndex ? (outputTrack?._id ?? null) : undefined,
        sends,
      },
    } as const
  }

  const listRoomClips = async () => await context.convex.query(context.convexApi.clips.listByRoom, {
    projectId: context.projectId,
    userId: context.userId,
  })

  const listOwnedClipIds = async () => {
    return new Set<string>((await context.convex.query(context.convexApi.ownerships.listOwnedClipIds, {
      projectId: context.projectId,
      ownerUserId: context.userId,
    }) as Array<Id<'clips'>>).map((clipId) => String(clipId)))
  }

  const listOwnedRoomClips = async () => {
    const [allClips, ownedClipIds] = await Promise.all([listRoomClips(), listOwnedClipIds()])
    return allClips.filter((clip) => ownedClipIds.has(String(clip._id)))
  }

  const isOwnedClip = (ownedClipIds: ReadonlySet<string>, clipId: unknown) => {
    return ownedClipIds.has(String(clipId))
  }

  const isAppliedClipMutationResult = (result: unknown) => {
    return !!result && typeof result === 'object' && 'status' in result && result.status === 'applied'
  }

  const resolveSourceClip = async (input: {
    trackIndex: number
    clipIndex?: number
    clipAtOrAfterSec?: number
  }) => {
    const track = await trackAtIndex(input.trackIndex)
    if (!track) return { error: `No track at index ${input.trackIndex}` } as const
    const allClips = await listRoomClips()
    const clipsOnTrack = listSortedClipsForTrack(allClips, track._id)
    const clip = resolveTrackClip(clipsOnTrack, input)
    if (!clip) return { error: 'Clip not found' } as const
    return { track, clip, allClips, clipsOnTrack } as const
  }

  const resolveOwnedSourceClip = async (input: {
    trackIndex: number
    clipIndex?: number
    clipAtOrAfterSec?: number
  }) => {
    const [resolved, ownedClipIds] = await Promise.all([
      resolveSourceClip(input),
      listOwnedClipIds(),
    ])
    if ('error' in resolved) return resolved
    if (!isOwnedClip(ownedClipIds, resolved.clip._id)) {
      return { error: 'Clip is not writable by the current user' } as const
    }
    return resolved
  }

  const resolveSourceClipSelection = async (input: {
    fromTrackIndex: number
    toTrackIndex?: number
    clipIndices?: number[]
    rangeStartSec?: number
    rangeEndSec?: number
    clipAtOrAfterSec?: number
    count?: number
  }) => {
    const trackList = await context.getTracks()
    const fromTrack = trackAtIndexImpl(trackList, input.fromTrackIndex)
    if (!fromTrack) return { error: 'Source track not found' } as const

    const explicitTo = trackAtIndexImpl(trackList, input.toTrackIndex)
    const fallbackTo = input.toTrackIndex == null && trackList.length > 0
      ? trackList[trackList.length - 1]
      : undefined
    const toTrack = explicitTo ?? fallbackTo

    const allClips = await listRoomClips()
    const sourceClips = listSortedClipsForTrack(allClips, fromTrack._id)
    const selectedClips = selectTrackClips(sourceClips, {
      clipIndices: input.clipIndices,
      rangeStartSec: input.rangeStartSec,
      rangeEndSec: input.rangeEndSec,
      clipAtOrAfterSec: input.clipAtOrAfterSec,
      count: input.count,
    })
    if (selectedClips.length === 0) return { error: 'No clips selected' } as const

    return { fromTrack, toTrack, selectedClips } as const
  }

  const resolveOwnedSourceClipSelection = async (input: {
    fromTrackIndex: number
    toTrackIndex?: number
    clipIndices?: number[]
    rangeStartSec?: number
    rangeEndSec?: number
    clipAtOrAfterSec?: number
    count?: number
  }) => {
    const [resolved, ownedClipIds] = await Promise.all([
      resolveSourceClipSelection(input),
      listOwnedClipIds(),
    ])
    if (!('selectedClips' in resolved)) return resolved
    const selectedClips = resolved.selectedClips ?? []
    const writableSelectedClips = selectedClips.filter((clip) => isOwnedClip(ownedClipIds, clip._id))
    return {
      ...resolved,
      selectedClips,
      writableSelectedClips,
      skippedByOwnership: selectedClips.length - writableSelectedClips.length,
    } as const
  }

  return {
    async createTrack(input: Omit<CreateTrackInput, 'type'>) {
      const trackId = await context.convex.mutation(context.convexApi.tracks.create, {
        projectId: context.projectId,
        userId: context.userId,
        kind: input.kind,
        channelRole: input.channelRole,
      })
      await context.refreshTracks()
      return { trackId }
    },

    async setTrackRouting(input: Omit<SetTrackRoutingInput, 'type'>) {
      const resolved = await toTrackRoutingPayload({ type: 'setTrackRouting', ...input })
      if ('error' in resolved) return resolved
      await context.convex.mutation(context.convexApi.tracks.setRouting, resolved.payload)
      return { ok: true }
    },

    async setTrackVolume(input: Omit<SetTrackVolumeInput, 'type'>) {
      const trackList = await context.getTracks()
      const fallbackIndex = input.trackIndex == null && trackList.length > 0
        ? trackList.length - 1
        : undefined
      const track = trackAtIndexImpl(trackList, input.trackIndex)
        ?? (typeof fallbackIndex === 'number' ? trackList[fallbackIndex] : undefined)
      if (!track) return { error: 'Track not found' }
      await context.convex.mutation(context.convexApi.tracks.setVolume, {
        trackId: track._id,
        volume: input.volume,
        userId: context.userId,
      })
      return { ok: true }
    },

    async addMidiClip(input: Omit<AddMidiClipInput, 'type'>) {
      const track = await trackAtIndex(input.trackIndex)
      if (!track) return { error: `No track at index ${input.trackIndex}` }
      const targetError = getClipTargetError(track, 'midi')
      if (targetError) return { error: targetError }
      const clipId = await context.convex.mutation(context.convexApi.clips.create, {
        projectId: context.projectId,
        trackId: track._id,
        startSec: input.startSec,
        duration: input.duration,
        userId: context.userId,
        name: 'MIDI Clip',
        clipKind: 'midi',
        midi: {
          wave: input.wave ?? 'sawtooth',
          gain: input.gain,
          notes: input.notes ?? [],
        },
      })
      return clipId ? { clipId } : { error: 'Failed to create clip' }
    },

    async setEqParams(input: Omit<SetEqParamsInput, 'type'>) {
      const params = { enabled: !!input.enabled, bands: Array.isArray(input.bands) ? input.bands : [] }
      return mutateEffectTarget({
        target: input.target,
        params,
      })
    },

    async setReverbParams(input: Omit<SetReverbParamsInput, 'type'>) {
      const params = {
        enabled: !!input.enabled,
        wet: Number(input.wet ?? 0.5),
        decaySec: Number(input.decaySec ?? 1.5),
        preDelayMs: Number(input.preDelayMs ?? 0),
      }
      return mutateEffectTarget({
        target: input.target,
        params,
      })
    },

    async setSynthParams(input: Omit<SetSynthParamsInput, 'type'>) {
      const track = await trackAtIndex(input.trackIndex)
      if (!track) return { error: `No track at index ${input.trackIndex}` }
      if ((track.kind ?? 'audio') !== 'instrument') return { error: 'Target track is not an instrument track' }
      const { trackIndex, ...updates } = input
      const row = await context.convex.query(context.convexApi.effects.getSynthForTrack, {
        projectId: context.projectId,
        userId: context.userId,
        trackId: track._id,
      })
      const params = normalizeSynthParams({
        ...normalizeSynthParams(row?.params ?? {}),
        ...updates,
      })
      const result = await context.convex.mutation(context.convexApi.effects.setSynthParams, {
        projectId: context.projectId,
        trackId: track._id,
        userId: context.userId,
        params,
      })
      return result ? { ok: true } : { error: 'Effect update did not apply' }
    },

    async deleteTrack(input: Omit<DeleteTrackInput, 'type'>) {
      const track = await trackAtIndex(input.trackIndex)
      if (!track) return { error: 'Track not found' }
      const result = await context.convex.mutation(context.convexApi.tracks.remove, {
        trackId: track._id,
        userId: context.userId,
      })
      if (result?.status === 'deleted') {
        await context.refreshTracks()
        return { ok: true }
      }
      if (result?.status === 'conflict') {
        return { error: `Track delete blocked: ${String(result.reason)}` }
      }
      return { error: 'Not owner or failed to delete' }
    },

    async moveClip(input: Omit<MoveClipInput, 'type'>) {
      const resolved = await resolveOwnedSourceClip({
        trackIndex: input.fromTrackIndex,
        clipIndex: input.clipIndex,
        clipAtOrAfterSec: input.clipAtOrAfterSec,
      })
      if ('error' in resolved) return resolved

      const toTrack = input.toTrackIndex == null ? undefined : await trackAtIndex(input.toTrackIndex)
      if (input.toTrackIndex != null && !toTrack) return { error: `No track at index ${input.toTrackIndex}` }
      if (toTrack) {
        const targetError = getClipTargetError(toTrack, getClipKindFromClip(resolved.clip))
        if (targetError) return { error: targetError }
      }

      const result = await context.convex.mutation(context.convexApi.clips.move, {
        clipId: resolved.clip._id,
        userId: context.userId,
        startSec: input.newStartSec,
        toTrackId: toTrack?._id,
      })

      return isAppliedClipMutationResult(result)
        ? { ok: true, clipId: resolved.clip._id }
        : { error: 'Move did not apply' }
    },

    async removeClip(input: Omit<RemoveClipInput, 'type'>) {
      const resolved = await resolveOwnedSourceClip({
        trackIndex: input.trackIndex,
        clipIndex: input.clipIndex,
        clipAtOrAfterSec: input.clipAtOrAfterSec,
      })
      if ('error' in resolved) return resolved

      const result = await context.convex.mutation(context.convexApi.clips.removeMany, {
        clipIds: [resolved.clip._id],
        userId: context.userId,
      })
      const removedIds = new Set(
        Array.isArray(result?.removedClipIds)
          ? result.removedClipIds.map((clipId: unknown) => String(clipId))
          : [],
      )
      return removedIds.has(String(resolved.clip._id)) ? { ok: true } : { error: 'Not owner or failed to delete' }
    },

    async setArpeggiatorParams(input: Omit<SetArpeggiatorParamsInput, 'type'>) {
      const track = await trackAtIndex(input.trackIndex)
      if (!track) return { error: `No track at index ${input.trackIndex}` }
      if ((track.kind ?? 'audio') !== 'instrument') return { error: 'Not an instrument track' }
      const result = await context.convex.mutation(context.convexApi.effects.setArpeggiatorParams, {
        projectId: context.projectId,
        trackId: track._id,
        userId: context.userId,
        params: {
          enabled: input.enabled,
          pattern: input.pattern,
          rate: input.rate,
          octaves: input.octaves,
          gate: input.gate,
          hold: input.hold,
        },
      })
      return result ? { ok: true } : { error: 'Effect update did not apply' }
    },

    async setTiming(input: Omit<SetTimingInput, 'type'>) {
      const resolved = await resolveOwnedSourceClip({
        trackIndex: input.trackIndex,
        clipIndex: input.clipIndex,
        clipAtOrAfterSec: input.clipAtOrAfterSec,
      })
      if ('error' in resolved) return resolved

      const result = await context.convex.mutation(context.convexApi.clips.setTiming, {
        clipId: resolved.clip._id,
        userId: context.userId,
        startSec: input.startSec,
        duration: input.duration,
        leftPadSec: input.leftPadSec,
        bufferOffsetSec: input.bufferOffsetSec,
        midiOffsetBeats: input.midiOffsetBeats,
      })

      return isAppliedClipMutationResult(result) ? { ok: true } : { error: 'Timing change did not apply' }
    },

    async moveClips(input: Omit<MoveClipsInput, 'type'>) {
      const resolved = await resolveOwnedSourceClipSelection(input)
      if (!('writableSelectedClips' in resolved)) return resolved
      if (resolved.writableSelectedClips.length === 0) {
        return { error: 'No writable clips selected' }
      }

      const targetTrack = resolved.toTrack ?? resolved.fromTrack
      for (const clip of resolved.writableSelectedClips) {
        const targetError = getClipTargetError(targetTrack, getClipKindFromClip(clip))
        if (targetError) return { error: targetError }
      }

      const base = resolved.selectedClips[0]?.startSec ?? resolved.writableSelectedClips[0].startSec
      let moved = 0
      for (const clip of resolved.writableSelectedClips) {
        const requestedStart = typeof input.newStartSec === 'number'
          ? (input.keepRelativePositions !== false ? input.newStartSec + (clip.startSec - base) : input.newStartSec)
          : clip.startSec
        const result = await context.convex.mutation(context.convexApi.clips.move, {
          clipId: clip._id,
          userId: context.userId,
          startSec: requestedStart,
          toTrackId: resolved.toTrack?._id,
        })
        if (isAppliedClipMutationResult(result)) {
          moved += 1
        }
      }
      const skipped = resolved.skippedByOwnership + (resolved.writableSelectedClips.length - moved)
      if (moved === 0) return { error: 'No clips were moved' }
      if (skipped > 0) {
        return { ok: true, moved, skipped }
      }
      return { ok: true, moved }
    },

    async copyClips(input: Omit<CopyClipsInput, 'type'>) {
      const resolved = await resolveOwnedSourceClipSelection(input)
      if (!('writableSelectedClips' in resolved)) return resolved
      if (!resolved.toTrack) return { error: 'Track not found' }
      if (resolved.writableSelectedClips.length === 0) {
        return { error: 'No writable clips selected' }
      }

      const toTrack = resolved.toTrack
      for (const clip of resolved.writableSelectedClips) {
        const targetError = getClipTargetError(toTrack, getClipKindFromClip(clip))
        if (targetError) return { error: targetError }
      }

      const base = resolved.selectedClips[0]?.startSec ?? resolved.writableSelectedClips[0].startSec
      const items = resolved.writableSelectedClips.map((clip) => {
        const startSec = typeof input.startAtSec === 'number'
          ? (input.keepRelativePositions !== false ? input.startAtSec + (clip.startSec - base) : input.startAtSec)
          : clip.startSec
        return buildClipCreatePayload({
          projectId: context.projectId,
          trackId: toTrack._id,
          userId: context.userId,
          clip: {
            startSec,
            duration: clip.duration,
            name: clip.name,
            sampleUrl: clip.sampleUrl,
            source: getPersistableAudioSourceMetadata({
              sourceDurationSec: clip.sourceDurationSec,
              sourceSampleRate: clip.sourceSampleRate,
              sourceChannelCount: clip.sourceChannelCount,
            }),
            sourceAssetKey: clip.sourceAssetKey,
            sourceKind: sanitizeAudioSourceKind(clip.sourceKind),
            midi: normalizeClipMidi(clip.midi),
            timing: {
              leftPadSec: clip.leftPadSec,
              bufferOffsetSec: clip.bufferOffsetSec,
              midiOffsetBeats: clip.midiOffsetBeats,
            },
          },
        })
      })
      const ids = await context.convex.mutation(context.convexApi.clips.createMany, { items })
      const created = Array.isArray(ids) ? ids.filter(Boolean).length : 0
      const skipped = resolved.skippedByOwnership + (items.length - created)
      if (created === 0) return { error: 'No clips were copied' }
      if (skipped > 0) return { ok: true, created, skipped }
      return { ok: true, created }
    },

    async removeMany(input: Omit<RemoveManyInput, 'type'>) {
      const track = await trackAtIndex(input.trackIndex)
      if (!track) return { error: 'Track not found' }
      const clipsOnTrack = (await listOwnedRoomClips()).filter((clip) => String(clip.trackId) === String(track._id))
      const targets = clipsOnTrack.filter((clip) => clip.startSec >= input.rangeStartSec && clip.startSec < input.rangeEndSec)
      const targetIds = targets.map((clip) => clip._id)
      if (targetIds.length === 0) return { ok: true, removed: 0 }
      const result = await context.convex.mutation(context.convexApi.clips.removeMany, {
        clipIds: targetIds,
        userId: context.userId,
      })
      const removed = Array.isArray(result?.removedClipIds)
        ? result.removedClipIds.length
        : 0
      return removed > 0 ? { ok: true, removed } : { error: 'No owned clips removed' }
    },

    async setMute(input: Omit<SetMuteInput, 'type'>) {
      const trackList = await context.getTracks()
      const indices = await trackIndices(input, 'last-track')
      const result = await setTrackMixFlag({
        trackList,
        indices,
        key: 'muted',
        value: !!input.value,
      })
      if (result.updated === 0) return { error: 'No writable tracks matched' }
      return {
        ok: true,
        updated: result.updated,
        appliedTrackIndices: result.appliedIndices.map((index) => index + 1),
      }
    },

    async setSolo(input: Omit<SetSoloInput, 'type'>) {
      const trackList = await context.getTracks()
      const indices = await trackIndices(input, 'last-track')
      if (input.exclusive && input.value === true && indices.length === 1) {
        await setTrackMixFlag({
          trackList,
          indices: trackList.map((_, index) => index),
          key: 'soloed',
          value: false,
          skipIndex: indices[0],
        })
      }
      const result = await setTrackMixFlag({
        trackList,
        indices,
        key: 'soloed',
        value: !!input.value,
      })
      if (result.updated === 0) return { error: 'No writable tracks matched' }
      return {
        ok: true,
        updated: result.updated,
        appliedTrackIndices: result.appliedIndices.map((index) => index + 1),
      }
    },

    async addSampleClips(input: Omit<AddSampleClipsInput, 'type'>) {
      const query = normalizeText(input.sampleQuery)
      if (!query) return { error: 'Missing sampleQuery' }

      const samples = await context.convex.query(context.convexApi.samples.listByRoom, {
        projectId: context.projectId,
        userId: context.userId,
      }) as SampleDoc[]
      const sample = pickMatchingSample(query, samples)
      if (!sample) return { error: 'Sample not found in project' }

      const hasKnownDuration = typeof sample.duration === 'number' && Number.isFinite(sample.duration) && sample.duration > 0
      if (!hasKnownDuration) return { error: 'Sample duration unavailable' }
      const baseDuration = Number(sample.duration)

      let trackList = await context.getTracks()
      const hasExplicitTrackIndex = typeof input.trackIndex === 'number'
      let targetTrack = hasExplicitTrackIndex ? trackAtIndexImpl(trackList, input.trackIndex) : undefined
      if (hasExplicitTrackIndex && !targetTrack) {
        return { error: `No track at index ${input.trackIndex}` }
      }
      if (!targetTrack) {
        const trackId = await context.convex.mutation(context.convexApi.tracks.create, {
          projectId: context.projectId,
          userId: context.userId,
          kind: 'audio',
        })
        trackList = await context.refreshTracks()
        targetTrack = trackList.find((track) => String(track._id) === String(trackId))
      }
      if (!targetTrack) return { error: 'Target track not found' }
      const targetError = getClipTargetError(targetTrack, 'audio')
      if (targetError) return { error: targetError }

      const bpm = typeof input.bpm === 'number' ? Math.max(20, Math.min(300, Number(input.bpm))) : 120
      const beatSec = 60 / bpm
      let count = typeof input.count === 'number' ? Math.max(1, Math.floor(Number(input.count))) : undefined
      let intervalSec = typeof input.intervalSec === 'number' ? Math.max(0, Number(input.intervalSec)) : undefined

      if (!intervalSec && input.pattern) {
        switch (input.pattern) {
          case 'fourOnFloor':
            intervalSec = beatSec
            if (!count) count = 4
            break
          case 'everyBeat':
            intervalSec = beatSec
            break
          case 'everyHalf':
            intervalSec = beatSec / 2
            break
        }
      }

      if (!intervalSec) intervalSec = baseDuration
      if (!count) count = 1

      const targetTrackId = targetTrack._id
      const clipIntervalSec = intervalSec
      const startSec = typeof input.startSec === 'number' ? Math.max(0, Number(input.startSec)) : 0
      const items = Array.from({ length: count }).map((_, index) => (
        buildAgentSampleClipPayload({
          projectId: context.projectId,
          userId: context.userId,
          trackId: targetTrackId,
          startSec: startSec + index * clipIntervalSec,
          duration: baseDuration,
          sample,
        })
      ))
      const created = await context.convex.mutation(context.convexApi.clips.createMany, { items })
      const createdCount = Array.isArray(created) ? created.filter(Boolean).length : 0
      return createdCount > 0 ? { ok: true, created: createdCount } : { error: 'Failed to create sample clips' }
    },
  }
}














