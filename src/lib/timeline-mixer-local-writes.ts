import { createLocalTimelineRepository, registerPendingLocalTimelineFlusher } from '~/lib/timeline-repository/local-timeline-repository'
import type { UpdateTrackInput } from '~/lib/timeline-repository/types'

export const createTimelineMixerLocalWrites = (flushAllTimers: () => Promise<void>) => {
  const registeredLocalTimelineFlushers = new Map<string, () => void>()
  const localTrackUpdateChains = new Map<string, Promise<void>>()

  const queueLocalTrackUpdate = (projectId: string, input: UpdateTrackInput) => {
    const chainKey = `${projectId}:${input.trackId}`
    const previous = localTrackUpdateChains.get(chainKey) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await createLocalTimelineRepository(projectId).updateTrack(input)
      })
    localTrackUpdateChains.set(chainKey, next)
    void next.finally(() => {
      if (localTrackUpdateChains.get(chainKey) === next) localTrackUpdateChains.delete(chainKey)
    }).catch(() => undefined)
    return next
  }

  const ensureLocalTimelineFlusher = (projectId: string) => {
    if (registeredLocalTimelineFlushers.has(projectId)) return
    registeredLocalTimelineFlushers.set(projectId, registerPendingLocalTimelineFlusher(projectId, flushAllTimers))
  }

  const cleanup = () => {
    for (const unregister of registeredLocalTimelineFlushers.values()) unregister()
    registeredLocalTimelineFlushers.clear()
    localTrackUpdateChains.clear()
  }

  return {
    cleanup,
    ensureLocalTimelineFlusher,
    queueLocalTrackUpdate,
  }
}
