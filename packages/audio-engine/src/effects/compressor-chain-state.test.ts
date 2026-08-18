import { describe, expect, test } from 'bun:test'
import { normalizeCompressorParams } from '@daw-browser/shared'
import type { CompressorNodeChain } from './chain'
import { createCompressorChainState } from './compressor-chain-state'

const createFakeChain = (onDisconnect: () => void = () => {}): CompressorNodeChain => {
  const node = () => Object.assign(Object.create(null), { disconnect: onDisconnect })
  return {
    enabled: true,
    state: 'active',
    input: node(),
    output: node(),
    dryGain: node(),
    processedGain: node(),
    workletNode: Object.assign(node(), {
      port: { onmessage: null, postMessage: () => {}, close: () => {} },
      onprocessorerror: null,
    }),
    fault: null,
  }
}

describe('compressor chain state recovery', () => {
  test('binds listeners registered before async construction and keeps them across replacement', async () => {
    const created: CompressorNodeChain[] = []
    const state = createCompressorChainState(async () => {
      const chain = createFakeChain()
      created.push(chain)
      return chain
    })
    const frames: number[] = []
    const unsubscribe = state.subscribeMeter((frame) => frames.push(frame.gainReductionDb))
    const context = Object.assign(Object.create(null), {})
    const params = normalizeCompressorParams({ enabled: true, thresholdDb: -18 })

    await state.set(context, params)
    created[0].workletNode.port.onmessage?.(new MessageEvent('message', {
      data: { type: 'meter', inputDb: -12, outputDb: -15, gainReductionDb: -3, thresholdDb: -18 },
    }))
    created[0].state = 'faulted'
    await state.set(context, params)
    created[1].workletNode.port.onmessage?.(new MessageEvent('message', {
      data: { type: 'meter', inputDb: -12, outputDb: -18, gainReductionDb: -6, thresholdDb: -18 },
    }))
    unsubscribe()
    created[1].workletNode.port.onmessage?.(new MessageEvent('message', {
      data: { type: 'meter', inputDb: -12, outputDb: -21, gainReductionDb: -9, thresholdDb: -18 },
    }))

    expect(frames).toEqual([-3, -6])
  })

  test('rebuilds a faulted chain even when the parameter signature is unchanged', async () => {
    let oldDisconnects = 0
    const created: CompressorNodeChain[] = []
    const state = createCompressorChainState(async () => {
      const chain = createFakeChain(created.length === 0 ? () => { oldDisconnects += 1 } : undefined)
      created.push(chain)
      return chain
    })
    const context = Object.assign(Object.create(null), {})
    const params = normalizeCompressorParams({ enabled: true, thresholdDb: -18 })

    expect(await state.set(context, params)).toEqual({ changed: true, requiresRoutingRebuild: true })
    created[0].state = 'faulted'
    created[0].fault = new Error('processor failed')

    expect(await state.set(context, params)).toEqual({ changed: true, requiresRoutingRebuild: true })
    expect(created).toHaveLength(2)
    expect(state.chain()).toBe(created[1])
    expect(state.chain()).not.toBe(created[0])
    expect(oldDisconnects).toBeGreaterThan(0)
  })

  test('retains the faulted dry-fallback chain when replacement construction fails', async () => {
    const original = createFakeChain()
    let attempts = 0
    const state = createCompressorChainState(async () => {
      attempts += 1
      if (attempts === 1) return original
      throw new Error('construction failed')
    })
    const context = Object.assign(Object.create(null), {})
    const params = normalizeCompressorParams({ enabled: true, thresholdDb: -18 })

    await state.set(context, params)
    original.state = 'faulted'
    original.fault = new Error('processor failed')

    expect(await state.set(context, params)).toEqual({ changed: false, requiresRoutingRebuild: false })
    expect(state.chain()).toBe(original)
    expect(original.state).toBe('faulted')
  })
})
