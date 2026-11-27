import { describe, expect, test } from 'bun:test'
import {
  AUDIO_EFFECT_CONTRACTS,
  AUDIO_EFFECT_KINDS,
  audioEffectAddPayloadSchema,
  createDefaultSpectrumParams,
  isDspAudioEffectKind,
  mergeSpectrumParamsEnvelope,
  normalizeSpectrumParamsEnvelope,
} from './index'

describe('Spectrum device params', () => {
  test('defaults to an enabled spectrum and spectrogram view', () => {
    expect(AUDIO_EFFECT_CONTRACTS.spectrum.createDefaultParams()).toEqual({ version: 1, state: { enabled: true, view: 'both', block: 2048, channel: 'both', maxHold: false } })
  })

  test('normalizes unknown views and non-boolean enabled back to the defaults', () => {
    expect(normalizeSpectrumParamsEnvelope({ version: 1, state: { enabled: 'yes', view: 'waterfall' } }).state)
      .toEqual({ enabled: true, view: 'both', block: 2048, channel: 'both', maxHold: false })
    expect(normalizeSpectrumParamsEnvelope(null).state).toEqual({ enabled: true, view: 'both', block: 2048, channel: 'both', maxHold: false })
  })

  test('keeps a valid block, channel and Max, and falls back for anything else', () => {
    expect(normalizeSpectrumParamsEnvelope({ version: 1, state: { block: 8192, channel: 'left', maxHold: true } }).state)
      .toEqual({ enabled: true, view: 'both', block: 8192, channel: 'left', maxHold: true })
    expect(normalizeSpectrumParamsEnvelope({ version: 1, state: { block: 3000, channel: 'middle', maxHold: 'on' } }).state)
      .toEqual({ enabled: true, view: 'both', block: 2048, channel: 'both', maxHold: false })
    expect(audioEffectAddPayloadSchema.safeParse({ effectKind: 'spectrum', params: { version: 1, state: { ...createDefaultSpectrumParams(), block: 777 } } }).success).toBe(false)
  })

  test('keeps a valid view and a disabled flag, merging partial updates over the existing state', () => {
    const existing = normalizeSpectrumParamsEnvelope({ version: 1, state: { enabled: false, view: 'spectrogram' } })
    expect(existing.state).toEqual({ enabled: false, view: 'spectrogram', block: 2048, channel: 'both', maxHold: false })
    expect(mergeSpectrumParamsEnvelope({ state: { view: 'spectrum' } }, existing).state)
      .toEqual({ enabled: false, view: 'spectrum', block: 2048, channel: 'both', maxHold: false })
  })

  test('is an orderable chain device but never a DSP kind', () => {
    expect(AUDIO_EFFECT_KINDS).toContain('spectrum')
    expect(isDspAudioEffectKind('spectrum')).toBe(false)
    expect(isDspAudioEffectKind('reverb')).toBe(true)
    expect(AUDIO_EFFECT_KINDS.filter(isDspAudioEffectKind)).toHaveLength(AUDIO_EFFECT_KINDS.length - 1)
  })

  test('is accepted as an effect insertion payload', () => {
    expect(audioEffectAddPayloadSchema.safeParse({ effectKind: 'spectrum' }).success).toBe(true)
    expect(audioEffectAddPayloadSchema.safeParse({ effectKind: 'spectrum', params: { version: 1, state: { enabled: true, view: 'bogus' } } }).success).toBe(false)
  })
})
