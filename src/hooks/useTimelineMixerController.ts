import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import type { Accessor } from 'solid-js'

import { convexApi, convexClient } from '~/lib/convex'
import { resolveTrackMixView } from '~/lib/timeline-mix-authority'
import { createTimelineTrackIndex } from '~/lib/timeline-track-index'
import type { LocalMixPatch } from '~/lib/timeline-storage'
import { buildTrackMixMutationInput, buildTrackVolumeMutationInput } from '~/lib/track-mutation-args'
import { type PendingTrackMixState, isPendingTrackMixStateEqual, pruneMapToKeys, reuseMapIfEqual } from '~/lib/timeline-mixer-pending'
import { buildTrackBooleanHistoryEntry, buildTrackRoutingHistoryEntry, buildTrackVolumeHistoryEntry } from '~/lib/undo/builders'
import type { HistoryEntry } from '~/lib/undo/types'
import { normalizeTrackRouting } from '~/lib/track-routing'
import { buildTrackRoutingMutationInput, isTrackRoutingEqual } from '~/lib/track-routing-state'
import type { Track, TrackRouting, TrackSend } from '~/types/timeline'

type LocalTrackRouting = TrackRouting & { sends: TrackSend[] }
type PendingTrackMixField = keyof PendingTrackMixState
type PendingTrackMixWriteAt = Partial<Record<PendingTrackMixField, number>>
type ScheduledTrackWrite = { timer: number; token: number }

const readMixIssuedAt = () => typeof performance !== 'undefined' ? performance.now() : Date.now()

type UseTimelineMixerControllerOptions = {
  roomId: Accessor<string>
  userId: Accessor<string>
  syncMix: Accessor<boolean>
  tracks: Accessor<Track[]>
  localMix: {
    byTrackId: Accessor<Record<string, LocalMixPatch>>
    apply: (trackId: Track['id'], patch: LocalMixPatch) => void
    persist: (trackId: Track['id'], patch: LocalMixPatch) => void
  }
  optimisticTrackIds: Accessor<Set<Track['id']>>
  canWriteTrack: (trackId: Track['id']) => boolean
  pushHistory: (entry: HistoryEntry, mergeKey?: string, mergeWindowMs?: number) => void
  serverTrackState: Accessor<{
    serverVolumes: Map<Track['id'], number>
    serverMuted: Map<Track['id'], boolean>
    serverSoloed: Map<Track['id'], boolean>
    serverRouting: Map<Track['id'], LocalTrackRouting>
  } | null>
}

type UseTimelineMixerControllerReturn = {
  pendingSharedTrackVolumes: Accessor<Map<Track['id'], number>>
  pendingSharedTrackRouting: Accessor<Map<Track['id'], LocalTrackRouting>>
  pendingSharedTrackMix: Accessor<Map<Track['id'], PendingTrackMixState>>
  cancelTrackVolumeWrite: (trackId: Track['id']) => void
  cancelTrackRoutingWrite: (trackId: Track['id']) => void
  cancelTrackMixWrite: (trackId: Track['id']) => void
  applyTrackVolume: (trackId: Track['id'], volume: number, scope?: 'local' | 'shared') => void
  applyTrackMixState: (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    scope?: 'local' | 'shared',
  ) => void
  applyConfirmedTrackMixState: (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    issuedAt?: number,
  ) => void
  applyTrackRouting: (trackId: Track['id'], routing: LocalTrackRouting) => void
  setTrackVolume: (trackId: Track['id'], volume: number) => void
  handleToggleTrackMute: (trackId: Track['id']) => void
  handleToggleTrackSolo: (trackId: Track['id']) => void
  updateTrackSends: (trackId: Track['id'], sends: TrackSend[]) => void
  updateTrackOutputTargetId: (trackId: Track['id'], outputTargetId?: Track['id']) => void
}

export function useTimelineMixerController(
  options: UseTimelineMixerControllerOptions,
): UseTimelineMixerControllerReturn {
  const [rawPendingSharedTrackVolumes, setRawPendingSharedTrackVolumes] = createSignal<Map<Track['id'], number>>(new Map())
  const [rawPendingSharedTrackRouting, setRawPendingSharedTrackRouting] = createSignal<Map<Track['id'], LocalTrackRouting>>(new Map())
  const [rawPendingSharedTrackMix, setRawPendingSharedTrackMix] = createSignal<Map<Track['id'], PendingTrackMixState>>(new Map())
  const [rawTrackMixWriteAtById, setRawTrackMixWriteAtById] = createSignal<Map<Track['id'], PendingTrackMixWriteAt>>(new Map())
  const volumeTimers = new Map<Track['id'], ScheduledTrackWrite>()
  const routingTimers = new Map<Track['id'], ScheduledTrackWrite>()
  const mixTimers = new Map<Track['id'], ScheduledTrackWrite>()
  const trackIndex = createMemo(() => createTimelineTrackIndex(options.tracks()))
  const relevantTrackIds = createMemo(() => {
    const next = new Set(options.optimisticTrackIds())
    const serverState = options.serverTrackState()
    if (serverState) {
      for (const trackId of serverState.serverVolumes.keys()) {
        next.add(trackId)
      }
    }
    return next
  })
  const getTrack = (trackId: Track['id']) => trackIndex().trackById.get(trackId)

  const getTrackRoutingSnapshot = (trackId: Track['id']): LocalTrackRouting => {
    const pendingRouting = rawPendingSharedTrackRouting().get(trackId)
    if (pendingRouting) return pendingRouting
    const track = getTrack(trackId)
    return {
      sends: track?.sends ?? [],
      outputTargetId: track?.outputTargetId,
    }
  }

  const resolveTrackMixSnapshot = (trackId: Track['id']) => {
    const track = getTrack(trackId)
    const localMix = options.localMix.byTrackId()[trackId]
    const pendingMix = rawPendingSharedTrackMix().get(trackId)
    const serverState = options.serverTrackState()
    return resolveTrackMixView({
      canWriteSharedMix: options.canWriteTrack(trackId),
      syncMix: options.syncMix(),
      current: {
        volume: track?.volume,
        muted: track?.muted,
        soloed: track?.soloed,
      },
      local: localMix,
      server: {
        volume: serverState?.serverVolumes.get(trackId),
        muted: serverState?.serverMuted.get(trackId),
        soloed: serverState?.serverSoloed.get(trackId),
      },
      pendingShared: {
        volume: rawPendingSharedTrackVolumes().get(trackId),
        muted: pendingMix?.muted,
        soloed: pendingMix?.soloed,
      },
    })
  }

  const getTrackVolumeSnapshot = (trackId: Track['id']) => {
    return resolveTrackMixSnapshot(trackId).volume
  }

  const getTrackMixSnapshot = (trackId: Track['id']) => {
    const resolvedMix = resolveTrackMixSnapshot(trackId)
    return {
      muted: resolvedMix.muted,
      soloed: resolvedMix.soloed,
    }
  }

  const clearTimers = (timers: Map<Track['id'], ScheduledTrackWrite>) => {
    for (const timer of timers.values()) {
      clearTimeout(timer.timer)
    }
    timers.clear()
  }

  const clearScheduledWrite = (timers: Map<Track['id'], ScheduledTrackWrite>, trackId: Track['id']) => {
    const timer = timers.get(trackId)
    if (!timer) return
    clearTimeout(timer.timer)
    timers.delete(trackId)
  }

  const updatePendingTrackMix = (
    trackId: Track['id'],
    update: (current: PendingTrackMixState | undefined) => PendingTrackMixState | null,
  ) => {
    setRawPendingSharedTrackMix((current) => {
      const nextValue = update(current.get(trackId))
      if (nextValue) {
        const previous = current.get(trackId)
        if (previous?.muted === nextValue.muted && previous?.soloed === nextValue.soloed) {
          return current
        }
        const next = new Map(current)
        next.set(trackId, nextValue)
        return next
      }
      if (!current.has(trackId)) return current
      const next = new Map(current)
      next.delete(trackId)
      return next
    })
  }

  const clearPendingTrackMixField = (
    trackId: Track['id'],
    field: PendingTrackMixField,
    expectedValue: boolean,
  ) => {
    updatePendingTrackMix(trackId, (current) => {
      if (!current || current[field] !== expectedValue) return current ?? null
      const next: PendingTrackMixState = {}
      if (field !== 'muted' && current.muted !== undefined) next.muted = current.muted
      if (field !== 'soloed' && current.soloed !== undefined) next.soloed = current.soloed
      return next.muted !== undefined || next.soloed !== undefined ? next : null
    })
  }

  const markTrackMixWriteAt = (
    trackId: Track['id'],
    patch: Partial<Record<PendingTrackMixField, boolean>>,
    issuedAt = readMixIssuedAt(),
  ) => {
    if (patch.muted === undefined && patch.soloed === undefined) return
    setRawTrackMixWriteAtById((current) => {
      const previous = current.get(trackId)
      const nextValue: PendingTrackMixWriteAt = {
        ...(previous?.muted !== undefined ? { muted: previous.muted } : {}),
        ...(previous?.soloed !== undefined ? { soloed: previous.soloed } : {}),
        ...(patch.muted !== undefined ? { muted: issuedAt } : {}),
        ...(patch.soloed !== undefined ? { soloed: issuedAt } : {}),
      }
      if (previous?.muted === nextValue.muted && previous?.soloed === nextValue.soloed) {
        return current
      }
      const next = new Map(current)
      next.set(trackId, nextValue)
      return next
    })
  }

  const clearTrackMixWriteAt = (
    trackId: Track['id'],
    fields: Partial<Record<PendingTrackMixField, boolean>>,
  ) => {
    if (fields.muted === undefined && fields.soloed === undefined) return
    setRawTrackMixWriteAtById((current) => {
      const previous = current.get(trackId)
      if (!previous) return current
      const nextValue: PendingTrackMixWriteAt = {
        ...(fields.muted === undefined && previous.muted !== undefined ? { muted: previous.muted } : {}),
        ...(fields.soloed === undefined && previous.soloed !== undefined ? { soloed: previous.soloed } : {}),
      }
      if (previous.muted === nextValue.muted && previous.soloed === nextValue.soloed) {
        return current
      }
      const next = new Map(current)
      if (nextValue.muted === undefined && nextValue.soloed === undefined) {
        next.delete(trackId)
      } else {
        next.set(trackId, nextValue)
      }
      return next
    })
  }

  function scheduleTrackWrite(
    timers: Map<Track['id'], ScheduledTrackWrite>,
    trackId: Track['id'],
    write: () => Promise<unknown>,
  ) {
    const previous = timers.get(trackId)
    if (previous) clearTimeout(previous.timer)
    const token = (previous?.token ?? 0) + 1
    // Coalesce fast slider/toggle updates into one shared write and clear the
    // timer map whenever the room changes or the controller unmounts.
    const timer = window.setTimeout(() => {
      void write().finally(() => {
        const current = timers.get(trackId)
        if (current?.token === token) {
          timers.delete(trackId)
        }
      })
    }, 150)
    timers.set(trackId, { timer, token })
  }

  const applyTrackRouting = (trackId: Track['id'], next: LocalTrackRouting) => {
    clearScheduledWrite(routingTimers, trackId)
    const track = getTrack(trackId)
    if (!track) return
    const normalized = normalizeTrackRouting(track, next, options.tracks())
    const previous = rawPendingSharedTrackRouting().get(trackId)
    if (previous && isTrackRoutingEqual(previous, normalized)) return

    setRawPendingSharedTrackRouting((current) => {
      if (isTrackRoutingEqual(current.get(trackId) ?? { sends: [], outputTargetId: undefined }, normalized)) {
        return current
      }
      const nextRouting = new Map(current)
      nextRouting.set(trackId, normalized)
      return nextRouting
    })
  }

  const persistTrackRouting = (trackId: Track['id'], routing: LocalTrackRouting) => {
    const userId = options.userId()
    if (!userId) return
    scheduleTrackWrite(routingTimers, trackId, () =>
      convexClient.mutation(
        convexApi.tracks.setRouting,
        buildTrackRoutingMutationInput({ trackId, userId, routing }),
      ).catch(() => {
        setRawPendingSharedTrackRouting((current) => {
          const pending = current.get(trackId)
          if (!pending || !isTrackRoutingEqual(pending, routing)) return current
          const nextRouting = new Map(current)
          nextRouting.delete(trackId)
          return nextRouting
        })
      }),
    )
  }

  const setTrackRouting = (trackId: Track['id'], next: LocalTrackRouting) => {
    const roomId = options.roomId()
    const track = getTrack(trackId)
    if (!track || !options.canWriteTrack(trackId)) return

    const previous = getTrackRoutingSnapshot(trackId)
    const normalized = normalizeTrackRouting(track, next, options.tracks())
    if (isTrackRoutingEqual(previous, normalized)) return

    applyTrackRouting(trackId, normalized)
    persistTrackRouting(trackId, normalized)

    if (!roomId) return
    options.pushHistory(
      buildTrackRoutingHistoryEntry({
        roomId,
        track,
        tracks: options.tracks(),
        from: previous,
        to: normalized,
      }),
      `track:routing:${trackId}`,
      400,
    )
  }

  const updateTrackSends = (trackId: Track['id'], sends: TrackSend[]) => {
    const current = getTrackRoutingSnapshot(trackId)
    setTrackRouting(trackId, { ...current, sends })
  }

  const updateTrackOutputTargetId = (trackId: Track['id'], outputTargetId?: Track['id']) => {
    const current = getTrackRoutingSnapshot(trackId)
    setTrackRouting(trackId, { ...current, outputTargetId })
  }

  const applyTrackVolume = (
    trackId: Track['id'],
    volume: number,
    scope: 'local' | 'shared' = options.canWriteTrack(trackId) ? 'shared' : 'local',
  ) => {
    clearScheduledWrite(volumeTimers, trackId)
    if (scope === 'local') {
      options.localMix.apply(trackId, { volume })
      return
    }

    setRawPendingSharedTrackVolumes((current) => {
      if (current.get(trackId) === volume) return current
      const next = new Map(current)
      next.set(trackId, volume)
      return next
    })
  }

  const persistTrackVolume = (trackId: Track['id'], volume: number) => {
    const userId = options.userId()
    if (!userId) return
    scheduleTrackWrite(volumeTimers, trackId, () =>
      convexClient.mutation(convexApi.tracks.setVolume, buildTrackVolumeMutationInput({ trackId, volume, userId })).catch(() => {
        setRawPendingSharedTrackVolumes((current) => {
          if (current.get(trackId) !== volume) return current
          const next = new Map(current)
          next.delete(trackId)
          return next
        })
      }),
    )
  }

  const setTrackVolume = (trackId: Track['id'], volume: number) => {
    const roomId = options.roomId()
    const track = getTrack(trackId)
    const canWriteSharedMix = options.canWriteTrack(trackId)
    const previousVolume = getTrackVolumeSnapshot(trackId) ?? volume
    if (roomId && track) {
      options.pushHistory(
        buildTrackVolumeHistoryEntry({
          roomId,
          track,
          scope: canWriteSharedMix ? 'shared' : 'local',
          from: previousVolume,
          to: volume,
        }),
        `track:vol:${trackId}`,
        600,
      )
    }

    applyTrackVolume(trackId, volume, canWriteSharedMix ? 'shared' : 'local')
    if (!canWriteSharedMix) {
      options.localMix.persist(trackId, { volume })
      return
    }
    persistTrackVolume(trackId, volume)
  }

  const applyTrackMixState = (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    scope: 'local' | 'shared' = options.canWriteTrack(trackId) ? 'shared' : 'local',
  ) => {
    clearScheduledWrite(mixTimers, trackId)
    const currentMix = getTrackMixSnapshot(trackId)
    const nextMuted = patch.muted ?? currentMix.muted
    const nextSoloed = patch.soloed ?? currentMix.soloed
    if (scope === 'local') {
      options.localMix.apply(trackId, {
        ...(patch.muted !== undefined ? { muted: nextMuted } : {}),
        ...(patch.soloed !== undefined ? { soloed: nextSoloed } : {}),
      })
      return
    }
    markTrackMixWriteAt(trackId, {
      ...(patch.muted !== undefined ? { muted: true } : {}),
      ...(patch.soloed !== undefined ? { soloed: true } : {}),
    })
    updatePendingTrackMix(trackId, (current) => ({
      ...current,
      ...(patch.muted !== undefined ? { muted: nextMuted } : {}),
      ...(patch.soloed !== undefined ? { soloed: nextSoloed } : {}),
    }))
  }

  const persistTrackMixState = (trackId: Track['id']) => {
    const userId = options.userId()
    if (!userId) return
    scheduleTrackWrite(mixTimers, trackId, () =>
      (() => {
        const pendingMix = rawPendingSharedTrackMix().get(trackId)
        const muted = pendingMix?.muted
        const soloed = pendingMix?.soloed
        if (muted === undefined && soloed === undefined) {
          return Promise.resolve()
        }
        return convexClient.mutation(convexApi.tracks.setMix, buildTrackMixMutationInput({
          trackId,
          userId,
          muted,
          soloed,
        })).then((result) => {
          if (result?.status === 'applied' || result?.status === 'noop') return
          if (muted !== undefined) clearPendingTrackMixField(trackId, 'muted', muted)
          if (soloed !== undefined) clearPendingTrackMixField(trackId, 'soloed', soloed)
        }).catch(() => {
          if (muted !== undefined) clearPendingTrackMixField(trackId, 'muted', muted)
          if (soloed !== undefined) clearPendingTrackMixField(trackId, 'soloed', soloed)
        })
      })(),
    )
  }

  const pushTrackMixHistory = (
    track: Track | undefined,
    currentMix: { muted: boolean; soloed: boolean },
    nextMix: { muted: boolean; soloed: boolean },
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    scope: 'local' | 'shared',
  ) => {
    const roomId = options.roomId()
    if (!roomId || !track) return
    if (patch.muted !== undefined && currentMix.muted !== nextMix.muted) {
      options.pushHistory(buildTrackBooleanHistoryEntry({
        type: 'track-mute',
        roomId,
        track,
        scope,
        from: currentMix.muted,
        to: nextMix.muted,
      }))
    }
    if (patch.soloed !== undefined && currentMix.soloed !== nextMix.soloed) {
      options.pushHistory(buildTrackBooleanHistoryEntry({
        type: 'track-solo',
        roomId,
        track,
        scope,
        from: currentMix.soloed,
        to: nextMix.soloed,
      }))
    }
  }

  const setTrackMixState = (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
  ) => {
    const track = getTrack(trackId)
    const currentMix = getTrackMixSnapshot(trackId)
    const nextMuted = patch.muted ?? currentMix.muted
    const nextSoloed = patch.soloed ?? currentMix.soloed
    const canWriteSharedMix = options.canWriteTrack(trackId)
    const changedMuted = patch.muted !== undefined && currentMix.muted !== nextMuted
    const changedSoloed = patch.soloed !== undefined && currentMix.soloed !== nextSoloed
    if (!changedMuted && !changedSoloed) return

    pushTrackMixHistory(
      track,
      currentMix,
      { muted: nextMuted, soloed: nextSoloed },
      patch,
      canWriteSharedMix ? 'shared' : 'local',
    )

    applyTrackMixState(trackId, patch, canWriteSharedMix ? 'shared' : 'local')
    if (!canWriteSharedMix) {
      options.localMix.persist(trackId, {
        ...(patch.muted !== undefined ? { muted: nextMuted } : {}),
        ...(patch.soloed !== undefined ? { soloed: nextSoloed } : {}),
      })
      return
    }
    persistTrackMixState(trackId)
  }

  const mirrorConfirmedTrackMixState = (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    issuedAt = readMixIssuedAt(),
  ) => {
    if (!options.canWriteTrack(trackId)) return
    const currentMix = getTrackMixSnapshot(trackId)
    const pendingMix = rawPendingSharedTrackMix().get(trackId)
    const writeAts = rawTrackMixWriteAtById().get(trackId)
    const nextPatch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>> = {}

    if (
      patch.muted !== undefined
      && (writeAts?.muted === undefined || writeAts.muted <= issuedAt)
      && (pendingMix?.muted !== patch.muted || currentMix.muted !== patch.muted)
    ) {
      nextPatch.muted = patch.muted
    }

    if (
      patch.soloed !== undefined
      && (writeAts?.soloed === undefined || writeAts.soloed <= issuedAt)
      && (pendingMix?.soloed !== patch.soloed || currentMix.soloed !== patch.soloed)
    ) {
      nextPatch.soloed = patch.soloed
    }

    if (nextPatch.muted === undefined && nextPatch.soloed === undefined) return

    clearTrackMixWriteAt(trackId, {
      ...(nextPatch.muted !== undefined ? { muted: true } : {}),
      ...(nextPatch.soloed !== undefined ? { soloed: true } : {}),
    })
    updatePendingTrackMix(trackId, (current) => ({
      ...(current?.muted !== undefined ? { muted: current.muted } : {}),
      ...(current?.soloed !== undefined ? { soloed: current.soloed } : {}),
      ...(nextPatch.muted !== undefined ? { muted: nextPatch.muted } : {}),
      ...(nextPatch.soloed !== undefined ? { soloed: nextPatch.soloed } : {}),
    }))
  }

  const applyConfirmedTrackMixState = (
    trackId: Track['id'],
    patch: Partial<Pick<PendingTrackMixState, 'muted' | 'soloed'>>,
    issuedAt = readMixIssuedAt(),
  ) => {
    const currentMix = getTrackMixSnapshot(trackId)
    const nextMuted = patch.muted ?? currentMix.muted
    const nextSoloed = patch.soloed ?? currentMix.soloed
    if (patch.muted === undefined && patch.soloed === undefined) return
    if (
      (patch.muted === undefined || currentMix.muted === nextMuted)
      && (patch.soloed === undefined || currentMix.soloed === nextSoloed)
    ) {
      return
    }
    if (!options.canWriteTrack(trackId)) {
      const localPatch: LocalMixPatch = {
        ...(patch.muted !== undefined ? { muted: nextMuted } : {}),
        ...(patch.soloed !== undefined ? { soloed: nextSoloed } : {}),
      }
      options.localMix.apply(trackId, localPatch)
      options.localMix.persist(trackId, localPatch)
      return
    }
    mirrorConfirmedTrackMixState(trackId, patch, issuedAt)
  }

  const handleToggleTrackMute = (trackId: Track['id']) => {
    const current = getTrackMixSnapshot(trackId)
    setTrackMixState(trackId, { muted: !current.muted })
  }

  const handleToggleTrackSolo = (trackId: Track['id']) => {
    const current = getTrackMixSnapshot(trackId)
    setTrackMixState(trackId, { soloed: !current.soloed })
  }

  createEffect(() => {
    options.roomId()
    clearTimers(volumeTimers)
    clearTimers(routingTimers)
    clearTimers(mixTimers)
    setRawPendingSharedTrackVolumes(new Map())
    setRawPendingSharedTrackRouting(new Map())
    setRawPendingSharedTrackMix(new Map())
    setRawTrackMixWriteAtById(new Map())
  })

  createEffect(() => {
    const trackIds = relevantTrackIds()
    setRawPendingSharedTrackVolumes((current) => pruneMapToKeys(current, trackIds))
    setRawPendingSharedTrackRouting((current) => pruneMapToKeys(current, trackIds))
    setRawPendingSharedTrackMix((current) => pruneMapToKeys(current, trackIds))
  })

  createEffect(() => {
    const pendingMixByTrackId = rawPendingSharedTrackMix()
    setRawTrackMixWriteAtById((current) => {
      let next: Map<Track['id'], PendingTrackMixWriteAt> | null = null
      for (const [trackId, writeAts] of current) {
        const pending = pendingMixByTrackId.get(trackId)
        if (!pending) {
          if (!next) next = new Map(current)
          next.delete(trackId)
          continue
        }
        const nextWriteAts: PendingTrackMixWriteAt = {
          ...(pending.muted !== undefined && writeAts.muted !== undefined ? { muted: writeAts.muted } : {}),
          ...(pending.soloed !== undefined && writeAts.soloed !== undefined ? { soloed: writeAts.soloed } : {}),
        }
        if (writeAts.muted === nextWriteAts.muted && writeAts.soloed === nextWriteAts.soloed) {
          continue
        }
        if (!next) next = new Map(current)
        if (nextWriteAts.muted === undefined && nextWriteAts.soloed === undefined) {
          next.delete(trackId)
        } else {
          next.set(trackId, nextWriteAts)
        }
      }
      return next ?? current
    })
  })

  createEffect(() => {
    const serverState = options.serverTrackState()
    if (!serverState) return
    setRawPendingSharedTrackVolumes((current) => {
      let next: Map<Track['id'], number> | null = null
      for (const [trackId, volume] of current) {
        const serverVolume = serverState.serverVolumes.get(trackId)
        if (typeof serverVolume !== 'number' || Math.abs(serverVolume - volume) >= 1e-6) continue
        if (!next) next = new Map(current)
        next.delete(trackId)
      }
      return next ?? current
    })
  })

  createEffect(() => {
    const serverState = options.serverTrackState()
    const routingTracks = options.tracks()
    if (!serverState) return
    setRawPendingSharedTrackRouting((current) => {
      let next: Map<Track['id'], LocalTrackRouting> | null = null
      for (const [trackId, routing] of current) {
        const normalized = normalizeTrackRouting(trackIndex().trackById.get(trackId), routing, routingTracks)
        const serverValue = serverState.serverRouting.get(trackId)
        if (!serverValue || !isTrackRoutingEqual(serverValue, normalized)) continue
        if (!next) next = new Map(current)
        next.delete(trackId)
      }
      return next ?? current
    })
  })

  createEffect(() => {
    const serverState = options.serverTrackState()
    if (!serverState) return
    setRawPendingSharedTrackMix((current) => {
      let next: Map<Track['id'], PendingTrackMixState> | null = null
      for (const [trackId, mix] of current) {
        const nextMix: PendingTrackMixState = {}
        if (mix.muted !== undefined && mix.muted !== serverState.serverMuted.get(trackId)) {
          nextMix.muted = mix.muted
        }
        if (mix.soloed !== undefined && mix.soloed !== serverState.serverSoloed.get(trackId)) {
          nextMix.soloed = mix.soloed
        }
        const hasMuted = nextMix.muted !== undefined
        const hasSoloed = nextMix.soloed !== undefined
        if (hasMuted === (mix.muted !== undefined) && hasSoloed === (mix.soloed !== undefined)) continue
        if (!next) next = new Map(current)
        if (!hasMuted && !hasSoloed) {
          next.delete(trackId)
          continue
        }
        next.set(trackId, nextMix)
      }
      return next ?? current
    })
  })

  const pendingSharedTrackVolumes = createMemo((previous: Map<Track['id'], number>) => {
    const serverState = options.serverTrackState()
    const next = new Map<Track['id'], number>()
    for (const [trackId, volume] of rawPendingSharedTrackVolumes()) {
      const serverVolume = serverState?.serverVolumes.get(trackId)
      if (typeof serverVolume === 'number' && Math.abs(serverVolume - volume) < 1e-6) {
        continue
      }
      next.set(trackId, volume)
    }
    return reuseMapIfEqual(previous, next, (left, right) => typeof right === 'number' && Math.abs(left - right) < 1e-6)
  }, new Map())

  const pendingSharedTrackRouting = createMemo((previous: Map<Track['id'], LocalTrackRouting>) => {
    const serverState = options.serverTrackState()
    const routingTracks = options.tracks()
    const next = new Map<Track['id'], LocalTrackRouting>()
    for (const [trackId, routing] of rawPendingSharedTrackRouting()) {
      if (!serverState) {
        next.set(trackId, routing)
        continue
      }
      const normalized = normalizeTrackRouting(trackIndex().trackById.get(trackId), routing, routingTracks)
      const serverValue = serverState.serverRouting.get(trackId)
      if (serverValue && isTrackRoutingEqual(serverValue, normalized)) {
        continue
      }
      next.set(trackId, normalized)
    }
    return reuseMapIfEqual(previous, next, (left, right) => !!right && isTrackRoutingEqual(left, right))
  }, new Map())

  const pendingSharedTrackMix = createMemo((previous: Map<Track['id'], PendingTrackMixState>) => {
    const serverState = options.serverTrackState()
    const next = new Map<Track['id'], PendingTrackMixState>()
    for (const [trackId, mix] of rawPendingSharedTrackMix()) {
      const nextMix: PendingTrackMixState = {}
      const serverMuted = serverState?.serverMuted.get(trackId)
      const serverSoloed = serverState?.serverSoloed.get(trackId)
      if (mix.muted !== undefined && mix.muted !== serverMuted) {
        nextMix.muted = mix.muted
      }
      if (mix.soloed !== undefined && mix.soloed !== serverSoloed) {
        nextMix.soloed = mix.soloed
      }
      if (nextMix.muted !== undefined || nextMix.soloed !== undefined) {
        next.set(trackId, nextMix)
      }
    }
    return reuseMapIfEqual(previous, next, (left, right) => !!right && isPendingTrackMixStateEqual(left, right))
  }, new Map())

  onCleanup(() => {
    clearTimers(volumeTimers)
    clearTimers(routingTimers)
    clearTimers(mixTimers)
  })

  return {
    pendingSharedTrackVolumes,
    pendingSharedTrackRouting,
    pendingSharedTrackMix,
    cancelTrackVolumeWrite: (trackId) => clearScheduledWrite(volumeTimers, trackId),
    cancelTrackRoutingWrite: (trackId) => clearScheduledWrite(routingTimers, trackId),
    cancelTrackMixWrite: (trackId) => clearScheduledWrite(mixTimers, trackId),
    applyTrackVolume,
    applyTrackMixState,
    applyConfirmedTrackMixState,
    applyTrackRouting,
    setTrackVolume,
    handleToggleTrackMute,
    handleToggleTrackSolo,
    updateTrackSends,
    updateTrackOutputTargetId,
  }
}
