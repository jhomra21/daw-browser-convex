import { createSamplerBufferCache, type AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionIdentity,
  sampledInstrumentRetainedBytes,
  validateSampledInstrumentBuffer,
  type SampledInstrumentBuffer,
} from '@daw-browser/audio-engine/sampled-instrument-region'
import type { GranularParams, SamplerParams, SamplerZone, TrackInstrumentParams } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { loadSampledInstrumentRegion, type SampledInstrumentRegionLoaderOptions } from '~/lib/sampled-instrument-region-loader'
import {
  createSampledInstrumentRegionBudget,
  type SampledInstrumentRegionBudget,
  type SampledInstrumentRegionPin,
} from '~/lib/sampled-instrument-region-budget'

export const DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES = 256 * 1024 * 1024

export type SamplerBufferSyncOptions = SampledInstrumentRegionLoaderOptions & {
  aggregateBudget?: SampledInstrumentRegionBudget
  aggregateMaxDecodedBytes?: number
}

const withSampledInstrumentIdentity = (
  value: SampledInstrumentBuffer,
  assetKey: string,
): SampledInstrumentBuffer & { assetKey: string } => {
  const next = { ...value, assetKey }
  if (value.sourceIdentity) Object.defineProperty(next, 'sourceIdentity', { value: value.sourceIdentity })
  return next
}

export type SamplerZoneLoadState = 'engine-miss' | 'loading' | 'ready' | 'error' | 'missing'
export type SamplerLoadStatus = {
  zones: ReadonlyMap<string, SamplerZoneLoadState>
  totalBytes: number
  maxBytes: number
  misses: number
  overBudgetPinned: boolean
}
export type GranularLoadStatus = {
  state: SamplerZoneLoadState
  totalBytes: number
  maxBytes: number
}

type RegionSpec = {
  key: string
  zone: SamplerZone
  sourceStartFrame: number
  sourceEndFrame: number
  bytes: number
}

type SamplerConfig = { params: SamplerParams; instanceId?: string; projectId: string }
type GranularConfig = { params: GranularParams; instanceId?: string; projectId: string }

const regionForZone = (zone: SamplerZone): RegionSpec => {
  const region = sampledInstrumentRegion(
    zone.sample.source,
    zone.startSec,
    zone.endSec ?? zone.sample.source.durationSec,
  )
  return {
    key: sampledInstrumentRegionIdentity(zone.sample, region),
    zone,
    ...region,
    bytes: sampledInstrumentRegionBytes(region, zone.sample.source.channelCount),
  }
}

const sameSample = (left: SamplerZone['sample'], right: SamplerZone['sample']) => (
  left.assetKey === right.assetKey
  && left.url === right.url
  && left.sourceKind === right.sourceKind
  && left.source.durationSec === right.source.durationSec
  && left.source.sampleRate === right.source.sampleRate
  && left.source.channelCount === right.source.channelCount
)

export function createSamplerBufferSync(options: SamplerBufferSyncOptions = {}) {
  const versions = new Map<Track['id'], number>()
  const abortControllers = new Map<Track['id'], AbortController>()
  const configs = new Map<Track['id'], SamplerConfig>()
  const granularConfigs = new Map<Track['id'], GranularConfig>()
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const granularEnginesByTrack = new Map<Track['id'], AudioEngine>()
  const samplerCaches = new Map<Track['id'], ReturnType<typeof createSamplerBufferCache<SampledInstrumentBuffer>>>()
  const granularCaches = new Map<Track['id'], ReturnType<typeof createSamplerBufferCache<SampledInstrumentBuffer>>>()
  const aggregate = options.aggregateBudget ?? createSampledInstrumentRegionBudget(
    options.aggregateMaxDecodedBytes ?? DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
  )
  const pending = new Map<string, {
    promise: Promise<SampledInstrumentBuffer | null>
    signal?: AbortSignal
  }>()
  const reservations = new Map<string, Set<{ release: () => void; commit: () => void }>>()
  const states = new Map<Track['id'], Map<string, SamplerZoneLoadState>>()
  const misses = new Map<Track['id'], number>()
  const granularStates = new Map<Track['id'], SamplerZoneLoadState>()
  const granularPins = new Map<Track['id'], {
    key: string
    cachePin: { release: () => void }
    pin: SampledInstrumentRegionPin
  }>()
  const activePins = new Map<string, Map<number, { cachePin: { release: () => void }; pin: SampledInstrumentRegionPin }>>()
  const listeners = new Set<() => void>()
  const listenerRemovers = new Map<AudioEngine, () => void>()
  let disposed = false

  const notify = () => {
    for (const listener of listeners) listener()
  }
  const installSamplerBuffers = (trackId: Track['id']) => {
    const config = configs.get(trackId)
    const engine = enginesByTrack.get(trackId)
    const cache = samplerCaches.get(trackId)
    if (!config || !engine || !cache) return
    const buffers = new Map<string, SampledInstrumentBuffer>()
    for (const zone of config.params.zones) {
      const region = regionForZone(zone)
      const value = cache.get(region.key)
      if (value) buffers.set(zone.id, value)
    }
    engine.setTrackSampler(trackId, config.params, buffers, config.instanceId)
  }
  const clearGranularRuntimeBuffer = (trackId: Track['id']) => {
    const engine = granularEnginesByTrack.get(trackId)
    const config = granularConfigs.get(trackId)
    if (engine && config) void engine.setTrackGranular(trackId, config.params, undefined, config.instanceId).catch(() => undefined)
  }
  const handleCacheEviction = (
    trackId: Track['id'],
    kind: 'sampler' | 'granular',
    key: string,
    releaseAggregate: boolean,
    version?: number,
  ) => {
    if (releaseAggregate) aggregate.release(`${kind}\u0000${trackId}\u0000${key}`)
    const caches = kind === 'sampler' ? samplerCaches : granularCaches
    caches.get(trackId)?.delete(key)
    if (version !== undefined && versions.get(trackId) !== version) return
    if (kind === 'sampler') {
      const next = states.get(trackId)
      let affectsCurrentConfig = false
      for (const zone of configs.get(trackId)?.params.zones ?? []) {
        if (regionForZone(zone).key !== key) continue
        next?.set(zone.id, 'missing')
        affectsCurrentConfig = true
      }
      if (affectsCurrentConfig) {
        installSamplerBuffers(trackId)
        notify()
      }
    } else {
      const zone = granularConfigs.get(trackId)?.params.zone
      if (zone && regionForZone(zone).key === key) {
        granularStates.set(trackId, 'missing')
        clearGranularRuntimeBuffer(trackId)
        notify()
      }
    }
  }
  const getCache = (
    trackId: Track['id'],
    maxBytes: number,
    kind: 'sampler' | 'granular',
  ) => {
    const caches = kind === 'sampler' ? samplerCaches : granularCaches
    const cacheMaxBytes = kind === 'granular'
      ? sampledInstrumentRetainedBytes(maxBytes, 2)
      : maxBytes
    const current = caches.get(trackId)
    if (current) {
      current.setMaxByteLength(cacheMaxBytes)
      return current
    }
    const cache = createSamplerBufferCache<SampledInstrumentBuffer>(
      cacheMaxBytes,
      (key) => handleCacheEviction(trackId, kind, key, true),
    )
    caches.set(trackId, cache)
    return cache
  }
  const getCached = (trackId: Track['id'], key: string, kind: 'sampler' | 'granular') => {
    const cache = (kind === 'sampler' ? samplerCaches : granularCaches).get(trackId)
    const value = cache?.get(key)
    if (value) aggregate.touch(`${kind}\u0000${trackId}\u0000${key}`)
    return value
  }
  const setState = (trackId: Track['id'], zoneId: string, state: SamplerZoneLoadState) => {
    const next = states.get(trackId) ?? new Map<string, SamplerZoneLoadState>()
    next.set(zoneId, state)
    states.set(trackId, next)
    notify()
  }
  const releaseGranularPin = (trackId: Track['id']) => {
    const key = granularPins.get(trackId)
    if (key) {
      key.cachePin.release()
      key.pin.release()
    }
    granularPins.delete(trackId)
  }
  const releaseActivePins = (trackId: Track['id']) => {
    const prefix = `sampler\u0000${trackId}\u0000`
    for (const [key, pins] of activePins) {
      if (!key.startsWith(prefix)) continue
      for (const { cachePin, pin } of pins.values()) {
        cachePin.release()
        pin.release()
      }
      activePins.delete(key)
    }
  }
  const releaseCache = (trackId: Track['id'], kind: 'sampler' | 'granular') => {
    const caches = kind === 'sampler' ? samplerCaches : granularCaches
    for (const key of caches.get(trackId)?.keys() ?? []) aggregate.release(`${kind}\u0000${trackId}\u0000${key}`)
    caches.delete(trackId)
  }
  const releaseTrackReservations = (trackId: Track['id']) => {
    for (const [key, owned] of reservations) {
      if (key.split('\u0000')[1] !== trackId) continue
      for (const reservation of owned) reservation.release()
      reservations.delete(key)
      pending.delete(key)
    }
  }
  const releaseReservationsForRequest = (key: string) => {
    const owned = reservations.get(key)
    if (!owned) return
    for (const reservation of owned) reservation.release()
    reservations.delete(key)
  }
  const loaderOptions = options
  const currentProjectId = () => options.projectId?.() ?? ''
  const loadRegion = (
    trackId: Track['id'],
    region: RegionSpec,
    maxBytes: number,
    kind: 'sampler' | 'granular',
    force = false,
  ) => {
    const config = kind === 'sampler' ? configs.get(trackId) : granularConfigs.get(trackId)
    const cache = getCache(trackId, maxBytes, kind)
    const key = `${kind}\u0000${trackId}\u0000${currentProjectId()}\u0000${region.key}`
    if (force) {
      pending.delete(key)
      releaseReservationsForRequest(key)
      options.resolveUrl?.(region.zone.sample.url)
    }
    const cached = getCached(trackId, region.key, kind)
    if (cached) {
      try {
        return Promise.resolve(validateSampledInstrumentBuffer(
          cached,
          region.zone.sample.source,
          region,
          region.key,
        ))
      } catch {
        cache.delete(region.key)
        aggregate.release(`${kind}\u0000${trackId}\u0000${region.key}`)
      }
    }
    const current = pending.get(key)
    if (current && !current.signal?.aborted) return current.promise
    if (current) {
      pending.delete(key)
      releaseReservationsForRequest(key)
    }
    const signal = abortControllers.get(trackId)?.signal
    const aggregateKey = `${kind}\u0000${trackId}\u0000${region.key}`
    const retainedBytes = kind === 'granular'
      ? sampledInstrumentRetainedBytes(region.bytes, 2)
      : region.bytes
    const reservation = aggregate.reserve(aggregateKey, retainedBytes)
    const owned = reservations.get(key) ?? new Set<{ release: () => void; commit: () => void }>()
    owned.add(reservation)
    reservations.set(key, owned)
    const forgetReservation = () => {
      const currentOwned = reservations.get(key)
      if (!currentOwned) return
      currentOwned.delete(reservation)
      if (currentOwned.size === 0) reservations.delete(key)
    }
    const request = loadSampledInstrumentRegion(
      {
        assetKey: region.zone.sample.assetKey,
        url: region.zone.sample.url,
        sourceKind: region.zone.sample.sourceKind,
        source: region.zone.sample.source,
      },
      { sourceStartFrame: region.sourceStartFrame, sourceEndFrame: region.sourceEndFrame },
      maxBytes,
      signal,
      loaderOptions,
    ).then((value) => {
      const currentConfig = kind === 'sampler' ? configs.get(trackId) : granularConfigs.get(trackId)
      const isCurrentRequest = pending.get(key)?.promise === request
      if (value && config && currentConfig === config && isCurrentRequest) {
        reservation.commit()
        forgetReservation()
        const version = versions.get(trackId)
        aggregate.set(aggregateKey, retainedBytes, () => {
          handleCacheEviction(trackId, kind, region.key, false, version)
        }, value.buffer)
        cache.set(region.key, value, region.bytes)
      } else {
        reservation.release()
        forgetReservation()
      }
      return value
    }).catch((cause) => {
      reservation.release()
      forgetReservation()
      throw cause
    }).finally(() => {
      if (pending.get(key)?.promise === request) pending.delete(key)
    })
    pending.set(key, { promise: request, signal })
    return request
  }
  const preflight = (
    trackId: Track['id'],
    regions: readonly RegionSpec[],
    maxBytes: number,
    kind: 'sampler' | 'granular',
  ) => {
    const cache = getCache(trackId, maxBytes, kind)
    const unique = new Map(regions.map((region) => [region.key, region]))
    const requestedKeys = new Set(unique.keys())
    const requestedBytes = [...unique.values()].reduce(
      (total, region) => total + (
        kind === 'granular'
          ? sampledInstrumentRetainedBytes(region.bytes, 2)
          : region.bytes
      ),
      0,
    )
    const pinnedBytesOutsideRequest = cache.pinnedKeys()
      .filter((key) => !requestedKeys.has(key))
      .reduce((total, key) => total + cache.byteLengthFor(key), 0)
    if (requestedBytes + pinnedBytesOutsideRequest > cache.maxByteLength()) {
      throw new Error(`${kind === 'sampler' ? 'Sampler' : 'Granular'} regions exceed the ${maxBytes} byte limit.`)
    }
    aggregate.ensureCapacityFor(new Map(
      [...unique.values()].map((region) => [
        `${kind}\u0000${trackId}\u0000${region.key}`,
        kind === 'granular'
          ? sampledInstrumentRetainedBytes(region.bytes, 2)
          : region.bytes,
      ]),
    ))
    return [...unique.values()]
  }
  const installRuntimeListeners = (engine: AudioEngine) => {
    if (listenerRemovers.has(engine)) return
    const remove = engine.addSamplerRuntimeListeners({
      onAssetUse: (use) => {
        const configured = enginesByTrack.get(use.trackId)
        if (configured !== engine) return
        const cache = samplerCaches.get(use.trackId)
        if (!cache) return
        const aggregateKey = `sampler\u0000${use.trackId}\u0000${use.regionKey}`
        if (use.active) {
          const cachePin = cache.pin(use.regionKey)
          if (!cachePin) return
          const pin = aggregate.pin(aggregateKey)
          if (!pin) {
            cachePin.release()
            return
          }
          const owned = activePins.get(aggregateKey) ?? new Map<number, { cachePin: { release: () => void }; pin: SampledInstrumentRegionPin }>()
          owned.set(use.voiceId, { cachePin, pin })
          activePins.set(aggregateKey, owned)
        } else {
          const owned = activePins.get(aggregateKey)
          const release = owned?.get(use.voiceId)
          owned?.delete(use.voiceId)
          release?.cachePin.release()
          release?.pin.release()
          if (owned && owned.size === 0) activePins.delete(aggregateKey)
        }
      },
      onNoteMiss: (miss) => {
        const configured = enginesByTrack.get(miss.trackId)
        if (configured !== engine) return
        misses.set(miss.trackId, (misses.get(miss.trackId) ?? 0) + 1)
        setState(miss.trackId, miss.zoneId, 'engine-miss')
        const config = configs.get(miss.trackId)
        const zone = config?.params.zones.find((candidate) => candidate.id === miss.zoneId)
        if (!config || !zone) return
        const version = versions.get(miss.trackId)
        void loadRegion(miss.trackId, regionForZone(zone), config.params.maxDecodedBytes, 'sampler')
          .then((value) => {
            if (disposed || versions.get(miss.trackId) !== version) return
            setState(miss.trackId, miss.zoneId, value ? 'ready' : 'missing')
            if (disposed || versions.get(miss.trackId) !== version) return
            installSamplerBuffers(miss.trackId)
          })
          .catch(() => {
            if (!disposed && versions.get(miss.trackId) === version) setState(miss.trackId, miss.zoneId, 'error')
          })
      },
    })
    listenerRemovers.set(engine, remove)
  }
  const clearTrack = (trackId: Track['id']) => {
    abortControllers.get(trackId)?.abort()
    abortControllers.delete(trackId)
    releaseTrackReservations(trackId)
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1)
    releaseActivePins(trackId)
    releaseGranularPin(trackId)
    configs.delete(trackId)
    granularConfigs.delete(trackId)
    enginesByTrack.delete(trackId)
    granularEnginesByTrack.delete(trackId)
    releaseCache(trackId, 'sampler')
    releaseCache(trackId, 'granular')
    states.delete(trackId)
    granularStates.delete(trackId)
    misses.delete(trackId)
    notify()
  }

  const syncTrack = async (engine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string) => {
    abortControllers.get(trackId)?.abort()
    releaseTrackReservations(trackId)
    const abortController = new AbortController()
    abortControllers.set(trackId, abortController)
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    disposed = false
    installRuntimeListeners(engine)
    enginesByTrack.set(trackId, engine)
    granularConfigs.delete(trackId)
    granularEnginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    releaseCache(trackId, 'granular')
    const projectId = currentProjectId()
    const previous = configs.get(trackId)
    if (previous && previous.projectId !== projectId) {
      releaseCache(trackId, 'sampler')
      states.delete(trackId)
    }
    const config = { params, instanceId, projectId }
    configs.set(trackId, config)
    getCache(trackId, params.maxDecodedBytes, 'sampler')
    const regions = params.zones.map(regionForZone)
    states.set(trackId, new Map(params.zones.map((zone) => [
      zone.id,
      getCached(trackId, regionForZone(zone).key, 'sampler') ? 'ready' : 'missing',
    ])))
    engine.setTrackSampler(trackId, params, new Map(), instanceId)
    installSamplerBuffers(trackId)
    if (params.cachePolicy !== 'preload') {
      notify()
      return
    }
    let unique: RegionSpec[]
    try {
      unique = preflight(trackId, regions, params.maxDecodedBytes, 'sampler')
    } catch (error) {
      for (const zone of params.zones) setState(trackId, zone.id, 'error')
      throw error
    }
    for (const region of unique) {
      if (disposed || versions.get(trackId) !== version) return
      for (const zone of params.zones.filter((candidate) => regionForZone(candidate).key === region.key)) {
        setState(trackId, zone.id, 'loading')
      }
      const value = await loadRegion(trackId, region, params.maxDecodedBytes, 'sampler')
      if (disposed || versions.get(trackId) !== version) return
      for (const zone of params.zones.filter((candidate) => regionForZone(candidate).key === region.key)) {
        setState(trackId, zone.id, value ? 'ready' : 'missing')
      }
    }
    installSamplerBuffers(trackId)
  }

  const syncGranularTrack = async (engine: AudioEngine, trackId: Track['id'], params: GranularParams, instanceId?: string) => {
    abortControllers.get(trackId)?.abort()
    releaseTrackReservations(trackId)
    const abortController = new AbortController()
    abortControllers.set(trackId, abortController)
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    installRuntimeListeners(engine)
    configs.delete(trackId)
    enginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    releaseCache(trackId, 'sampler')
    granularEnginesByTrack.set(trackId, engine)
    const projectId = currentProjectId()
    const previous = granularConfigs.get(trackId)
    if (previous && previous.projectId !== projectId) {
      releaseCache(trackId, 'granular')
      granularStates.delete(trackId)
    }
    granularConfigs.set(trackId, { params, instanceId, projectId })
    const zone = params.zone
    if (!zone) {
      granularStates.set(trackId, 'missing')
      notify()
      await engine.setTrackGranular(trackId, params, undefined, instanceId)
      return
    }
    const region = regionForZone(zone)
    const cache = getCache(trackId, params.maxDecodedBytes, 'granular')
    let value = getCached(trackId, region.key, 'granular')
    granularStates.set(trackId, value ? 'ready' : 'loading')
    try {
      preflight(trackId, [region], params.maxDecodedBytes, 'granular')
      value = value ?? (await loadRegion(trackId, region, params.maxDecodedBytes, 'granular') ?? undefined)
      if (disposed || versions.get(trackId) !== version) return
      await engine.setTrackGranular(
        trackId,
        params,
        value ? withSampledInstrumentIdentity(value, sampledInstrumentRegionIdentity(zone.sample, region)) : undefined,
        instanceId,
      )
      const cachePin = value ? cache.pin(region.key) : undefined
      if (cachePin) {
        const pin = aggregate.pin(`granular\u0000${trackId}\u0000${region.key}`)
        if (pin) granularPins.set(trackId, { key: region.key, cachePin, pin })
        else cachePin.release()
      }
      granularStates.set(trackId, value ? 'ready' : 'missing')
    } catch {
      if (!disposed && versions.get(trackId) === version) granularStates.set(trackId, 'error')
      throw new Error('Granular region installation failed.')
    } finally {
      notify()
    }
  }

  const matchesSampler = (trackId: string, instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>) => {
    const config = configs.get(trackId)
    return config
      && config.projectId === currentProjectId()
      && config.instanceId === instrument.instanceId
      && config.params.zones.length === instrument.params.zones.length
      && config.params.zones.every((zone, index) => {
        const candidate = instrument.params.zones[index]
        return candidate !== undefined && zone.id === candidate.id && sameSample(zone.sample, candidate.sample)
      })
  }
  return {
    clearTrack,
    syncTrack,
    syncGranularTrack,
    snapshotSamplerBuffers: (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>) => {
      if (!matchesSampler(trackId, instrument)) return undefined
      const cache = samplerCaches.get(trackId)
      if (!cache) return undefined
      const result = new Map<string, SampledInstrumentBuffer>()
      for (const zone of instrument.params.zones) {
        const region = regionForZone(zone)
        const cached = getCached(trackId, region.key, 'sampler')
        const value = cached && (() => {
          try {
            return validateSampledInstrumentBuffer(cached, zone.sample.source, region, region.key)
          } catch {
            return undefined
          }
        })()
        if (value) result.set(zone.id, value)
      }
      return result
    },
    snapshotGranularBuffer: (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>) => {
      const config = granularConfigs.get(trackId)
      const zone = config?.params.zone
      const current = instrument.params.zone
      if (!config || config.projectId !== currentProjectId() || !zone || !current || config.instanceId !== instrument.instanceId || !sameSample(zone.sample, current.sample)) return undefined
      const granularRegion = regionForZone(current)
      const cached = getCached(trackId, granularRegion.key, 'granular')
      const value = cached && (() => {
        try {
          return validateSampledInstrumentBuffer(cached, current.sample.source, granularRegion, granularRegion.key)
        } catch {
          return undefined
        }
      })()
      return value
        ? withSampledInstrumentIdentity(value, sampledInstrumentRegionIdentity(current.sample, granularRegion))
        : undefined
    },
    retryZone: (engine: AudioEngine, trackId: Track['id'], zoneId: string) => {
      const config = configs.get(trackId)
      const zone = config?.params.zones.find((candidate) => candidate.id === zoneId)
      if (!config || !zone) return Promise.resolve()
      void engine
      const version = versions.get(trackId)
      return loadRegion(trackId, regionForZone(zone), config.params.maxDecodedBytes, 'sampler', true)
        .then((value) => {
          if (disposed || versions.get(trackId) !== version) return
          setState(trackId, zoneId, value ? 'ready' : 'missing')
          installSamplerBuffers(trackId)
        })
        .catch(() => {
          if (!disposed && versions.get(trackId) === version) setState(trackId, zoneId, 'error')
        })
    },
    retryGranular: (engine: AudioEngine, trackId: Track['id']) => {
      const config = granularConfigs.get(trackId)
      if (config) void syncGranularTrack(engine, trackId, config.params, config.instanceId).catch(() => undefined)
    },
    getGranularStatus: (trackId: Track['id']): GranularLoadStatus => {
      const cache = granularCaches.get(trackId)
      return { state: granularStates.get(trackId) ?? 'missing', totalBytes: cache?.byteLength() ?? 0, maxBytes: cache?.maxByteLength() ?? 0 }
    },
    getStatus: (trackId: Track['id']): SamplerLoadStatus => {
      const cache = samplerCaches.get(trackId)
      return { zones: states.get(trackId) ?? new Map(), totalBytes: cache?.byteLength() ?? 0, maxBytes: cache?.maxByteLength() ?? 0, misses: misses.get(trackId) ?? 0, overBudgetPinned: cache?.overBudgetPinned() ?? false }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      for (const remove of listenerRemovers.values()) remove()
      listenerRemovers.clear()
      versions.clear()
      configs.clear()
      granularConfigs.clear()
      enginesByTrack.clear()
      granularEnginesByTrack.clear()
      for (const trackId of granularPins.keys()) releaseGranularPin(trackId)
      for (const pins of activePins.values()) for (const { cachePin, pin } of pins.values()) {
        cachePin.release()
        pin.release()
      }
      for (const trackId of samplerCaches.keys()) releaseCache(trackId, 'sampler')
      for (const trackId of granularCaches.keys()) releaseCache(trackId, 'granular')
      samplerCaches.clear()
      granularCaches.clear()
      pending.clear()
      for (const owned of reservations.values()) {
        for (const reservation of owned) reservation.release()
      }
      reservations.clear()
      for (const controller of abortControllers.values()) controller.abort()
      abortControllers.clear()
      states.clear()
      granularStates.clear()
      activePins.clear()
      listeners.clear()
    },
  }
}
