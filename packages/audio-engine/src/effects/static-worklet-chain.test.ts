import { expect, test } from 'bun:test'
import { createDefaultSpectralParams } from '@daw-browser/shared'
import { applyStaticWorkletNodeParams, type StaticWorkletNodeChain } from './static-worklet-chain'

const testChain = () => {
  const messages: unknown[] = []
  const node = Object.create(null)
  node.port = {
    postMessage: (message: unknown) => messages.push(message),
  }
  node.parameters = new Map()
  const chain = {
    kind: 'spectral',
    state: 'active',
    node,
    fault: null,
    revision: 0,
    gateMeterListeners: new Set(),
  } satisfies StaticWorkletNodeChain
  return { chain, messages }
}

test('normalizes static worklet state once per update and skips no-op configuration', () => {
  const { chain, messages } = testChain()
  const params = { version: 1 as const, state: createDefaultSpectralParams() }

  applyStaticWorkletNodeParams(chain, params)
  applyStaticWorkletNodeParams(chain, params)
  applyStaticWorkletNodeParams(chain, {
    ...params,
    state: { ...params.state, mix: 0.5 },
  })

  expect(messages.map((message) => typeof message === 'object' && message !== null ? Reflect.get(message, 'type') : undefined)).toEqual([
    'reconfigure',
    'configure',
    'configure',
  ])
  expect(chain.revision).toBe(2)
})

test('reconfigures spectral topology only when FFT size or overlap changes', () => {
  const { chain, messages } = testChain()
  const params = { version: 1 as const, state: createDefaultSpectralParams() }

  applyStaticWorkletNodeParams(chain, params)
  applyStaticWorkletNodeParams(chain, {
    ...params,
    state: { ...params.state, mode: 'gate' },
  })
  applyStaticWorkletNodeParams(chain, {
    ...params,
    state: { ...params.state, fftSize: 1024 },
  })

  expect(messages.map((message) => typeof message === 'object' && message !== null ? Reflect.get(message, 'type') : undefined)).toEqual([
    'reconfigure',
    'configure',
    'configure',
    'reconfigure',
    'configure',
  ])
})
