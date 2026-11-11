import { afterEach, describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { captureFxTransitions, compressorInstance, createCountingBudget, createFxTestAudio, createFxTransitionHarness, eqInstance, heldEqGain, partialWriteCases, reverbInstance, staticGateInstance, syncedDelayInstance } from './fx-runtime-test-audio'
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

describe('live mixer publication recovery transitions', () => {
  test('fault bypass preserves a failed publication mark for an equal retry', async () => {
    const f = createFxTransitionHarness('track')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.track.subscribeTrackGateMeter('t', 'h', () => {
        if (fail) {
          fail = false
          throw new Error('Publication reset failed.')
        }
      })
      await f.set([h, eqInstance(0, 'e')])
      fail = true
      const failedPublication = [staticGateInstance(-20, 4, 'h'), eqInstance(6, 'e')]
      expect((await Promise.allSettled([f.set(failedPublication)]))[0]?.status).toBe('rejected')
      f.audio.faultCompressor(1)

      expect((await f.set([eqInstance(6, 'e')])).disposition).toBe('applied')
    } finally {
      fail = false
      subscription.unsubscribe()
      f.close()
    }
  })

  test('preserves a later meter publication failure across a pending reconnect', async () => {
    const f = createFxTransitionHarness('track')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    const frames: number[] = []
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.track.subscribeTrackGateMeter('t', 'h', (frame) => {
        if (fail) {
          fail = false
          throw new Error('Later meter reset failed.')
        }
        frames.push(frame.gainReductionDb)
      })
      await f.set([h, eqInstance(0, 'e')])
      fail = true
      const next = [staticGateInstance(-20, 4, 'h'), eqInstance(6, 'e')]
      expect((await Promise.allSettled([f.set(next)]))[0]?.status).toBe('rejected')
      f.timers.run()
      expect((await f.set(next)).disposition).toBe('applied')
      const onmessage = f.audio.workletNode(1)?.port.onmessage
      if (!onmessage) throw new Error('No meter port callback.')
      onmessage(new MessageEvent('message', { data: { type: 'meter', gainReductionDb: 7 } }))
      expect(frames).toContain(7)
    } finally {
      fail = false
      subscription.unsubscribe()
      f.close()
    }
  })

  test('preserves the publication mark when a pending reconnect throws after an in-place edit', async () => {
    const f = createFxTransitionHarness('track')
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), staticGateInstance(-40, 4, 'h'), eqInstance(0, 'e')])
      f.timers.run()
      const next = [staticGateInstance(-40, 4, 'h'), eqInstance(0, 'e')]
      await f.set(next)
      expect((await f.set([staticGateInstance(-40, 4, 'h'), eqInstance(6, 'e')])).disposition).toBe('applied')
      f.audio.failNextConnection()
      expect(() => f.timers.run()).toThrow('Audio connection failed.')
      const retry = [staticGateInstance(-40, 4, 'h'), eqInstance(6, 'e')]
      expect((await f.set(retry)).disposition).toBe('applied')
      f.timers.run()
      expect(f.audio.connections().some((edge) => edge.target === f.audio.biquads[0])).toBe(true)
    } finally {
      f.close()
    }
  })

  test('preserves auxiliary publication work across a successful reconnect', async () => {
    const f = createFxTransitionHarness('track')
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), eqInstance(0, 'e')])
      f.timers.run()
      f.track.ensureTrackInput('source')
      f.track.setExternalSidechainRoutes([{ sourceTrackId: 'source', targetTrackId: 't', effectInstanceId: 'h' }])
      const createDelay = f.audio.context.createDelay
      let fail = true
      f.audio.context.createDelay = () => {
        const delay = createDelay()
        const connect = delay.connect
        delay.connect = (target: AudioNode | AudioParam) => {
          if (fail) {
            fail = false
            throw new Error('Auxiliary connection failed.')
          }
          return connect(target)
        }
        return delay
      }
      const next = [staticGateInstance(-40, 4, 'h'), eqInstance(0, 'e')]
      expect((await Promise.allSettled([f.set(next)]))[0]?.status).toBe('rejected')
      f.timers.run()
      expect((await f.set(next)).disposition).toBe('applied')
      const h = f.audio.workletNode(1)
      expect(f.audio.connections().some((edge) => f.audio.delays.some((delay) => delay === edge.source) && edge.target === h)).toBe(true)
    } finally {
      f.close()
    }
  })

  test('preserves spectral refresh work across a successful reconnect', async () => {
    let failAt = Number.POSITIVE_INFINITY
    let calls = 0
    const f = createFxTransitionHarness('track', () => {
      calls += 1
      if (calls === failAt) throw new Error('Spectral refresh latency failed.')
    })
    try {
      await f.set([staticGateInstance(-40, 4, 'g')])
      f.timers.run()
      failAt = calls + 2
      const spectral = { id: 's', kind: 'spectral', params: AUDIO_EFFECT_CONTRACTS.spectral.createDefaultParams() } satisfies AudioEffectRuntimeInstance
      expect((await Promise.allSettled([f.set([spectral])]))[0]?.status).toBe('rejected')
      f.timers.run()
      expect((await f.set([spectral])).disposition).toBe('applied')
    } finally {
      f.close()
    }
  })

  test('fault bypass drains retirement owned by the superseded reconnect', async () => {
    const f = createFxTransitionHarness('track')
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), staticGateInstance(-40, 4, 'h')])
      f.timers.run()
      await f.set([staticGateInstance(-40, 4, 'h')])
      f.audio.faultCompressor(1)
      f.timers.run()
      expect((await f.set([])).disposition).toBe('skipped')
      expect(f.audio.workletCloseCounts()).toEqual([1, 1])
    } finally {
      f.close()
    }
  })

  test('retries retirement after a meter reset throw and closes the port exactly once', async () => {
    const f = createFxTransitionHarness('track')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.track.subscribeTrackGateMeter('t', 'g', () => {
        if (fail) {
          fail = false
          throw new Error('Retirement meter reset failed.')
        }
      })
      await f.set([eqInstance(0, 'e')])
      fail = true
      expect(() => f.timers.run()).toThrow('Retirement meter reset failed.')
      expect((await f.set([eqInstance(0, 'e')])).disposition).toBe('applied')
      f.timers.run()
      expect(f.audio.workletCloseCounts()).toEqual([1])
    } finally {
      fail = false
      subscription.unsubscribe()
      f.close()
    }
  })

  test('rebinds the meter after the one-instance recovery fast path', async () => {
    const f = createFxTransitionHarness('track')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    const frames: number[] = []
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.track.subscribeTrackGateMeter('t', 'h', (frame) => {
        if (fail) {
          fail = false
          throw new Error('Meter rebind reset failed.')
        }
        frames.push(frame.gainReductionDb)
      })
      fail = true
      expect((await Promise.allSettled([f.set([h, eqInstance(0, 'e')])]))[0]?.status).toBe('rejected')
      expect((await f.set([h, eqInstance(6, 'e')])).disposition).toBe('applied')
      f.timers.run()
      const onmessage = f.audio.workletNode(1)?.port.onmessage
      if (!onmessage) throw new Error('No meter port callback.')
      onmessage(new MessageEvent('message', { data: { type: 'meter', gainReductionDb: 7 } }))
      expect(frames).toContain(7)
    } finally {
      fail = false
      subscription.unsubscribe()
      f.close()
    }
  })

  test('a fade-in ramp failure preserves the pending publication for an equal retry', async () => {
    const f = createFxTransitionHarness('track')
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), eqInstance(0, 'e')])
      f.timers.run()
      await f.set([eqInstance(0, 'e')])
      f.audio.failNextRampToValue(1)
      expect(() => f.timers.run()).toThrow('Audio ramp to 1 failed.')
      expect((await f.set([eqInstance(0, 'e')])).disposition).toBe('applied')
    } finally {
      f.close()
    }
  })

  test('a fade-out ramp failure keeps the publication retryable', async () => {
    const f = createFxTransitionHarness('track')
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), eqInstance(0, 'e')])
      f.timers.run()
      f.audio.failNextRampToValue(0)
      expect((await Promise.allSettled([f.set([eqInstance(0, 'e')])]))[0]?.status).toBe('rejected')
      expect((await f.set([eqInstance(0, 'e')])).disposition).toBe('applied')
      f.timers.run()
      expect(f.audio.connections().some((edge) => edge.target === f.audio.biquads[0])).toBe(true)
    } finally {
      f.close()
    }
  })
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

describe('track effect chain delivery', () => {
  const restores: Array<() => void> = []
  afterEach(() => {
    for (const restore of restores.splice(0)) restore()
  })

  const createChainRuntime = (hasContext: () => boolean = () => true, refuseCommit = false, ignoreBudgetCurrency = false) => {
    const audio = createFxTestAudio()
    const timers = captureFxTransitions()
    restores.push(audio.restore)
    restores.push(timers.restore)
    const counting = createCountingBudget(refuseCommit)
    const workletBudget = ignoreBudgetCurrency
      ? { ...counting.budget, isCurrent: () => true, commit: () => true }
      : counting.budget
    const runtime = createLiveMixerRuntime({
      ensureAudio: () => {},
      getAudioContext: () => hasContext() ? audio.context : null,
      getMasterInput: () => audio.masterInput,
      getDestination: () => null,
      reconnectTrackMeters: () => {},
      disposeTrackMeters: () => {},
      disposeSynthTrack: () => {},
      getMasterFx: () => ({}),
      getFaultGeneration: () => 0,
      workletBudget,
      transitionScheduler: timers.scheduler,
    })
    return { audio, runtime, budget: counting.budget, begins: counting.begins, timers }
  }

  test('re-applies the installed compressor value over an in-flight tick', async () => {
    const { audio, runtime } = createChainRuntime()
    await runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])
    const tick = runtime.setTrackFxInstances('track-1', [compressorInstance(-10)])
    const cancel = runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])
    const [tickResult, cancelResult] = await Promise.all([tick, cancel])

    expect(audio.compressorThreshold()).toBe(-24)
    expect(cancelResult).toBe('applied')
    expect(tickResult).toBe('superseded')
    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])).toBe('skipped')
  })

  test('control: an in-flight EQ tick never reaches the node, so the installed value stays', async () => {
    const { audio, runtime } = createChainRuntime()
    await runtime.setTrackFxInstances('track-1', [eqInstance(0)])
    const tick = runtime.setTrackFxInstances('track-1', [eqInstance(6)])
    const cancel = runtime.setTrackFxInstances('track-1', [eqInstance(0)])
    await Promise.all([tick, cancel])

    expect(heldEqGain(audio)).toBe(0)
  })

  test('skips an equal chain before the apply path', async () => {
    const { audio, runtime, begins } = createChainRuntime()
    const chain = [compressorInstance(-18), eqInstance(3)]
    expect(await runtime.setTrackFxInstances('track-1', chain)).toBe('applied')
    const posted = audio.postedCount()
    const beganBefore = begins()

    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18), eqInstance(3)])).toBe('skipped')
    expect(begins()).toBe(beganBefore)
    expect(audio.postedCount()).toBe(posted)
  })

  test('an equal chain skips during the recorded routing reconnect window', async () => {
    const { audio, runtime, timers } = createChainRuntime()
    runtime.ensureTrackInput('track-1')
    await runtime.setTrackFxInstances('track-1', [staticGateInstance(-40, 4, 'gate')])
    timers.run()
    const rampsBefore = audio.gainRampCount()

    expect(await runtime.setTrackFxInstances('track-1', [])).toBe('applied')
    const rampsDuringReconnect = audio.gainRampCount()
    expect(rampsDuringReconnect).toBe(rampsBefore + 1)
    expect(await runtime.setTrackFxInstances('track-1', [])).toBe('skipped')
    expect(audio.gainRampCount()).toBe(rampsDuringReconnect)
  })

  test('in-place edits during reconnect do not restart the fade or drain retirement', async () => {
    const { audio, runtime, timers } = createChainRuntime()
    runtime.ensureTrackInput('track-1')
    await runtime.setTrackFxInstances('track-1', [staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
    timers.run()
    const rampsBeforeReconnect = audio.gainRampCount()
    const oldGate = audio.workletNode(0)
    const input = audio.connections().find((connection) => connection.target === oldGate)?.source
    if (!oldGate || !input) throw new Error('Missing connected gate input.')

    expect(await runtime.setTrackFxInstances('track-1', [eqInstance(0, 'eq')])).toBe('applied')
    const rampsDuringReconnect = audio.gainRampCount()
    expect(rampsDuringReconnect).toBe(rampsBeforeReconnect + 1)
    expect(await runtime.setTrackFxInstances('track-1', [eqInstance(6, 'eq')])).toBe('applied')
    expect(await runtime.setTrackFxInstances('track-1', [eqInstance(3, 'eq')])).toBe('applied')
    expect(audio.gainRampCount()).toBe(rampsDuringReconnect)
    expect(audio.workletCloseCounts()).toEqual([0])
    expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(true)

    timers.run()
    expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
    expect(audio.connections().some((connection) => connection.target === audio.biquads[0])).toBe(true)
    expect(audio.workletCloseCounts()).toEqual([1])
  })

  test('retries a track reconnect after its callback throws', async () => {
    const { audio, runtime, timers } = createChainRuntime()
    runtime.ensureTrackInput('track-1')
    await runtime.setTrackFxInstances('track-1', [staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
    timers.run()
    const input = audio.connections().find((connection) => connection.target === audio.workletNode(0))?.source
    if (!input) throw new Error('Missing connected gate input.')
    expect(await runtime.setTrackFxInstances('track-1', [eqInstance(0, 'eq')])).toBe('applied')
    const rampsAfterRequest = audio.gainRampCount()
    audio.failNextConnection()
    expect(() => timers.run()).toThrow('Audio connection failed.')
    expect(audio.workletCloseCounts()).toEqual([0])
    expect(await runtime.setTrackFxInstances('track-1', [eqInstance(0, 'eq')])).toBe('applied')
    timers.run()

    expect(audio.connections().some((connection) => connection.source === input && connection.target === audio.biquads[0])).toBe(true)
    expect(audio.workletCloseCounts()).toEqual([1])
    expect(audio.gainRampCount()).toBe(rampsAfterRequest + 2)
  })

  test('joins an equal request while its work is pending', async () => {
    const { audio, runtime, begins } = createChainRuntime()
    const first = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
    const second = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])

    expect(await Promise.all([first, second])).toEqual(['applied', 'joined'])
    expect(begins()).toBe(1)
    expect(audio.compressorNodeCount()).toBe(1)
  })

  test('rejects a joined caller with the pending work failure and installs nothing', async () => {
    const { audio, runtime, begins } = createChainRuntime()
    audio.failNextModuleLoad()
    const first = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
    const second = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
    const settled = await Promise.allSettled([first, second])

    expect(begins()).toBe(1)
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected'])
    expect(audio.compressorNodeCount()).toBe(0)
    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
    expect(begins()).toBe(2)
  })

  test('applies the old value again after a whole-chain replacement', async () => {
    const { audio, runtime } = createChainRuntime()
    await runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])
    await runtime.setTrackFxInstances('track-1', [compressorInstance(-10)])

    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])).toBe('applied')
    expect(audio.compressorThreshold()).toBe(-24)
  })

  test('applies an equal resend again after the resource faulted', async () => {
    const { audio, runtime, begins } = createChainRuntime()
    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
    audio.faultCompressor()

    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
    expect(begins()).toBe(2)
    expect(audio.compressorNodeCount()).toBe(2)
  })

  test('applies an equal chain again after the track was removed and re-added', async () => {
    const { runtime, begins } = createChainRuntime()
    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
    runtime.disposeTrack('track-1')

    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
    expect(begins()).toBe(2)
  })

  test('drops a chain it cannot install without an audio context', async () => {
    const { runtime } = createChainRuntime(() => false)

    expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('dropped')
  })

  test('reports the single-instance replacement as a disposition, and an unknown id as not held', async () => {
    const { audio, runtime } = createChainRuntime()
    await runtime.setTrackFxInstances('track-1', [compressorInstance(-24)])

    expect(await runtime.replaceTrackFxInstance('track-1', compressorInstance(-10))).toBe('applied')
    expect(audio.compressorThreshold()).toBe(-10)
    expect(await runtime.replaceTrackFxInstance('track-1', compressorInstance(-10))).toBe('skipped')
    expect(await runtime.replaceTrackFxInstance('track-1', compressorInstance(-10, 'compressor-2'))).toBe('not-held')
  })

  describe('stale and unconfirmed writes', () => {
    const pair = (first: number, second: number) => [compressorInstance(first, 'c1'), compressorInstance(second, 'c2')]

    test('a superseded request writes nothing to the effects after the one it was applying', async () => {
      const { audio, runtime } = createChainRuntime()
      await runtime.setTrackFxInstances('track-1', pair(-24, -30))
      const tick = runtime.setTrackFxInstances('track-1', pair(-10, -6))
      const cancel = runtime.setTrackFxInstances('track-1', pair(-24, -30))

      expect(await Promise.all([tick, cancel])).toEqual(['superseded', 'applied'])
      expect([audio.compressorThreshold(0), audio.compressorThreshold(1)]).toEqual([-24, -30])
      expect(await runtime.setTrackFxInstances('track-1', pair(-24, -30))).toBe('skipped')
    })

    test('a failed parameter write is not remembered as held, so the resend writes it', async () => {
      const { audio, runtime } = createChainRuntime()
      await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      audio.failNextParamsPost()

      expect((await Promise.allSettled([runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])]))[0]?.status).toBe('rejected')
      expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])).toBe('applied')
      expect(audio.compressorThreshold()).toBe(-12)
    })

    test('a compressor that cannot be rebuilt after a fault fails the request instead of reporting it applied', async () => {
      const { audio, runtime } = createChainRuntime()
      await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      audio.faultCompressor()
      audio.failNextConstruction()

      expect((await Promise.allSettled([runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])]))[0]?.status).toBe('rejected')
      expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])).toBe('applied')
      expect(audio.compressorThreshold(1)).toBe(-12)
    })
  })

  describe('asynchronous publication', () => {
    // Enabling an installed, disabled effect builds its processor behind an await; a newer request must win it.
    const disabled = (kind: 'compressor' | 'reverb') => kind === 'compressor' ? compressorInstance(-18, 'fx', false) : reverbInstance(false, 0.2, 1, 'fx')
    const enabled = (kind: 'compressor' | 'reverb') => kind === 'compressor' ? compressorInstance(-18, 'fx') : reverbInstance(true, 0.8, 1, 'fx')
    const newer = (kind: 'compressor' | 'reverb') => kind === 'compressor' ? compressorInstance(-12, 'fx', false) : reverbInstance(false, 0.3, 1, 'fx')
    const kinds: Array<'compressor' | 'reverb'> = ['compressor', 'reverb']

    for (const kind of kinds) {
      test(`${kind}: an equal request to the installed disabled effect cancels the enable still building`, async () => {
        const { audio, runtime } = createChainRuntime()
        await runtime.setTrackFxInstances('track-1', [disabled(kind)])
        const stale = runtime.setTrackFxInstances('track-1', [enabled(kind)])
        const cancel = runtime.setTrackFxInstances('track-1', [disabled(kind)])

        expect(await Promise.all([stale, cancel])).toEqual(['superseded', 'applied'])
        expect(audio.liveWorkletCount()).toBe(0)
        expect(await runtime.setTrackFxInstances('track-1', [disabled(kind)])).toBe('skipped')
      })

      test(`${kind}: a different disabled request cancels the enable still building`, async () => {
        const { audio, runtime } = createChainRuntime()
        await runtime.setTrackFxInstances('track-1', [disabled(kind)])
        const stale = runtime.setTrackFxInstances('track-1', [enabled(kind)])
        const cancel = runtime.setTrackFxInstances('track-1', [newer(kind)])

        expect(await Promise.all([stale, cancel])).toEqual(['superseded', 'applied'])
        expect(audio.liveWorkletCount()).toBe(0)
      })

      test(`${kind}: removing the track releases the processor of an enable still building`, async () => {
        const { audio, runtime } = createChainRuntime()
        await runtime.setTrackFxInstances('track-1', [disabled(kind)])
        const stale = runtime.setTrackFxInstances('track-1', [enabled(kind)])
        runtime.disposeTrack('track-1')
        await Promise.allSettled([stale])

        expect(audio.liveWorkletCount()).toBe(0)
      })
    }
  })

  describe('partial writes', () => {
    const cases = (audio: ReturnType<typeof createFxTestAudio>, runtime: ReturnType<typeof createChainRuntime>['runtime']) =>
      partialWriteCases(audio, (parameterId, instanceId) => runtime.resolveTrackAutomationBindings('track-1', parameterId, instanceId)[0]?.param)

    for (const name of ['delay', 'saturator', 'reverb', 'eq']) {
      test(`${name}: a write that fails partway is repaired by returning to the previous value`, async () => {
        const { audio, runtime } = createChainRuntime()
        const edit = cases(audio, runtime).find((entry) => entry.name === name)
        if (!edit) throw new Error(`No case ${name}`)
        await runtime.setTrackFxInstances('track-1', [edit.before])
        edit.arm()

        expect((await Promise.allSettled([runtime.setTrackFxInstances('track-1', [edit.after])]))[0]?.status).toBe('rejected')
        expect(await runtime.setTrackFxInstances('track-1', [edit.before])).toBe('applied')
        expect(edit.read()).toBeCloseTo(edit.heldBefore)
        expect(await runtime.setTrackFxInstances('track-1', [edit.before])).toBe('skipped')
      })

      test(`${name}: a write that fails partway is repaired by retrying the new value`, async () => {
        const { audio, runtime } = createChainRuntime()
        const edit = cases(audio, runtime).find((entry) => entry.name === name)
        if (!edit) throw new Error(`No case ${name}`)
        await runtime.setTrackFxInstances('track-1', [edit.before])
        edit.arm()
        await Promise.allSettled([runtime.setTrackFxInstances('track-1', [edit.after])])

        expect(await runtime.setTrackFxInstances('track-1', [edit.after])).toBe('applied')
        expect(edit.read()).toBeCloseTo(edit.heldAfter)
      })
    }
  })

  describe('static worklet and tempo partial writes', () => {
    test('installed gate fault bypasses after a failed tempo write', async () => {
      const { audio, runtime, budget, begins } = createChainRuntime()
      const gate = staticGateInstance(-40, 4, 'gate')
      await runtime.setTrackFxInstances('track-1', [gate, syncedDelayInstance('delay')])
      audio.failNextParameterWrite(audio.delays[1]?.delayTime)

      expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
      audio.faultCompressor(0)

      expect(budget.committedCount()).toBe(0)
      expect(await runtime.setTrackFxInstances('track-1', [syncedDelayInstance('delay')])).toBe('applied')
      expect(audio.liveWorkletCount()).toBe(0)
      expect(begins()).toBe(3)
    })

    test('a pending chain request cannot restore an installed gate after its fault', async () => {
      const { audio, runtime } = createChainRuntime(() => true, false, true)
      const gate = staticGateInstance(-40, 4, 'gate')
      const delay = syncedDelayInstance('delay')
      await runtime.setTrackFxInstances('track-1', [gate, delay])
      const pending = runtime.setTrackFxInstances('track-1', [staticGateInstance(-20, 8, 'gate'), delay])
      audio.faultCompressor(0)

      expect(await pending).toBe('superseded')
      expect(await runtime.setTrackFxInstances('track-1', [delay])).toBe('skipped')
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('a retired gate fault cannot disturb a pending track edit and retirement closes it once', async () => {
      const { audio, runtime, timers } = createChainRuntime()
      runtime.ensureTrackInput('track-1')
      const gate = staticGateInstance(-40, 4, 'gate')
      const delay = syncedDelayInstance('delay')
      if (delay.kind !== 'delay') throw new Error('Expected delay fixture.')
      await runtime.setTrackFxInstances('track-1', [gate, delay])
      await runtime.setTrackFxInstances('track-1', [delay])
      const editedDelay = { ...delay, params: { ...delay.params, feedback: 0.7 } }
      const pending = runtime.setTrackFxInstances('track-1', [editedDelay])

      audio.faultCompressor(0)

      expect(await pending).toBe('applied')
      timers.run()
      expect(audio.workletCloseCount()).toBe(1)
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('a failed deferred EQ write still retires a removed track gate', async () => {
      const { audio, runtime, timers } = createChainRuntime()
      runtime.ensureTrackInput('track-1')
      const gate = staticGateInstance(-40, 4, 'gate')
      await runtime.setTrackFxInstances('track-1', [gate, eqInstance(0, 'eq')])
      timers.run()

      audio.failNextParameterWrite(audio.biquads[2]?.gain)
      await expect(Promise.allSettled([
        runtime.setTrackFxInstances('track-1', [eqInstance(6, 'eq')]),
      ])).resolves.toMatchObject([{ status: 'rejected' }])
      await runtime.setTrackFxInstances('track-1', [eqInstance(0, 'eq')])
      runtime.disposeTrack('track-1')

      expect(audio.workletCloseCounts()).toEqual([1])
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('rebuilds routing before retiring a removed gate after a deferred EQ failure', async () => {
      const { audio, runtime, timers } = createChainRuntime()
      runtime.ensureTrackInput('track-1')
      await runtime.setTrackFxInstances('track-1', [staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
      timers.run()
      const oldGate = audio.workletNode(0)
      const input = audio.connections().find((connection) => connection.target === oldGate)?.source
      if (!oldGate || !input) throw new Error('Missing connected gate input.')

      audio.failNextParameterWrite(audio.biquads[2]?.gain)
      expect((await Promise.allSettled([
        runtime.setTrackFxInstances('track-1', [eqInstance(6, 'eq')]),
      ]))[0]?.status).toBe('rejected')
      expect(await runtime.setTrackFxInstances('track-1', [eqInstance(6, 'eq')])).toBe('applied')
      timers.run()
      expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
      expect(audio.connections().some((connection) => connection.source === input && connection.target === audio.biquads[0])).toBe(true)
      expect(audio.workletCloseCounts()).toEqual([1])
      expect(await runtime.setTrackFxInstances('track-1', [eqInstance(6, 'eq')])).toBe('skipped')
    })

    test('settles routing after a certified request fails during latency publication', async () => {
      const audio = createFxTestAudio()
      const timers = captureFxTransitions()
      let failLatency = false
      const runtime = createLiveMixerRuntime({
        ensureAudio: () => {},
        getAudioContext: () => audio.context,
        getMasterInput: () => audio.masterInput,
        getDestination: () => null,
        reconnectTrackMeters: () => {},
        disposeTrackMeters: () => {},
        disposeSynthTrack: () => {},
        getMasterFx: () => ({}),
        getFaultGeneration: () => 0,
        workletBudget: createLiveWorkletBudget(),
        transitionScheduler: timers.scheduler,
        onGraphLatencyChange: () => {
          if (!failLatency) return
          failLatency = false
          throw new Error('Latency publication failed.')
        },
      })
      try {
        runtime.updateTrackGains([{ id: 'track-latency', name: 'track-latency', volume: 1, clips: [] }])
        await runtime.setTrackFxInstances('track-latency', [staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
        timers.run()
        const oldGate = audio.workletNode(0)
        const input = audio.connections().find((connection) => connection.target === oldGate)?.source
        if (!oldGate || !input) throw new Error('Missing connected gate input.')
        failLatency = true

        expect((await Promise.allSettled([
          runtime.setTrackFxInstances('track-latency', [eqInstance(6, 'eq')]),
        ]))[0]?.status).toBe('rejected')
        expect(await runtime.setTrackFxInstances('track-latency', [eqInstance(6, 'eq')])).toBe('applied')
        timers.run()
        expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
        expect(audio.connections().some((connection) => connection.source === input && connection.target === audio.biquads[0])).toBe(true)
      } finally {
        runtime.clear()
        timers.restore()
        audio.restore()
      }
    })

    test('a retired track gate fault preserves its pending re-add intent', async () => {
      const { audio, runtime } = createChainRuntime()
      runtime.ensureTrackInput('track-1')
      const delay = syncedDelayInstance('delay')
      const gate = staticGateInstance(-20, 8, 'gate')
      if (delay.kind !== 'delay') throw new Error('Expected delay fixture.')
      await runtime.setTrackFxInstances('track-1', [staticGateInstance(-40, 4, 'gate'), delay])
      await runtime.setTrackFxInstances('track-1', [delay])
      const pending = runtime.setTrackFxInstances('track-1', [gate, { ...delay, params: { ...delay.params, feedback: 0.7 } }])

      audio.faultCompressor(0)

      expect(await pending).toBe('applied')
      expect(await runtime.replaceTrackFxInstance('track-1', gate)).not.toBe('not-held')
    })

    for (const recovery of ['old', 'new']) {
      test(`static gate retry repairs a partial write when returning to ${recovery}`, async () => {
        const { audio, runtime } = createChainRuntime()
        const before = staticGateInstance(-40, 4)
        const after = staticGateInstance(-20, 8)
        await runtime.setTrackFxInstances('track-1', [before])
        audio.failNextParameterWrite(audio.workletParameter('gate.ratio'))

        expect((await Promise.allSettled([runtime.setTrackFxInstances('track-1', [after])]))[0]?.status).toBe('rejected')
        const recovered = recovery === 'old' ? before : after
        expect(await runtime.setTrackFxInstances('track-1', [recovered])).toBe('applied')
        expect(audio.workletParameter('gate.thresholdDb')?.value).toBe(recovery === 'old' ? -40 : -20)
        expect(audio.workletParameter('gate.ratio')?.value).toBe(recovery === 'old' ? 4 : 8)
      })
    }

    test('a failed tempo write is retried by an equal delay request and repairs both channels', async () => {
      const { audio, runtime } = createChainRuntime()
      const delay = syncedDelayInstance()
      await runtime.setTrackFxInstances('track-1', [delay])
      audio.failNextParameterWrite(audio.delays[1]?.delayTime)

      expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
      expect(await runtime.setTrackFxInstances('track-1', [delay])).toBe('applied')
      expect(audio.delays.map((node) => node.delayTime.value)).toEqual([0.5, 0.5])
    })

    for (const wholeChain of [false, true]) {
      test(`tempo failure fences a pending ${wholeChain ? 'whole-chain' : 'single-instance'} delay edit`, async () => {
        const { audio, runtime } = createChainRuntime()
        const first = syncedDelayInstance('first')
        const second = syncedDelayInstance('second')
        if (first.kind !== 'delay' || second.kind !== 'delay') throw new Error('Expected delay fixtures.')
        const initial = wholeChain ? [first, second] : [first]
        const requested = wholeChain
          ? [
            { ...first, params: { ...first.params, feedback: 0.7 } },
            { ...second, params: { ...second.params, feedback: 0.7 } },
          ]
          : [{ ...first, params: { ...first.params, feedback: 0.7 } }]
        await runtime.setTrackFxInstances('track-1', initial)
        const pending = runtime.setTrackFxInstances('track-1', requested)
        audio.failNextParameterWrite(audio.delays[1]?.delayTime)

        expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
        expect(await pending).toBe('superseded')
        expect(await runtime.setTrackFxInstances('track-1', requested)).toBe('applied')
        expect(audio.delays.map((node) => node.delayTime.value)).toEqual(
          wholeChain ? [0.5, 0.5, 0.5, 0.5] : [0.5, 0.5],
        )
      })
    }

    test('one delay tempo failure does not stop other instances or latency publication', async () => {
      const audio = createFxTestAudio()
      const counting = createCountingBudget()
      const latencies: Array<number | null> = []
      const runtime = createLiveMixerRuntime({
        ensureAudio: () => {},
        getAudioContext: () => audio.context,
        getMasterInput: () => audio.masterInput,
        getDestination: () => null,
        reconnectTrackMeters: () => {},
        disposeTrackMeters: () => {},
        disposeSynthTrack: () => {},
        getMasterFx: () => ({}),
        getFaultGeneration: () => 0,
        workletBudget: counting.budget,
        onGraphLatencyChange: (frames) => latencies.push(frames),
      })
      const failed = syncedDelayInstance('failed')
      const healthy = syncedDelayInstance('healthy')
      try {
        await runtime.setTrackFxInstances('track-1', [failed, healthy])
        const publicationsBeforeTempo = latencies.length
        audio.failNextParameterWrite(audio.delays[1]?.delayTime)

        expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
        expect(audio.delays.slice(2).map((node) => node.delayTime.value)).toEqual([0.5, 0.5])
        expect(latencies.length).toBeGreaterThan(publicationsBeforeTempo)
      } finally {
        runtime.disposeTrack('track-1')
        audio.restore()
      }
    })
  })

  describe('requested chain composition', () => {
    test('a single-instance edit lands on the chain that is already being requested', async () => {
      const { audio, runtime } = createChainRuntime()
      await runtime.setTrackFxInstances('track-1', [compressorInstance(-24), eqInstance(0)])
      const whole = runtime.setTrackFxInstances('track-1', [compressorInstance(-10), eqInstance(6)])
      const single = runtime.replaceTrackFxInstance('track-1', compressorInstance(-10))

      expect(await Promise.all([whole, single])).toEqual(['applied', 'joined'])
      expect(heldEqGain(audio)).toBe(6)
    })

    test('a single-instance edit composes onto a chain whose install is waiting for a context', async () => {
      let hasContext = false
      const { audio, runtime } = createChainRuntime(() => hasContext)
      expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-24), eqInstance(6)])).toBe('dropped')
      hasContext = true

      expect(await runtime.replaceTrackFxInstance('track-1', compressorInstance(-10))).toBe('applied')
      expect(audio.compressorThreshold()).toBe(-10)
      expect(heldEqGain(audio)).toBe(6)
    })
  })

  describe('one admission path for replay and requests', () => {
    const awaitingContext = () => {
      let hasContext = false
      const harness = createChainRuntime(() => hasContext)
      return { ...harness, grantContext: () => { hasContext = true } }
    }

    test('work started before the context went away is not joinable by a later equal request', async () => {
      let hasContext = true
      const { audio, runtime } = createChainRuntime(() => hasContext)
      const first = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      hasContext = false
      expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])).toBe('dropped')
      hasContext = true

      expect(await runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])).toBe('applied')
      expect(await first).toBe('superseded')
      expect(audio.compressorThreshold(0)).toBe(-18)
    })

    test('a request without a context is not install work a replay can join', async () => {
      const { audio, runtime, begins, grantContext } = awaitingContext()
      const chain = [compressorInstance(-18)]
      const initial = runtime.setTrackFxInstances('track-1', chain)
      grantContext()
      runtime.ensureTrackInput('track-1')
      expect(await initial).toBe('dropped')

      expect(['joined', 'skipped']).toContain(await runtime.setTrackFxInstances('track-1', chain))
      expect(begins()).toBe(1)
      expect(audio.compressorNodeCount()).toBe(1)
    })

    test('an equal request during the replay joins its success', async () => {
      const { audio, runtime, begins, grantContext } = awaitingContext()
      const chain = [compressorInstance(-18)]
      await runtime.setTrackFxInstances('track-1', chain)
      grantContext()
      runtime.ensureTrackInput('track-1')

      expect(await runtime.setTrackFxInstances('track-1', chain)).toBe('joined')
      expect(begins()).toBe(1)
      expect(audio.compressorNodeCount()).toBe(1)
    })

    test('an equal request during the replay joins its failure', async () => {
      const { audio, runtime, begins, grantContext } = awaitingContext()
      const chain = [compressorInstance(-18)]
      await runtime.setTrackFxInstances('track-1', chain)
      grantContext()
      audio.failNextModuleLoad()
      runtime.ensureTrackInput('track-1')

      expect((await Promise.allSettled([runtime.setTrackFxInstances('track-1', chain)]))[0]?.status).toBe('rejected')
      expect(begins()).toBe(1)
      expect(audio.compressorNodeCount()).toBe(0)
      expect(await runtime.setTrackFxInstances('track-1', chain)).toBe('applied')
    })
  })

  describe('outcomes a caller can trust', () => {
    test('a joined caller gets the dropped outcome when the budget refused the install', async () => {
      const { runtime } = createChainRuntime(() => true, true)
      const first = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      const second = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])

      expect(await Promise.all([first, second])).toEqual(['dropped', 'dropped'])
    })

    test('a joined caller gets the superseded outcome when a different request replaced the work', async () => {
      const { runtime } = createChainRuntime()
      const first = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      const second = runtime.setTrackFxInstances('track-1', [compressorInstance(-18)])
      const third = runtime.setTrackFxInstances('track-1', [compressorInstance(-12)])

      expect(await Promise.all([first, second, third])).toEqual(['superseded', 'superseded', 'applied'])
    })
  })
})
