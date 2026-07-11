import { createSamplerBufferCache, type AudioEngine } from '@daw-browser/audio-engine/audio-engine'
import type { GranularParams, SamplerParams } from '@daw-browser/shared'
import type { Track } from '@daw-browser/timeline-core/types'
import { createSampleBufferLoader } from '~/lib/sample-buffer-loader'

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

export function createSamplerBufferSync() {
  const loader = createSampleBufferLoader()
  const versions = new Map<Track['id'], number>()
  const configs = new Map<Track['id'], { params: SamplerParams; instanceId?: string }>()
  const enginesByTrack = new Map<Track['id'], AudioEngine>()
  const pending = new Map<string, Promise<void>>()
  const engines = new Set<AudioEngine>()
  const states = new Map<Track['id'], Map<string, SamplerZoneLoadState>>()
  const misses = new Map<Track['id'], number>()
  const granularConfigs = new Map<Track['id'], { params: GranularParams; instanceId?: string }>()
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

  const cache = createSamplerBufferCache<AudioBuffer>(256 * 1024 * 1024, (assetKey) => {
    for (const [trackId, config] of configs) {
      if (!config.params.zones.some((zone) => zone.sample.assetKey === assetKey)) continue
      const audioEngine = enginesByTrack.get(trackId)
      if (audioEngine) installTrackBuffers(audioEngine, trackId, config.params, config.instanceId)
    }
    for (const [trackId, config] of granularConfigs) {
      if (config.params.zone?.sample.assetKey !== assetKey) continue
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
    const buffers = new Map<string, AudioBuffer>()
    for (const zone of params.zones) {
      const buffer = cache.get(zone.sample.assetKey)
      if (buffer) buffers.set(zone.id, buffer)
    }
    audioEngine.setTrackSampler(trackId, params, buffers, instanceId)
  }

  const loadZone = (audioEngine: AudioEngine, trackId: Track['id'], zoneId: string, force = false) => {
    const config = configs.get(trackId)
    const params = config?.params
    const zone = params?.zones.find((candidate) => candidate.id === zoneId)
    if (!params || !zone) return
    const requestKey = `${trackId}\u0000${zone.id}\u0000${zone.sample.assetKey}`
    if (force) loader.invalidate(zone.sample.url)
    if (pending.has(requestKey)) return
    setZoneState(trackId, zoneId, 'loading')
    const version = versions.get(trackId)
    const request = loader.load(zone.sample.url, (data) => audioEngine.decodeAudioData(data)).then((buffer) => {
      if (disposed || versions.get(trackId) !== version || !buffer) return
      cache.set(zone.sample.assetKey, buffer, bufferBytes(buffer))
      setZoneState(trackId, zoneId, 'ready')
      installTrackBuffers(audioEngine, trackId, params, config?.instanceId)
    }).catch(() => {
      if (!disposed && versions.get(trackId) === version) setZoneState(trackId, zoneId, 'error')
    }).finally(() => {
      pending.delete(requestKey)
      notify()
    })
    pending.set(requestKey, request)
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

  const syncTrack = (audioEngine: AudioEngine, trackId: Track['id'], params: SamplerParams, instanceId?: string) => {
    const version = (versions.get(trackId) ?? 0) + 1
    versions.set(trackId, version)
    engines.add(audioEngine)
    enginesByTrack.set(trackId, audioEngine)
    granularConfigs.delete(trackId)
    granularEnginesByTrack.delete(trackId)
    releaseGranularPin(trackId)
    configs.set(trackId, { params, instanceId })
    states.set(trackId, new Map(params.zones.map((zone) => [
      zone.id,
      cache.get(zone.sample.assetKey) ? 'ready' : 'missing',
    ])))
    installTrackBuffers(audioEngine, trackId, params, instanceId)
    audioEngine.setSamplerRuntimeListeners({
      onNoteMiss: (miss) => {
        misses.set(miss.trackId, (misses.get(miss.trackId) ?? 0) + 1)
        setZoneState(miss.trackId, miss.zoneId, 'engine-miss')
        loadZone(audioEngine, miss.trackId, miss.zoneId)
      },
      onAssetUse: (assetKey, active) => {
        if (active) cache.pin(assetKey)
        else cache.unpin(assetKey)
      },
    })
    if (params.cachePolicy === 'preload') for (const zone of params.zones) loadZone(audioEngine, trackId, zone.id)
    notify()
  }

  return {
    clearTrack,
    syncTrack,
    retryZone: (audioEngine: AudioEngine, trackId: Track['id'], zoneId: string) => loadZone(audioEngine, trackId, zoneId, true),
    syncGranularTrack: (audioEngine: AudioEngine, trackId: Track['id'], params: GranularParams, instanceId?: string) => {
      const version = (versions.get(trackId) ?? 0) + 1
      versions.set(trackId, version)
      engines.add(audioEngine)
      configs.delete(trackId)
      enginesByTrack.delete(trackId)
      releaseGranularPin(trackId)
      granularEnginesByTrack.set(trackId, audioEngine)
      granularConfigs.set(trackId, { params, instanceId })
      const zone = params.zone
      if (!zone) {
        granularStates.set(trackId, 'missing')
        void audioEngine.setTrackGranular(trackId, params, undefined, instanceId)
        notify()
        return
      }
      const cached = cache.get(zone.sample.assetKey)
      granularStates.set(trackId, cached ? 'ready' : 'loading')
      if (cached && cache.pin(zone.sample.assetKey)) granularPinnedAssets.set(trackId, zone.sample.assetKey)
      void audioEngine.setTrackGranular(trackId, params, cached ? { assetKey: zone.sample.assetKey, buffer: cached } : undefined, instanceId)
      if (cached) {
        notify()
        return
      }
      const requestKey = `${trackId}\u0000granular\u0000${zone.sample.assetKey}`
      if (pending.has(requestKey)) return
      const request = loader.load(zone.sample.url, (data) => audioEngine.decodeAudioData(data)).then(async (buffer) => {
        if (disposed || versions.get(trackId) !== version || !buffer) return
        cache.set(zone.sample.assetKey, buffer, bufferBytes(buffer))
        if (cache.pin(zone.sample.assetKey)) granularPinnedAssets.set(trackId, zone.sample.assetKey)
        await audioEngine.setTrackGranular(trackId, params, { assetKey: zone.sample.assetKey, buffer }, instanceId)
        granularStates.set(trackId, 'ready')
      }).catch(() => {
        if (!disposed && versions.get(trackId) === version) granularStates.set(trackId, 'error')
      }).finally(() => {
        pending.delete(requestKey)
        notify()
      })
      pending.set(requestKey, request)
      notify()
    },
    retryGranular: (audioEngine: AudioEngine, trackId: Track['id']) => {
      const config = granularConfigs.get(trackId)
      const zone = config?.params.zone
      if (!config || !zone) return
      const { params, instanceId } = config
      loader.invalidate(zone.sample.url)
      releaseGranularPin(trackId)
      cache.delete(zone.sample.assetKey)
      granularStates.set(trackId, 'loading')
      const next = { ...params }
      granularConfigs.delete(trackId)
      const version = (versions.get(trackId) ?? 0) + 1
      versions.set(trackId, version)
      granularConfigs.set(trackId, { params: next, instanceId })
      const requestKey = `${trackId}\u0000granular\u0000${zone.sample.assetKey}`
      const request = loader.load(zone.sample.url, (data) => audioEngine.decodeAudioData(data)).then(async (buffer) => {
        if (disposed || versions.get(trackId) !== version || !buffer) return
        cache.set(zone.sample.assetKey, buffer, bufferBytes(buffer))
        if (cache.pin(zone.sample.assetKey)) granularPinnedAssets.set(trackId, zone.sample.assetKey)
        await audioEngine.setTrackGranular(trackId, next, { assetKey: zone.sample.assetKey, buffer }, instanceId)
        granularStates.set(trackId, 'ready')
      }).catch(() => {
        if (!disposed && versions.get(trackId) === version) granularStates.set(trackId, 'error')
      }).finally(() => {
        pending.delete(requestKey)
        notify()
      })
      pending.set(requestKey, request)
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
      notify()
      listeners.clear()
    },
  }
}
