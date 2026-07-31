import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { createMasterFxRuntime } from './master-fx-runtime'

describe('master FX pending swaps', () => {
  test('does not publish a pending request without an audio context', async () => {
    const runtime = createMasterFxRuntime({
      getFaultGeneration: () => 0,
      workletBudget: createLiveWorkletBudget(),
    })

    await runtime.setFxInstances(null, null, null, [{
      id: 'pending-master-eq',
      kind: 'eq',
      params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams(),
    }])

    expect(runtime.getMixerFx().masterFxInstances).toEqual([])
  })
})
