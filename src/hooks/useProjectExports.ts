import { createEffect, createMemo, createSignal, type Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'
import { listLocalExportMetadata } from '~/lib/local-export-metadata'
import { isLocalId } from '~/lib/local-ids'

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
}

export function useProjectExports(options: UseProjectExportsArgs): UseProjectExportsResult {
  const { projectId, userId, enabled } = options
  const [localExports, setLocalExports] = createSignal<ProjectExportItem[]>([])

  createEffect(() => {
    if (enabled && !enabled()) {
      setLocalExports([])
      return
    }
    const rid = projectId()
    if (!rid || !isLocalId('project', rid)) {
      setLocalExports([])
      return
    }
    void listLocalExportMetadata(rid).then((rows) => {
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
    }).catch(() => setLocalExports([]))
  })

  const raw = useConvexQuery(
    (convexApi as any).exports.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = projectId()
      if (isLocalId('project', rid)) return null
      const uid = userId()
      return rid && uid ? ({ projectId: rid, userId: uid }) : null
    },
    () => ['exports', 'by_room', projectId(), userId()]
  )

  const list = createMemo<ProjectExportItem[]>(() => {
    const rid = projectId()
    if (isLocalId('project', rid)) return localExports()
    return Array.isArray(raw.data) ? raw.data : []
  })

  return { exports: list }
}
