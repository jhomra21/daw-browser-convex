import { describe, expect, test } from 'bun:test'
import { handleCompressorProcessorError, type CompressorFaultTransition } from './chain'

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
