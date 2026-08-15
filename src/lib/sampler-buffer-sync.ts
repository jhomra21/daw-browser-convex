import { createSamplerBufferCache, type AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { GranularParams, SamplerParams, TrackInstrumentParams } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { createSampleBufferLoader, type SampleBufferLoaderOptions } from '~/lib/sample-buffer-loader'

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

const sampleCacheKey = (projectId: string, assetKey: string, sampleRate: number) => `${projectId}\u0000${assetKey}\u0000${sampleRate}`

export function createSamplerBufferSync(options: Pick<SampleBufferLoaderOptions, 'projectId' | 'readLocalAsset'> = {}) {
  const loader = createSampleBufferLoader({ ...options, cacheDecodedBuffers: false })
  const versions = new Map<Track['id'], number>()
  const configs = new Map<Track['id'], { params: SamplerParams; instanceId?: string; projectId: string }>()
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const pending = new Map<string, Promise<AudioBuffer | null>>()
  const engines = new Set<AudioEngine>()
  const listenerEngines = new Set<AudioEngine>()
  const states = new Map<Track['id'], Map<string, SamplerZoneLoadState>>()
  const misses = new Map<Track['id'], number>()
  const granularConfigs = new Map<Track['id'], { params: GranularParams; instanceId?: string; projectId: string }>()
  const granularEnginesByTrack = new Map<Track['id'], AudioEngine>()
  const granularPinnedAssets = new Map<Track['id'], string>()
  const granularStates = new Map<Track['id'], SamplerZoneLoadState>()
  const listeners = new Set<() => void>()
  let disposed = false
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const setZoneState = (trackId: Track['id'], zoneId: string, state: SamplerZoneLoadState) => {
    const trackStates = states.get(trackId) ?? new Map<string, SamplerZoneLoadState>()
    trackStates.set(zoneId, state)
    states.set(trackId, trackStates)
    notify()
  }

  const bufferBytes = (buffer: AudioBuffer) => buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT

  const cache = createSamplerBufferCache<AudioBuffer>(256 * 1024 * 1024, (cacheKey) => {
    for (const [trackId, config] of configs) {
      if (!config.params.zones.some((zone) => sampleCacheKey(config.projectId, zone.sample.assetKey, zone.sample.source.sampleRate) === cacheKey)) continue
      const audioEngine = enginesByTrack.get(trackId)
      if (audioEngine) installTrackBuffers(audioEngine, trackId, config.params, config.instanceId)
    }
    for (const [trackId, config] of granularConfigs) {
      if (!config.params.zone || sampleCacheKey(config.projectId, config.params.zone.sample.assetKey, config.params.zone.sample.source.sampleRate) !== cacheKey) continue
      const audioEngine = granularEnginesByTrack.get(trackId)
      if (audioEngine) void audioEngine.setTrackGranular(trackId, config.params, undefined, config.instanceId)
    }
  })

  const releaseGranularPin = (trackId: Track['id']) => {
    const assetKey = granularPinnedAssets.get(trackId)
    if (!assetKey) return
    granularPinnedAssets.delete(trackId)
    cache.unpin(assetKey)
  }

  const installTrackBuffers = (audioEngine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string) => {
    const projectId = configs.get(trackId)?.projectId ?? options.projectId?.() ?? ''
    const buffers = new Map<string, AudioBuffer>()
    for (const zone of params.zones) {
      const buffer = cache.get(sampleCacheKey(projectId, zone.sample.assetKey, zone.sample.source.sampleRate))
      if (buffer) buffers.set(zone.id, buffer)
    }
    audioEngine.setTrackSampler(trackId, params, buffers, instanceId)
  }

  const sameSamplerSample = (left: SamplerParams['zones'][number]['sample'], right: SamplerParams['zones'][number]['sample']) => (
    left.assetKey === right.assetKey
    && left.url === right.url
    && left.sourceKind === right.sourceKind
    && left.source.durationSec === right.source.durationSec
    && left.source.sampleRate === right.source.sampleRate
    && left.source.channelCount === right.source.channelCount
  )

  const matchesSamplerConfig = (
    config: { params: SamplerParams; instanceId?: string } | undefined,
    instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>,
  ) => {
    if (!config || config.instanceId !== instrument.instanceId || config.params.zones.length !== instrument.params.zones.length) return false
    return config.params.zones.every((zone, index) => {
      const candidate = instrument.params.zones[index]
      return candidate !== undefined
        && zone.id === candidate.id
        && sameSamplerSample(zone.sample, candidate.sample)
    })
  }

  const loadZone = (audioEngine: AudioEngine, trackId: Track['id'], zoneId: string, force = false): Promise<void> => {
    const config = configs.get(trackId)
    const params = config?.params
    const zone = params?.zones.find((candidate) => candidate.id === zoneId)
    if (!params || !zone) return Promise.resolve()
    const projectId = config.projectId
    const cacheKey = sampleCacheKey(projectId, zone.sample.assetKey, zone.sample.source.sampleRate)
    const requestKey = `${trackId}\u0000${zone.id}\u0000${cacheKey}`
    if (force) {
      loader.invalidate(zone.sample.url)
      pending.delete(requestKey)
    }
    setZoneState(trackId, zoneId, 'loading')
    const version = versions.get(trackId)
    const request = pending.get(requestKey) ?? loader.load(
      zone.sample.url,
      (data, targetSampleRate) => audioEngine.decodeAudioData(data, targetSampleRate),
      { targetSampleRate: zone.sample.source.sampleRate },
    )
    pending.set(requestKey, request)
    const completion = request.then((buffer) => {
      if (disposed || versions.get(trackId) !== version) return
      if (!buffer) {
        setZoneState(trackId, zoneId, 'missing')
        return
      }
      cache.set(cacheKey, buffer, bufferBytes(buffer))
      setZoneState(trackId, zoneId, 'ready')
      installTrackBuffers(audioEngine, trackId, params, config?.instanceId)
    }).catch(() => {
      if (!disposed && versions.get(trackId) === version) setZoneState(trackId, zoneId, 'error')
    }).finally(() => {
      if (pending.get(requestKey) === request) pending.delete(requestKey)
      notify()
    })
    return completion
  }

  const clearTrack = (trackId: Track['id']) => {
    versions.set(trackId, (versions.get(trackId) ?? 0) + 1)
    configs.delete(trackId)
    enginesByTrack.delete(trackId)
    granularConfigs.delete(trackId)
    granularEnginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    states.delete(trackId)
    misses.delete(trackId)
    granularStates.delete(trackId)
    notify()
  }

  const installRuntimeListeners = (audioEngine: AudioEngine) => {
    if (listenerEngines.has(audioEngine)) return
    listenerEngines.add(audioEngine)
    audioEngine.setSamplerRuntimeListeners({
      onNoteMiss: (miss) => {
        const configuredEngine = enginesByTrack.get(miss.trackId)
        if (configuredEngine !== audioEngine) return
        misses.set(miss.trackId, (misses.get(miss.trackId) ?? 0) + 1)
        setZoneState(miss.trackId, miss.zoneId, 'engine-miss')
        loadZone(audioEngine, miss.trackId, miss.zoneId)
      },
      onAssetUse: (assetKey, active) => {
        const cacheKeys = new Set<string>()
        for (const config of configs.values()) {
          for (const zone of config.params.zones) {
            if (zone.sample.assetKey === assetKey) {
              cacheKeys.add(sampleCacheKey(config.projectId, assetKey, zone.sample.source.sampleRate))
            }
          }
        }
        for (const config of granularConfigs.values()) {
          const sample = config.params.zone?.sample
          if (sample?.assetKey === assetKey) {
            cacheKeys.add(sampleCacheKey(config.projectId, assetKey, sample.source.sampleRate))
          }
        }
        for (const cacheKey of cacheKeys) {
          if (active) cache.pin(cacheKey)
          else cache.unpin(cacheKey)
        }
      },
    })
  }

  const syncTrack = (audioEngine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string): Promise<void> => {
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    engines.add(audioEngine)
    installRuntimeListeners(audioEngine)
    enginesByTrack.set(trackId, audioEngine)
    granularConfigs.delete(trackId)
    granularEnginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    const projectId = options.projectId?.() ?? ''
    configs.set(trackId, { params, instanceId, projectId })
    states.set(trackId, new Map(params.zones.map((zone) => [
      zone.id,
        cache.get(sampleCacheKey(projectId, zone.sample.assetKey, zone.sample.source.sampleRate)) ? 'ready' : 'missing',
    ])))
    installTrackBuffers(audioEngine, trackId, params, instanceId)
    const loads = params.cachePolicy === 'preload'
      ? params.zones.map((zone) => loadZone(audioEngine, trackId, zone.id))
      : []
    notify()
    return Promise.all(loads).then(() => undefined)
  }

  return {
    clearTrack,
    syncTrack,
    snapshotSamplerBuffers: (
      trackId: Track['id'],
      instrument: Extract<TrackInstrumentParams, { kind: 'sampler' }>,
    ) => {
      const config = configs.get(trackId)
      if (
        !config
        || config.projectId !== (options.projectId?.() ?? '')
        || !matchesSamplerConfig(config, instrument)
      ) return undefined
      const buffers = new Map<string, AudioBuffer>()
      for (const zone of instrument.params.zones) {
        const buffer = cache.get(sampleCacheKey(config.projectId, zone.sample.assetKey, zone.sample.source.sampleRate))
        if (buffer) buffers.set(zone.id, buffer)
      }
      return buffers
    },
    retryZone: (audioEngine: AudioEngine, trackId: Track['id'], zoneId: string) => {
      void loadZone(audioEngine, trackId, zoneId, true)
    },
    syncGranularTrack: (audioEngine: AudioEngine, trackId: Track['id'], params: GranularParams, instanceId?: string): Promise<void> => {
      const version = (versions.get(trackId) ?? 0) + 1
      versions.set(trackId, version)
      engines.add(audioEngine)
      installRuntimeListeners(audioEngine)
      configs.delete(trackId)
      enginesByTrack.delete(trackId)
      releaseGranularPin(trackId)
      granularEnginesByTrack.set(trackId, audioEngine)
      const projectId = options.projectId?.() ?? ''
      granularConfigs.set(trackId, { params, instanceId, projectId })
      const zone = params.zone
      if (!zone) {
        granularStates.set(trackId, 'missing')
        notify()
        return audioEngine.setTrackGranular(trackId, params, undefined, instanceId)
      }
      const cacheKey = sampleCacheKey(projectId, zone.sample.assetKey, zone.sample.source.sampleRate)
      const cached = cache.get(cacheKey)
      granularStates.set(trackId, cached ? 'ready' : 'loading')
      if (cached && cache.pin(cacheKey)) granularPinnedAssets.set(trackId, cacheKey)
      const initialInstall = audioEngine.setTrackGranular(trackId, params, cached ? { assetKey: zone.sample.assetKey, buffer: cached } : undefined, instanceId)
      if (cached) {
        notify()
        return initialInstall
      }
      const requestKey = `${trackId}\u0000granular\u0000${cacheKey}`
      const request = pending.get(requestKey) ?? loader.load(
        zone.sample.url,
        (data, targetSampleRate) => audioEngine.decodeAudioData(data, targetSampleRate),
        { targetSampleRate: zone.sample.source.sampleRate },
      )
      pending.set(requestKey, request)
      const completion = Promise.all([initialInstall, request]).then(async ([, buffer]) => {
        if (disposed || versions.get(trackId) !== version) return
        if (!buffer) {
          granularStates.set(trackId, 'missing')
          return
        }
        cache.set(cacheKey, buffer, bufferBytes(buffer))
        if (cache.pin(cacheKey)) granularPinnedAssets.set(trackId, cacheKey)
        await audioEngine.setTrackGranular(trackId, params, { assetKey: zone.sample.assetKey, buffer }, instanceId)
        granularStates.set(trackId, 'ready')
      }).catch(() => {
        if (!disposed && versions.get(trackId) === version) granularStates.set(trackId, 'error')
      }).finally(() => {
        if (pending.get(requestKey) === request) pending.delete(requestKey)
        notify()
      })
      notify()
      return completion
    },
    snapshotGranularBuffer: (
      trackId: Track['id'],
      instrument: Extract<TrackInstrumentParams, { kind: 'granular' }>,
    ) => {
      const config = granularConfigs.get(trackId)
      const zone = config?.params.zone
      const currentZone = instrument.params.zone
      if (
        !config
        || config.projectId !== (options.projectId?.() ?? '')
        || config.instanceId !== instrument.instanceId
        || (zone === undefined) !== (currentZone === undefined)
        || (zone && currentZone && !sameSamplerSample(zone.sample, currentZone.sample))
      ) return undefined
      if (!currentZone) return undefined
      const buffer = cache.get(sampleCacheKey(config.projectId, currentZone.sample.assetKey, currentZone.sample.source.sampleRate))
      return buffer ? { assetKey: currentZone.sample.assetKey, buffer } : undefined
    },
    retryGranular: (audioEngine: AudioEngine, trackId: Track['id']) => {
      const config = granularConfigs.get(trackId)
      const zone = config?.params.zone
      if (!config || !zone) return
      const { params, instanceId } = config
      loader.invalidate(zone.sample.url)
      releaseGranularPin(trackId)
      const cacheKey = sampleCacheKey(config.projectId, zone.sample.assetKey, zone.sample.source.sampleRate)
      cache.delete(cacheKey)
      granularStates.set(trackId, 'loading')
      const next = { ...params }
      granularConfigs.delete(trackId)
      const version = (versions.get(trackId) ?? 0) + 1
      versions.set(trackId, version)
      granularConfigs.set(trackId, { params: next, instanceId, projectId: config.projectId })
      const requestKey = `${trackId}\u0000granular\u0000${cacheKey}`
      const request = loader.load(
        zone.sample.url,
        (data, targetSampleRate) => audioEngine.decodeAudioData(data, targetSampleRate),
        { targetSampleRate: zone.sample.source.sampleRate },
      )
      pending.set(requestKey, request)
      void request.then(async (buffer) => {
        if (disposed || versions.get(trackId) !== version) return
        if (!buffer) {
          granularStates.set(trackId, 'missing')
          return
        }
        cache.set(cacheKey, buffer, bufferBytes(buffer))
        if (cache.pin(cacheKey)) granularPinnedAssets.set(trackId, cacheKey)
        await audioEngine.setTrackGranular(trackId, next, { assetKey: zone.sample.assetKey, buffer }, instanceId)
        granularStates.set(trackId, 'ready')
      }).catch(() => {
        if (!disposed && versions.get(trackId) === version) granularStates.set(trackId, 'error')
      }).finally(() => {
        if (pending.get(requestKey) === request) pending.delete(requestKey)
        notify()
      })
      notify()
    },
    getGranularStatus: (trackId: Track['id']): GranularLoadStatus => ({
      state: granularStates.get(trackId) ?? 'missing',
      totalBytes: cache.byteLength(),
      maxBytes: cache.maxByteLength(),
    }),
    getStatus: (trackId: Track['id']): SamplerLoadStatus => ({
      zones: states.get(trackId) ?? new Map(),
      totalBytes: cache.byteLength(),
      maxBytes: cache.maxByteLength(),
      misses: misses.get(trackId) ?? 0,
      overBudgetPinned: cache.overBudgetPinned(),
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => {
      disposed = true
      versions.clear()
      configs.clear()
      states.clear()
      misses.clear()
      granularConfigs.clear()
      granularStates.clear()
      granularEnginesByTrack.clear()
      granularPinnedAssets.clear()
      pending.clear()
      cache.clear()
      loader.clear()
      for (const audioEngine of engines) audioEngine.setSamplerRuntimeListeners({})
      engines.clear()
      listenerEngines.clear()
      notify()
      listeners.clear()
    },
  }
}
