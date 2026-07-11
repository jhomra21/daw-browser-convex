import { describe, expect, test } from 'bun:test'
import {
  OWNED_PROCESSOR_KINDS,
  OWNED_PROCESSOR_PARAMETER_IDS,
} from '@daw-browser/shared'
import { ownedProcessorAudioParamValues } from './owned-processor-audio-descriptors'

describe('owned processor audio descriptors', () => {
  test('binds every declared AudioParam for every owned processor kind', () => {
    for (const kind of OWNED_PROCESSOR_KINDS) {
      const bindings = ownedProcessorAudioParamValues(kind, {})
      expect(bindings.map((binding) => binding.parameterId)).toEqual([...OWNED_PROCESSOR_PARAMETER_IDS[kind]])
      for (const binding of bindings) expect(binding.value).toBeNumber()
    }
  })

  test('maps AudioParam aliases and nested state paths', () => {
    expect(ownedProcessorAudioParamValues('limiter', {
      version: 1,
      state: { ceilingDbtp: -3, releaseMs: 250 },
    })).toContainEqual({ parameterId: 'limiter.ceiling', value: -3 })
    expect(ownedProcessorAudioParamValues('autofilter', {
      version: 1,
      state: { envelope: { amountOctaves: 2 } },
    })).toContainEqual({ parameterId: 'autofilter.envelope.amountOctaves', value: 2 })
  })
})
