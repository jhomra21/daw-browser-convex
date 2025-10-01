import { createMemo, type Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'

export type ProjectExportItem = {
  _id: string
  roomId: string
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
  roomId: Accessor<string>
  enabled?: Accessor<boolean>
}

type UseProjectExportsResult = {
  exports: Accessor<ProjectExportItem[]>
  raw: ReturnType<typeof useConvexQuery>
}

export function useProjectExports(options: UseProjectExportsArgs): UseProjectExportsResult {
  const { roomId, enabled } = options

  const raw = useConvexQuery(
    (convexApi as any).exports.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = roomId()
      return rid ? ({ roomId: rid }) : null
    },
    () => ['exports', 'by_room', roomId()]
  )

  const list = createMemo<ProjectExportItem[]>(() => {
    const dataRaw: any = (raw as any).data
    const data = typeof dataRaw === 'function' ? dataRaw() : dataRaw
    return Array.isArray(data) ? data : []
  })

  return { exports: list, raw }
}
