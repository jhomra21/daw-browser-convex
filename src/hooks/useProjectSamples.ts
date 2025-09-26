import { createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'

import { useConvexQuery, convexApi } from '~/lib/convex'

export type ProjectSampleInventoryItem = {
  url: string
  name?: string
  duration?: number
  ownerUserId: string
  createdAt: number
}

export type ProjectSampleUsage = {
  sampleUrl?: string
  clipId: string
  trackId: string
  startSec: number
  name?: string
  duration: number
}

export type ProjectSampleListItem = {
  url: string
  name: string
  duration?: number
  createdAt: number
  ownerUserId: string
  count: number
  earliestClip?: ProjectSampleUsage
}

type UseProjectSamplesArgs = {
  roomId: Accessor<string>
  enabled?: Accessor<boolean>
}

type UseProjectSamplesResult = {
  samples: Accessor<ProjectSampleListItem[]>
  rawInventory: ReturnType<typeof useConvexQuery>
  roomClips: ReturnType<typeof useConvexQuery>
}

export function useProjectSamples(options: UseProjectSamplesArgs): UseProjectSamplesResult {
  const { roomId, enabled } = options

  const inventory = useConvexQuery(
    (convexApi as any).samples.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = roomId()
      return rid ? ({ roomId: rid }) : null
    },
    () => ['samples', 'by_room', roomId()]
  )

  const clips = useConvexQuery(
    (convexApi as any).clips.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = roomId()
      return rid ? ({ roomId: rid }) : null
    },
    () => ['clips', 'by_room', roomId()]
  )

  const samples = createMemo<ProjectSampleListItem[]>(() => {
    const invRaw: any = (inventory as any).data
    const invData = typeof invRaw === 'function' ? invRaw() : invRaw
    const invList: ProjectSampleInventoryItem[] = Array.isArray(invData) ? invData : []

    const clipsRaw: any = (clips as any).data
    const clipsData = typeof clipsRaw === 'function' ? clipsRaw() : clipsRaw
    const clipList: ProjectSampleUsage[] = Array.isArray(clipsData)
      ? clipsData.map((clip: any) => ({
        sampleUrl: clip.sampleUrl as string | undefined,
        clipId: clip._id as string,
        trackId: clip.trackId as string,
        startSec: Number(clip.startSec || 0),
        name: clip.name as string | undefined,
        duration: Number(clip.duration || 0),
      }))
      : []

    const usageByUrl = new Map<string, ProjectSampleUsage[]>()
    for (const clip of clipList) {
      if (!clip.sampleUrl) continue
      const list = usageByUrl.get(clip.sampleUrl)
      if (list) list.push(clip); else usageByUrl.set(clip.sampleUrl, [clip])
    }

    const allUrls = new Set<string>()
    for (const entry of invList) {
      allUrls.add(entry.url)
    }
    for (const url of usageByUrl.keys()) {
      allUrls.add(url)
    }

    const items: ProjectSampleListItem[] = []

    for (const url of allUrls) {
      const inv = invList.find(item => item.url === url)
      const usages = usageByUrl.get(url) ?? []
      const count = usages.length
      const earliest = usages.reduce<ProjectSampleUsage | undefined>((current, candidate) => {
        if (!current) return candidate
        return candidate.startSec < current.startSec ? candidate : current
      }, undefined)

      const name = inv?.name || earliest?.name || 'Sample'

      items.push({
        url,
        name,
        duration: inv?.duration ?? earliest?.duration,
        createdAt: inv?.createdAt ?? 0,
        ownerUserId: inv?.ownerUserId ?? '',
        count,
        earliestClip: earliest,
      })
    }

    items.sort((a, b) => {
      const aTime = a.earliestClip?.startSec ?? 0
      const bTime = b.earliestClip?.startSec ?? 0
      if (aTime !== bTime) return aTime - bTime
      return a.name.localeCompare(b.name)
    })

    return items
  })

  return {
    samples,
    rawInventory: inventory,
    roomClips: clips,
  }
}
