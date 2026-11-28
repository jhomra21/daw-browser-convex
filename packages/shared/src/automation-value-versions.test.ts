import { describe, expect, it, spyOn } from 'bun:test'
import {
  AUDIO_EFFECT_PARAMS_VERSION,
  AUDIO_EFFECT_PARAMS_VERSIONING,
  automationValuesVersionStamp,
  migrateAutomationPointValues,
  type AudioEffectParamsVersioning,
} from './audio-effect-param-versions'
import { AUTO_FILTER_MAX_Q, AUTO_FILTER_MIN_Q } from './effects-params'

const points = (...values: number[]) => values.map((value, index) => ({ id: `p${index}`, timeSec: index, value, interpolation: 'linear' as const }))

const qOf = (resonance: number) => AUTO_FILTER_MIN_Q * (AUTO_FILTER_MAX_Q / AUTO_FILTER_MIN_Q) ** resonance

// Test-only chain: utility is pretended to be at version 3; gain is doubled at 1 -> 2 and offset at 2 -> 3.
const exampleVersioning: AudioEffectParamsVersioning = {
  ...AUDIO_EFFECT_PARAMS_VERSIONING,
  current: { ...AUDIO_EFFECT_PARAMS_VERSION, utility: 3 },
  parameterValues: {
    utility: {
      1: { 'utility.gainDb': (value) => value * 2 },
      2: { 'utility.gainDb': (value) => value + 1 },
    },
  },
}

describe('automation value versions', () => {
  it('migrates an unversioned Auto Filter resonance lane so it drives the same Q as when it was recorded', () => {
    const old = [0.05, 0.25, 0.38]
    const migrated = migrateAutomationPointValues('autofilter.resonance', points(...old), undefined)

    migrated.forEach((point, index) => expect(qOf(point.value)).toBeCloseTo(0.5 + 19.5 * (old[index] ?? 0), 6))
    expect(migrated.map((point) => point.id)).toEqual(['p0', 'p1', 'p2'])
    expect(migrateAutomationPointValues('autofilter.resonance', points(1, 0), 1).map((point) => point.value)).toEqual([1, 0])
  })

  it('rescales the Auto Filter envelope amount lane', () => {
    expect(migrateAutomationPointValues('autofilter.envelope.amountOctaves', points(4, -6, 0), 1).map((point) => point.value)).toEqual([
      4 * 0.25118864 / 0.8, -6 * 0.25118864 / 0.8, 0,
    ])
  })

  it('leaves a current-version lane unchanged', () => {
    const lane = points(0.1, 0.9)

    expect(migrateAutomationPointValues('autofilter.resonance', lane, AUDIO_EFFECT_PARAMS_VERSION.autofilter)).toBe(lane)
  })

  it('leaves parameters without a table entry, mixer lanes and instrument lanes untouched', () => {
    const lane = points(0.5, 1.5)

    expect(migrateAutomationPointValues('autofilter.mix', lane, 1)).toEqual(lane)
    expect(migrateAutomationPointValues('volume', lane, 1)).toBe(lane)
    expect(migrateAutomationPointValues('instrument:sampler-1:gain', lane, 1)).toBe(lane)
    expect(automationValuesVersionStamp('volume')).toEqual({})
    expect(automationValuesVersionStamp('instrument:sampler-1:gain')).toEqual({})
  })

  it('applies each step from the stored version up to current', () => {
    expect(migrateAutomationPointValues('utility.gainDb', points(3), 1, exampleVersioning)[0]?.value).toBe(7)
    expect(migrateAutomationPointValues('utility.gainDb', points(3), undefined, exampleVersioning)[0]?.value).toBe(7)
    expect(migrateAutomationPointValues('utility.gainDb', points(3), 2, exampleVersioning)[0]?.value).toBe(4)
    expect(migrateAutomationPointValues('utility.gainDb', points(3), 3, exampleVersioning)[0]?.value).toBe(3)
  })

  it('returns values from a newer build unchanged and warns once per kind and version', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const lane = points(0.4)

    expect(migrateAutomationPointValues('autofilter.resonance', lane, 99)).toBe(lane)
    expect(migrateAutomationPointValues('autofilter.resonance', lane, 99)).toBe(lane)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('stamps an effect parameter with its kind current version and nothing else', () => {
    expect(automationValuesVersionStamp('autofilter.resonance')).toEqual({ valuesVersion: AUDIO_EFFECT_PARAMS_VERSION.autofilter })
    expect(automationValuesVersionStamp('utility.gainDb')).toEqual({ valuesVersion: AUDIO_EFFECT_PARAMS_VERSION.utility })
  })

  it('round trips: a lane stamped on write reads back unchanged', () => {
    const lane = points(0.2, 0.7)
    const { valuesVersion } = automationValuesVersionStamp('autofilter.resonance')

    expect(migrateAutomationPointValues('autofilter.resonance', lane, valuesVersion)).toBe(lane)
  })
})
