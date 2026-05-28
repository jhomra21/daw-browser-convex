import { createLocalTimelineRepository, registerPendingLocalTimelineFlusher } from '~/lib/timeline-repository/local-timeline-repository'
import type { UpdateTrackInput } from '~/lib/timeline-repository/types'

export const createTimelineMixerLocalWrites = (flushAllTimers: () => Promise<void>) => {
  const localTrackWriteChains = new Map<string, Promise<unknown>>()
  const registeredLocalTimelineFlushers = new Map<string, () => void>()

  const queueLocalTrackUpdate = (projectId: string, input: UpdateTrackInput) => {
    const key = `${projectId}:${input.trackId}`
    const previous = localTrackWriteChains.get(key) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() => createLocalTimelineRepository(projectId).updateTrack(input))
    const tracked = write.finally(() => {
      if (localTrackWriteChains.get(key) === tracked) {
        localTrackWriteChains.delete(key)
      }
    })
    localTrackWriteChains.set(key, tracked)
    return tracked
  }

  const ensureLocalTimelineFlusher = (projectId: string) => {
    if (registeredLocalTimelineFlushers.has(projectId)) return
    registeredLocalTimelineFlushers.set(projectId, registerPendingLocalTimelineFlusher(projectId, flushAllTimers))
  }

  const cleanup = () => {
    for (const unregister of registeredLocalTimelineFlushers.values()) unregister()
    registeredLocalTimelineFlushers.clear()
  }

  return {
    cleanup,
    ensureLocalTimelineFlusher,
    queueLocalTrackUpdate,
  }
}
