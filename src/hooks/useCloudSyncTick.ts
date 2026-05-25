import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import { subscribeToLocalProjectChanges } from '~/lib/local-project-changes'

type Options = {
  projectId: Accessor<string>
  enabled: Accessor<boolean>
  sync: () => void | Promise<void>
}

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
    if (!projectId || !options.enabled()) return

    if (syncInFlight) return
    pendingChange = false
    syncInFlight = true
    void Promise.resolve(options.sync()).finally(() => {
      syncInFlight = false
      if (pendingChange) {
        pendingChange = false
        setChangeVersion((version) => version + 1)
      }
    })
  })
}
