import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { createLiveMixerRuntime, findExternalSidechainTarget, sidechainRouteIdentity } from './live-mixer-runtime'

const createTestAudio = () => {
  let failNextParameterWrite = false
  const createParam = (value = 1) => {
    let currentValue = value
    return {
      get value() {
        return currentValue
      },
      set value(nextValue: number) {
        if (failNextParameterWrite) {
          failNextParameterWrite = false
          throw new Error('Audio parameter update failed.')
        }
        currentValue = nextValue
      },
      cancelScheduledValues: () => {},
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
    }
  }
  const createNode = () => {
    const node = Object.assign(Object.create(null), {
      connect: () => {},
      disconnect: () => {},
    })
    return node
  }
  const createGain = () => Object.assign(createNode(), { gain: createParam() })
  const context = Object.assign(Object.create(null), {
    currentTime: 0,
    sampleRate: 48_000,
    destination: Object.assign(createNode(), { maxChannelCount: 2 }),
    createGain,
    createDelay: () => Object.assign(createNode(), { delayTime: createParam(0) }),
  })
  return {
    context,
    masterInput: createGain(),
    failNextParameterWrite: () => {
      failNextParameterWrite = true
    },
  }
}

const createRuntime = () => {
  const audio = createTestAudio()
  const runtime = createLiveMixerRuntime({
    ensureAudio: () => {},
    getAudioContext: () => audio.context,
    getMasterInput: () => audio.masterInput,
    getDestination: () => null,
    createImpulseResponse: () => {
      throw new Error('Effects are not used by this test.')
    },
    reconnectTrackMeters: () => {},
    disposeTrackMeters: () => {},
    disposeSynthTrack: () => {},
    getMasterFx: () => ({}),
    getFaultGeneration: () => 0,
    workletBudget: createLiveWorkletBudget(),
  })
  return { runtime, audio }
}

const track = (id: string, volume: number, options?: { muted?: boolean; soloed?: boolean; clips?: Array<{ id: string }> }) => ({
  id,
  name: id,
  volume,
  muted: options?.muted,
  soloed: options?.soloed,
  clips: options?.clips?.map((clip) => ({
    ...clip,
    name: clip.id,
    color: '#ffffff',
    startSec: 0,
    duration: 1,
  })) ?? [],
})

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

  test('preserves live fader previews across topology refreshes while applying static mixer changes', () => {
    const { runtime } = createRuntime()
    runtime.updateTrackGains([track('track-a', 0.8)])
    const volume = runtime.resolveTrackAutomationBindings('track-a', 'volume')[0]?.param
    const output = runtime.getTrackOutput('track-a')

    expect(volume?.value).toBe(0.8)
    expect(output?.gain.value).toBe(1)

    runtime.previewTrackVolume('track-a', 0.2, false)
    runtime.updateTrackGains([
      track('track-a', 0.8, { clips: [{ id: 'new-clip' }] }),
      track('track-b', 0.4),
    ])

    expect(volume?.value).toBe(0.2)
    expect(runtime.getTrackOutput('track-b')?.gain.value).toBe(1)
    expect(runtime.resolveTrackAutomationBindings('track-b', 'volume')[0]?.param.value).toBe(0.4)

    runtime.updateTrackGains([
      track('track-a', 0.8, { clips: [{ id: 'new-clip' }] }),
      track('track-b', 0.4, { soloed: true }),
    ])

    expect(volume?.value).toBe(0.2)
    expect(output?.gain.value).toBe(0)

    runtime.updateTrackGains([
      track('track-a', 0.6, { clips: [{ id: 'new-clip' }] }),
      track('track-b', 0.4, { soloed: true }),
    ])

    expect(volume?.value).toBe(0.6)
    expect(output?.gain.value).toBe(0)

    runtime.updateTrackGains([track('track-b', 0.4)])
    runtime.updateTrackGains([track('track-a', 0.8)])

    expect(runtime.resolveTrackAutomationBindings('track-a', 'volume')[0]?.param.value).toBe(0.8)
  })

  test('retries static gain initialization after a failed graph application', () => {
    const { runtime, audio } = createRuntime()
    audio.failNextParameterWrite()

    expect(() => runtime.updateTrackGains([track('track-a', 0.6)])).toThrow('Audio parameter update failed.')
    expect(runtime.resolveTrackAutomationBindings('track-a', 'volume')[0]?.param.value).toBe(1)

    runtime.updateTrackGains([track('track-a', 0.6)])
    expect(runtime.resolveTrackAutomationBindings('track-a', 'volume')[0]?.param.value).toBe(0.6)
  })
})
