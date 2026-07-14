import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { createLiveMixerRuntime, findExternalSidechainTarget, sidechainRouteIdentity } from './live-mixer-runtime'

describe('live mixer sidechain identity', () => {
  test('scopes an effect instance identity by target track', () => {
    expect(sidechainRouteIdentity('target-a', 'compressor-1'))
      .not.toBe(sidechainRouteIdentity('target-b', 'compressor-1'))
    expect(sidechainRouteIdentity('target-a', 'compressor-1'))
      .toBe(sidechainRouteIdentity('target-a', 'compressor-1'))
  })

  test('keeps a sidechain route eligible while its target effect chain hydrates', () => {
    const effectInstanceId = 'compressor-1'
    expect(findExternalSidechainTarget(undefined, effectInstanceId)).toBeUndefined()

    const target = findExternalSidechainTarget([{
      id: effectInstanceId,
      kind: 'compressor',
      params: AUDIO_EFFECT_CONTRACTS.compressor.createDefaultParams(),
    }], effectInstanceId)

    expect(target?.id).toBe(effectInstanceId)
    expect(target?.kind).toBe('compressor')
  })

  test('ignores permanently missing and non-sidechain effect targets', () => {
    expect(findExternalSidechainTarget(undefined, 'missing')).toBeUndefined()
    expect(findExternalSidechainTarget([{
      id: 'eq-1',
      kind: 'eq',
      params: AUDIO_EFFECT_CONTRACTS.eq.createDefaultParams(),
    }], 'eq-1')).toBeUndefined()
  })

  test('contains a persisted route whose target effect is missing', () => {
    const runtime = createLiveMixerRuntime({
      ensureAudio: () => {},
      getAudioContext: () => null,
      getMasterInput: () => null,
      getDestination: () => null,
      createImpulseResponse: () => {
        throw new Error('No audio context is available.')
      },
      reconnectTrackMeters: () => {},
      disposeTrackMeters: () => {},
      disposeSynthTrack: () => {},
      getMasterFx: () => ({}),
      getFaultGeneration: () => 0,
      workletBudget: createLiveWorkletBudget(),
    })

    expect(() => runtime.setExternalSidechainRoutes([{
      sourceTrackId: 'source',
      targetTrackId: 'target',
      effectInstanceId: 'missing',
    }])).not.toThrow()
  })
})
