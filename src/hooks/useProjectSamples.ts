import type { FunctionReturnType } from 'convex/server'
import { createEffect, createMemo, createSignal, on, type Accessor } from 'solid-js'
import { useConvexQuery, convexApi } from '~/lib/convex'
import { useQuery } from '@tanstack/solid-query'
import { getPersistedAudioSource, type AudioSourceKind, type AudioSourceMetadata } from '~/lib/audio-source'
import { sanitizeAudioSourceKind } from '@daw-browser/shared'
import { ensureDefaultSampleMetadata, loadCachedDefaultSampleMetadata } from '~/lib/default-sample-cache'
import { listLocalAssets } from '~/lib/local-assets'
import { getProjectDirectoryHandle } from '~/lib/local-project-db'
import { isLocalId } from '@daw-browser/shared'
import { createLocalTimelineRepository } from '~/lib/timeline-repository/local-timeline-repository'
import type { Track } from '@daw-browser/timeline-core/types'

type SampleRow = FunctionReturnType<typeof convexApi.samples.listByRoom>[number]
type ClipRow = FunctionReturnType<typeof convexApi.clips.listByRoom>[number]

type ProjectSampleInventoryItem = {
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  name?: string
  source: AudioSourceMetadata
  ownerUserId?: string
  createdAt?: number
}

type ProjectSampleUsage = {
  assetKey: string
  sourceKind: AudioSourceKind
  clipId: string
  trackId: Track['id']
  startSec: number
  name?: string
  source: AudioSourceMetadata
}

export type ProjectSampleListItem = {
  key: string
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  filePath: string
  name: string
  duration: number
  source: AudioSourceMetadata
  createdAt: number
  ownerUserId: string
  count: number
  earliestClip?: ProjectSampleUsage
}

type DefaultSampleCatalogItem = {
  key: string
  assetKey: string
  sourceKind: AudioSourceKind
  url: string
  name: string
  duration?: number
  source?: AudioSourceMetadata
  sizeBytes?: number
  mimeType?: string
  uploadedAt?: string
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
  projectId: Accessor<string>
  userId?: Accessor<string>
  enabled?: Accessor<boolean>
  includeFilePath?: Accessor<boolean>
  includeUsage?: Accessor<boolean>
  sampleLimit?: Accessor<number | undefined>
  defaultSampleLimit?: Accessor<number | undefined>
}

type UseProjectSamplesResult = {
  samples: Accessor<ProjectSampleListItem[]>
  defaultSamples: Accessor<DefaultSampleListItem[]>
  refreshSamples: () => void
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const readFiniteNumber = (value: unknown) => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const readString = (value: unknown) => {
  return typeof value === 'string' ? value : undefined
}

const readAudioSourceKind = (value: unknown): AudioSourceKind | undefined => {
  return typeof value === 'string' ? sanitizeAudioSourceKind(value) : undefined
}

const toTrackId = (value: string): Track['id'] => value as Track['id']

const readAudioSourceMetadata = (value: unknown): AudioSourceMetadata | undefined => {
  if (!isRecord(value)) return undefined
  const durationSec = readFiniteNumber(value.durationSec)
  const sampleRate = readFiniteNumber(value.sampleRate)
  const channelCount = readFiniteNumber(value.channelCount)
  if (durationSec === undefined || sampleRate === undefined || channelCount === undefined) {
    return undefined
  }
  return { durationSec, sampleRate, channelCount }
}

function isAudioSourceMetadataEqual(a: AudioSourceMetadata | undefined, b: AudioSourceMetadata | undefined): boolean {
  if (!a || !b) return a === b
  return a.durationSec === b.durationSec
    && a.sampleRate === b.sampleRate
    && a.channelCount === b.channelCount
}

function isAudioSourceMetadataMapEqual(
  a: Map<string, AudioSourceMetadata>,
  b: Map<string, AudioSourceMetadata>,
): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (!isAudioSourceMetadataEqual(value, b.get(key))) return false
  }
  return true
}

const buildProjectSampleInventoryItem = (item: SampleRow): ProjectSampleInventoryItem => {
  const sourceKind = readAudioSourceKind(item.sourceKind)
  const durationSec = readFiniteNumber(item.duration)
  const sampleRate = readFiniteNumber(item.sampleRate)
  const channelCount = readFiniteNumber(item.channelCount)
  if (
    !item.assetKey
    || !sourceKind
    || !item.url
    || durationSec === undefined
    || sampleRate === undefined
    || channelCount === undefined
  ) {
    throw new Error('Invalid sample inventory row')
  }

  return {
    assetKey: item.assetKey,
    sourceKind,
    url: item.url,
    name: readString(item.name),
    source: {
      durationSec,
      sampleRate,
      channelCount,
    },
    ownerUserId: readString(item.ownerUserId),
    createdAt: readFiniteNumber(item.createdAt),
  }
}

const buildProjectSampleUsage = (clip: ClipRow): ProjectSampleUsage | null => {
  const sourceKind = readAudioSourceKind(clip.sourceKind)
  const source = getPersistedAudioSource({
    sourceAssetKey: clip.sourceAssetKey,
    sourceKind,
    sourceDurationSec: clip.sourceDurationSec,
    sourceSampleRate: clip.sourceSampleRate,
    sourceChannelCount: clip.sourceChannelCount,
  })
  if (!source) return null

  return {
    assetKey: source.assetKey,
    sourceKind: source.sourceKind,
    clipId: clip._id,
    trackId: clip.trackId,
    startSec: Number(clip.startSec ?? 0),
    name: readString(clip.name),
    source: source.source,
  }
}

function buildDefaultSampleCatalogItem(raw: unknown): DefaultSampleCatalogItem {
  if (!isRecord(raw)) {
    throw new Error('Invalid default sample payload')
  }

  const key = readString(raw.key)
  const assetKey = readString(raw.assetKey)
  const sourceKind = readAudioSourceKind(raw.sourceKind)
  const url = readString(raw.url)
  const name = readString(raw.name)
  if (!key || !assetKey || !sourceKind || !url || !name) {
    throw new Error('Invalid default sample payload')
  }

  return {
    key,
    assetKey,
    sourceKind,
    url,
    name,
    duration: readFiniteNumber(raw.duration),
    source: readAudioSourceMetadata(raw.source),
    sizeBytes: readFiniteNumber(raw.sizeBytes),
    mimeType: readString(raw.mimeType),
    uploadedAt: readString(raw.uploadedAt),
  }
}

function mergeDefaultSampleMetadata(
  sample: DefaultSampleCatalogItem,
  source: AudioSourceMetadata,
): DefaultSampleListItem {
  return {
    ...sample,
    duration: sample.duration ?? source.durationSec,
    source,
  }
}

export function useProjectSamples(options: UseProjectSamplesArgs): UseProjectSamplesResult {
  const { projectId, enabled, includeFilePath, includeUsage, sampleLimit, defaultSampleLimit, userId } = options
  const [refreshKey, setRefreshKey] = createSignal(0)
  const [localSamples, setLocalSamples] = createSignal<ProjectSampleListItem[]>([])
  const [localSamplesProjectId, setLocalSamplesProjectId] = createSignal('')
  const isLocalProject = createMemo(() => {
    const id = projectId()
    return Boolean(id && isLocalId('project', id))
  })
  const inventory = useConvexQuery(
    convexApi.samples.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      const rid = projectId()
      if (rid && isLocalId('project', rid)) return null
      const uid = userId ? userId() : ''
      const limit = sampleLimit ? sampleLimit() : undefined
      return rid && uid ? ({ projectId: rid, limit }) : null
    },
    () => ['samples', 'by_room', projectId(), userId ? userId() : '', sampleLimit ? sampleLimit() : 'all']
  )

  const clips = useConvexQuery(
    convexApi.clips.listByRoom,
    () => {
      if (enabled && !enabled()) return null
      if (includeUsage && !includeUsage()) return null
      const rid = projectId()
      if (rid && isLocalId('project', rid)) return null
      const uid = userId ? userId() : ''
      return rid && uid ? ({ projectId: rid }) : null
    },
    () => ['clips', 'by_room', projectId(), userId ? userId() : '', includeUsage ? includeUsage() : true]
  )

  const [cachedDefaultSampleMetadataByKey, setCachedDefaultSampleMetadataByKey] = createSignal<Map<string, AudioSourceMetadata>>(new Map())

  const defaultSamplesQuery = useQuery(() => ({
    queryKey: ['default-samples'],
    enabled: enabled ? enabled() : true,
    queryFn: async (): Promise<DefaultSampleCatalogItem[]> => {
      const res = await fetch('/api/default-samples').catch(() => null)
      if (!res || !res.ok) return []
      const data = await res.json().catch(() => null)
      const list = isRecord(data) && Array.isArray(data.samples) ? data.samples : []
      return list.map(buildDefaultSampleCatalogItem)
    },
    staleTime: 1000 * 60 * 60,
    gcTime: 1000 * 60 * 60 * 24,
    refetchOnWindowFocus: false,
    placeholderData: (prev: DefaultSampleCatalogItem[] | undefined) => prev ?? [],
  }))

  createEffect(on(
    () => [projectId(), enabled ? enabled() : true, includeFilePath ? includeFilePath() : false, includeUsage ? includeUsage() : true, sampleLimit ? sampleLimit() : undefined, refreshKey()] as const,
    ([rid, isEnabled, shouldIncludeFilePath, shouldIncludeUsage, maxSamples]) => {
      if (!rid || !isLocalId('project', rid)) {
        setLocalSamples([])
        setLocalSamplesProjectId('')
        return
      }
      if (!isEnabled) {
        return
      }

      const isCurrentProject = () => projectId() === rid && (!enabled || enabled())
      void (async () => {
        const [assets, snapshot, directoryHandle] = await Promise.all([
          listLocalAssets(rid),
          shouldIncludeUsage ? createLocalTimelineRepository(rid).loadSnapshot() : Promise.resolve({ clips: [] }),
          shouldIncludeFilePath ? getProjectDirectoryHandle(rid) : Promise.resolve(null),
        ])
        const rootPath = directoryHandle?.name ?? rid
        const usagesByAsset = new Map<string, ProjectSampleUsage[]>()
        for (const clip of snapshot.clips) {
          if (!clip.sourceAssetKey || !clip.sourceKind || !clip.sourceDurationSec || !clip.sourceSampleRate || !clip.sourceChannelCount) continue
          const usage: ProjectSampleUsage = {
            assetKey: clip.sourceAssetKey,
            sourceKind: clip.sourceKind,
            clipId: clip.id,
            trackId: toTrackId(clip.trackId),
            startSec: clip.startSec,
            name: clip.name,
            source: {
              durationSec: clip.sourceDurationSec,
              sampleRate: clip.sourceSampleRate,
              channelCount: clip.sourceChannelCount,
            },
          }
          const list = usagesByAsset.get(clip.sourceAssetKey)
          if (list) list.push(usage); else usagesByAsset.set(clip.sourceAssetKey, [usage])
        }

        const items: ProjectSampleListItem[] = []
        for (const asset of assets) {
          if (maxSamples && maxSamples > 0 && items.length >= maxSamples) break
          const source = asset.durationSec && asset.sampleRate
            ? {
                durationSec: asset.durationSec,
                sampleRate: asset.sampleRate,
                channelCount: 2,
              }
            : undefined
          if (!source) continue
          const usages = usagesByAsset.get(asset.id) ?? []
          const earliest = usages.reduce<ProjectSampleUsage | undefined>((current, candidate) => {
            if (!current) return candidate
            return candidate.startSec < current.startSec ? candidate : current
          }, undefined)
          items.push({
            key: asset.id,
            assetKey: asset.id,
            sourceKind: earliest?.sourceKind ?? 'upload',
            url: `local-asset:${asset.id}`,
            filePath: `${rootPath}/assets/${asset.storagePath}`,
            name: asset.name || earliest?.name || 'Sample',
            duration: source.durationSec,
            source,
            createdAt: asset.createdAt,
            ownerUserId: 'local',
            count: usages.length,
            earliestClip: earliest,
          })
        }
        if (!isCurrentProject()) return
        setLocalSamples(items)
        setLocalSamplesProjectId(rid)
      })().catch(() => {
        if (isCurrentProject()) setLocalSamples([])
      })
    },
  ))

  createEffect(on(
    () => defaultSamplesQuery.data,
    (data) => {
      const list = Array.isArray(data) ? data.slice(0, defaultSampleLimit ? defaultSampleLimit() : undefined) : []
      if (list.length === 0) return

      void (async () => {
        const next = new Map<string, AudioSourceMetadata>()
        const cachedSources = await Promise.all(list.map(async (sample) => ({
          sample,
          source: sample.source ?? await loadCachedDefaultSampleMetadata(sample.assetKey),
        })))
        for (const { sample, source } of cachedSources) {
          if (source) {
            next.set(sample.key, source)
          }
        }
        const uncachedSources = await Promise.all(list
          .filter((sample) => !next.has(sample.key) && !sample.source)
          .map(async (sample) => ({
            sample,
            source: await ensureDefaultSampleMetadata({
              assetKey: sample.assetKey,
              url: sample.url,
            }),
          })))
        for (const { sample, source } of uncachedSources) {
          if (source) {
            next.set(sample.key, source)
          }
        }
        setCachedDefaultSampleMetadataByKey((current) => {
          return isAudioSourceMetadataMapEqual(current, next) ? current : next
        })
      })()
    },
  ))

  const defaultSamples = createMemo<DefaultSampleListItem[]>(() => {
    const list = Array.isArray(defaultSamplesQuery.data)
      ? defaultSamplesQuery.data.slice(0, defaultSampleLimit ? defaultSampleLimit() : undefined)
      : []
    const metadataByKey = cachedDefaultSampleMetadataByKey()
    const items: DefaultSampleListItem[] = []
    for (const sample of list) {
      const source = sample.source ?? metadataByKey.get(sample.key)
      if (!source) continue
      items.push(mergeDefaultSampleMetadata(sample, source))
    }
    return items
  })

  const samples = createMemo<ProjectSampleListItem[]>(() => {
    if (isLocalProject()) return localSamplesProjectId() === projectId() ? localSamples() : []
    const inventoryData = inventory.data
    const clipsData = includeUsage && !includeUsage() ? [] : clips.data
    if (!Array.isArray(inventoryData)) return []
    if (!Array.isArray(clipsData)) return []

    const invList: ProjectSampleInventoryItem[] = inventoryData.map(buildProjectSampleInventoryItem)

    const clipList: ProjectSampleUsage[] = []
    for (const clip of clipsData) {
      const usage = buildProjectSampleUsage(clip)
      if (usage) clipList.push(usage)
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
    const defaultInventoryByKey = new Map<string, DefaultSampleListItem>()
    for (const sample of defaultSamples()) {
      defaultInventoryByKey.set(sample.assetKey, sample)
    }

    const allKeys = new Set<string>([...inventoryByKey.keys(), ...usageByKey.keys()])

    const items: ProjectSampleListItem[] = []
    for (const key of allKeys) {
      const inv = inventoryByKey.get(key)
      const fallback = defaultInventoryByKey.get(key)
      const usages = usageByKey.get(key) ?? []
      const earliest = usages.reduce<ProjectSampleUsage | undefined>((current, candidate) => {
        if (!current) return candidate
        return candidate.startSec < current.startSec ? candidate : current
      }, undefined)
      const source = inv?.source ?? fallback?.source ?? earliest?.source
      if (!source) continue
      const url = inv?.url ?? fallback?.url
      if (!url) continue
      const sourceKind = inv?.sourceKind ?? fallback?.sourceKind ?? earliest?.sourceKind
      if (!sourceKind) continue
      const name = inv?.name || fallback?.name || earliest?.name || 'Sample'
      items.push({
        key,
        assetKey: inv?.assetKey ?? fallback?.assetKey ?? key,
        sourceKind,
        url,
        filePath: url,
        name,
        duration: source.durationSec,
        source,
        createdAt: inv?.createdAt ?? 0,
        ownerUserId: inv?.ownerUserId ?? '',
        count: usages.length,
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
    defaultSamples,
    refreshSamples: () => setRefreshKey((value) => value + 1),
  }
}
