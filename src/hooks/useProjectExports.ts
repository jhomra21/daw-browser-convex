import { createMemo, type Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'

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
  enabled?: Accessor<boolean>
}

type UseProjectExportsResult = {
  exports: Accessor<ProjectExportItem[]>
}

export function useProjectExports(options: UseProjectExportsArgs): UseProjectExportsResult {
  const { projectId, enabled } = options

  const raw = useConvexQuery(
    (convexApi as any).exports.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = projectId()
      return rid ? ({ projectId: rid }) : null
    },
    () => ['exports', 'by_room', projectId()]
  )

  const list = createMemo<ProjectExportItem[]>(() => {
    return Array.isArray(raw.data) ? raw.data : []
  })

  return { exports: list }
}
