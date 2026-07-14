import { describe, expect, test } from 'bun:test'
import { automationTargetKey, granularAutomationKey, instrumentAutomationKey, type AutomationEnvelope } from '@daw-browser/shared'
import { rebaseTrackAutomationEnvelope } from './history-persistence'

describe('history automation rebasing', () => {
  test('rebases sampler and granular keys without changing effect parameters', () => {
    const sampler: AutomationEnvelope = {
      id: 'sampler',
      projectId: 'project',
      target: { kind: 'track', trackId: 'old-track' },
      targetKey: 'old',
      parameterId: instrumentAutomationKey('old-track', 'instrument:sampler:1', 'filter.frequency'),
      enabled: true,
      points: [],
      updatedAt: 1,
    }
    const granular = {
      ...sampler,
      id: 'granular',
      parameterId: granularAutomationKey('old-track', 'instrument:granular:1', 'grainSize'),
    }
    const effect = {
      ...sampler,
      id: 'effect',
      parameterId: 'compressor.thresholdDb',
    }

    const rebasedSampler = rebaseTrackAutomationEnvelope(sampler, 'new-track')
    const rebasedGranular = rebaseTrackAutomationEnvelope(granular, 'new-track')
    const rebasedEffect = rebaseTrackAutomationEnvelope(effect, 'new-track')

    expect(rebasedSampler.parameterId).toBe(instrumentAutomationKey('new-track', 'instrument:sampler:1', 'filter.frequency'))
    expect(rebasedSampler.target).toMatchObject({ trackId: 'new-track' })
    expect(rebasedSampler.targetKey).toBe(automationTargetKey(rebasedSampler.target, rebasedSampler.parameterId))
    expect(rebasedGranular.parameterId).toBe(granularAutomationKey('new-track', 'instrument:granular:1', 'grainSize'))
    expect(rebasedEffect.parameterId).toBe('compressor.thresholdDb')
    expect(rebasedEffect.targetKey).toBe(automationTargetKey(rebasedEffect.target, rebasedEffect.parameterId))
  })
})
