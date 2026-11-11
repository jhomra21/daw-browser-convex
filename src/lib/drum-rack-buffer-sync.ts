import type { AudioEngine, EngineDisposition } from '@daw-browser/audio-engine/audio-engine'
import { DRUM_RACK_MAX_DECODED_BYTES } from '@daw-browser/audio-engine/drum-rack-runtime'
import {
  sampledInstrumentRegion,
  sampledInstrumentRegionBytes,
  sampledInstrumentRegionIdentity,
  validateSampledInstrumentBuffer,
  type SampledInstrumentBuffer,
} from '@daw-browser/audio-engine/sampled-instrument-region'
import type { DrumRackPadSample, DrumRackParams, TrackInstrumentParams } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import {
  loadSampledInstrumentRegion,
  type SampledInstrumentRegionLoadResult,
  type SampledInstrumentRegionLoaderOptions,
} from '~/lib/sampled-instrument-region-loader'
import { DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES } from '~/lib/sampler-buffer-sync'
import { SampledInstrumentSyncSupersededError } from '~/lib/sampled-instrument-sync-error'
import {
  createSampledInstrumentRegionBudget,
  type SampledInstrumentRegionBudget,
  type SampledInstrumentRegionPin,
} from '~/lib/sampled-instrument-region-budget'
import { createSamplerBufferCache } from '@daw-browser/audio-engine/audio-engine'
import { nativeInstrumentDeviceDecodedBytes, type NativeInstrumentPreparation } from '~/lib/desktop/native-instrument-budget-policy'
import type { NativeInstrumentRetryIdentity } from '~/lib/sampler-buffer-sync'

export type DrumRackBufferSyncOptions = SampledInstrumentRegionLoaderOptions & {
  isCurrentProject?: () => boolean
  aggregateBudget?: SampledInstrumentRegionBudget
  aggregateMaxDecodedBytes?: number
  nativeAudio?: () => boolean
}

type CacheEntry = {
  key: string
  projectId: string
  instanceId?: string
  buffers: ReadonlyMap<string, SampledInstrumentBuffer>
  regionKeys: ReadonlyMap<string, string>
  unavailableSampleAssetKeys: readonly string[]
}

const regionForSample = (sample: DrumRackPadSample, startSec: number, endSec?: number) => {
  const region = sampledInstrumentRegion(sample.source, startSec, endSec ?? sample.source.durationSec)
  return {
    region,
    key: sampledInstrumentRegionIdentity(sample, region),
    bytes: sampledInstrumentRegionBytes(region, sample.source.channelCount),
  }
}

export function createDrumRackBufferSync(options: DrumRackBufferSyncOptions = {}) {
  const loaderOptions = options
  const cache = new Map<Track['id'], CacheEntry>()
  const regionCaches = new Map<Track['id'], ReturnType<typeof createSamplerBufferCache<SampledInstrumentBuffer>>>()
  const cacheProjects = new Map<Track['id'], string>()
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const paramsByTrack = new Map<Track['id'], DrumRackParams>()
  const versions = new Map<Track['id'], number>()
  const abortControllers = new Map<Track['id'], AbortController>()
  const pending = new Map<string, {
    promise: Promise<SampledInstrumentRegionLoadResult>
    signal?: AbortSignal
    retain: Set<() => void>
  }>()
  const aggregate = options.aggregateBudget ?? createSampledInstrumentRegionBudget(
    options.aggregateMaxDecodedBytes ?? DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
  )
  const reservations = new Map<string, Set<{ release: () => void; commit: () => void }>>()
  const pinned = new Map<string, Map<number, { cachePin: { release: () => void }; pin: SampledInstrumentRegionPin }>>()
  const retired = new Set<string>()
  const listenerRemovers = new Map<AudioEngine, () => void>()
  const listeners = new Set<() => void>()
  const nativePreparation = new Map<string, NativeInstrumentPreparation>()
  const missingSampleErrors = new Map<string, Map<string, string>>()
  const decodedLimit = () => options.nativeAudio?.() ? nativeInstrumentDeviceDecodedBytes : DRUM_RACK_MAX_DECODED_BYTES
  let disposed = false
  const notify = () => {
    for (const listener of listeners) listener()
  }

  const aggregateKey = (trackId: string, regionKey: string) => `drum\u0000${trackId}\u0000${regionKey}`
  const forgetReservation = (requestKey: string, reservation: { release: () => void; commit: () => void }) => {
    const owned = reservations.get(requestKey)
    if (!owned) return
    owned.delete(reservation)
    if (owned.size === 0) reservations.delete(requestKey)
  }
  const releaseTrackReservations = (trackId: string) => {
    for (const [requestKey, owned] of reservations) {
      if (!requestKey.split('\u0000')[1] || requestKey.split('\u0000')[1] !== trackId) continue
      for (const reservation of owned) reservation.release()
      reservations.delete(requestKey)
    }
  }
  const releaseTrackCache = (
    trackId: string,
    keep: ReadonlySet<string> = new Set(),
    force = false,
  ) => {
    const regionCache = regionCaches.get(trackId)
    for (const regionKey of regionCache?.keys() ?? []) {
      if (keep.has(regionKey)) continue
      const key = aggregateKey(trackId, regionKey)
      if (!force && (pinned.get(key)?.size ?? 0) > 0) {
        retired.add(key)
        continue
      }
      aggregate.release(key)
      pinned.delete(key)
      retired.delete(key)
      regionCache?.delete(regionKey)
    }
  }

  const isCurrentRegion = (trackId: Track['id'], regionKey: string) => (
    paramsByTrack.get(trackId)?.pads.some((pad) => (
      pad.sample !== undefined
      && regionForSample(pad.sample, pad.startSec, pad.endSec).key === regionKey
    )) ?? false
  )

  const releaseRetiredRegion = (trackId: Track['id'], regionKey: string) => {
    const key = aggregateKey(trackId, regionKey)
    if (!retired.has(key) || isCurrentRegion(trackId, regionKey)) return
    retired.delete(key)
    regionCaches.get(trackId)?.delete(regionKey)
  }
  const releaseActivePins = (trackId: Track['id']) => {
    const prefix = `drum\u0000${trackId}\u0000`
    for (const [key, pins] of pinned) {
      if (!key.startsWith(prefix)) continue
      for (const { cachePin, pin } of pins.values()) {
        cachePin.release()
        pin.release()
      }
      pinned.delete(key)
    }
  }

  const markEvicted = (trackId: Track['id'], regionKey: string) => {
    const entry = cache.get(trackId)
    if (!entry) return
    const buffers = new Map(entry.buffers)
    for (const [padId, key] of entry.regionKeys) {
      if (key === regionKey) buffers.delete(padId)
    }
    cache.set(trackId, { ...entry, buffers })
    const engine = enginesByTrack.get(trackId)
    const params = paramsByTrack.get(trackId)
    if (engine && params) engine.setTrackDrumRack(trackId, params, buffers)
    notify()
  }
  const installRuntimeListeners = (engine: AudioEngine) => {
    if (listenerRemovers.has(engine)) return
    const remove = engine.addSamplerRuntimeListeners({
      onDrumRackAssetUse: (use) => {
        const configured = enginesByTrack.get(use.trackId)
        if (configured !== engine) return
        const key = aggregateKey(use.trackId, use.regionKey)
        if (use.active) {
          const regionCache = regionCaches.get(use.trackId)
          const cachePin = regionCache?.pin(use.regionKey)
          if (!cachePin) return
          const pin = aggregate.pin(key)
          if (!pin) {
            cachePin.release()
            return
          }
          const owned = pinned.get(key) ?? new Map<number, { cachePin: { release: () => void }; pin: SampledInstrumentRegionPin }>()
          owned.set(use.hitId, { cachePin, pin })
          pinned.set(key, owned)
          return
        }
        const owned = pinned.get(key)
        const release = owned?.get(use.hitId)
        owned?.delete(use.hitId)
        release?.cachePin.release()
        release?.pin.release()
        if (!owned || owned.size === 0) {
          pinned.delete(key)
          releaseRetiredRegion(use.trackId, use.regionKey)
        }
      },
    })
    listenerRemovers.set(engine, remove)
  }
  const getRegionCache = (trackId: Track['id']) => {
    if (cacheProjects.get(trackId) !== projectId()) {
      releaseTrackCache(trackId, new Set(), true)
      regionCaches.delete(trackId)
    }
    cacheProjects.set(trackId, projectId())
    const current = regionCaches.get(trackId)
    if (current) return current
    const created = createSamplerBufferCache<SampledInstrumentBuffer>(
      decodedLimit(),
      (regionKey) => {
        aggregate.release(aggregateKey(trackId, regionKey))
        regionCaches.get(trackId)?.delete(regionKey)
        markEvicted(trackId, regionKey)
      },
    )
    regionCaches.set(trackId, created)
    return created
  }
  const projectId = () => options.projectId?.() ?? ''
  const loadRegion = (
    trackId: Track['id'],
    sample: DrumRackPadSample,
    regional: ReturnType<typeof regionForSample>,
    retain?: () => void,
  ) => {
    const projectKey = projectId()
    const regionCache = getRegionCache(trackId)
    const value = regionCache.get(regional.key)
    if (value) {
      try {
        const buffer = validateSampledInstrumentBuffer(value, sample.source, regional.region, regional.key)
        aggregate.touch(aggregateKey(trackId, regional.key))
        retain?.()
        return Promise.resolve({ status: 'ready', buffer } satisfies SampledInstrumentRegionLoadResult)
      } catch {
        regionCache.delete(regional.key)
        aggregate.release(aggregateKey(trackId, regional.key))
      }
    }
    const requestKey = `${projectKey}\u0000${trackId}\u0000${regional.key}`
    const existingRequest = pending.get(requestKey)
    if (existingRequest && !existingRequest.signal?.aborted) {
      if (retain) existingRequest.retain.add(retain)
      return existingRequest.promise
    }
    const signal = abortControllers.get(trackId)?.signal
    const retainers = new Set(retain ? [retain] : [])
    const reservation = aggregate.reserve(aggregateKey(trackId, regional.key), regional.bytes)
    const request = loadSampledInstrumentRegion(
      sample, regional.region, decodedLimit(), signal, loaderOptions,
    ).then((result) => {
      if (result.status !== 'ready' || disposed || projectId() !== projectKey
        || regionCaches.get(trackId) !== regionCache || pending.get(requestKey)?.promise !== request) {
        reservation.release()
        return result
      }
      reservation.commit()
      aggregate.set(aggregateKey(trackId, regional.key), regional.bytes, () => {
        regionCache.delete(regional.key)
        markEvicted(trackId, regional.key)
      }, result.buffer.buffer)
      regionCache.set(regional.key, result.buffer, regional.bytes)
      // Retain before another completed load can evict this compile's region.
      for (const retain of retainers) retain()
      return result
    }).catch((cause) => {
      reservation.release()
      throw cause
    }).finally(() => {
      if (pending.get(requestKey)?.promise === request) pending.delete(requestKey)
      forgetReservation(requestKey, reservation)
    })
    const owned = reservations.get(requestKey) ?? new Set<{ release: () => void; commit: () => void }>()
    owned.add(reservation)
    reservations.set(requestKey, owned)
    pending.set(requestKey, { promise: request, signal, retain: retainers })
    return request
  }
  const clearTrack = (trackId: Track['id']) => {
    enginesByTrack.get(trackId)?.clearTrackDrumRack(trackId)
    abortControllers.get(trackId)?.abort()
    abortControllers.delete(trackId)
    releaseActivePins(trackId)
    releaseTrackReservations(trackId)
    releaseTrackCache(trackId, new Set(), true)
    cache.delete(trackId)
    nativePreparation.delete(trackId)
    missingSampleErrors.delete(trackId)
    regionCaches.delete(trackId)
    cacheProjects.delete(trackId)
    for (const key of retired) {
      if (key.startsWith(`drum\u0000${trackId}\u0000`)) retired.delete(key)
    }
    enginesByTrack.delete(trackId)
    paramsByTrack.delete(trackId)
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1)
    notify()
  }
  const runSyncTrack = async (engine: AudioEngine, trackId: Track['id'], params: DrumRackParams, instanceId?: string): Promise<EngineDisposition> => {
    if (disposed || options.isCurrentProject?.() === false) return 'dropped'
    const abortController = new AbortController()
    abortControllers.set(trackId, abortController)
    releaseTrackReservations(trackId)
    const projectKey = projectId()
    const previous = cache.get(trackId)
    const key = params.pads.map((pad) => {
      if (!pad.sample) return `${pad.id}:`
      return `${pad.id}:${regionForSample(pad.sample, pad.startSec, pad.endSec).key}`
    }).join('\n')
    const identityChanged = previous !== undefined
      && (previous.projectId !== projectKey
        || previous.instanceId !== instanceId
        || previous.key !== key)
    if (identityChanged) missingSampleErrors.delete(trackId)
    if (previous && previous.projectId !== projectKey) {
      engine.clearTrackDrumRack(trackId)
      releaseTrackCache(trackId, new Set(), true)
      regionCaches.get(trackId)?.clear()
      cache.delete(trackId)
    }
    const version = (versions.get(trackId) ?? 0) + 1
    if (!previous || previous.projectId !== projectKey || previous.instanceId !== instanceId
      || params.pads.some((pad) => pad.sample
        && previous.regionKeys.get(pad.id) !== regionForSample(pad.sample, pad.startSec, pad.endSec).key)
      || previous.regionKeys.size !== params.pads.filter((pad) => pad.sample).length) nativePreparation.delete(trackId)
    versions.set(trackId, version)
    enginesByTrack.set(trackId, engine)
    paramsByTrack.set(trackId, params)
    installRuntimeListeners(engine)
    const jobs = params.pads.flatMap((pad) => {
      if (!pad.sample) return []
      const regional = regionForSample(pad.sample, pad.startSec, pad.endSec)
      return [{ pad, sample: pad.sample, regional }]
    })
    const unique = new Map(jobs.map((job) => [job.regional.key, job]))
    const padsByRegion = new Map<string, DrumRackParams['pads'][number][]>()
    for (const job of jobs) {
      const pads = padsByRegion.get(job.regional.key) ?? []
      pads.push(job.pad)
      padsByRegion.set(job.regional.key, pads)
    }
    const resultingBytes = [...unique.values()].reduce((total, job) => total + job.regional.bytes, 0)
    if (resultingBytes > decodedLimit()) {
      throw new Error(`Drum Rack regions exceed the ${decodedLimit()} byte limit.`)
    }
    const requestedRegionKeys = new Set(unique.keys())
    releaseTrackCache(trackId, requestedRegionKeys)
    const regionCache = getRegionCache(trackId)
    const cachedRegionKeys = new Set(regionCache.keys())
    if ([...unique.values()].some((job) => !cachedRegionKeys.has(job.regional.key))) cache.delete(trackId)
    aggregate.ensureCapacityFor(
      new Map(
        [...unique.values()].map((job) => [aggregateKey(trackId, job.regional.key), job.regional.bytes]),
      ),
    )
    const missingSampleAssetKeys = new Set<string>()
    const missingErrors = new Map(missingSampleErrors.get(trackId) ?? [])
    const publishMissingErrors = () => {
      if (missingErrors.size > 0) missingSampleErrors.set(trackId, missingErrors)
      else missingSampleErrors.delete(trackId)
    }
    const requestedAssetKeys = new Set([...unique.values()].map((job) => job.sample.assetKey))
    for (const assetKey of missingErrors.keys()) {
      if (!requestedAssetKeys.has(assetKey)) missingErrors.delete(assetKey)
    }
    const existingByRegion = new Map<string, SampledInstrumentBuffer>()
    for (const job of jobs) {
      const regionKey = job.regional.key
      const value = regionCache.get(regionKey)
      if (!value) continue
      missingErrors.delete(job.sample.assetKey)
      aggregate.touch(aggregateKey(trackId, regionKey))
      try {
        existingByRegion.set(
          regionKey,
          validateSampledInstrumentBuffer(value, job.sample.source, job.regional.region, job.regional.key),
        )
      } catch {
        regionCache.delete(regionKey)
        aggregate.release(aggregateKey(trackId, regionKey))
      }
    }
    const buffers = new Map<string, SampledInstrumentBuffer>()
    const regionKeys = new Map<string, string>()
    for (const job of unique.values()) {
      const value = existingByRegion.get(job.regional.key)
      if (value) {
        aggregate.touch(aggregateKey(trackId, job.regional.key))
        for (const pad of padsByRegion.get(job.regional.key) ?? []) {
          buffers.set(pad.id, value)
          regionKeys.set(pad.id, job.regional.key)
        }
      }
    }
    engine.setTrackDrumRack(trackId, params, buffers)
    for (const job of unique.values()) {
      if (disposed) return 'dropped'
      if (versions.get(trackId) !== version) return 'superseded'
      const existingValue = existingByRegion.get(job.regional.key)
      if (existingValue) {
        continue
      }
      missingErrors.delete(job.sample.assetKey)
      let result: SampledInstrumentRegionLoadResult
      try {
        result = await loadRegion(trackId, job.sample, job.regional)
      } catch (cause) {
        if (cause instanceof SampledInstrumentSyncSupersededError) throw cause
        if (disposed || abortController.signal.aborted) return 'dropped'
        if (versions.get(trackId) !== version) return 'superseded'
        if (projectId() === projectKey && options.isCurrentProject?.() !== false) publishMissingErrors()
        throw cause
      }
      if (result.status !== 'ready' || disposed || versions.get(trackId) !== version || options.isCurrentProject?.() === false) {
        if (result.status === 'missing' && versions.get(trackId) === version) {
          const sampleName = job.sample.name ?? job.sample.assetKey
          const assetKey = job.sample.assetKey
          missingSampleAssetKeys.add(assetKey)
          missingErrors.set(assetKey, `"${sampleName}" is missing. Restore the file and retry.`)
        }
        continue
      }
      missingErrors.delete(job.sample.assetKey)
      for (const pad of padsByRegion.get(job.regional.key) ?? []) {
        if (regionCache.get(job.regional.key)) buffers.set(pad.id, result.buffer)
        regionKeys.set(pad.id, job.regional.key)
      }
    }
    const retainedBuffers = new Map<string, SampledInstrumentBuffer>()
    const retainedRegionKeys = new Map<string, string>()
    for (const pad of params.pads) {
      if (!pad.sample) continue
      const regionKey = regionForSample(pad.sample, pad.startSec, pad.endSec).key
      const value = regionCache.get(regionKey)
      if (value) {
        retainedBuffers.set(pad.id, value)
        retainedRegionKeys.set(pad.id, regionKey)
      }
    }
    if (disposed || options.isCurrentProject?.() === false || projectId() !== projectKey) return 'dropped'
    if (versions.get(trackId) !== version) return 'superseded'
    publishMissingErrors()
    if (missingErrors.size > 0) nativePreparation.set(trackId, { state: 'error', error: [...missingErrors.values()].join(' ') })
    cache.set(trackId, {
      projectId: projectKey,
      key,
      instanceId,
      buffers: retainedBuffers,
      regionKeys: retainedRegionKeys,
      unavailableSampleAssetKeys: [...missingSampleAssetKeys],
    })
    const disposition = engine.setTrackDrumRack(trackId, params, retainedBuffers)
    notify()
    return disposition
  }
  const syncTrack = (engine: AudioEngine, trackId: Track['id'], params: DrumRackParams, instanceId?: string): Promise<EngineDisposition> => {
    if (disposed || options.isCurrentProject?.() === false) return Promise.resolve('dropped')
    const previousController = abortControllers.get(trackId)
    let startReplacement = () => {}
    const replacement = new Promise<EngineDisposition>((resolve, reject) => {
      startReplacement = () => {
        void runSyncTrack(engine, trackId, params, instanceId).then(resolve, reject)
      }
    })
    previousController?.abort(new SampledInstrumentSyncSupersededError(replacement))
    startReplacement()
    return replacement
  }
  return {
    retryTrack: async (
      engine: AudioEngine,
      trackId: Track['id'],
      params: DrumRackParams,
      instanceId: string | undefined,
      retryNativePreparation?: (identity: NativeInstrumentRetryIdentity) => Promise<void>,
    ) => {
      const projectKey = projectId()
      // Missing results are not cached: re-sync re-reads them while loaded pads keep playing.
      nativePreparation.set(trackId, { state: 'loading' })
      notify()
      const request = syncTrack(engine, trackId, params, instanceId)
      const version = versions.get(trackId)
      try {
        await request
        if (disposed || versions.get(trackId) !== version || projectId() !== projectKey
          || paramsByTrack.get(trackId) !== params) return
        if (nativePreparation.get(trackId)?.state === 'error') return
        await retryNativePreparation?.({ trackId, projectId: projectKey, version: version ?? 0, instanceId })
      } catch (cause) {
        if (!disposed && versions.get(trackId) === version && projectId() === projectKey) {
          nativePreparation.set(trackId, {
            state: 'error',
            error: cause instanceof Error
              ? cause.message
              : 'Drum Rack sample preparation failed. Retry to reload the sample.',
          })
          notify()
        }
      }
    },
    setNativePreparation: (trackId: string, status: NativeInstrumentPreparation) => {
      nativePreparation.set(trackId, status)
      notify()
    },
    getNativePreparation: (trackId: string) => {
      if (!options.nativeAudio?.() || !paramsByTrack.get(trackId)?.pads.some((pad) => pad.sample)) return undefined
      const missingErrors = missingSampleErrors.get(trackId)
      return missingErrors?.size
        ? { state: 'error', error: [...missingErrors.values()].join(' ') } satisfies NativeInstrumentPreparation
        : nativePreparation.get(trackId) ?? { state: 'loading' satisfies NativeInstrumentPreparation['state'] }
    },
    clearTrack,
    dispose: () => {
      disposed = true
      for (const trackId of new Set([...cache.keys(), ...enginesByTrack.keys()])) {
        enginesByTrack.get(trackId)?.clearTrackDrumRack(trackId)
        releaseActivePins(trackId)
        releaseTrackCache(trackId, new Set(), true)
      }
      for (const owned of reservations.values()) {
        for (const reservation of owned) reservation.release()
      }
      reservations.clear()
      pinned.clear()
      retired.clear()
      cache.clear()
      nativePreparation.clear()
      missingSampleErrors.clear()
      regionCaches.clear()
      cacheProjects.clear()
      versions.clear()
      pending.clear()
      for (const controller of abortControllers.values()) controller.abort()
      abortControllers.clear()
      for (const remove of listenerRemovers.values()) remove()
      listenerRemovers.clear()
      enginesByTrack.clear()
      paramsByTrack.clear()
      listeners.clear()
    },
    hydrationInputs: (instrument: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>) => ({
      kind: instrument.kind,
      instanceId: instrument.instanceId,
      maxDecodedBytes: decodedLimit(),
      pads: instrument.params.pads.map(pad => [
        pad.id, pad.sample ? regionForSample(pad.sample, pad.startSec, pad.endSec).key : undefined,
      ]),
    }),
    loadBuffers: async (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>) => {
      if (!abortControllers.get(trackId) || abortControllers.get(trackId)?.signal.aborted) {
        abortControllers.set(trackId, new AbortController())
      }
      const regionCache = getRegionCache(trackId)
      const pins: { release: () => void }[] = []
      const release = () => { for (const pin of pins.splice(0)) pin.release() }
      const buffers = new Map<string, SampledInstrumentBuffer>()
      const unavailableSampleAssetKeys = new Set<string>()
      const jobs = instrument.params.pads.flatMap(pad => pad.sample
        ? [{ padId: pad.id, sample: pad.sample, regional: regionForSample(pad.sample, pad.startSec, pad.endSec) }] : [])
      const unique = new Map(jobs.map(job => [job.regional.key, job]))
      try {
        const bytes = [...unique.values()].reduce((total, job) => total + job.regional.bytes, 0)
        if (bytes > decodedLimit()) throw new Error(`Drum Rack regions exceed the ${decodedLimit()} byte limit.`)
        aggregate.ensureCapacityFor(new Map([...unique.values()].map(job => [aggregateKey(trackId, job.regional.key), job.regional.bytes])))
        const loaded = new Map<string, SampledInstrumentBuffer>()
        for (const job of unique.values()) {
          const result = await loadRegion(trackId, job.sample, job.regional, () => {
            const cachePin = regionCache.pin(job.regional.key)
            const aggregatePin = aggregate.pin(aggregateKey(trackId, job.regional.key))
            if (cachePin) pins.push(cachePin)
            if (aggregatePin) pins.push(aggregatePin)
            if (!cachePin || !aggregatePin) throw new Error('Projected drum region was not retained.')
          })
          if (result.status === 'ready') {
            if (regionCache.get(job.regional.key) !== result.buffer) throw new Error('Projected drum region was invalidated.')
            loaded.set(job.regional.key, result.buffer)
          }
          else unavailableSampleAssetKeys.add(job.sample.assetKey)
        }
        for (const job of jobs) {
          const value = loaded.get(job.regional.key)
          if (value) buffers.set(job.padId, value)
        }
        return { drumRackBuffers: buffers, unavailableSampleAssetKeys: [...unavailableSampleAssetKeys], release }
      } catch (cause) { release(); throw cause }
    },
    snapshotBuffers: (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>) => {
      const entry = cache.get(trackId)
      if (entry?.projectId !== projectId()) return undefined
      const key = instrument.params.pads.map((pad) => {
        if (!pad.sample) return `${pad.id}:`
        return `${pad.id}:${regionForSample(pad.sample, pad.startSec, pad.endSec).key}`
      }).join('\n')
      if (entry?.key !== key || entry.instanceId !== instrument.instanceId) return undefined
      const valid = new Map<string, SampledInstrumentBuffer>()
      const unavailableSampleAssetKeys = new Set(entry.unavailableSampleAssetKeys)
      for (const pad of instrument.params.pads) {
        const sample = pad.sample
        const value = sample ? entry.buffers.get(pad.id) : undefined
        if (!sample) continue
        if (!value) {
          if (unavailableSampleAssetKeys.has(sample.assetKey)) continue
          return undefined
        }
        const region = regionForSample(sample, pad.startSec, pad.endSec)
        try {
          aggregate.touch(aggregateKey(trackId, region.key))
          valid.set(pad.id, validateSampledInstrumentBuffer(value, sample.source, region.region, region.key))
        } catch {
          return undefined
        }
      }
      return { buffers: valid, unavailableSampleAssetKeys: [...unavailableSampleAssetKeys] }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    syncTrack: (...args: Parameters<typeof syncTrack>) => {
      const projectKey = projectId()
      const request = syncTrack(...args)
      const version = versions.get(args[1])
      return request.catch((cause) => {
        if (disposed || versions.get(args[1]) !== version || projectKey !== projectId()) throw cause
        if (options.nativeAudio?.()) {
          nativePreparation.set(args[1], { state: 'error', error: cause instanceof Error ? cause.message : 'Drum Rack sample preparation failed.' })
          notify()
        }
        throw cause
      })
    },
  }
}
