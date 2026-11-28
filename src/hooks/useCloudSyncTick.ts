import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import {
  subscribeToLocalProjectChanges,
  subscribeToLocalProjectStateChanges,
} from '~/lib/local-project-changes'

type Options = {
  projectId: Accessor<string>
  enabled: Accessor<boolean>
  sync: (projectId: string) => void | Promise<void>
}

const CLOUD_SYNC_DEBOUNCE_MS = 30_000

export const useCloudSyncTick = (options: Options) => {
  const syncInFlight = new Set<string>()
  const pendingChanges = new Set<string>()
  const timers = new Map<string, number>()
  const [changeVersion, setChangeVersion] = createSignal(0)

  const scheduleSync = (projectId: string) => {
    if (!options.enabled() || syncInFlight.has(projectId) || timers.has(projectId)) return

    // Debounce local edits per project so high-frequency changes coalesce without losing project identity.
    const timer = window.setTimeout(() => {
      timers.delete(projectId)

      if (!options.enabled()) {
        return
      }

      pendingChanges.delete(projectId)
      syncInFlight.add(projectId)
      void Promise.resolve(options.sync(projectId)).finally(() => {
        syncInFlight.delete(projectId)

        if (pendingChanges.has(projectId)) scheduleSync(projectId)
      })
    }, CLOUD_SYNC_DEBOUNCE_MS)

    timers.set(projectId, timer)
  }

  createEffect(
    () => options.projectId(),
    (projectId) => {
      if (!projectId) return

      const onProjectChanged = () => {
        const alreadyPending = pendingChanges.has(projectId)
        pendingChanges.add(projectId)

        if (options.enabled()) {
          scheduleSync(projectId)
        } else if (!alreadyPending) {
          setChangeVersion((version) => version + 1)
        }
      }

      const unsubscribeProjectChanges = subscribeToLocalProjectChanges(projectId, onProjectChanged)
      const unsubscribeProjectStateChanges = subscribeToLocalProjectStateChanges(projectId, onProjectChanged)

      return () => {
        unsubscribeProjectChanges()
        unsubscribeProjectStateChanges()
      }
    },
  )

  createEffect(
    () => ({ projectId: options.projectId(), enabled: options.enabled(), version: changeVersion() }),
    ({ projectId, enabled }) => {
      if (!projectId || !enabled || !pendingChanges.has(projectId)) return
      scheduleSync(projectId)
    },
  )

  onCleanup(() => {
    for (const timer of timers.values()) window.clearTimeout(timer)
    timers.clear()
  })
}
