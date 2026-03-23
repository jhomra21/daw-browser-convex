import { createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'
import { useQuery } from '@tanstack/solid-query'
import { getPersistedAudioSource, type AudioSourceKind, type AudioSourceMetadata } from '~/lib/audio-source'

export type ProjectSampleInventoryItem = {
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  name?: string
  source: AudioSourceMetadata
  ownerUserId: string
  createdAt: number
}

export type ProjectSampleUsage = {
  assetKey: string
  sourceKind: AudioSourceKind
  clipId: string
  trackId: string
  startSec: number
  name?: string
  source: AudioSourceMetadata
}

export type ProjectSampleListItem = {
  key: string
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  name: string
  duration: number
  source: AudioSourceMetadata
  createdAt: number
  ownerUserId: string
  count: number
  earliestClip?: ProjectSampleUsage
}

export type DefaultSampleListItem = {
  key: string
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  name: string
  duration: number
  source: AudioSourceMetadata
  sizeBytes?: number
  mimeType?: string
  uploadedAt?: string
}

type UseProjectSamplesArgs = {
  roomId: Accessor<string>
  enabled?: Accessor<boolean>
}

type UseProjectSamplesResult = {
  samples: Accessor<ProjectSampleListItem[]>
  defaultSamples: Accessor<DefaultSampleListItem[]>
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
    const inventoryData = inventory.data
    const clipsData = clips.data
    if (!Array.isArray(inventoryData)) return []
    if (!Array.isArray(clipsData)) return []

    const invList: ProjectSampleInventoryItem[] = inventoryData.map((item: any) => {
      const assetKey = item.assetKey as string | undefined
      const sourceKind = item.sourceKind as AudioSourceKind | undefined
      const durationSec = item.duration as number
      const sampleRate = item.sampleRate as number
      const channelCount = item.channelCount as number
      const createdAt = item.createdAt as number
      const url = item.url as string | undefined
      const ownerUserId = item.ownerUserId as string | undefined
      if (!assetKey || !sourceKind || !url || !ownerUserId || !Number.isFinite(durationSec) || !Number.isFinite(sampleRate) || !Number.isFinite(channelCount) || !Number.isFinite(createdAt)) {
        throw new Error('Invalid sample inventory row')
      }
      return {
        assetKey,
        sourceKind,
        url,
        name: item.name as string | undefined,
        source: {
          durationSec,
          sampleRate,
          channelCount,
        },
        ownerUserId,
        createdAt,
      }
    })

    const clipList: ProjectSampleUsage[] = []
    for (const clip of clipsData) {
      const source = getPersistedAudioSource({
        sourceAssetKey: clip.sourceAssetKey,
        sourceKind: clip.sourceKind,
        sourceDurationSec: clip.sourceDurationSec,
        sourceSampleRate: clip.sourceSampleRate,
        sourceChannelCount: clip.sourceChannelCount,
      })
      if (!source) {
        continue
      }
      clipList.push({
        assetKey: source.assetKey,
        sourceKind: source.sourceKind,
        clipId: clip._id as string,
        trackId: clip.trackId as string,
        startSec: Number(clip.startSec ?? 0),
        name: clip.name as string | undefined,
        source: source.source,
      })
    }

    const inventoryByKey = new Map<string, ProjectSampleInventoryItem>()
    for (const item of invList) {
      if (inventoryByKey.has(item.assetKey)) continue
      inventoryByKey.set(item.assetKey, item)
    }
    const usageByKey = new Map<string, ProjectSampleUsage[]>()
    for (const clip of clipList) {
      const list = usageByKey.get(clip.assetKey)
      if (list) list.push(clip); else usageByKey.set(clip.assetKey, [clip])
    }
    const allKeys = new Set<string>([...inventoryByKey.keys(), ...usageByKey.keys()])

    const items: ProjectSampleListItem[] = []
    for (const key of allKeys) {
      const inv = inventoryByKey.get(key)
      if (!inv) {
        throw new Error('Missing sample inventory row for clip usage')
      }
      const usages = usageByKey.get(key) ?? []
      const count = usages.length
      const earliest = usages.reduce<ProjectSampleUsage | undefined>((current, candidate) => {
        if (!current) return candidate
        return candidate.startSec < current.startSec ? candidate : current
      }, undefined)
      const name = inv.name || earliest?.name || 'Sample'
      items.push({
        key,
        assetKey: inv.assetKey,
        sourceKind: inv.sourceKind,
        url: inv.url,
        name,
        duration: inv.source.durationSec,
        source: inv.source,
        createdAt: inv.createdAt,
        ownerUserId: inv.ownerUserId,
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

  const defaultSamplesQuery = useQuery(() => ({
    queryKey: ['default-samples'],
    queryFn: async (): Promise<DefaultSampleListItem[]> => {
      const res = await fetch('/api/default-samples').catch(() => null)
      if (!res || !res.ok) return []
      const data: any = await res.json().catch(() => null)
      const list: any[] = Array.isArray(data?.samples) ? data.samples : []
      return list.map((raw: any) => {
        const key = raw?.key as string | undefined
        const assetKey = raw?.assetKey as string | undefined
        const sourceKind = raw?.sourceKind as AudioSourceKind | undefined
        const url = raw?.url as string | undefined
        const name = raw?.name as string | undefined
        const duration = raw?.duration as number
        const source = raw?.source as AudioSourceMetadata | undefined
        if (
          !key ||
          !assetKey ||
          !sourceKind ||
          !url ||
          !name ||
          !Number.isFinite(duration) ||
          !source ||
          !Number.isFinite(source.durationSec) ||
          !Number.isFinite(source.sampleRate) ||
          !Number.isFinite(source.channelCount)
        ) {
          throw new Error('Invalid default sample payload')
        }
        return {
          key,
          assetKey,
          sourceKind,
          url,
          name,
          duration,
          source,
          sizeBytes: typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : undefined,
          mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
          uploadedAt: typeof raw.uploadedAt === 'string' ? raw.uploadedAt : undefined,
        }
      })
    },
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
    placeholderData: (prev: DefaultSampleListItem[] | undefined) => prev ?? [],
  }))

  const defaultSamples = createMemo<DefaultSampleListItem[]>(() => {
    return Array.isArray(defaultSamplesQuery.data) ? defaultSamplesQuery.data : []
  })

  return {
    samples,
    defaultSamples,
  }
}
