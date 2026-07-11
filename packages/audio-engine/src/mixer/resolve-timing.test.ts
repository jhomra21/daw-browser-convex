import { describe, expect, test } from 'bun:test'
import { createMixerChannels } from './channels'
import { resolveMixerGraph } from './resolve-routing'
import { MASTER_ROUTE_TARGET, mixerRouteKey, resolveMixerTiming } from './resolve-timing'
import { normalizeCompressorParams } from '@daw-browser/shared'

describe('mixer timing resolution', () => {
  test('compensates shorter parallel routes and rejects cycles deterministically', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        { id: 'fast', name: 'Fast', clips: [], volume: 1 },
        { id: 'slow', name: 'Slow', clips: [], volume: 1 },
      ]),
      trackFx: {
        slow: { compressor: normalizeCompressorParams({ enabled: true, lookaheadMs: 10 }) },
      },
    })
    const timing = resolveMixerTiming(graph, 48_000)
    expect(timing.routeDelayFrames.get(mixerRouteKey('fast', MASTER_ROUTE_TARGET, 'output'))).toBe(480)
    expect(timing.routeDelayFrames.get(mixerRouteKey('slow', MASTER_ROUTE_TARGET, 'output'))).toBe(0)
  })

  test('uses source tap arrival for nested mixed-tap paths', () => {
    const graph = resolveMixerGraph({
      channels: createMixerChannels([
        { id: 'source', name: 'Source', clips: [], volume: 1, sends: [{ targetId: 'prefx-return', amount: 1, tap: 'pre-fx' }, { targetId: 'postfx-return', amount: 1, tap: 'pre-fader' }] },
        { id: 'prefx-return', name: 'Pre FX', channelRole: 'return', clips: [], volume: 1 },
        { id: 'postfx-return', name: 'Post FX', channelRole: 'return', clips: [], volume: 1 },
      ]),
      trackFx: {
        source: { compressor: normalizeCompressorParams({ enabled: true, lookaheadMs: 10 }) },
      },
    })
    const timing = resolveMixerTiming(graph, 48_000)
    expect(timing.routeDelayFrames.get(mixerRouteKey('prefx-return', MASTER_ROUTE_TARGET, 'output'))).toBe(480)
    expect(timing.routeDelayFrames.get(mixerRouteKey('postfx-return', MASTER_ROUTE_TARGET, 'output'))).toBe(0)
  })
})
