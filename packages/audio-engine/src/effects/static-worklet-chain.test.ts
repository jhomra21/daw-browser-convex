import { expect, test } from 'bun:test'
import { createDefaultSpectralParams, type JsonValue } from '@daw-browser/shared'
import { applyStaticWorkletNodeParams, disconnectStaticWorkletNodeChain, type StaticWorkletNodeChain } from './static-worklet-chain'

type TestMessage = { type: 'reconfigure' | 'configure'; [key: string]: JsonValue | undefined }

const testChain = (kind: 'spectral' | 'gate' = 'spectral') => {
  const messages: TestMessage[] = []
  let portCloseCount = 0
  let disconnectCount = 0
  const node = Object.create(null)
  node.port = {
    postMessage: (message: TestMessage) => messages.push(message),
    close: () => { portCloseCount += 1 },
    onmessage: null,
  }
  node.disconnect = () => { disconnectCount += 1 }
  node.onprocessorerror = null
  node.parameters = new Map()
  const chain = {
    kind,
    state: 'active',
    node,
    fault: null,
    revision: 0,
    gateMeterListeners: new Set(),
  } satisfies StaticWorkletNodeChain
  return { chain, messages, portCloseCount: () => portCloseCount, disconnectCount: () => disconnectCount }
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

  expect(messages.map((message) => message.type)).toEqual([
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

  expect(messages.map((message) => message.type)).toEqual([
    'reconfigure',
    'configure',
    'configure',
    'reconfigure',
    'configure',
  ])
})

test('closes a retired gate even when a meter-reset listener throws', () => {
  const { chain, portCloseCount, disconnectCount } = testChain('gate')
  let fail = true
  chain.gateMeterListeners.add(() => {
    if (!fail) return
    fail = false
    throw new Error('Meter reset failed.')
  })

  expect(() => disconnectStaticWorkletNodeChain(chain)).toThrow('Meter reset failed.')
  disconnectStaticWorkletNodeChain(chain)
  disconnectStaticWorkletNodeChain(chain)

  expect(portCloseCount()).toBe(1)
  expect(disconnectCount()).toBe(1)
})
