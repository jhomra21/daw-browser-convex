import { afterEach, describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_CONTRACTS } from '@daw-browser/shared'
import { createLiveWorkletBudget } from './effects/live-worklet-budget'
import { captureFxTransitions, compressorInstance, createCountingBudget, createFxTestAudio, createFxTransitionHarness, eqInstance, heldEqGain, partialWriteCases, reverbInstance, staticGateInstance, syncedDelayInstance } from './fx-runtime-test-audio'
import { AudioEngine } from './audio-engine'
import { createMasterFxRuntime } from './master-fx-runtime'

describe('master FX publication recovery transitions', () => {
  test('fault bypass preserves a failed publication mark for an equal retry', async () => {
    const f = createFxTransitionHarness('master')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.master.subscribeGateMeter('h', () => {
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
    const f = createFxTransitionHarness('master')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    const frames: number[] = []
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.master.subscribeGateMeter('h', (frame) => {
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
    const f = createFxTransitionHarness('master')
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

  test('fault bypass drains retirement owned by the superseded reconnect', async () => {
    const f = createFxTransitionHarness('master')
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
    const f = createFxTransitionHarness('master')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    try {
      await f.set([staticGateInstance(-40, 4, 'g'), eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.master.subscribeGateMeter('g', () => {
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
    const f = createFxTransitionHarness('master')
    let fail = false
    const subscription = { unsubscribe: () => {} }
    const frames: number[] = []
    try {
      const h = staticGateInstance(-40, 4, 'h')
      await f.set([staticGateInstance(-40, 4, 'g'), h, eqInstance(0, 'e')])
      f.timers.run()
      subscription.unsubscribe = f.master.subscribeGateMeter('h', (frame) => {
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
    const f = createFxTransitionHarness('master')
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
    const f = createFxTransitionHarness('master')
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

describe('master effect chain delivery', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  const createChainRuntime = (refuseCommit = false, ignoreBudgetCurrency = false) => {
    const audio = createFxTestAudio()
    const timers = captureFxTransitions()
    const counting = createCountingBudget(refuseCommit)
    const workletBudget = ignoreBudgetCurrency
      ? { ...counting.budget, isCurrent: () => true, commit: () => true }
      : counting.budget
    const runtime = createMasterFxRuntime({ getFaultGeneration: () => 0, workletBudget, transitionScheduler: timers.scheduler })
    cleanups.push(audio.restore, runtime.close, timers.restore)
    const set = (instances: Parameters<typeof runtime.setFxInstances>[3]) =>
      runtime.setFxInstances(audio.context, audio.masterInput, audio.context.destination, instances)
    return { audio, runtime, set, begins: counting.begins, timers }
  }

  test('re-applies the installed compressor value over an in-flight tick', async () => {
    const { audio, set, timers } = createChainRuntime()
    await set([compressorInstance(-24)])
    timers.run()
    const tick = set([compressorInstance(-10)])
    const cancel = set([compressorInstance(-24)])
    const [tickResult, cancelResult] = await Promise.all([tick, cancel])

    expect(audio.compressorThreshold()).toBe(-24)
    expect(cancelResult.disposition).toBe('applied')
    expect(tickResult.disposition).toBe('superseded')
    expect((await set([compressorInstance(-24)])).disposition).toBe('skipped')
  })

  test('control: an in-flight EQ tick never reaches the node, so the installed value stays', async () => {
    const { audio, set } = createChainRuntime()
    await set([eqInstance(0)])
    const tick = set([eqInstance(6)])
    const cancel = set([eqInstance(0)])
    await Promise.all([tick, cancel])

    expect(heldEqGain(audio)).toBe(0)
  })

  test('skips an equal chain before the apply path and counts it as in place', async () => {
    const { audio, set, begins, timers } = createChainRuntime()
    expect((await set([compressorInstance(-18), eqInstance(3)])).disposition).toBe('applied')
    timers.run()
    const posted = audio.postedCount()
    const beganBefore = begins()

    expect(await set([compressorInstance(-18), eqInstance(3)])).toEqual({ disposition: 'skipped', inPlace: true })
    expect(begins()).toBe(beganBefore)
    expect(audio.postedCount()).toBe(posted)
  })

  test('an equal chain skips during the recorded routing reconnect window', async () => {
    const { audio, set, timers } = createChainRuntime()
    await set([staticGateInstance(-40, 4, 'gate')])
    timers.run()
    const rampsBefore = audio.gainRampCount()

    expect(await set([])).toMatchObject({ disposition: 'applied' })
    const rampsDuringReconnect = audio.gainRampCount()
    expect(rampsDuringReconnect).toBe(rampsBefore + 1)
    expect(await set([])).toMatchObject({ disposition: 'skipped' })
    expect(audio.gainRampCount()).toBe(rampsDuringReconnect)
  })

  test('in-place edits during reconnect do not restart the fade or drain retirement', async () => {
    const { audio, set, timers } = createChainRuntime()
    await set([staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
    timers.run()
    const rampsBeforeReconnect = audio.gainRampCount()
    const oldGate = audio.workletNode(0)
    const input = audio.connections().find((connection) => connection.target === oldGate)?.source
    if (!oldGate || !input) throw new Error('Missing connected gate input.')

    expect(await set([eqInstance(0, 'eq')])).toMatchObject({ disposition: 'applied' })
    const rampsDuringReconnect = audio.gainRampCount()
    expect(rampsDuringReconnect).toBe(rampsBeforeReconnect + 1)
    expect(await set([eqInstance(6, 'eq')])).toMatchObject({ disposition: 'applied', inPlace: true })
    expect(await set([eqInstance(3, 'eq')])).toMatchObject({ disposition: 'applied', inPlace: true })
    expect(audio.gainRampCount()).toBe(rampsDuringReconnect)
    expect(audio.workletCloseCounts()).toEqual([0])
    expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(true)

    timers.run()
    expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
    expect(audio.connections().some((connection) => connection.target === audio.biquads[0])).toBe(true)
    expect(audio.workletCloseCounts()).toEqual([1])
  })

  test('master bypass clears its publication mark before the reconnect', async () => {
    const { audio, set, timers } = createChainRuntime()
    await set([staticGateInstance(-40, 4, 'gate')])
    timers.run()
    audio.faultCompressor(0)
    const rampsDuringReconnect = audio.gainRampCount()

    expect((await set([])).disposition).toBe('skipped')
    expect(audio.gainRampCount()).toBe(rampsDuringReconnect)
  })

  test('retries a master reconnect after its callback throws', async () => {
    const { audio, runtime, set, timers } = createChainRuntime()
    await set([staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
    timers.run()
    try {
      expect((await set([eqInstance(0, 'eq')])).disposition).toBe('applied')
      const rampsAfterRequest = audio.gainRampCount()
      audio.failNextConnection()
      expect(() => timers.run()).toThrow('Audio connection failed.')
      expect(audio.workletCloseCounts()).toEqual([0])
      expect((await set([eqInstance(0, 'eq')])).disposition).toBe('applied')
      timers.run()

      expect(audio.connections().some((connection) => connection.target === audio.biquads[0])).toBe(true)
      expect(audio.workletCloseCounts()).toEqual([1])
      expect(audio.gainRampCount()).toBe(rampsAfterRequest + 2)
    } finally {
      runtime.close()
    }
  })

  test('joins an equal request while its work is pending', async () => {
    const { audio, set, begins } = createChainRuntime()
    const first = set([compressorInstance(-18)])
    const second = set([compressorInstance(-18)])

    expect((await Promise.all([first, second])).map((result) => result.disposition)).toEqual(['applied', 'joined'])
    expect(begins()).toBe(1)
    expect(audio.compressorNodeCount()).toBe(1)
  })

  test('rejects a joined caller with the pending work failure and installs nothing', async () => {
    const { audio, set, begins } = createChainRuntime()
    audio.failNextModuleLoad()
    const first = set([compressorInstance(-18)])
    const second = set([compressorInstance(-18)])
    const settled = await Promise.allSettled([first, second])

    expect(begins()).toBe(1)
    expect(settled.map((entry) => entry.status)).toEqual(['rejected', 'rejected'])
    expect(audio.compressorNodeCount()).toBe(0)
    expect((await set([compressorInstance(-18)])).disposition).toBe('applied')
    expect(begins()).toBe(2)
  })

  test('applies an equal resend again after the resource faulted', async () => {
    const { audio, set, begins } = createChainRuntime()
    expect((await set([compressorInstance(-18)])).disposition).toBe('applied')
    audio.faultCompressor()

    expect((await set([compressorInstance(-18)])).disposition).toBe('applied')
    expect(begins()).toBe(2)
    expect(audio.compressorNodeCount()).toBe(2)
  })

  test('drops a chain it cannot install without an audio context', async () => {
    const runtime = createMasterFxRuntime({ getFaultGeneration: () => 0, workletBudget: createLiveWorkletBudget() })

    expect(await runtime.setFxInstances(null, null, null, [compressorInstance(-18)])).toEqual({ disposition: 'dropped', inPlace: false })
  })

  describe('stale and unconfirmed writes', () => {
    const pair = (first: number, second: number) => [compressorInstance(first, 'c1'), compressorInstance(second, 'c2')]

    test('a superseded request writes nothing to the effects after the one it was applying', async () => {
      const { audio, set, timers } = createChainRuntime()
      await set(pair(-24, -30))
      timers.run()
      const tick = set(pair(-10, -6))
      const cancel = set(pair(-24, -30))

      expect((await Promise.all([tick, cancel])).map((result) => result.disposition)).toEqual(['superseded', 'applied'])
      expect([audio.compressorThreshold(0), audio.compressorThreshold(1)]).toEqual([-24, -30])
      expect((await set(pair(-24, -30))).disposition).toBe('skipped')
    })

    test('a failed parameter write is not remembered as held, so the resend writes it', async () => {
      const { audio, set } = createChainRuntime()
      await set([compressorInstance(-18)])
      audio.failNextParamsPost()

      expect((await Promise.allSettled([set([compressorInstance(-12)])]))[0]?.status).toBe('rejected')
      expect((await set([compressorInstance(-12)])).disposition).toBe('applied')
      expect(audio.compressorThreshold()).toBe(-12)
    })

    test('a compressor that cannot be rebuilt after a fault fails the request instead of reporting it applied', async () => {
      const { audio, set } = createChainRuntime()
      await set([compressorInstance(-18)])
      audio.faultCompressor()
      audio.failNextConstruction()

      expect((await Promise.allSettled([set([compressorInstance(-12)])]))[0]?.status).toBe('rejected')
      expect((await set([compressorInstance(-12)])).disposition).toBe('applied')
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
        const { audio, set, timers } = createChainRuntime()
        await set([disabled(kind)])
        timers.run()
        const stale = set([enabled(kind)])
        const cancel = set([disabled(kind)])

        expect((await Promise.all([stale, cancel])).map((result) => result.disposition)).toEqual(['superseded', 'applied'])
        expect(audio.liveWorkletCount()).toBe(0)
        expect((await set([disabled(kind)])).disposition).toBe('skipped')
      })

      test(`${kind}: a different disabled request cancels the enable still building`, async () => {
        const { audio, set } = createChainRuntime()
        await set([disabled(kind)])
        const stale = set([enabled(kind)])
        const cancel = set([newer(kind)])

        expect((await Promise.all([stale, cancel])).map((result) => result.disposition)).toEqual(['superseded', 'applied'])
        expect(audio.liveWorkletCount()).toBe(0)
      })

      test(`${kind}: closing the runtime releases the processor of an enable still building`, async () => {
        const { audio, runtime, set } = createChainRuntime()
        await set([disabled(kind)])
        const stale = set([enabled(kind)])
        runtime.close()
        await Promise.allSettled([stale])

        expect(audio.liveWorkletCount()).toBe(0)
      })
    }
  })

  describe('partial writes', () => {
    const cases = (audio: ReturnType<typeof createChainRuntime>['audio'], runtime: ReturnType<typeof createChainRuntime>['runtime']) =>
      partialWriteCases(audio, (parameterId, instanceId) => runtime.resolveMasterAutomationBindings(parameterId, audio.masterInput, instanceId)[0]?.param)

    for (const name of ['delay', 'saturator', 'reverb', 'eq']) {
      test(`${name}: a write that fails partway is repaired by returning to the previous value`, async () => {
        const { audio, runtime, set, timers } = createChainRuntime()
        const edit = cases(audio, runtime).find((entry) => entry.name === name)
        if (!edit) throw new Error(`No case ${name}`)
        await set([edit.before])
        edit.arm()

        expect((await Promise.allSettled([set([edit.after])]))[0]?.status).toBe('rejected')
        expect((await set([edit.before])).disposition).toBe('applied')
        expect(edit.read()).toBeCloseTo(edit.heldBefore)
        timers.run()
        expect((await set([edit.before])).disposition).toBe('skipped')
      })

      test(`${name}: a write that fails partway is repaired by retrying the new value`, async () => {
        const { audio, runtime, set } = createChainRuntime()
        const edit = cases(audio, runtime).find((entry) => entry.name === name)
        if (!edit) throw new Error(`No case ${name}`)
        await set([edit.before])
        edit.arm()
        await Promise.allSettled([set([edit.after])])

        expect((await set([edit.after])).disposition).toBe('applied')
        expect(edit.read()).toBeCloseTo(edit.heldAfter)
      })
    }
  })

  describe('static worklet and tempo partial writes', () => {
    test('installed gate fault bypasses after a failed tempo write', async () => {
      const { audio, runtime, set, begins } = createChainRuntime()
      const gate = staticGateInstance(-40, 4, 'gate')
      await set([gate, syncedDelayInstance('delay')])
      audio.failNextParameterWrite(audio.delays[1]?.delayTime)

      expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
      audio.faultCompressor(0)

      expect((await set([syncedDelayInstance('delay')])).disposition).toBe('applied')
      expect(audio.liveWorkletCount()).toBe(0)
      expect(begins()).toBe(3)
    })

    test('a pending chain request cannot restore an installed gate after its fault', async () => {
      const { audio, set, timers } = createChainRuntime(false, true)
      const gate = staticGateInstance(-40, 4, 'gate')
      const delay = syncedDelayInstance('delay')
      await set([gate, delay])
      timers.run()
      const pending = set([staticGateInstance(-20, 8, 'gate'), delay])
      audio.faultCompressor(0)

      expect((await pending).disposition).toBe('superseded')
      timers.run()
      expect((await set([delay])).disposition).toBe('skipped')
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('a retired gate fault cannot disturb a pending master edit and retirement closes it once', async () => {
      const { audio, set, timers } = createChainRuntime()
      const gate = staticGateInstance(-40, 4, 'gate')
      const delay = syncedDelayInstance('delay')
      if (delay.kind !== 'delay') throw new Error('Expected delay fixture.')
      await set([gate, delay])
      await set([delay])
      const editedDelay = { ...delay, params: { ...delay.params, feedback: 0.7 } }
      const pending = set([editedDelay])

      audio.faultCompressor(0)

      expect((await pending).disposition).toBe('applied')
      timers.run()
      expect(audio.workletCloseCount()).toBe(1)
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('a failed deferred EQ write still retires a removed master gate', async () => {
      const { audio, runtime, set, timers } = createChainRuntime()
      const gate = staticGateInstance(-40, 4, 'gate')
      await set([gate, eqInstance(0, 'eq')])
      timers.run()

      audio.failNextParameterWrite(audio.biquads[2]?.gain)
      await expect(Promise.allSettled([set([eqInstance(6, 'eq')])]))
        .resolves.toMatchObject([{ status: 'rejected' }])
      await set([eqInstance(0, 'eq')])
      runtime.close()

      expect(audio.workletCloseCounts()).toEqual([1])
      expect(audio.liveWorkletCount()).toBe(0)
    })

    test('rebuilds routing before retiring a removed gate after a deferred EQ failure', async () => {
      const { audio, runtime, set, timers } = createChainRuntime()
      await set([staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
      timers.run()
      const oldGate = audio.workletNode(0)
      const input = audio.connections().find((connection) => connection.target === oldGate)?.source
      if (!oldGate || !input) throw new Error('Missing connected gate input.')

      audio.failNextParameterWrite(audio.biquads[2]?.gain)
      expect((await Promise.allSettled([set([eqInstance(6, 'eq')])]))[0]?.status).toBe('rejected')
      expect((await set([eqInstance(6, 'eq')])).disposition).toBe('applied')
      timers.run()
      expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
      expect(audio.connections().some((connection) => connection.source === input && connection.target === audio.biquads[0])).toBe(true)
      expect(audio.workletCloseCounts()).toEqual([1])
      expect((await set([eqInstance(6, 'eq')])).disposition).toBe('skipped')
      runtime.close()
    })

    test('rebuilds routing after certified parameters when a routing ramp throws', async () => {
      const { audio, runtime, set, timers } = createChainRuntime()
      let failRamp = false
      const createGain = audio.context.createGain
      audio.context.createGain = () => {
        const node = createGain()
        node.gain.cancelScheduledValues = () => {
          if (!failRamp) return
          failRamp = false
          throw new Error('Routing ramp failed.')
        }
        return node
      }
      try {
        await set([staticGateInstance(-40, 4, 'gate'), eqInstance(0, 'eq')])
        timers.run()
        const oldGate = audio.workletNode(0)
        const input = audio.connections().find((connection) => connection.target === oldGate)?.source
        if (!oldGate || !input) throw new Error('Missing connected gate input.')
        failRamp = true

        expect((await Promise.allSettled([set([eqInstance(6, 'eq')])]))[0]?.status).toBe('rejected')
        expect((await set([eqInstance(6, 'eq')])).disposition).toBe('applied')
        timers.run()
        expect(audio.connections().some((connection) => connection.source === input && connection.target === oldGate)).toBe(false)
        expect(audio.connections().some((connection) => connection.source === input && connection.target === audio.biquads[0])).toBe(true)
      } finally {
        runtime.close()
        audio.restore()
      }
    })

    test('a retired master gate fault preserves its pending re-add intent', async () => {
      const { audio, runtime, set } = createChainRuntime()
      const delay = syncedDelayInstance('delay')
      const gate = staticGateInstance(-20, 8, 'gate')
      if (delay.kind !== 'delay') throw new Error('Expected delay fixture.')
      await set([staticGateInstance(-40, 4, 'gate'), delay])
      await set([delay])
      const pending = set([gate, { ...delay, params: { ...delay.params, feedback: 0.7 } }])

      audio.faultCompressor(0)

      expect((await pending).disposition).toBe('applied')
      expect(runtime.retainedInstances().map((instance) => instance.id)).toEqual(['gate', 'delay'])
    })

    for (const recovery of ['old', 'new']) {
      test(`static gate retry repairs a partial write when returning to ${recovery}`, async () => {
        const { audio, set } = createChainRuntime()
        const before = staticGateInstance(-40, 4)
        const after = staticGateInstance(-20, 8)
        await set([before])
        audio.failNextParameterWrite(audio.workletParameter('gate.ratio'))

        expect((await Promise.allSettled([set([after])]))[0]?.status).toBe('rejected')
        const recovered = recovery === 'old' ? before : after
        expect((await set([recovered])).disposition).toBe('applied')
        expect(audio.workletParameter('gate.thresholdDb')?.value).toBe(recovery === 'old' ? -40 : -20)
        expect(audio.workletParameter('gate.ratio')?.value).toBe(recovery === 'old' ? 4 : 8)
      })
    }

    test('a failed tempo write is retried by an equal delay request and repairs both channels', async () => {
      const { audio, runtime, set } = createChainRuntime()
      const delay = syncedDelayInstance()
      await set([delay])
      audio.failNextParameterWrite(audio.delays[1]?.delayTime)

      expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
      expect((await set([delay])).disposition).toBe('applied')
      expect(audio.delays.map((node) => node.delayTime.value)).toEqual([0.5, 0.5])
    })

    for (const wholeChain of [false, true]) {
      test(`tempo failure fences a pending ${wholeChain ? 'whole-chain' : 'single-instance'} delay edit`, async () => {
        const { audio, runtime, set } = createChainRuntime()
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
        await set(initial)
        const pending = set(requested)
        audio.failNextParameterWrite(audio.delays[1]?.delayTime)

        expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
        expect((await pending).disposition).toBe('superseded')
        expect((await set(requested)).disposition).toBe('applied')
        expect(audio.delays.map((node) => node.delayTime.value)).toEqual(
          wholeChain ? [0.5, 0.5, 0.5, 0.5] : [0.5, 0.5],
        )
      })
    }

    test('one delay tempo failure does not stop other instances from updating', async () => {
      const { audio, runtime, set } = createChainRuntime()
      try {
        await set([syncedDelayInstance('failed'), syncedDelayInstance('healthy')])
        audio.failNextParameterWrite(audio.delays[1]?.delayTime)

        expect(() => runtime.setBpm(60)).toThrow('Audio parameter write failed.')
        expect(audio.delays.slice(2).map((node) => node.delayTime.value)).toEqual([0.5, 0.5])
      } finally {
        runtime.close()
        audio.restore()
      }
    })
  })

  describe('requested chain composition', () => {
    test('a single-instance edit through the engine lands on the chain that is already being requested', async () => {
      const audio = createFxTestAudio()
      cleanups.push(audio.restore)
      const engine = new AudioEngine()
      Object.assign(engine, { audioCtx: audio.context, masterGain: audio.masterInput, destination: audio.context.destination })
      await engine.setMasterFxInstances([compressorInstance(-24), eqInstance(0)])
      const whole = engine.setMasterFxInstances([compressorInstance(-10), eqInstance(6)])
      const single = engine.setMasterFxInstance(compressorInstance(-10))

      expect(await Promise.all([whole, single])).toEqual(['applied', 'joined'])
      expect(heldEqGain(audio)).toBe(6)
    })
  })

  describe('one admission path for replay and requests', () => {
    const awaitingContext = () => {
      const harness = createChainRuntime()
      const replay = () => harness.runtime.applyPending(harness.audio.context, harness.audio.masterInput, harness.audio.context.destination)
      return { ...harness, replay }
    }

    test('work started before the context went away is not joinable by a later equal request', async () => {
      const { audio, runtime, set } = awaitingContext()
      const first = set([compressorInstance(-18)])
      expect((await runtime.setFxInstances(null, null, null, [compressorInstance(-12)])).disposition).toBe('dropped')

      expect((await set([compressorInstance(-18)])).disposition).toBe('applied')
      expect((await first).disposition).toBe('superseded')
      expect(audio.compressorThreshold(0)).toBe(-18)
    })

    test('an equal request during the replay joins its success', async () => {
      const { audio, runtime, set, begins, replay } = awaitingContext()
      const chain = [compressorInstance(-18)]
      await runtime.setFxInstances(null, null, null, chain)
      replay()

      expect((await set(chain)).disposition).toBe('joined')
      expect(begins()).toBe(1)
      expect(audio.compressorNodeCount()).toBe(1)
    })

    test('an equal request during the replay joins its failure', async () => {
      const { audio, runtime, set, begins, replay } = awaitingContext()
      const chain = [compressorInstance(-18)]
      await runtime.setFxInstances(null, null, null, chain)
      audio.failNextModuleLoad()
      replay()

      expect((await Promise.allSettled([set(chain)]))[0]?.status).toBe('rejected')
      expect(begins()).toBe(1)
      expect(audio.compressorNodeCount()).toBe(0)
      expect((await set(chain)).disposition).toBe('applied')
    })

    test('the chain requested without a context stays retained until the replay installs it', async () => {
      const { runtime, set, replay } = awaitingContext()
      await runtime.setFxInstances(null, null, null, [compressorInstance(-18)])
      expect(runtime.retainedInstances()).toEqual([compressorInstance(-18)])
      replay()

      expect(runtime.retainedInstances()).toEqual([compressorInstance(-18)])
      expect((await set([compressorInstance(-18)])).disposition).toBe('joined')
    })
  })

  describe('outcomes a caller can trust', () => {
    test('a joined caller gets the dropped outcome when the budget refused the install', async () => {
      const { set } = createChainRuntime(true)
      const first = set([compressorInstance(-18)])
      const second = set([compressorInstance(-18)])

      expect((await Promise.all([first, second])).map((result) => result.disposition)).toEqual(['dropped', 'dropped'])
    })

    test('a joined caller gets the superseded outcome when a different request replaced the work', async () => {
      const { set } = createChainRuntime()
      const first = set([compressorInstance(-18)])
      const second = set([compressorInstance(-18)])
      const third = set([compressorInstance(-12)])

      expect((await Promise.all([first, second, third])).map((result) => result.disposition)).toEqual(['superseded', 'superseded', 'applied'])
    })
  })
})
