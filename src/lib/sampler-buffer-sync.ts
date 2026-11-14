import { createSamplerBufferCache, type AudioEngine, type EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionIdentity,
  sampledInstrumentRetainedBytes,
  validateSampledInstrumentBuffer,
  type SampledInstrumentBuffer,
} from '@daw-browser/audio-engine/sampled-instrument-region'
import { serializeSamplerParams, type GranularParams, type SamplerParams, type SamplerZone, type TrackInstrumentParams } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { loadSampledInstrumentRegion, type SampledInstrumentRegionLoaderOptions } from '~/lib/sampled-instrument-region-loader'
import {
  createSampledInstrumentRegionBudget,
  type SampledInstrumentRegionBudget,
  type SampledInstrumentRegionPin,
} from '~/lib/sampled-instrument-region-budget'
import { SampledInstrumentSyncSupersededError } from '~/lib/sampled-instrument-sync-error'
import { nativeInstrumentDeviceDecodedBytes, type NativeInstrumentPreparation } from '~/lib/desktop/native-instrument-budget-policy'

export const DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES = 256 * 1024 * 1024

export type SamplerBufferSyncOptions = SampledInstrumentRegionLoaderOptions & {
  aggregateBudget?: SampledInstrumentRegionBudget
  aggregateMaxDecodedBytes?: number
  nativeAudio?: () => boolean
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
  errors: ReadonlyMap<string, string>
  totalBytes: number
  maxBytes: number
  misses: number
  overBudgetPinned: boolean
}
export type GranularLoadStatus = {
  state: SamplerZoneLoadState
  error?: string
  totalBytes: number
  maxBytes: number
}
export type NativeInstrumentRetryIdentity = {
  trackId: Track['id']
  projectId: string
  version: number
  instanceId?: string
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
  // The latest sampler sync per track: joined while it loads, skipped once it installed with nothing failed.
  const samplerSyncs = new Map<Track['id'], { key: string; applied: boolean; promise: Promise<EngineDisposition> }>()
  const granularConfigs = new Map<Track['id'], GranularConfig>()
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const granularEnginesByTrack = new Map<Track['id'], AudioEngine>()
  const samplerCaches = new Map<Track['id'], ReturnType<typeof createSamplerBufferCache<SampledInstrumentBuffer>>>()
  const granularCaches = new Map<Track['id'], ReturnType<typeof createSamplerBufferCache<SampledInstrumentBuffer>>>()
  const cacheProjects = new Map<string, string>()
  const aggregate = options.aggregateBudget ?? createSampledInstrumentRegionBudget(
    options.aggregateMaxDecodedBytes ?? DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
  )
  const pending = new Map<string, {
    promise: Promise<Awaited<ReturnType<typeof loadSampledInstrumentRegion>>>
    signal?: AbortSignal
    retain: Set<() => void>
  }>()
  const reservations = new Map<string, Set<{ release: () => void; commit: () => void }>>()
  const states = new Map<Track['id'], Map<string, SamplerZoneLoadState>>()
  const samplerErrors = new Map<Track['id'], Map<string, string>>()
  const misses = new Map<Track['id'], number>()
  const granularStates = new Map<Track['id'], SamplerZoneLoadState>()
  const granularErrors = new Map<Track['id'], string>()
  const nativePreparation = new Map<string, NativeInstrumentPreparation>()
  const missingSampleErrors = new Map<Track['id'], Map<string, string>>()
  const missingSampleAssetKeys = new Map<Track['id'], Set<string>>()
  const decodedLimit = (portableLimit: number) => options.nativeAudio?.()
    ? nativeInstrumentDeviceDecodedBytes : portableLimit
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
  ) => {
    if (releaseAggregate) aggregate.release(`${kind}\u0000${trackId}\u0000${key}`)
    const caches = kind === 'sampler' ? samplerCaches : granularCaches
    caches.get(trackId)?.delete(key)
    if (kind === 'sampler') {
      const next = states.get(trackId)
      let affectsCurrentConfig = false
      for (const zone of configs.get(trackId)?.params.zones ?? []) {
        if (regionForZone(zone).key !== key) continue
        next?.set(zone.id, 'missing')
        affectsCurrentConfig = true
      }
      if (affectsCurrentConfig) {
        // The sync that loaded this region no longer proves the track holds it.
        samplerSyncs.delete(trackId)
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
    const projectKey = `${kind}\u0000${trackId}`
    if (cacheProjects.get(projectKey) !== currentProjectId()) releaseCache(trackId, kind)
    cacheProjects.set(projectKey, currentProjectId())
    const cacheMaxBytes = kind === 'granular' && !options.nativeAudio?.()
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
    cacheProjects.delete(`${kind}\u0000${trackId}`)
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
  const clearMissingSamples = (trackId: Track['id']) => {
    missingSampleErrors.delete(trackId)
    missingSampleAssetKeys.delete(trackId)
  }
  const loadRegion = async (
    trackId: Track['id'],
    region: RegionSpec,
    maxBytes: number,
    kind: 'sampler' | 'granular',
    force = false,
    retain?: () => void,
  ) => {
    const projectId = currentProjectId()
    maxBytes = decodedLimit(maxBytes)
    const cache = getCache(trackId, maxBytes, kind)
    const key = `${kind}\u0000${trackId}\u0000${currentProjectId()}\u0000${region.key}`
    if (force) {
      pending.delete(key)
      releaseReservationsForRequest(key)
      cache.delete(region.key)
      aggregate.release(`${kind}\u0000${trackId}\u0000${region.key}`)
      options.resolveUrl?.(region.zone.sample.url)
    }
    const cached = getCached(trackId, region.key, kind)
    if (cached) {
      try {
        const buffer = validateSampledInstrumentBuffer(cached, region.zone.sample.source, region, region.key)
        retain?.()
        return Promise.resolve({
          status: 'ready',
          buffer,
        } satisfies { status: 'ready'; buffer: SampledInstrumentBuffer })
      } catch {
        cache.delete(region.key)
        aggregate.release(`${kind}\u0000${trackId}\u0000${region.key}`)
      }
    }
    const current = pending.get(key)
    if (current && !current.signal?.aborted) {
      if (retain) current.retain.add(retain)
      return current.promise
    }
    if (current) {
      pending.delete(key)
      releaseReservationsForRequest(key)
    }
    const signal = abortControllers.get(trackId)?.signal
    const retainers = new Set(retain ? [retain] : [])
    const aggregateKey = `${kind}\u0000${trackId}\u0000${region.key}`
    const retainedBytes = kind === 'granular' && !options.nativeAudio?.()
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
    ).then((result) => {
      const isCurrentRequest = pending.get(key)?.promise === request
      if (result.status === 'ready' && !disposed && currentProjectId() === projectId
        && (kind === 'sampler' ? samplerCaches : granularCaches).get(trackId) === cache && isCurrentRequest) {
        // Identity changes/retries invalidate readiness before decoding starts.
        // A late decode for that same identity must not erase its native ACK.
        reservation.commit()
        forgetReservation()
        // The budget drops this callback with the entry, so it answers for the cached entry's lifetime, not for one sync's.
        aggregate.set(aggregateKey, retainedBytes, () => {
          handleCacheEviction(trackId, kind, region.key, false)
        }, result.buffer.buffer)
        cache.set(region.key, result.buffer, region.bytes)
        // Compile pins are acquired before any await continuation can admit a competing load.
        for (const retain of retainers) retain()
      } else {
        reservation.release()
        forgetReservation()
      }
      return result
    }).catch((cause) => {
      reservation.release()
      forgetReservation()
      throw cause
    }).finally(() => {
      if (pending.get(key)?.promise === request) pending.delete(key)
    })
    pending.set(key, { promise: request, signal, retain: retainers })
    return request
  }
  const preflight = (
    trackId: Track['id'],
    regions: readonly RegionSpec[],
    maxBytes: number,
    kind: 'sampler' | 'granular',
  ) => {
    maxBytes = decodedLimit(maxBytes)
    const cache = getCache(trackId, maxBytes, kind)
    const unique = new Map(regions.map((region) => [region.key, region]))
    const requestedKeys = new Set(unique.keys())
    const requestedBytes = [...unique.values()].reduce(
      (total, region) => total + (
        kind === 'granular' && !options.nativeAudio?.()
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
        kind === 'granular' && !options.nativeAudio?.()
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
        missingSampleErrors.get(miss.trackId)?.delete(zone.sample.assetKey)
        missingSampleAssetKeys.get(miss.trackId)?.delete(zone.sample.assetKey)
        void loadRegion(miss.trackId, regionForZone(zone), config.params.maxDecodedBytes, 'sampler')
          .then((result) => {
            if (disposed || versions.get(miss.trackId) !== version) return
            if (result.status === 'ready') {
              samplerErrors.get(miss.trackId)?.delete(miss.zoneId)
              missingSampleErrors.get(miss.trackId)?.delete(zone.sample.assetKey)
              missingSampleAssetKeys.get(miss.trackId)?.delete(zone.sample.assetKey)
              setState(miss.trackId, miss.zoneId, 'ready')
            } else if (result.status === 'missing') {
              const sampleName = zone.sample.name ?? zone.sample.assetKey
              const error = `"${sampleName}" is missing. Restore the file and retry.`
              samplerErrors.get(miss.trackId)?.set(miss.zoneId, error)
              const errors = missingSampleErrors.get(miss.trackId) ?? new Map<string, string>()
              errors.set(zone.sample.assetKey, error)
              missingSampleErrors.set(miss.trackId, errors)
              const keys = missingSampleAssetKeys.get(miss.trackId) ?? new Set<string>()
              keys.add(zone.sample.assetKey)
              missingSampleAssetKeys.set(miss.trackId, keys)
              setState(miss.trackId, miss.zoneId, 'error')
            }
            if (disposed || versions.get(miss.trackId) !== version) return
            installSamplerBuffers(miss.trackId)
          })
          .catch((cause) => {
            if (!disposed && versions.get(miss.trackId) === version) {
              samplerErrors.get(miss.trackId)?.set(miss.zoneId, cause instanceof Error ? cause.message : 'Sampler region loading failed.')
              setState(miss.trackId, miss.zoneId, 'error')
            }
          })
      },
    })
    listenerRemovers.set(engine, remove)
  }
  const clearTrack = (trackId: Track['id']) => {
    abortControllers.get(trackId)?.abort()
    abortControllers.delete(trackId)
    samplerSyncs.delete(trackId)
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
    samplerErrors.delete(trackId)
    granularStates.delete(trackId)
    granularErrors.delete(trackId)
    misses.delete(trackId)
    nativePreparation.delete(trackId)
    missingSampleErrors.delete(trackId)
    missingSampleAssetKeys.delete(trackId)
    notify()
  }

  const runSyncTrack = async (engine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string): Promise<EngineDisposition> => {
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
    const identityChanged = previous === undefined
      || previous.projectId !== projectId
      || previous.instanceId !== instanceId
      || previous.params.zones.length !== params.zones.length
      || previous.params.zones.some((zone, index) => {
        const next = params.zones[index]
        return !next || regionForZone(zone).key !== regionForZone(next).key
      })
    if (identityChanged) {
      clearMissingSamples(trackId)
      nativePreparation.delete(trackId)
    }
    if (previous && previous.projectId !== projectId) {
      releaseCache(trackId, 'sampler')
      states.delete(trackId)
    }
    const config = { params, instanceId, projectId }
    configs.set(trackId, config)
    getCache(trackId, decodedLimit(params.maxDecodedBytes), 'sampler')
    if (!previous || previous.projectId !== projectId
      || previous.instanceId !== instanceId
      || previous.params.zones.length !== params.zones.length
      || previous.params.zones.some((zone, index) => {
        const next = params.zones[index]
        return !next || regionForZone(zone).key !== regionForZone(next).key
      })) nativePreparation.delete(trackId)
    const regions = params.zones.map(regionForZone)
    const requestedAssetKeys = new Set(params.zones.map((zone) => zone.sample.assetKey))
    for (const assetKey of missingSampleErrors.get(trackId)?.keys() ?? []) {
      if (!requestedAssetKeys.has(assetKey)) missingSampleErrors.get(trackId)?.delete(assetKey)
    }
    for (const assetKey of missingSampleAssetKeys.get(trackId) ?? []) {
      if (!requestedAssetKeys.has(assetKey)) missingSampleAssetKeys.get(trackId)?.delete(assetKey)
    }
    states.set(trackId, new Map(params.zones.map((zone) => [
      zone.id,
      getCached(trackId, regionForZone(zone).key, 'sampler') ? 'ready' : 'missing',
    ])))
    samplerErrors.set(trackId, new Map())
    engine.setTrackSampler(trackId, params, new Map(), instanceId)
    installSamplerBuffers(trackId)
    if (params.cachePolicy !== 'preload' && !options.nativeAudio?.()) {
      notify()
      return 'applied'
    }
    let unique: RegionSpec[]
    try {
      unique = preflight(trackId, regions, params.maxDecodedBytes, 'sampler')
    } catch (error) {
      for (const zone of params.zones) {
        samplerErrors.get(trackId)?.set(zone.id, error instanceof Error ? error.message : 'Sampler memory admission failed.')
        setState(trackId, zone.id, 'error')
      }
      throw error
    }
    for (const region of unique) {
      if (disposed || versions.get(trackId) !== version) return 'superseded'
      for (const zone of params.zones.filter((candidate) => regionForZone(candidate).key === region.key)) {
        setState(trackId, zone.id, 'loading')
        missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
        missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
      }
      let result: Awaited<ReturnType<typeof loadSampledInstrumentRegion>>
      try {
        result = await loadRegion(trackId, region, params.maxDecodedBytes, 'sampler')
      } catch (error) {
        if (disposed || versions.get(trackId) !== version) throw error
        const message = error instanceof Error ? error.message : 'Sampler region installation failed.'
        for (const zone of params.zones.filter((candidate) => regionForZone(candidate).key === region.key)) {
          samplerErrors.get(trackId)?.set(zone.id, message)
          setState(trackId, zone.id, 'error')
        }
        throw error
      }
      if (disposed || versions.get(trackId) !== version) return 'superseded'
      for (const zone of params.zones.filter((candidate) => regionForZone(candidate).key === region.key)) {
        if (result.status === 'ready') {
          missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
          missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
          setState(trackId, zone.id, 'ready')
        } else if (result.status === 'missing') {
          const sampleName = zone.sample.name ?? zone.sample.assetKey
          const error = `"${sampleName}" is missing. Restore the file and retry.`
          samplerErrors.get(trackId)?.set(zone.id, error)
          const errors = missingSampleErrors.get(trackId) ?? new Map<string, string>()
          errors.set(zone.sample.assetKey, error)
          missingSampleErrors.set(trackId, errors)
          const keys = missingSampleAssetKeys.get(trackId) ?? new Set<string>()
          keys.add(zone.sample.assetKey)
          missingSampleAssetKeys.set(trackId, keys)
          setState(trackId, zone.id, 'error')
        }
      }
    }
    installSamplerBuffers(trackId)
    return 'applied'
  }

  const samplerHasFailure = (trackId: Track['id']) =>
    (samplerErrors.get(trackId)?.size ?? 0) > 0 || (missingSampleErrors.get(trackId)?.size ?? 0) > 0

  const syncTrack = (engine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string): Promise<EngineDisposition> => {
    const key = JSON.stringify([currentProjectId(), instanceId, serializeSamplerParams(params)])
    const held = samplerSyncs.get(trackId)
    if (held?.key === key && enginesByTrack.get(trackId) === engine) {
      // 'joined' only when the joined load installed; a superseded one is this request's outcome too.
      if (!held.applied) return held.promise.then((disposition): EngineDisposition => disposition === 'applied' ? 'joined' : disposition)
      if (engine.getTrackInstrumentKind(trackId) === 'sampler' && !samplerHasFailure(trackId)) return Promise.resolve('skipped')
    }
    const previousController = abortControllers.get(trackId)
    let startReplacement = () => {}
    const replacement = new Promise<EngineDisposition>((resolve, reject) => {
      startReplacement = () => {
        void runSyncTrack(engine, trackId, params, instanceId).then(resolve, reject)
      }
    })
    const entry = { key, applied: false, promise: replacement }
    samplerSyncs.set(trackId, entry)
    void replacement.then((disposition) => {
      if (samplerSyncs.get(trackId) === entry) entry.applied = disposition === 'applied'
    }, () => {
      if (samplerSyncs.get(trackId) === entry) samplerSyncs.delete(trackId)
    })
    previousController?.abort(new SampledInstrumentSyncSupersededError(replacement))
    startReplacement()
    return replacement
  }

  const runSyncGranularTrack = async (
    engine: AudioEngine,
    trackId: Track['id'],
    params: GranularParams,
    instanceId?: string,
    force = false,
  ): Promise<EngineDisposition> => {
    disposed = false
    releaseTrackReservations(trackId)
    const abortController = new AbortController()
    abortControllers.set(trackId, abortController)
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    installRuntimeListeners(engine)
    configs.delete(trackId)
    samplerSyncs.delete(trackId)
    enginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    releaseCache(trackId, 'sampler')
    granularEnginesByTrack.set(trackId, engine)
    const projectId = currentProjectId()
    const previous = granularConfigs.get(trackId)
    const previousZone = previous?.params.zone
    const nextZone = params.zone
    const identityChanged = previous === undefined
      || previous.projectId !== projectId
      || previous.instanceId !== instanceId
      || previousZone === undefined
      || nextZone === undefined
      || regionForZone(previousZone).key !== regionForZone(nextZone).key
    if (identityChanged) {
      clearMissingSamples(trackId)
      nativePreparation.delete(trackId)
    }
    if (previous && previous.projectId !== projectId) {
      releaseCache(trackId, 'granular')
      granularStates.delete(trackId)
    }
    granularConfigs.set(trackId, { params, instanceId, projectId })
    granularErrors.delete(trackId)
    const zone = params.zone
    if (!force) {
      const keep = zone ? new Set([zone.sample.assetKey]) : new Set<string>()
      for (const assetKey of missingSampleErrors.get(trackId)?.keys() ?? []) {
        if (!keep.has(assetKey)) missingSampleErrors.get(trackId)?.delete(assetKey)
      }
      for (const assetKey of missingSampleAssetKeys.get(trackId) ?? []) {
        if (!keep.has(assetKey)) missingSampleAssetKeys.get(trackId)?.delete(assetKey)
      }
    }
    if (!zone) {
      granularStates.set(trackId, 'missing')
      notify()
      return engine.setTrackGranular(trackId, params, undefined, instanceId)
    }
    const region = regionForZone(zone)
    const cache = getCache(trackId, decodedLimit(params.maxDecodedBytes), 'granular')
    missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
    missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
    if (!previous || previous.projectId !== projectId || previous.instanceId !== instanceId
      || !previous.params.zone || regionForZone(previous.params.zone).key !== region.key) nativePreparation.delete(trackId)
    let value = getCached(trackId, region.key, 'granular')
    granularStates.set(trackId, value ? 'ready' : 'loading')
    try {
      preflight(trackId, [region], params.maxDecodedBytes, 'granular')
      const result = force
        ? await loadRegion(trackId, region, params.maxDecodedBytes, 'granular', true)
        : value
          ? { status: 'ready', buffer: value } satisfies { status: 'ready'; buffer: SampledInstrumentBuffer }
          : await loadRegion(trackId, region, params.maxDecodedBytes, 'granular')
      if (abortController.signal.reason instanceof SampledInstrumentSyncSupersededError) {
        throw abortController.signal.reason
      }
      if (disposed || abortController.signal.aborted) return 'dropped'
      value = result.status === 'ready' ? result.buffer : undefined
      // Native preparation owns publication; never allocate/copy a browser
      // granular worklet sample under the portable limit on this explicit path.
      const disposition = options.nativeAudio?.()
        ? 'dropped'
        : await engine.setTrackGranular(
          trackId,
          params,
          value ? withSampledInstrumentIdentity(value, sampledInstrumentRegionIdentity(zone.sample, region)) : undefined,
          instanceId,
        )
      if (abortController.signal.reason instanceof SampledInstrumentSyncSupersededError) {
        throw abortController.signal.reason
      }
      if (disposed || abortController.signal.aborted) return 'dropped'
      const cachePin = value ? cache.pin(region.key) : undefined
      if (cachePin) {
        const pin = aggregate.pin(`granular\u0000${trackId}\u0000${region.key}`)
        if (pin) granularPins.set(trackId, { key: region.key, cachePin, pin })
        else cachePin.release()
      }
      if (value) {
        granularErrors.delete(trackId)
        missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
        missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
        granularStates.set(trackId, 'ready')
      } else if (result.status === 'missing') {
        const sampleName = zone.sample.name ?? zone.sample.assetKey
        const error = `"${sampleName}" is missing. Restore the file and retry.`
        granularErrors.set(trackId, error)
        missingSampleErrors.set(trackId, new Map([[zone.sample.assetKey, error]]))
        missingSampleAssetKeys.set(trackId, new Set([zone.sample.assetKey]))
        granularStates.set(trackId, 'error')
      }
      return disposition
    } catch (cause) {
      if (cause instanceof SampledInstrumentSyncSupersededError) throw cause
      if (disposed || abortController.signal.aborted) return 'dropped'
      const error = cause instanceof Error ? cause.message : 'Granular region installation failed.'
      granularStates.set(trackId, 'error')
      granularErrors.set(trackId, error)
      throw new Error(error)
    } finally {
      notify()
    }
  }

  const syncGranularTrack = (
    engine: AudioEngine,
    trackId: Track['id'],
    params: GranularParams,
    instanceId?: string,
    force = false,
  ): Promise<EngineDisposition> => {
    const previousController = abortControllers.get(trackId)
    let startReplacement = () => {}
    const replacement = new Promise<EngineDisposition>((resolve, reject) => {
      startReplacement = () => {
        void runSyncGranularTrack(engine, trackId, params, instanceId, force).then(resolve, reject)
      }
    })
    previousController?.abort(new SampledInstrumentSyncSupersededError(replacement))
    startReplacement()
    return replacement
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
    setNativePreparation: (trackId: string, status: NativeInstrumentPreparation) => {
      nativePreparation.set(trackId, status)
      notify()
    },
    clearTrack,
    syncTrack,
    syncGranularTrack,
    hydrationInputs: (instrument: Extract<TrackInstrumentParams, { kind: 'sampler' | 'granular' }>) => ({
      kind: instrument.kind,
      instanceId: instrument.instanceId,
      maxDecodedBytes: decodedLimit(instrument.params.maxDecodedBytes),
      zones: (instrument.kind === 'sampler' ? instrument.params.zones
        : instrument.params.zone ? [instrument.params.zone] : [])
        .map(zone => [zone.id, regionForZone(zone).key]),
    }),
    loadBuffers: async (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'sampler' | 'granular' }>) => {
      if (!abortControllers.get(trackId) || abortControllers.get(trackId)?.signal.aborted) {
        abortControllers.set(trackId, new AbortController())
      }
      const kind = instrument.kind
      const params = instrument.params
      const zones = instrument.kind === 'sampler' ? instrument.params.zones
        : instrument.params.zone ? [instrument.params.zone] : []
      const cache = getCache(trackId, decodedLimit(params.maxDecodedBytes), kind)
      const pins: { release: () => void }[] = []
      const release = () => { for (const pin of pins.splice(0)) pin.release() }
      const buffers = new Map<string, SampledInstrumentBuffer>()
      const unavailableSampleAssetKeys: string[] = []
      try {
        const regions = preflight(trackId, zones.map(regionForZone), params.maxDecodedBytes, kind)
        const loaded = new Map<string, SampledInstrumentBuffer>()
        for (const region of regions) {
          const result = await loadRegion(trackId, region, params.maxDecodedBytes, kind, false, () => {
            const cachePin = cache.pin(region.key)
            const aggregatePin = aggregate.pin(`${kind}\u0000${trackId}\u0000${region.key}`)
            if (cachePin) pins.push(cachePin)
            if (aggregatePin) pins.push(aggregatePin)
            if (!cachePin || !aggregatePin) throw new Error('Projected sampled region was not retained.')
          })
          if (result.status === 'ready') {
            if (getCached(trackId, region.key, kind) !== result.buffer) throw new Error('Projected sampled region was invalidated.')
            loaded.set(region.key, result.buffer)
          }
          else unavailableSampleAssetKeys.push(region.zone.sample.assetKey)
        }
        for (const zone of zones) {
          const value = loaded.get(regionForZone(zone).key)
          if (value) buffers.set(zone.id, value)
        }
        const currentZone = instrument.kind === 'granular' ? instrument.params.zone : undefined
        const value = currentZone ? buffers.get(currentZone.id) : undefined
        return {
          samplerBuffers: kind === 'sampler' ? buffers : undefined,
          granularBuffer: value && currentZone
            ? withSampledInstrumentIdentity(value, regionForZone(currentZone).key) : undefined,
          unavailableSampleAssetKeys,
          release,
        }
      } catch (cause) { release(); throw cause }
    },
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
    snapshotUnavailableAssetKeys: (trackId: Track['id'], instrument: TrackInstrumentParams) => {
      if (instrument.kind === 'sampler') {
        if (!matchesSampler(trackId, instrument)) return undefined
        return [...(missingSampleAssetKeys.get(trackId) ?? [])]
          .filter((assetKey) => instrument.params.zones.some((zone) => zone.sample.assetKey === assetKey))
      }
      if (instrument.kind === 'granular') {
        const config = granularConfigs.get(trackId)
        const currentZone = instrument.params.zone
        if (!config || config.projectId !== currentProjectId() || config.instanceId !== instrument.instanceId
          || !config.params.zone || !currentZone || !sameSample(config.params.zone.sample, currentZone.sample)) return undefined
        return [...(missingSampleAssetKeys.get(trackId) ?? [])].filter((assetKey) => assetKey === currentZone.sample.assetKey)
      }
      return undefined
    },
    retryZone: (
      engine: AudioEngine,
      trackId: Track['id'],
      zoneId: string,
      retryNativePreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>,
    ) => {
      const config = configs.get(trackId)
      const zone = config?.params.zones.find((candidate) => candidate.id === zoneId)
      if (!config || !zone) return Promise.resolve()
      void engine
      const version = versions.get(trackId)
      const projectId = currentProjectId()
      const retryIdentity = { trackId, projectId, version: version ?? 0, instanceId: config.instanceId }
      if (options.nativeAudio?.()) {
        nativePreparation.set(trackId, { state: 'loading' })
        samplerErrors.get(trackId)?.delete(zoneId)
        notify()
      }
      missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
      missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
      return loadRegion(trackId, regionForZone(zone), config.params.maxDecodedBytes, 'sampler', true)
        .then(async (result) => {
          if (disposed || versions.get(trackId) !== version) return
          if (result.status === 'ready') {
            samplerErrors.get(trackId)?.delete(zoneId)
            missingSampleErrors.get(trackId)?.delete(zone.sample.assetKey)
            missingSampleAssetKeys.get(trackId)?.delete(zone.sample.assetKey)
            setState(trackId, zoneId, 'ready')
          } else if (result.status === 'missing') {
            const sampleName = zone.sample.name ?? zone.sample.assetKey
            const error = `"${sampleName}" is missing. Restore the file and retry.`
            samplerErrors.get(trackId)?.set(zoneId, error)
            const errors = missingSampleErrors.get(trackId) ?? new Map<string, string>()
            errors.set(zone.sample.assetKey, error)
            missingSampleErrors.set(trackId, errors)
            const keys = missingSampleAssetKeys.get(trackId) ?? new Set<string>()
            keys.add(zone.sample.assetKey)
            missingSampleAssetKeys.set(trackId, keys)
            setState(trackId, zoneId, 'error')
          }
          installSamplerBuffers(trackId)
          if (result.status === 'ready' && options.nativeAudio?.()
            && versions.get(trackId) === version
            && configs.get(trackId)?.params === config.params
            && configs.get(trackId)?.instanceId === config.instanceId
            && configs.get(trackId)?.projectId === projectId
            && currentProjectId() === projectId) {
            await retryNativePreparation?.(retryIdentity)
          }
        })
        .catch((cause) => {
          if (!disposed && versions.get(trackId) === version) {
            samplerErrors.get(trackId)?.set(zoneId, cause instanceof Error ? cause.message : 'Sampler region loading failed.')
            setState(trackId, zoneId, 'error')
            if (options.nativeAudio?.()) {
              nativePreparation.set(trackId, {
                state: 'error',
                error: cause instanceof Error ? cause.message : 'Native sample preparation failed.',
              })
            }
          }
        })
    },
    retryGranular: (
      engine: AudioEngine,
      trackId: Track['id'],
      retryNativePreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>,
    ) => {
      const config = granularConfigs.get(trackId)
      if (config) {
        const projectId = currentProjectId()
        if (options.nativeAudio?.()) {
          nativePreparation.set(trackId, { state: 'loading' })
          granularErrors.delete(trackId)
          notify()
        }
        const request = syncGranularTrack(engine, trackId, config.params, config.instanceId, true)
        const version = versions.get(trackId)
        const retryIdentity = { trackId, projectId, version: version ?? 0, instanceId: config.instanceId }
        return request
          .then(async () => {
            if (options.nativeAudio?.()
              && granularStates.get(trackId) === 'ready'
              && versions.get(trackId) === version
              && granularConfigs.get(trackId)?.params === config.params
              && granularConfigs.get(trackId)?.instanceId === config.instanceId
              && granularConfigs.get(trackId)?.projectId === projectId
              && currentProjectId() === projectId) {
              await retryNativePreparation?.(retryIdentity)
            }
          })
          .catch(() => undefined)
      }
      return Promise.resolve()
    },
    getGranularStatus: (trackId: Track['id']): GranularLoadStatus => {
      const cache = granularCaches.get(trackId)
      const native = options.nativeAudio?.() ? nativePreparation.get(trackId) : undefined
      const decoded = granularStates.get(trackId) ?? 'missing'
      const assetKey = granularConfigs.get(trackId)?.params.zone?.sample.assetKey
      const missingError = assetKey ? missingSampleErrors.get(trackId)?.get(assetKey) : undefined
      return { state: decoded === 'ready' && options.nativeAudio?.() ? native?.state ?? 'loading' : decoded,
        error: missingError ?? native?.error ?? granularErrors.get(trackId), totalBytes: cache?.byteLength() ?? 0, maxBytes: cache?.maxByteLength() ?? 0 }
    },
    getStatus: (trackId: Track['id']): SamplerLoadStatus => {
      const cache = samplerCaches.get(trackId)
      const native = options.nativeAudio?.() ? nativePreparation.get(trackId) : undefined
      const zones = new Map(states.get(trackId) ?? [])
      const errors = new Map(samplerErrors.get(trackId) ?? [])
      if (options.nativeAudio?.()) for (const [id, state] of zones) {
        if (state === 'ready') zones.set(id, native?.state ?? 'loading')
        if (native?.error) errors.set(id, native.error)
      }
      for (const [id, error] of missingSampleErrors.get(trackId) ?? []) {
        for (const zone of configs.get(trackId)?.params.zones ?? []) {
          if (zone.sample.assetKey === id) {
            zones.set(zone.id, 'error')
            errors.set(zone.id, error)
          }
        }
      }
      return { zones, errors, totalBytes: cache?.byteLength() ?? 0, maxBytes: cache?.maxByteLength() ?? 0, misses: misses.get(trackId) ?? 0, overBudgetPinned: cache?.overBudgetPinned() ?? false }
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
      samplerSyncs.clear()
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
      nativePreparation.clear()
      granularStates.clear()
      activePins.clear()
      listeners.clear()
    },
  }
}
