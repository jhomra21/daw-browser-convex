import { describe, expect, test } from 'bun:test'
import { createReverbImpulseRenderInfo, getImpulseBucket } from './dsp'
import { normalizeReverbParams, REVERB_DECAY_SEC_MAX } from '@daw-browser/shared'

describe('reverb impulse rendering', () => {
  test('uses shared maximum decay for impulse buckets', () => {
    const bucket = getImpulseBucket(REVERB_DECAY_SEC_MAX + 10)

    expect(bucket.bucketSec).toBe(REVERB_DECAY_SEC_MAX)
  })

  test('includes impulse-shaping params in the render signature', () => {
    const base = normalizeReverbParams({ decaySec: 2, size: 0.5, density: 0.5, diffusion: 0.5, highCutHz: 12000 })
    const denser = normalizeReverbParams({ ...base, density: 0.8 })
    const darker = normalizeReverbParams({ ...base, highCutHz: 8000 })

    const baseSignature = createReverbImpulseRenderInfo(48000, base).signature

    expect(createReverbImpulseRenderInfo(48000, denser).signature).not.toBe(baseSignature)
    expect(createReverbImpulseRenderInfo(48000, darker).signature).not.toBe(baseSignature)
  })
})
