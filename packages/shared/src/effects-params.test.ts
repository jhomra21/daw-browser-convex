import { describe, expect, test } from 'bun:test'
import {
  createDefaultEqParams,
  createDefaultReverbParams,
  DELAY_FEEDBACK_MAX,
  DELAY_TIME_MS_MAX,
  createDefaultEqBand,
  EQ_FREQUENCY_MAX,
  EQ_FREQUENCY_MIN,
  EQ_GAIN_DB_MAX,
  EQ_GAIN_DB_MIN,
  EQ_Q_MAX,
  EQ_Q_MIN,
  normalizeEqParams,
  normalizeEqParamsForUpdate,
  normalizeDelayParams,
  normalizeReverbParams,
  normalizeReverbParamsForUpdate,
  normalizeSaturatorParams,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
  serializeDelayParams,
  serializeEqParams,
  serializeReverbParams,
  serializeSaturatorParams,
  REVERB_DECAY_SEC_MAX,
  REVERB_WET_MAX,
  serializeNormalizedEqParams,
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
    expect(normalized.channelMode).toBe('stereo')
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

  test('defaults missing or invalid channel mode to stereo', () => {
    expect(createDefaultEqParams().channelMode).toBe('stereo')
    expect(normalizeEqParams({}).channelMode).toBe('stereo')
    expect(normalizeEqParams({ channelMode: 'side' }).channelMode).toBe('stereo')
  })

  test('preserves mono channel mode', () => {
    expect(normalizeEqParams({ channelMode: 'mono' }).channelMode).toBe('mono')
  })

  test('includes channel mode in normalized serialization', () => {
    const stereo = normalizeEqParams({ channelMode: 'stereo' })
    const mono = normalizeEqParams({ channelMode: 'mono' })

    expect(serializeNormalizedEqParams(mono)).not.toBe(serializeNormalizedEqParams(stereo))
  })

  test('preserves existing channel mode for partial updates', () => {
    const existing = normalizeEqParams({ channelMode: 'mono' })

    expect(normalizeEqParamsForUpdate({ enabled: false }, existing).channelMode).toBe('mono')
    expect(normalizeEqParamsForUpdate({ enabled: false }).channelMode).toBe('stereo')
    expect(normalizeEqParamsForUpdate({ channelMode: 'stereo' }, existing).channelMode).toBe('stereo')
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
          channelMode: 'stereo',
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
          channelMode: 'stereo',
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

describe('Saturator params', () => {
  test('normalizes and serializes equivalent inputs', () => {
    const normalized = normalizeSaturatorParams({ driveDb: 999, outputDb: -999, dryWet: 2, colorFrequencyHz: 1, colorAmount: 2 })

    expect(normalized.driveDb).toBe(SATURATOR_DRIVE_DB_MAX)
    expect(normalized.outputDb).toBe(SATURATOR_OUTPUT_DB_MIN)
    expect(normalized.dryWet).toBe(1)
    expect(normalized.colorFrequencyHz).toBe(100)
    expect(normalized.colorAmount).toBe(1)
    expect(serializeSaturatorParams(normalized)).toBe(serializeSaturatorParams({ ...normalized, driveDb: 999 }))
  })
})

describe('Delay params', () => {
  test('normalizes limits and keeps low cut below high cut', () => {
    const normalized = normalizeDelayParams({ timeMs: 9999, feedback: 4, dryWet: -1, lowCutHz: 1900, highCutHz: 1000 })

    expect(normalized.timeMs).toBe(DELAY_TIME_MS_MAX)
    expect(normalized.feedback).toBe(DELAY_FEEDBACK_MAX)
    expect(normalized.dryWet).toBe(0)
    expect(normalized.lowCutHz).toBeLessThan(normalized.highCutHz)
    expect(serializeDelayParams(normalized)).toBe(serializeDelayParams({ ...normalized, feedback: 4 }))
  })

  test('parses shared track and master delay operations', () => {
    const params = normalizeDelayParams({})
    expect(parseSharedTimelineOperation({ kind: 'effects.setDelayParams', payload: { trackId: 'track-1', params } })?.kind)
      .toBe('effects.setDelayParams')
    expect(parseSharedTimelineOperation({ kind: 'effects.setMasterDelayParams', payload: { params } })?.kind)
      .toBe('effects.setMasterDelayParams')
  })
})

describe('Saturator shared operations', () => {
  test('parses shared track and master saturator operations', () => {
    const params = normalizeSaturatorParams({})
    expect(parseSharedTimelineOperation({ kind: 'effects.setSaturatorParams', payload: { trackId: 'track-1', params } })?.kind)
      .toBe('effects.setSaturatorParams')
    expect(parseSharedTimelineOperation({ kind: 'effects.setMasterSaturatorParams', payload: { params } })?.kind)
      .toBe('effects.setMasterSaturatorParams')
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

  test('preserves existing optional params during partial updates', () => {
    const existing = normalizeReverbParams({
      enabled: true,
      wet: 0.3,
      decaySec: 3,
      preDelayMs: 30,
      reflections: 0.7,
      reflectionSpin: false,
      stereoWidth: 1.5,
    })

    expect(normalizeReverbParamsForUpdate({ wet: 0.5 }, existing)).toEqual({
      ...existing,
      wet: 0.5,
    })
  })

  test('parses shared Reverb operations without filling omitted optional params', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterReverbParams',
      payload: {
        params: {
          enabled: true,
          wet: 0.4,
          decaySec: 4,
          preDelayMs: 40,
        },
      },
    })).toEqual({
      kind: 'effects.setMasterReverbParams',
      payload: {
        params: {
          enabled: true,
          wet: 0.4,
          decaySec: 4,
          preDelayMs: 40,
        },
      },
    })
  })
})
