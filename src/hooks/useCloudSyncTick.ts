import { createEffect, onCleanup, type Accessor } from 'solid-js'
const CLOUD_SYNC_INTERVAL_MS = 30_000

type Options = {
  projectId: Accessor<string>
  enabled: Accessor<boolean>
  sync: () => void | Promise<void>
}

export const useCloudSyncTick = (options: Options) => {
  createEffect(() => {
    const projectId = options.projectId()
    if (!projectId || !options.enabled()) return

    const intervalId = window.setInterval(() => {
      void options.sync()
    }, CLOUD_SYNC_INTERVAL_MS)

    onCleanup(() => {
      window.clearInterval(intervalId)
    })
  })
}
