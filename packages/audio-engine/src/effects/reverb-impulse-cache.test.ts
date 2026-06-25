import { describe, expect, test } from 'bun:test'
import { normalizeReverbParams } from '@daw-browser/shared'
import { createReverbImpulseCache } from './reverb-impulse-cache'

describe('reverb impulse cache', () => {
  const ctx48000 = { sampleRate: 48000 }
  const createBuffer = () => ({})

  test('reuses buffers for the same sample rate and signature', () => {
    const cache = createReverbImpulseCache({ createBuffer })
    const params = normalizeReverbParams({ decaySec: 2, size: 0.5 })

    expect(cache.get(ctx48000, params)).toBe(cache.get(ctx48000, params))
  })

  test('does not share buffers across sample rates', () => {
    const cache = createReverbImpulseCache({ createBuffer })
    const params = normalizeReverbParams({ decaySec: 2, size: 0.5 })

    expect(cache.get({ sampleRate: 44100 }, params))
      .not.toBe(cache.get(ctx48000, params))
  })

  test('evicts the oldest entry when the limit is exceeded', () => {
    const cache = createReverbImpulseCache({ limit: 2, createBuffer })
    const firstParams = normalizeReverbParams({ decaySec: 1, size: 0.5 })
    const secondParams = normalizeReverbParams({ decaySec: 2, size: 0.5 })
    const thirdParams = normalizeReverbParams({ decaySec: 3, size: 0.5 })

    const firstBuffer = cache.get(ctx48000, firstParams)
    cache.get(ctx48000, secondParams)
    cache.get(ctx48000, thirdParams)

    expect(cache.get(ctx48000, firstParams)).not.toBe(firstBuffer)
  })
})
