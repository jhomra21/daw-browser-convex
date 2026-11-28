import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_KINDS, isModulationOperationKind } from './audio-effect-registry'
import { normalizeAudioEffectRow } from './audio-effect-normalization'
import { buildEffectParamsOperation } from './effect-params-operation'
import { parseSharedTimelineOperation } from './shared-timeline-operations'
import type { JsonValue } from './json-value'

describe('effect params operations', () => {
  for (const kind of AUDIO_EFFECT_KINDS) {
    test(`${kind} builds an operation the shared parser accepts unchanged, on a track and on the master`, () => {
      const row = normalizeAudioEffectRow(kind, {})

      for (const trackId of ['track-1', undefined]) {
        const operation = buildEffectParamsOperation(row, 'instance-1', trackId)
        const parsed = parseSharedTimelineOperation(JSON.parse(JSON.stringify(operation)))

        expect(parsed).toEqual(operation)
        expect(operation.kind.startsWith(trackId === undefined ? 'effects.setMaster' : 'effects.set')).toBe(true)
        expect(operation.kind.includes('Modulation')).toBe(isModulationOperationKind(kind))
      }
    })
  }

  test('the shared parser refuses modulation payloads without a track, an effect or a version-1 envelope', () => {
    const params = normalizeAudioEffectRow('chorus', {}).params
    const parse = (kind: string, payload: Record<string, JsonValue>) => parseSharedTimelineOperation({ kind, payload })

    expect(parse('effects.setModulationParams', { effect: 'chorus', params, instanceId: 'a' })).toBeNull()
    expect(parse('effects.setMasterModulationParams', { effect: 'eq', params, instanceId: 'a' })).toBeNull()
    expect(parse('effects.setMasterModulationParams', { effect: 'chorus', params: { version: 2, state: {} }, instanceId: 'a' })).toBeNull()
    expect(parse('effects.setMasterModulationParams', { effect: 'chorus', params, instanceId: '' })).toBeNull()
  })
})
