import { describe, expect, test } from 'bun:test'
import {
  createDefaultEqParams,
  createDefaultReverbParams,
  createDefaultEqBand,
  EQ_FREQUENCY_MAX,
  EQ_FREQUENCY_MIN,
  EQ_GAIN_DB_MAX,
  EQ_GAIN_DB_MIN,
  EQ_Q_MAX,
  EQ_Q_MIN,
  normalizeEqParams,
  normalizeReverbParams,
  serializeEqParams,
  serializeReverbParams,
  REVERB_DECAY_SEC_MAX,
  REVERB_WET_MAX,
} from './effects-params'
import { parseSharedTimelineOperation } from './shared-timeline-operations'

describe('EQ params', () => {
  test('normalizes band values and falls back for invalid values', () => {
    const defaults = createDefaultEqParams()
    const normalized = normalizeEqParams({
      enabled: false,
      bands: [
        {
          id: '',
          type: 'invalid',
          frequency: Number.NaN,
          gainDb: -999,
          q: 999,
          enabled: false,
        },
        {
          id: 'custom',
          type: 'highpass',
          frequency: 1,
          gainDb: 999,
          q: 0,
          enabled: true,
        },
      ],
    })

    expect(normalized.enabled).toBe(false)
    expect(normalized.bands[0]).toEqual({
      ...defaults.bands[0],
      gainDb: EQ_GAIN_DB_MIN,
      q: EQ_Q_MAX,
      enabled: false,
    })
    expect(normalized.bands[1]).toEqual({
      id: 'custom',
      type: 'highpass',
      frequency: EQ_FREQUENCY_MIN,
      gainDb: EQ_GAIN_DB_MAX,
      q: EQ_Q_MIN,
      enabled: true,
    })
  })

  test('serializes normalized params', () => {
    const low = normalizeEqParams({ bands: [{ frequency: EQ_FREQUENCY_MIN, gainDb: EQ_GAIN_DB_MIN, q: EQ_Q_MAX }] })
    const outOfRange = normalizeEqParams({ bands: [{ frequency: -1, gainDb: -999, q: 999 }] })

    expect(serializeEqParams(outOfRange)).toBe(serializeEqParams(low))
  })

  test('uses shared defaults for bands beyond the default set', () => {
    const normalized = normalizeEqParams({
      bands: Array.from({ length: 9 }, (_, index) => (
        index === 8 ? { id: '', type: 'invalid' } : createDefaultEqBand(index)
      )),
    })

    expect(normalized.bands[8]).toEqual(createDefaultEqBand(8))
  })

  test('parses shared EQ operations with normalized payloads', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterEqParams',
      payload: {
        params: {
          enabled: true,
          bands: [{
            id: 'b1',
            type: 'peaking',
            frequency: 1,
            gainDb: 999,
            q: 999,
            enabled: true,
          }],
        },
      },
    })).toEqual({
      kind: 'effects.setMasterEqParams',
      payload: {
        params: {
          enabled: true,
          bands: [{
            id: 'b1',
            type: 'peaking',
            frequency: EQ_FREQUENCY_MIN,
            gainDb: EQ_GAIN_DB_MAX,
            q: EQ_Q_MAX,
            enabled: true,
          }],
        },
      },
    })
  })
})

describe('Reverb params', () => {
  test('normalizes booleans safely and clamps numeric values', () => {
    const defaults = createDefaultReverbParams()
    const normalized = normalizeReverbParams({
      ...JSON.parse('{"enabled":"no","reflectionSpin":"yes"}'),
      wet: 999,
      decaySec: 999,
    })

    expect(normalized).toEqual({
      ...defaults,
      wet: REVERB_WET_MAX,
      decaySec: REVERB_DECAY_SEC_MAX,
    })
    expect(normalizeReverbParams({ enabled: false, reflectionSpin: false }).enabled).toBe(false)
    expect(normalizeReverbParams({ enabled: false, reflectionSpin: false }).reflectionSpin).toBe(false)
  })

  test('serializes normalized params', () => {
    const high = normalizeReverbParams({ wet: REVERB_WET_MAX, decaySec: REVERB_DECAY_SEC_MAX })
    const outOfRange = { ...createDefaultReverbParams(), wet: 999, decaySec: 999 }

    expect(serializeReverbParams(outOfRange)).toBe(serializeReverbParams(high))
  })
})
