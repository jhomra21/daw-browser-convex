import { resolveUniqueEffectInstance } from './agent-actions'

declare function describe(name: string, run: () => void): void
declare function test(name: string, run: () => void): void
declare function expect(value: unknown): {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
}

describe('agent effect target resolution', () => {
  test('rejects ambiguous track and master effect matches', () => {
    const effects = [
      { targetType: 'track', type: 'eq', instanceId: 'track-eq-1' },
      { targetType: 'track', type: 'eq', instanceId: 'track-eq-2' },
      { targetType: 'master', type: 'reverb', instanceId: 'master-reverb-1' },
      { targetType: 'master', type: 'reverb', instanceId: 'master-reverb-2' },
    ]

    expect(resolveUniqueEffectInstance(effects, 'track', 'eq', 'track 2'))
      .toEqual({ error: 'Ambiguous eq effect target for track 2: found 2 instances.' })
    expect(resolveUniqueEffectInstance(effects, 'master', 'reverb', 'master'))
      .toEqual({ error: 'Ambiguous reverb effect target for master: found 2 instances.' })
  })

  test('preserves zero and one match behavior', () => {
    const effects = [{ targetType: 'track', type: 'eq', instanceId: 'eq-1' }]
    expect(resolveUniqueEffectInstance(effects, 'track', 'reverb', 'track 2')).toEqual({})
    expect(resolveUniqueEffectInstance(effects, 'track', 'eq', 'track 2')).toEqual({ instanceId: 'eq-1' })
  })
})
