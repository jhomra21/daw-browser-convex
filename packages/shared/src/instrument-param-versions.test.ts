import { describe, expect, it, spyOn } from 'bun:test'
import { automationValuesVersionStamp, migrateAutomationPointValues } from './audio-effect-param-versions'
import { effectRowParamsVersionStamp, migrateEffectRowParams } from './effect-row-param-versions'
import { createDefaultArpeggiatorParams } from './effects-params'
import { createDefaultDrumRackParams } from './drum-rack-params'
import { createDefaultGranularParams } from './granular-params'
import {
  INSTRUMENT_PARAMS_VERSION,
  INSTRUMENT_PARAMS_VERSIONING,
  migrateInstrumentParams,
  type InstrumentParamsVersioning,
  type VersionedInstrumentKind,
} from './instrument-param-versions'
import { granularAutomationKey } from './granular-automation'
import { isJsonObject, type JsonValue } from './json-value'
import { instrumentAutomationKey } from './sampler-automation'
import { createDefaultSamplerParams } from './sampler-params'
import { createDefaultSynthParams, normalizeSynthParams } from './synth-params'
import { synthAutomationKey } from './synth-automation'

const defaults: Readonly<Record<VersionedInstrumentKind, JsonValue>> = {
  synth: createDefaultSynthParams(),
  sampler: createDefaultSamplerParams(),
  'drum-rack': createDefaultDrumRackParams(),
  granular: createDefaultGranularParams(),
  arpeggiator: createDefaultArpeggiatorParams(),
}

const legacySynth = { wave1: 'square', wave2: 'sine', gain: 0.5, attackMs: 40, releaseMs: 300 }

describe('instrument parameter versions', () => {
  it('loads an unversioned saved params object of every kind as the same value', () => {
    for (const kind of Object.keys(defaults) as VersionedInstrumentKind[]) {
      expect(migrateInstrumentParams(kind, defaults[kind], undefined)).toEqual(defaults[kind])
    }
  })

  it('stamps the current version on every instrument row type and leaves other rows alone', () => {
    const envelope = (kind: VersionedInstrumentKind) => ({ kind, instanceId: 'i', params: defaults[kind] })

    for (const kind of ['synth', 'sampler', 'drum-rack', 'granular'] as const) {
      expect(effectRowParamsVersionStamp('instrument', envelope(kind))).toEqual({ paramsVersion: INSTRUMENT_PARAMS_VERSION[kind] })
    }
    expect(effectRowParamsVersionStamp('synth', defaults.synth)).toEqual({ paramsVersion: 2 })
    expect(effectRowParamsVersionStamp('arpeggiator', defaults.arpeggiator)).toEqual({ paramsVersion: 1 })
    expect(effectRowParamsVersionStamp('reverb', {})).toEqual({ paramsVersion: 2 })
    expect(effectRowParamsVersionStamp('external', {})).toEqual({})
    expect(effectRowParamsVersionStamp('instrument', { nothing: true })).toEqual({})
  })

  it('migrates a v1 synth (wave1/attackMs shape) to the v2 shape, bare or inside an instrument row', () => {
    const migrated = migrateInstrumentParams('synth', legacySynth, 1)

    expect(migrated).toEqual(normalizeSynthParams(legacySynth))
    expect(isJsonObject(migrated) && migrated.version).toBe(2)
    expect(migrateInstrumentParams('synth', legacySynth, undefined)).toEqual(migrated)
    expect(migrateEffectRowParams('synth', legacySynth, undefined)).toEqual(migrated)
    expect(migrateEffectRowParams('instrument', { kind: 'synth', instanceId: 'i', params: legacySynth }, undefined)).toEqual({ kind: 'synth', instanceId: 'i', params: migrated })
  })

  it('keeps a v2 synth that was saved before versions were stamped', () => {
    const params = createDefaultSynthParams()

    expect(migrateEffectRowParams('instrument', { kind: 'synth', instanceId: 'i', params }, undefined)).toEqual({ kind: 'synth', instanceId: 'i', params })
    expect(migrateEffectRowParams('synth', params, 2)).toEqual(params)
  })

  it('migrates by the envelope kind and leaves unrelated rows untouched', () => {
    const sampler = { kind: 'sampler', instanceId: 'i', params: defaults.sampler }
    const arp = defaults.arpeggiator

    expect(migrateEffectRowParams('instrument', sampler, undefined)).toEqual(sampler)
    expect(migrateEffectRowParams('arpeggiator', arp, undefined)).toEqual(arp)
    expect(migrateEffectRowParams('external', { x: 1 }, 7)).toEqual({ x: 1 })
  })

  it('applies a test-only chain step by step and fails on a gap', () => {
    const chain: InstrumentParamsVersioning = {
      parameterValues: {},
      current: { ...INSTRUMENT_PARAMS_VERSION, sampler: 3 },
      migrations: {
        sampler: {
          1: (params) => isJsonObject(params) ? { renamed: params.oldName } : params,
          2: (params) => isJsonObject(params) ? { ...params, current: true } : params,
        },
      },
    }

    expect(migrateInstrumentParams('sampler', { oldName: 1 }, undefined, chain)).toEqual({ renamed: 1, current: true })
    expect(migrateInstrumentParams('sampler', { renamed: 1 }, 2, chain)).toEqual({ renamed: 1, current: true })
    expect(() => migrateInstrumentParams('granular', {}, 1, { ...chain, current: { ...chain.current, granular: 2 } })).toThrow('Missing granular params migration from version 1 to 2.')
  })

  it('returns params from a newer build unchanged and warns once', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const params = { fromTheFuture: true }

    expect(migrateInstrumentParams('granular', params, 99)).toBe(params)
    expect(migrateInstrumentParams('granular', params, 99)).toBe(params)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('has a step for every version below current for every kind', () => {
    for (const kind of Object.keys(INSTRUMENT_PARAMS_VERSION) as VersionedInstrumentKind[]) {
      for (let version = 1; version < INSTRUMENT_PARAMS_VERSIONING.current[kind]; version += 1) {
        expect(INSTRUMENT_PARAMS_VERSIONING.migrations[kind]?.[version]).toBeFunction()
      }
    }
  })
})

describe('instrument automation value versions', () => {
  const lanes = [
    ['synth', synthAutomationKey('t', 'i', 'output.gain'), 2],
    ['sampler', instrumentAutomationKey('t', 'i', 'output.gain'), 1],
    ['granular', granularAutomationKey('t', 'i', 'position'), 1],
  ] as const

  it('stamps instrument lanes with the version of their instrument', () => {
    for (const [, parameterId, version] of lanes) expect(automationValuesVersionStamp(parameterId)).toEqual({ valuesVersion: version })
    expect(automationValuesVersionStamp('volume')).toEqual({})
  })

  it('passes instrument lane values through today, stamped or not', () => {
    const points = [{ value: 0.25 }, { value: 0.75 }]

    for (const [, parameterId] of lanes) {
      expect(migrateAutomationPointValues(parameterId, points, undefined)).toEqual(points)
      expect(migrateAutomationPointValues(parameterId, points, 1)).toEqual(points)
    }
  })
})
