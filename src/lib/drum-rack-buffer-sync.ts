import type { AudioEngine } from '@daw-browser/audio-engine/audio-engine'
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
import { loadSampledInstrumentRegion, type SampledInstrumentRegionLoaderOptions } from '~/lib/sampled-instrument-region-loader'
import { DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES } from '~/lib/sampler-buffer-sync'
import {
  createSampledInstrumentRegionBudget,
  type SampledInstrumentRegionBudget,
  type SampledInstrumentRegionPin,
} from '~/lib/sampled-instrument-region-budget'
import { createSamplerBufferCache } from '@daw-browser/audio-engine/audio-engine'

export type DrumRackBufferSyncOptions = SampledInstrumentRegionLoaderOptions & {
  isCurrentProject?: () => boolean
  aggregateBudget?: SampledInstrumentRegionBudget
  aggregateMaxDecodedBytes?: number
}

type CacheEntry = {
  key: string
  projectId: string
  instanceId?: string
  buffers: ReadonlyMap<string, SampledInstrumentBuffer>
  regionKeys: ReadonlyMap<string, string>
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
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const paramsByTrack = new Map<Track['id'], DrumRackParams>()
  const versions = new Map<Track['id'], number>()
  const abortControllers = new Map<Track['id'], AbortController>()
  const pending = new Map<string, {
    promise: Promise<SampledInstrumentBuffer | null>
    signal: AbortSignal
  }>()
  const aggregate = options.aggregateBudget ?? createSampledInstrumentRegionBudget(
    options.aggregateMaxDecodedBytes ?? DEFAULT_SAMPLED_INSTRUMENT_AGGREGATE_BYTES,
  )
  const reservations = new Map<string, Set<{ release: () => void; commit: () => void }>>()
  const pinned = new Map<string, Map<number, { cachePin: { release: () => void }; pin: SampledInstrumentRegionPin }>>()
  const retired = new Set<string>()
  const listenerRemovers = new Map<AudioEngine, () => void>()
  const listeners = new Set<() => void>()
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
    const current = regionCaches.get(trackId)
    if (current) return current
    const created = createSamplerBufferCache<SampledInstrumentBuffer>(
      DRUM_RACK_MAX_DECODED_BYTES,
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
  const clearTrack = (trackId: Track['id']) => {
    enginesByTrack.get(trackId)?.clearTrackDrumRack(trackId)
    abortControllers.get(trackId)?.abort()
    abortControllers.delete(trackId)
    releaseActivePins(trackId)
    releaseTrackReservations(trackId)
    releaseTrackCache(trackId, new Set(), true)
    cache.delete(trackId)
    regionCaches.delete(trackId)
    for (const key of retired) {
      if (key.startsWith(`drum\u0000${trackId}\u0000`)) retired.delete(key)
    }
    enginesByTrack.delete(trackId)
    paramsByTrack.delete(trackId)
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1)
    notify()
  }
  const syncTrack = async (engine: AudioEngine, trackId: Track['id'], params: DrumRackParams, instanceId?: string) => {
    if (disposed || options.isCurrentProject?.() === false) return
    abortControllers.get(trackId)?.abort()
    const abortController = new AbortController()
    abortControllers.set(trackId, abortController)
    releaseTrackReservations(trackId)
    const projectKey = projectId()
    const previous = cache.get(trackId)
    if (previous && previous.projectId !== projectKey) {
      engine.clearTrackDrumRack(trackId)
      releaseTrackCache(trackId, new Set(), true)
      regionCaches.get(trackId)?.clear()
      cache.delete(trackId)
    }
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    enginesByTrack.set(trackId, engine)
    paramsByTrack.set(trackId, params)
    installRuntimeListeners(engine)
    const jobs = params.pads.flatMap((pad) => {
      if (!pad.sample) return []
      const regional = regionForSample(pad.sample, pad.startSec, pad.endSec)
      return [{ pad, regional }]
    })
    const unique = new Map(jobs.map((job) => [job.regional.key, job]))
    const padsByRegion = new Map<string, DrumRackParams['pads'][number][]>()
    for (const job of jobs) {
      const pads = padsByRegion.get(job.regional.key) ?? []
      pads.push(job.pad)
      padsByRegion.set(job.regional.key, pads)
    }
    const resultingBytes = [...unique.values()].reduce((total, job) => total + job.regional.bytes, 0)
    if (resultingBytes > DRUM_RACK_MAX_DECODED_BYTES) {
      throw new Error(`Drum Rack regions exceed the ${DRUM_RACK_MAX_DECODED_BYTES} byte limit.`)
    }
    const requestedRegionKeys = new Set(unique.keys())
    releaseTrackCache(trackId, requestedRegionKeys)
    const regionCache = getRegionCache(trackId)
    aggregate.ensureCapacityFor(
      new Map(
        [...unique.values()].map((job) => [aggregateKey(trackId, job.regional.key), job.regional.bytes]),
      ),
    )
    const existingByRegion = new Map<string, SampledInstrumentBuffer>()
    for (const job of jobs) {
      const regionKey = job.regional.key
      const value = regionCache.get(regionKey)
      if (!value) continue
      aggregate.touch(aggregateKey(trackId, regionKey))
      try {
        existingByRegion.set(
          regionKey,
          validateSampledInstrumentBuffer(value, job.pad.sample!.source, job.regional.region, job.regional.key),
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
      if (disposed || versions.get(trackId) !== version) return
      const existingValue = existingByRegion.get(job.regional.key)
      if (existingValue) {
        continue
      }
      const requestKey = `${projectKey}\u0000${trackId}\u0000${job.regional.key}`
      const existingRequest = pending.get(requestKey)
      const canReuseRequest = existingRequest && !existingRequest.signal.aborted
      let request: Promise<SampledInstrumentBuffer | null>
      if (canReuseRequest) {
        request = existingRequest.promise
      } else {
        const reservation = aggregate.reserve(aggregateKey(trackId, job.regional.key), job.regional.bytes)
        request = loadSampledInstrumentRegion(
          {
            assetKey: job.pad.sample?.assetKey ?? '',
            url: job.pad.sample?.url ?? '',
            sourceKind: job.pad.sample?.sourceKind ?? 'upload',
            source: job.pad.sample?.source ?? { durationSec: 0, sampleRate: 1, channelCount: 1 },
          },
          job.regional.region,
          DRUM_RACK_MAX_DECODED_BYTES,
          abortController.signal,
          loaderOptions,
        ).then((value) => {
          if (!value || disposed || versions.get(trackId) !== version) {
            reservation.release()
            return value
          }
          reservation.commit()
          aggregate.set(aggregateKey(trackId, job.regional.key), job.regional.bytes, () => {
            regionCache.delete(job.regional.key)
            markEvicted(trackId, job.regional.key)
          }, value.buffer)
          regionCache.set(job.regional.key, value, job.regional.bytes)
          return value
        }).catch((cause) => {
          reservation.release()
          throw cause
        }).finally(() => {
          const current = pending.get(requestKey)
          if (current?.promise === request) pending.delete(requestKey)
          forgetReservation(requestKey, reservation)
        })
        const owned = reservations.get(requestKey) ?? new Set<{ release: () => void; commit: () => void }>()
        owned.add(reservation)
        reservations.set(requestKey, owned)
        pending.set(requestKey, { promise: request, signal: abortController.signal })
      }
      const value: SampledInstrumentBuffer | null = await request
      if (!value || disposed || versions.get(trackId) !== version || options.isCurrentProject?.() === false) {
        return
      }
      for (const pad of padsByRegion.get(job.regional.key) ?? []) {
        if (regionCache.get(job.regional.key)) buffers.set(pad.id, value)
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
    if (disposed || versions.get(trackId) !== version || options.isCurrentProject?.() === false) return
    cache.set(trackId, {
      projectId: projectKey,
      key: params.pads.map((pad) => {
        if (!pad.sample) return `${pad.id}:`
        return `${pad.id}:${regionForSample(pad.sample, pad.startSec, pad.endSec).key}`
      }).join('\n'),
      instanceId,
      buffers: retainedBuffers,
      regionKeys: retainedRegionKeys,
    })
    engine.setTrackDrumRack(trackId, params, retainedBuffers)
    notify()
  }
  return {
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
      regionCaches.clear()
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
    snapshotBuffers: (trackId: Track['id'], instrument: Extract<TrackInstrumentParams, { kind: 'drum-rack' }>) => {
      const entry = cache.get(trackId)
      if (entry?.projectId !== projectId()) return undefined
      const key = instrument.params.pads.map((pad) => {
        if (!pad.sample) return `${pad.id}:`
        return `${pad.id}:${regionForSample(pad.sample, pad.startSec, pad.endSec).key}`
      }).join('\n')
      if (entry?.key !== key || entry.instanceId !== instrument.instanceId) return undefined
      const valid = new Map<string, SampledInstrumentBuffer>()
      for (const pad of instrument.params.pads) {
        const sample = pad.sample
        const value = sample ? entry.buffers.get(pad.id) : undefined
        if (!sample) continue
        if (!value) return undefined
        const region = regionForSample(sample, pad.startSec, pad.endSec)
        try {
          aggregate.touch(aggregateKey(trackId, region.key))
          valid.set(pad.id, validateSampledInstrumentBuffer(value, sample.source, region.region, region.key))
        } catch {
          return undefined
        }
      }
      return valid
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    syncTrack,
  }
}
