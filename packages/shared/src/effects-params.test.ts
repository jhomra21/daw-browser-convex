import { describe, expect, test } from 'bun:test'
import {
  AUDIO_EFFECT_CONTRACTS,
  computeCompressorStaticCurveDb,
  COMPRESSOR_EXPAND_MAX_GAIN_DB,
  COMPRESSOR_RATIO_MAX,
  createDefaultCompressorParams,
  createDefaultEqParams,
  createDefaultReverbParams,
  DELAY_FEEDBACK_MAX,
  DELAY_FILTER_HZ_MIN,
  DELAY_FILTER_WIDTH_MAX,
  DELAY_OFFSET_PERCENT_MAX,
  DELAY_TIME_MS_MAX,
  DELAY_TIME_MS_MIN,
  createDefaultEqBand,
  EQ_FREQUENCY_MIN,
  EQ_GAIN_DB_MAX,
  EQ_GAIN_DB_MIN,
  EQ_Q_MAX,
  EQ_Q_MIN,
  normalizeEqParams,
  normalizeEqParamsForUpdate,
  normalizeDelayParams,
  normalizeAudioEffectOrder,
  normalizeCompressorParams,
  normalizeReverbParams,
  normalizeReverbParamsForUpdate,
  normalizeSaturatorParams,
  SATURATOR_DRIVE_DB_MAX,
  SATURATOR_OUTPUT_DB_MIN,
  serializeCompressorParams,
  serializeDelayParams,
  serializeEqParams,
  serializeReverbParams,
  snapLimiterLookaheadMs,
  serializeSaturatorParams,
  REVERB_DECAY_SEC_MAX,
  REVERB_WET_MAX,
  serializeNormalizedEqParams,
} from './effects-params'
import { AUDIO_EFFECT_KINDS } from './audio-effect-registry'
import { normalizeSynthParams } from './synth-params'
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

  test('keeps exactly two curves of eight bands', () => {
    const custom = { id: 'b8', type: 'highpass' as const, frequency: 180, gainDb: 0, q: 0.7, enabled: true }
    const fewer = normalizeEqParams({ bands: [custom] })
    const more = normalizeEqParams({ bands: Array.from({ length: 20 }, (_, index) => createDefaultEqBand(index)) })

    // A missing second curve starts as a copy of the first.
    expect(fewer.bands).toEqual([
      custom,
      ...createDefaultEqParams().bands.slice(1, 7),
      { ...createDefaultEqBand(7), id: 'b8-default' },
      { ...custom, id: 'b9' },
      ...createDefaultEqParams().bands.slice(9),
    ])
    expect(more.bands).toEqual(createDefaultEqParams().bands)
  })

  test('parses shared EQ operations with normalized payloads', () => {
    const firstBand = { id: 'b1', type: 'peaking' as const, frequency: EQ_FREQUENCY_MIN, gainDb: EQ_GAIN_DB_MAX, q: EQ_Q_MAX, enabled: true }

    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterEqParams',
      payload: {
        instanceId: 'master-eq-1',
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
        instanceId: 'master-eq-1',
        params: {
          enabled: true,
          channelMode: 'stereo',
          adaptiveQ: false,
          scale: 1,
          outputDb: 0,
          highQuality: true,
          bands: [firstBand, ...createDefaultEqParams().bands.slice(1, 8), { ...firstBand, id: 'b9' }, ...createDefaultEqParams().bands.slice(9)],
        },
      },
    })
  })
})

describe('Synth params', () => {
  test('defaults non-finite gain and envelope values', () => {
    const defaults = normalizeSynthParams({})

    expect(normalizeSynthParams({
      gain: Number.NaN,
      attackMs: Number.POSITIVE_INFINITY,
      releaseMs: Number.NEGATIVE_INFINITY,
    })).toMatchObject({
      gain: defaults.gain,
      ampEnvelope: { attackSec: defaults.ampEnvelope.attackSec, releaseSec: defaults.ampEnvelope.releaseSec },
    })
  })
})


describe('Compressor params', () => {
  test('normalizes defaults, clamps ratio, and falls back for invalid enums', () => {
    const defaults = createDefaultCompressorParams()

    const normalized = normalizeCompressorParams({
      ratio: 999,
      thresholdDb: -999,
      detectorMode: 'average',
      dynamicsMode: 'limit',
      envelopeCurve: 'fast',
      sidechain: { enabled: true, filterType: 'tilt', frequencyHz: 999999, q: 0 },
    })

    expect(normalized.ratio).toBe(COMPRESSOR_RATIO_MAX)
    expect(normalized.thresholdDb).toBe(-60)
    expect(normalized.detectorMode).toBe(defaults.detectorMode)
    expect(normalized.dynamicsMode).toBe(defaults.dynamicsMode)
    expect(normalized.envelopeCurve).toBe(defaults.envelopeCurve)
    expect(normalized.sidechain.filterType).toBe(defaults.sidechain.filterType)
    expect(normalized.sidechain.frequencyHz).toBe(20000)
    expect(normalized.sidechain.q).toBe(0.1)
  })

  test('serializes normalized compressor params stably without Infinity', () => {
    const normalized = normalizeCompressorParams({ ratio: 999 })
    expect(normalized.ratio).toBe(100)
    expect(serializeCompressorParams(normalized)).not.toContain('Infinity')
    expect(serializeCompressorParams(normalized)).toBe(serializeCompressorParams({ ...normalized, ratio: 999 }))
  })

  test('adds compressor to audio effect order', () => {
    expect(AUDIO_EFFECT_KINDS).toEqual(['utility', 'eq', 'autofilter', 'gate', 'compressor', 'saturator', 'limiter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'delay', 'reverb', 'spectral', 'spectrum'])
    expect(normalizeAudioEffectOrder(['delay', 'compressor'], ['eq', 'compressor', 'delay'])).toEqual(['delay', 'compressor', 'eq'])
  })

  test('computes hard-knee compression and expansion static curves', () => {
    expect(computeCompressorStaticCurveDb(-12, { thresholdDb: -24, ratio: 4, kneeDb: 0 })).toBeCloseTo(-21, 5)
    // Live: a ratio of 1:2 means that every 1 dB of input above the threshold raises the output by 2 dB; 1:1 is no expansion.
    expect(computeCompressorStaticCurveDb(-12, { thresholdDb: -24, ratio: 2, kneeDb: 0, dynamicsMode: 'expand' })).toBeCloseTo(0, 5)
    expect(computeCompressorStaticCurveDb(-36, { thresholdDb: -24, ratio: 2, kneeDb: 0, dynamicsMode: 'expand' })).toBeCloseTo(-36, 5)
    expect(computeCompressorStaticCurveDb(-12, { thresholdDb: -24, ratio: 1, kneeDb: 0, dynamicsMode: 'expand' })).toBeCloseTo(-12, 5)
  })

  test('stops upward expansion at the gain limit', () => {
    expect(computeCompressorStaticCurveDb(0, { thresholdDb: -24, ratio: 100, kneeDb: 0, dynamicsMode: 'expand' })).toBeCloseTo(COMPRESSOR_EXPAND_MAX_GAIN_DB, 5)
  })

  test('keeps soft-knee compression continuous around threshold', () => {
    const below = computeCompressorStaticCurveDb(-24.01, { thresholdDb: -24, ratio: 4, kneeDb: 6 })
    const above = computeCompressorStaticCurveDb(-23.99, { thresholdDb: -24, ratio: 4, kneeDb: 6 })
    expect(Math.abs(above - below)).toBeLessThan(0.03)
  })

  test('keeps soft-knee expansion continuous in value and slope across the knee', () => {
    const params = { thresholdDb: -24, ratio: 3, kneeDb: 6, dynamicsMode: 'expand' } as const
    const gain = (inputDb: number) => computeCompressorStaticCurveDb(inputDb, params) - inputDb

    for (const edge of [-27, -21]) {
      expect(Math.abs(gain(edge + 1e-6) - gain(edge - 1e-6))).toBeLessThan(1e-5)
      const slopeBelow = (gain(edge) - gain(edge - 1e-3)) / 1e-3
      const slopeAbove = (gain(edge + 1e-3) - gain(edge)) / 1e-3
      expect(Math.abs(slopeAbove - slopeBelow)).toBeLessThan(0.01)
    }
  })

  test('computes soft-knee expansion fixtures around threshold and knee edge', () => {
    expect(computeCompressorStaticCurveDb(-24, { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' })).toBeCloseTo(-24 + 0.75, 5)
    expect(computeCompressorStaticCurveDb(-21, { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' })).toBeCloseTo(-21 + 3, 5)
    expect(computeCompressorStaticCurveDb(-27, { thresholdDb: -24, ratio: 2, kneeDb: 6, dynamicsMode: 'expand' })).toBeCloseTo(-27, 5)
  })

  test('parses shared track and master compressor operations', () => {
    const params = normalizeCompressorParams({})
    expect(parseSharedTimelineOperation({ kind: 'effects.setCompressorParams', payload: { trackId: 'track-1', instanceId: 'compressor-1', params } })?.kind)
      .toBe('effects.setCompressorParams')
    expect(parseSharedTimelineOperation({ kind: 'effects.setMasterCompressorParams', payload: { instanceId: 'master-compressor-1', params } })?.kind)
      .toBe('effects.setMasterCompressorParams')
  })

  test('rejects partial shared track and master compressor operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setCompressorParams',
      payload: { trackId: 'track-1', params: { enabled: true } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterCompressorParams',
      payload: { params: { enabled: true } },
    })).toBeNull()
  })
})

describe('Limiter params', () => {
  test('normalizes the state envelope', () => {
    expect(AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams({ version: 1,
      state: {
        enabled: false,
        gainDb: 40,
        ceilingDbtp: -20,
        releaseMs: 5,
        autoRelease: true,
        lookaheadMs: 20,
        link: 2,
      },
    })).toEqual({
      version: 1,
      state: {
        enabled: false,
        gainDb: 24,
        ceilingDbtp: -12,
        releaseMs: 20,
        autoRelease: true,
        lookaheadMs: 6,
        link: 1,
      },
    })
  })

  test('snaps the lookahead to the nearest step and defaults to Gain 0 dB with Auto off', () => {
    expect(AUDIO_EFFECT_CONTRACTS.limiter.createDefaultParams().state).toMatchObject({ gainDb: 0, autoRelease: false, lookaheadMs: 3 })
    expect([1, 2, 2.3, 2.3, 4.5, 5].map(snapLimiterLookaheadMs)).toEqual([1.5, 1.5, 3, 3, 6, 6])
  })
})

describe('Audio effect order', () => {
  test('normalizes order against enabled effects', () => {
    expect(normalizeAudioEffectOrder(['delay', 'unknown', 'eq', 'delay'], ['eq', 'delay', 'reverb'])).toEqual(['delay', 'eq', 'reverb'])
  })

  test('parses shared reorder operations and rejects unknown effects', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.reorderAudioChain',
      payload: { trackId: 'track-1', order: ['delay', 'eq'] },
    })).toEqual({
      kind: 'effects.reorderAudioChain',
      payload: { trackId: 'track-1', order: ['delay', 'eq'] },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.reorderMasterAudioChain',
      payload: { order: ['reverb', 'saturator'] },
    })?.kind).toBe('effects.reorderMasterAudioChain')
    expect(parseSharedTimelineOperation({
      kind: 'effects.reorderAudioChain',
      payload: { trackId: 'track-1', order: [{ id: 'eq-a', kind: 'eq' }, { id: 'eq-b', kind: 'eq' }] },
    })).toEqual({
      kind: 'effects.reorderAudioChain',
      payload: { trackId: 'track-1', order: [{ id: 'eq-a', kind: 'eq' }, { id: 'eq-b', kind: 'eq' }] },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.reorderAudioChain',
      payload: { trackId: 'track-1', order: ['delay', 'chorus'] },
    })?.kind).toBe('effects.reorderAudioChain')
  })

  test('parses shared audio effect removal operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'track', trackId: 'track-1', effect: 'delay', instanceId: 'delay-1' },
    })).toEqual({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'track', trackId: 'track-1', effect: 'delay', instanceId: 'delay-1' },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'master', effect: 'reverb', instanceId: 'master-reverb-1' },
    })).toEqual({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'master', effect: 'reverb', instanceId: 'master-reverb-1' },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'track', trackId: 'track-1', effect: 'eq', instanceId: 'eq-a' },
    })).toEqual({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'track', trackId: 'track-1', effect: 'eq', instanceId: 'eq-a' },
    })
    expect(parseSharedTimelineOperation({
      kind: 'effects.removeAudioEffect',
      payload: { targetType: 'track', trackId: 'track-1', effect: 'chorus', instanceId: 'chorus-1' },
    })?.kind).toBe('effects.removeAudioEffect')
  })
})

describe('Modulation effect contracts', () => {
  test('normalizes v1 envelopes and includes all modulation kinds in order', () => {
    expect(AUDIO_EFFECT_KINDS).toContain('chorus')
    expect(AUDIO_EFFECT_KINDS).toContain('ensemble')
    expect(AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams({ delayMs: 100, feedback: -1 })).toEqual({
      version: 1,
      state: {
        enabled: true,
        delayMs: 30,
        depthMs: 4,
        rateHz: 0.8,
        feedback: 0,
        stereoPhase: 0.25,
        mix: 0.35,
        mode: 'chorus',
        waveform: 'sine',
        safeBass: false,
        safeBassHz: 100,
        width: 1,
        outputDb: 0,
      },
    })
    expect(AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams({ version: 1, state: { stages: 5, centerHz: 1 } }).state)
      .toMatchObject({ stages: 6, centerHz: 100 })
    // 'square' became a real Tremolo waveform in v2; only names outside the list fall back to sine.
    expect(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({ waveform: 'square' }).state.waveform).toBe('square')
    expect(AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams({ waveform: 'zigzag' }).state.waveform).toBe('sine')
    expect(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({ mode: 'vibrato' }).state.mode).toBe('flanger')
    expect(AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams({ voices: 9 }).state.voices).toBe(3)
  })

  test('serializes normalized modulation envelopes stably', () => {
    const normalized = AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({ feedback: 2 })
    expect(AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(normalized))
      .toBe(AUDIO_EFFECT_CONTRACTS.flanger.serializeParams(AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams({ feedback: 0.95 })))
  })
})

describe('Saturator params', () => {
  test('normalizes and serializes equivalent inputs', () => {
    const normalized = normalizeSaturatorParams({ driveDb: 999, outputDb: -999, dryWet: 2, colorFrequencyHz: 1, colorHighDb: 99, bassThresholdDb: 5, warpPeriod: 0 })

    expect(normalized.driveDb).toBe(SATURATOR_DRIVE_DB_MAX)
    expect(normalized.outputDb).toBe(SATURATOR_OUTPUT_DB_MIN)
    expect(normalized.dryWet).toBe(1)
    expect(normalized.colorFrequencyHz).toBe(100)
    expect(normalized.colorHighDb).toBe(12)
    expect(normalized.bassThresholdDb).toBe(0)
    expect(normalized.warpPeriod).toBe(0.1)
    expect(serializeSaturatorParams(normalized)).toBe(serializeSaturatorParams({ ...normalized, driveDb: 999 }))
  })

  test('rejects partial shared track and master operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setSaturatorParams',
      payload: { trackId: 'track-1', params: { enabled: false } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterSaturatorParams',
      payload: { params: { enabled: false } },
    })).toBeNull()
  })
})

describe('Delay params', () => {
  test('normalizes limits of the time, offset and band-pass filter', () => {
    const normalized = normalizeDelayParams({ timeLeftMs: 9999, timeRightMs: 0, offsetLeftPercent: 90, feedback: 4, dryWet: -1, filterHz: 5, filterWidth: 99 })

    expect(normalized.timeLeftMs).toBe(DELAY_TIME_MS_MAX)
    expect(normalized.timeRightMs).toBe(DELAY_TIME_MS_MIN)
    expect(normalized.offsetLeftPercent).toBe(DELAY_OFFSET_PERCENT_MAX)
    expect(normalized.feedback).toBe(DELAY_FEEDBACK_MAX)
    expect(normalized.dryWet).toBe(0)
    expect(normalized.filterHz).toBe(DELAY_FILTER_HZ_MIN)
    expect(normalized.filterWidth).toBe(DELAY_FILTER_WIDTH_MAX)
    expect(serializeDelayParams(normalized)).toBe(serializeDelayParams({ ...normalized, feedback: 4 }))
  })

  test('parses shared track and master delay operations', () => {
    const params = normalizeDelayParams({})
    expect(parseSharedTimelineOperation({ kind: 'effects.setDelayParams', payload: { trackId: 'track-1', instanceId: 'delay-1', params } })?.kind)
      .toBe('effects.setDelayParams')
    expect(parseSharedTimelineOperation({ kind: 'effects.setMasterDelayParams', payload: { instanceId: 'master-delay-1', params } })?.kind)
      .toBe('effects.setMasterDelayParams')
  })

  test('rejects partial shared track and master operations', () => {
    expect(parseSharedTimelineOperation({
      kind: 'effects.setDelayParams',
      payload: { trackId: 'track-1', params: { enabled: false } },
    })).toBeNull()
    expect(parseSharedTimelineOperation({
      kind: 'effects.setMasterDelayParams',
      payload: { params: { enabled: false } },
    })).toBeNull()
  })
})

describe('Saturator shared operations', () => {
  test('parses shared track and master saturator operations', () => {
    const params = normalizeSaturatorParams({})
    expect(parseSharedTimelineOperation({ kind: 'effects.setSaturatorParams', payload: { trackId: 'track-1', instanceId: 'saturator-1', params } })?.kind)
      .toBe('effects.setSaturatorParams')
    expect(parseSharedTimelineOperation({ kind: 'effects.setMasterSaturatorParams', payload: { instanceId: 'master-saturator-1', params } })?.kind)
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
        instanceId: 'master-reverb-1',
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
        instanceId: 'master-reverb-1',
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
