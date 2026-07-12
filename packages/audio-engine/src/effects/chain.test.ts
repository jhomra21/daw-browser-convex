import { describe, expect, test } from 'bun:test'
import { createGainTransitionOwner, handleCompressorProcessorError, type CompressorFaultTransition } from './chain'

describe('compressor processor fault fallback', () => {
  test('transitions to the dry path once and suppresses duplicate faults', () => {
    const ramps: Array<[number, number]> = []
    let cancellations = 0
    const createGain = (value: number) => ({
      gain: {
        value,
        cancelScheduledValues: () => { cancellations += 1 },
        setValueAtTime: () => {},
        linearRampToValueAtTime: (nextValue: number, time: number) => {
          ramps.push([nextValue, time])
        },
      },
    })
    const chain: CompressorFaultTransition = {
      state: 'active',
      fault: null,
      dryGain: createGain(0),
      processedGain: createGain(1),
    }

    handleCompressorProcessorError(chain, 4)
    handleCompressorProcessorError(chain, 5)

    expect(chain.state).toBe('faulted')
    expect(chain.fault?.message).toBe('Compressor processor failed during runtime processing.')
    expect(cancellations).toBe(2)
    expect(ramps).toEqual([[1, 4.01], [0, 4.01]])
  })
})

describe('routing transitions', () => {
  const createTestGain = () => {
    const ramp: Array<[string, number, number]> = []
    return {
      ramp,
      gain: {
        value: 1,
        cancelScheduledValues: (time: number) => ramp.push(['cancel', 0, time]),
        setValueAtTime: (value: number, time: number) => ramp.push(['set', value, time]),
        linearRampToValueAtTime: (value: number, time: number) => ramp.push(['ramp', value, time]),
      },
    }
  }

  test('coalesces rapid topology changes and reconnects only the latest graph', () => {
    const events: string[] = []
    const scheduled: Array<() => void> = []
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const { gain, ramp } = createTestGain()
    const owner = createGainTransitionOwner({ gain }, () => 4, {
      schedule: (callback) => {
        scheduled.push(callback)
        const timer = setTimeout(() => undefined, 60_000)
        timers.push(timer)
        return timer
      },
      clear: (timer) => {
        events.push('clear')
        clearTimeout(timer)
      },
    }, 0.01, 0.02)

    owner.request(() => events.push('first'))
    owner.request(() => events.push('second'))
    owner.request(() => events.push('third'))

    expect(events).toEqual(['clear', 'clear'])
    expect(ramp.slice(0, 6)).toEqual([
      ['cancel', 0, 4],
      ['set', 1, 4],
      ['ramp', 0, 4.01],
      ['cancel', 0, 4],
      ['set', 1, 4],
      ['ramp', 0, 4.01],
    ])
    for (const callback of scheduled) callback()
    expect(events).toEqual(['clear', 'clear', 'third'])
    expect(ramp.at(-2)).toEqual(['set', 0, 4.01])
    expect(ramp.at(-1)?.slice(0, 2)).toEqual(['ramp', 1])
    expect(ramp.at(-1)?.[2]).toBeCloseTo(4.03, 10)
    owner.dispose()
    for (const timer of timers) clearTimeout(timer)
  })

  test('ordinary cancellation restores unity while disposal leaves the node untouched', () => {
    const { gain, ramp } = createTestGain()
    const scheduled: Array<() => void> = []
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const owner = createGainTransitionOwner({ gain }, () => 7, {
      schedule: (callback) => {
        scheduled.push(callback)
        const timer = setTimeout(() => undefined, 60_000)
        timers.push(timer)
        return timer
      },
      clear: clearTimeout,
    })

    owner.request(() => {
      throw new Error('Cancelled transition reconnected a stale graph.')
    })
    owner.cancel()
    expect(ramp.slice(-2)).toEqual([
      ['cancel', 0, 7],
      ['set', 1, 7],
    ])
    scheduled[0]?.()

    owner.request(() => {
      throw new Error('Disposed transition reconnected a graph.')
    })
    owner.dispose()
    scheduled[1]?.()
    const scheduledCount = scheduled.length
    owner.request(() => {
      throw new Error('Disposed owner scheduled a new transition.')
    })
    expect(scheduled.length).toBe(scheduledCount)
    for (const timer of timers) clearTimeout(timer)
  })
})
