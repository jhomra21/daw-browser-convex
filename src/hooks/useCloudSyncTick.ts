import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'

type Options = {
  projectId: Accessor<string>
  enabled: Accessor<boolean>
  sync: () => void | Promise<void>
}

const CLOUD_SYNC_DEBOUNCE_MS = 30_000

export const useCloudSyncTick = (options: Options) => {
  let syncInFlight = false
  let pendingChange = false
  const [changeVersion, setChangeVersion] = createSignal(0)

  createEffect(() => {
    const projectId = options.projectId()
    if (!projectId) return
    const unsubscribe = subscribeToLocalProjectChanges(projectId, () => {
      pendingChange = true
      setChangeVersion((version) => version + 1)
    })
    onCleanup(unsubscribe)
  })

  createEffect(() => {
    const projectId = options.projectId()
    changeVersion()
    if (!projectId || !options.enabled() || !pendingChange || syncInFlight) return

    // Backup is debounced so high-frequency local edits coalesce; Solid cleanup clears it on project/mode changes.
    const timer = window.setTimeout(() => {
      pendingChange = false
      syncInFlight = true
      void Promise.resolve(options.sync()).finally(() => {
        syncInFlight = false
        if (pendingChange) setChangeVersion((version) => version + 1)
      })
    }, CLOUD_SYNC_DEBOUNCE_MS)
    onCleanup(() => window.clearTimeout(timer))
  })
}
