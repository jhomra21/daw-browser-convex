import { describe, expect, test } from 'bun:test'
import { createDefaultSamplerParams, normalizeSamplerParams, type DrumRackPadSample, type SamplerZone } from '@daw-browser/shared'
import { createSamplerBufferCache, createSamplerVoicePlan, getSamplerEnvelopeTimes, getSamplerLoopBounds, resetSamplerRoundRobin, selectSamplerZone } from './sampler-core'

const sample: DrumRackPadSample = {
  assetKey: 'asset',
  url: '/sample.wav',
  sourceKind: 'upload',
  source: { durationSec: 2, sampleRate: 48_000, channelCount: 2 },
}

const zone = (id: string, roundRobinIndex: number): SamplerZone => ({
  id, sample, keyLow: 60, keyHigh: 60, velocityLow: 1, velocityHigh: 127, rootNote: 60,
  tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 1, roundRobinIndex,
  playbackMode: 'crossfade-loop', startSec: 0, endSec: 2, loopStartSec: 0.5, loopEndSec: 1.5,
  crossfadeSec: 0.75, chokeGroup: 0,
})

describe('sampler core', () => {
  test('selects velocity ranges and advances round robin deterministically', () => {
    const zones = [zone('b', 1), zone('a', 0)]
    const first = selectSamplerZone(zones, 60, 100, resetSamplerRoundRobin())
    const second = selectSamplerZone(zones, 60, 100, first.roundRobin)
    expect(first.zone?.id).toBe('a')
    expect(second.zone?.id).toBe('b')
    expect(selectSamplerZone(zones, 61, 100, second.roundRobin).zone).toBeUndefined()
  })

  test('bounds loop crossfade and envelope times', () => {
    expect(getSamplerLoopBounds(zone('a', 0))?.crossfadeSec).toBe(0.5)
    expect(getSamplerEnvelopeTimes({ attackSec: 1, decaySec: 1, sustain: 0.5, releaseSec: 2, amount: 1 }, 3, 3.5))
      .toEqual({ startTime: 3, attackEnd: 4, decayEnd: 5, releaseTime: 5, endTime: 7, sustain: 0.5 })
  })

  test('normalizes versioned persisted state and invalid loop bounds', () => {
    const params = normalizeSamplerParams({ version: 0, zones: [{ ...zone('a', 0), loopStartSec: 1.8, loopEndSec: 1 }] })
    expect(params.version).toBe(1)
    expect(params.zones[0]?.loopStartSec).toBe(1.8)
    expect(params.zones[0]?.loopEndSec).toBe(1.8)
    expect(params.zones[0]?.crossfadeSec).toBe(0)
    expect(createDefaultSamplerParams()).toEqual(normalizeSamplerParams({}))
  })

  test('evicts decoded buffers deterministically by least recent use', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('a', 'A', 5)
    cache.set('b', 'B', 5)
    cache.get('a')
    cache.set('c', 'C', 5)
    expect(cache.keys()).toEqual(['a', 'c'])
    expect(cache.byteLength()).toBe(10)
  })

  test('builds deterministic bounded equal-power crossfade segments', () => {
    const plan = createSamplerVoicePlan({
      zone: zone('a', 0),
      params: createDefaultSamplerParams(),
      note: 72,
      velocity: 127,
      when: 1,
      durationSec: 2,
    })
    expect(plan.detuneCents).toBe(1200)
    expect(plan.segments.length).toBeGreaterThan(1)
    expect(plan.segments.every((segment) => segment.durationSec > 0)).toBe(true)
    expect(plan.segments[1]?.fadeInSec).toBe(0.25)
  })

  test('advances the first crossfade in playback time at every playback rate', () => {
    for (const [note, expectedAdvance] of [[48, 2], [60, 1], [72, 0.5]]) {
      const plan = createSamplerVoicePlan({
        zone: zone('a', 0),
        params: createDefaultSamplerParams(),
        note,
        velocity: 127,
        when: 1,
        durationSec: 4,
      })
      expect((plan.segments[1]?.startTime ?? 0) - plan.startTime).toBeCloseTo(expectedAdvance, 12)
    }
  })

  test('keeps forward-loop sources alive through the note envelope', () => {
    const forwardLoop: SamplerZone = { ...zone('forward', 0), playbackMode: 'forward-loop' }
    const plan = createSamplerVoicePlan({
      zone: forwardLoop,
      params: createDefaultSamplerParams(),
      note: 60,
      velocity: 127,
      when: 1,
      durationSec: 4,
    })
    expect(plan.segments).toHaveLength(1)
    expect(plan.segments[0]?.durationSec).toBeCloseTo(plan.endTime - plan.startTime, 12)
  })

  test('does not evict pinned decoded buffers', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('a', 'A', 5)
    const pin = cache.pin('a')
    cache.set('b', 'B', 5)
    cache.set('c', 'C', 5)
    expect(cache.keys()).toEqual(['a', 'c'])
    pin?.release()
    cache.set('d', 'D', 6)
    expect(cache.keys()).toEqual(['d'])
  })

  test('reports pinned over-budget state and evicts after the final unpin', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('active', 'A', 10)
    const pin = cache.pin('active')
    cache.setMaxByteLength(5)
    expect(cache.overBudgetPinned()).toBe(true)
    expect(cache.byteLength()).toBe(10)
    pin?.release()
    expect(cache.overBudgetPinned()).toBe(false)
    expect(cache.byteLength()).toBe(0)
  })

  test('reports evicted values so runtime holders can release decoded buffers', () => {
    const evicted: Array<[string, string]> = []
    const cache = createSamplerBufferCache<string>(5, (key, value) => evicted.push([key, value]))
    cache.set('a', 'A', 5)
    cache.set('b', 'B', 5)
    expect(evicted).toEqual([['a', 'A']])
  })

  test('retains a replaced pinned value until its pin is released', () => {
    const cache = createSamplerBufferCache<string>(10)
    cache.set('region', 'old', 5)
    const pin = cache.pin('region')
    cache.set('region', 'new', 5)
    expect(cache.get('region')).toBe('new')
    expect(cache.byteLength()).toBe(10)
    pin?.release()
    expect(cache.byteLength()).toBe(5)
  })
})
