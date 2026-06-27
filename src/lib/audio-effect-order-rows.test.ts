import { describe, expect, test } from 'bun:test'
import { collectAudioEffectOrders } from './audio-effect-order-rows'

describe('collectAudioEffectOrders', () => {
  test('uses canonical order fallback for rows without indexes', () => {
    const orders = collectAudioEffectOrders([
      { targetId: 'track-1', kind: 'delay' },
      { targetId: 'track-1', kind: 'eq' },
      { targetId: 'track-1', kind: 'reverb' },
    ])

    expect(orders.tracks.get('track-1')).toEqual(['eq', 'delay', 'reverb'])
  })

  test('keeps indexed rows before canonical fallback rows', () => {
    const orders = collectAudioEffectOrders([
      { targetId: 'master', kind: 'eq', index: 1 },
      { targetId: 'master', kind: 'delay', index: 0 },
      { targetId: 'master', kind: 'saturator' },
    ])

    expect(orders.master).toEqual(['delay', 'eq', 'saturator'])
  })

  test('keeps explicit indexes ahead of matching canonical fallback indexes', () => {
    const orders = collectAudioEffectOrders([
      { targetId: 'track-1', kind: 'eq' },
      { targetId: 'track-1', kind: 'reverb', index: 0 },
    ])

    expect(orders.tracks.get('track-1')).toEqual(['reverb', 'eq'])
  })
})
