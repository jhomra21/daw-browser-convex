import { describe, expect, test } from 'bun:test'
import { CompressorProcessorError } from '../effects/chain'
import type { CompressorMeterFrame } from '../effects/compressor-worklet'
import { createOfflineCompressorLifecycle } from './offline-compressor-lifecycle'
import type { CompressorProcessorLifecyclePhase } from '../effects/chain'

const createChain = (state: 'active' | 'faulted' = 'active') => {
  type ProcessorMessage = CompressorMeterFrame | { type: 'meter'; inputDb: number }
  let onmessage: ((data: ProcessorMessage) => void) | null = null
  return {
    chain: {
      state,
      fault: state === 'faulted' ? new Error('render failed') : null,
    },
    setMessageHandler: (handler: ((data: ProcessorMessage) => void) | null) => { onmessage = handler },
    emit: (data: ProcessorMessage) => onmessage?.(data),
  }
}

describe('offline compressor failure contract', () => {
  test('wraps registration and construction rejection with processor context', async () => {
    const phases: CompressorProcessorLifecyclePhase[] = ['registration', 'construction']
    for (const phase of phases) {
      const lifecycle = createOfflineCompressorLifecycle(() => {}, () => {})
      const result = lifecycle.create(
        { kind: 'master' },
        'master-compressor-1',
        () => Promise.reject(new CompressorProcessorError(phase, 'failed')),
      )
      await expect(result).rejects.toMatchObject({
        processor: 'daw-compressor-processor',
        target: { kind: 'master' },
        instanceId: 'master-compressor-1',
        phase,
      })
      await expect(result).rejects.toThrow(`instance=master-compressor-1, phase=${phase}`)
    }
  })

  test('rejects runtime faults instead of silently succeeding', async () => {
    const processor = createChain('faulted')
    const lifecycle = createOfflineCompressorLifecycle(() => {}, (chain, handler) => processor.setMessageHandler(handler))
    await lifecycle.create({ kind: 'track', trackId: 'track-1' }, 'compressor-1', () => Promise.resolve(processor.chain))
    expect(() => lifecycle.assertHealthy()).toThrow(
      'target=track "track-1", instance=compressor-1, phase=runtime',
    )
  })

  test('turns malformed processor messages into protocol faults', async () => {
    const processor = createChain()
    const lifecycle = createOfflineCompressorLifecycle(() => {}, (chain, handler) => processor.setMessageHandler(handler))
    await lifecycle.create({ kind: 'track', trackId: 'track-1' }, 'compressor-1', () => Promise.resolve(processor.chain))
    processor.emit({ type: 'meter', inputDb: Number.NaN })
    expect(() => lifecycle.assertHealthy()).toThrow(
      'target=track "track-1", instance=compressor-1, phase=protocol',
    )
  })

  test('cleans up an earlier processor when a later sequential construction rejects', async () => {
    let teardownCalls = 0
    const first = createChain()
    const lifecycle = createOfflineCompressorLifecycle(
      () => { teardownCalls += 1 },
      (chain, handler) => first.setMessageHandler(handler),
    )
    await lifecycle.create({ kind: 'master' }, 'first', () => Promise.resolve(first.chain))
    await expect(lifecycle.create(
      { kind: 'master' },
      'second',
      () => Promise.reject(new CompressorProcessorError('construction', 'failed')),
    )).rejects.toThrow('instance=second')
    lifecycle.dispose()
    expect(teardownCalls).toBe(1)
  })
})
