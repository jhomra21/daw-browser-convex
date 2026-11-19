import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'
import { listLocalExportMetadata } from '~/lib/local-export-metadata'
import { isLocalId } from '@daw-browser/shared'

type ProjectExportItem = {
  _id: string
  projectId: string
  name: string
  url: string
  r2Key: string
  format: string
  duration?: number
  sampleRate?: number
  sizeBytes?: number
  createdAt: number
  createdBy: string
}

type UseProjectExportsArgs = {
  projectId: Accessor<string>
  userId: Accessor<string>
  enabled?: Accessor<boolean>
}

type UseProjectExportsResult = {
  exports: Accessor<ProjectExportItem[]>
  loading: Accessor<boolean>
  error: Accessor<unknown>
  retry: () => void
}

export function useProjectExports(options: UseProjectExportsArgs): UseProjectExportsResult {
  const { projectId, userId, enabled } = options
  const [localExports, setLocalExports] = createSignal<ProjectExportItem[]>([])
  const [localLoading, setLocalLoading] = createSignal(false)
  const [localError, setLocalError] = createSignal<unknown>(null)
  const [localRetry, setLocalRetry] = createSignal(0)

  createEffect(() => {
    localRetry()
    setLocalExports([])
    setLocalLoading(false)
    setLocalError(null)
    if (enabled && !enabled()) {
      return
    }
    const rid = projectId()
    if (!rid || !isLocalId('project', rid)) {
      return
    }
    let active = true
    onCleanup(() => { active = false })
    setLocalLoading(true)
    const isCurrentProject = () => active && (!enabled || enabled()) && projectId() === rid
    void listLocalExportMetadata(rid).then((rows) => {
      if (!isCurrentProject()) return
      setLocalExports(rows.map((row) => ({
        _id: row.id,
        projectId: rid,
        name: row.name,
        url: '',
        r2Key: '',
        format: row.format,
        duration: row.durationSec,
        sampleRate: row.sampleRate,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
        createdBy: 'local',
      })))
    }).catch((error) => {
      if (isCurrentProject()) setLocalError(error)
    }).finally(() => {
      if (isCurrentProject()) setLocalLoading(false)
    })
  })

  const raw = useConvexQuery(
    convexApi.exports.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = projectId()
      if (isLocalId('project', rid)) return null
      const uid = userId()
      return rid && uid ? ({ projectId: rid }) : null
    },
    () => ['exports', 'by_room', projectId(), userId()]
  )

  const list = createMemo<ProjectExportItem[]>(() => {
    const rid = projectId()
    if (isLocalId('project', rid)) return localExports()
    return Array.isArray(raw.data) ? raw.data : []
  })
  const cloudQueryEnabled = () => Boolean(
    (!enabled || enabled())
    && projectId()
    && !isLocalId('project', projectId())
    && userId(),
  )

  return {
    exports: list,
    loading: () => isLocalId('project', projectId()) ? localLoading() : cloudQueryEnabled() && raw.isLoading,
    error: () => isLocalId('project', projectId()) ? localError() : cloudQueryEnabled() ? raw.error : null,
    retry: () => {
      if (isLocalId('project', projectId())) setLocalRetry((version) => version + 1)
      else void raw.refetch()
    },
  }
}
