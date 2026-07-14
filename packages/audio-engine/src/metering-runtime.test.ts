import { afterEach, describe, expect, test } from 'bun:test'
import { createMeteringRuntime, readTrackMeterFrame, readTrackStereoLevels } from './metering-runtime'
import { createReliabilityResourceLedger } from './reliability-characterization'

const originalAudioWorkletNode = globalThis.AudioWorkletNode
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

afterEach(() => {
  Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: originalAudioWorkletNode })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: originalRequestAnimationFrame })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: originalCancelAnimationFrame })
})

describe('meter worklet messages', () => {
  test('accepts only finite bounded level messages', () => {
    expect(readTrackStereoLevels({ type: 'levels', left: 0.25, right: 1 })).toEqual({ left: 0.25, right: 1 })
    expect(readTrackStereoLevels({ left: 0.25, right: 0.5 })).toBeNull()
    expect(readTrackStereoLevels({ type: 'levels', left: -1, right: 0.5 })).toBeNull()
    expect(readTrackStereoLevels({ type: 'levels', left: Number.POSITIVE_INFINITY, right: 0.5 })).toBeNull()
  })

  test('accepts typed meter frames with DC, correlation, clipping, and true peak', () => {
    const frame = {
      type: 'meter-frame',
      frameCount: 2048,
      channels: [
        { samplePeak: 1.1, rms: 0.5, clipping: true, dcMean: 0.25, truePeak: 1.12 },
        { samplePeak: 0.5, rms: 0.25, clipping: false, dcMean: -0.25, truePeak: null },
      ],
      correlation: -1,
    }
    expect(readTrackMeterFrame(frame)).toEqual({
      frameCount: 2048,
      channels: [
        { samplePeak: 1.1, rms: 0.5, clipping: true, dcMean: 0.25, truePeak: 1.12 },
        { samplePeak: 0.5, rms: 0.25, clipping: false, dcMean: -0.25, truePeak: null },
      ],
      correlation: -1,
    })
  })
})

describe('meter worklet lifecycle', () => {
  test('releases nodes, subscriptions, and scheduled flushes on idempotent close', async () => {
    class FakeAudioWorkletNode {
      port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: () => {}, close: () => {} }
      onprocessorerror: (() => void) | null = null
      disconnect = () => {}
    }
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
    const ledger = createReliabilityResourceLedger()
    const runtime = createMeteringRuntime({ resourceObserver: ledger })
    const unsubscribe = runtime.subscribeTrackStereoLevels(() => undefined)
    runtime.reconnectTrackMeters(
      Object.assign(Object.create(null), { audioWorklet: { addModule: () => Promise.resolve() } }),
      'track-1',
      Object.assign(Object.create(null), { connect: () => {} }),
      () => true,
    )
    await Bun.sleep(0)
    runtime.close()
    runtime.close()
    unsubscribe()
    ledger.assertEmpty()
  })

  test('keeps duplicate callback subscriptions alive until each handle is released', () => {
    const ledger = createReliabilityResourceLedger()
    const runtime = createMeteringRuntime({ resourceObserver: ledger })
    const listener = () => undefined
    const first = runtime.subscribeTrackStereoLevels(listener)
    const second = runtime.subscribeTrackStereoLevels(listener)

    first()
    runtime.close()
    second()
    ledger.assertEmpty()
  })

  test('clears stale levels and retries a processor fault only once per generation', async () => {
    const nodes: FakeAudioWorkletNode[] = []
    let flush = () => {}
    class FakeAudioWorkletNode {
      port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: () => {},
        close: () => {},
      }
      onprocessorerror: (() => void) | null = null
      disconnect = () => {}

      constructor() {
        nodes.push(this)
      }
    }
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: () => void) => {
        flush = callback
        return 1
      },
    })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
    const context = Object.assign(Object.create(null), {
      audioWorklet: { addModule: () => Promise.resolve() },
    })
    const gain = Object.assign(Object.create(null), { connect: () => {} })
    const batches: Array<ReadonlyMap<string, { left: number; right: number }>> = []
    const runtime = createMeteringRuntime()
    runtime.subscribeTrackStereoLevels((levels) => batches.push(levels))
    runtime.reconnectTrackMeters(context, 'track-1', gain, () => true)
    await Bun.sleep(0)

    nodes[0].port.onmessage?.({ data: {
      type: 'meter-frame',
      frameCount: 2048,
      channels: [
        { samplePeak: 0.8, rms: 0.64, clipping: false, dcMean: 0, truePeak: null },
        { samplePeak: 0.6, rms: 0.36, clipping: false, dcMean: 0, truePeak: null },
      ],
      correlation: 0,
    } })
    flush()
    expect(batches.at(-1)?.get('track-1')).toEqual({ left: 0.64, right: 0.36 })
    nodes[0].onprocessorerror?.()
    await Bun.sleep(0)
    flush()

    expect(nodes).toHaveLength(2)
    expect(batches.at(-1)?.get('track-1')).toEqual({ left: 0, right: 0 })

    nodes[1].onprocessorerror?.()
    await Bun.sleep(0)
    expect(nodes).toHaveLength(2)
  })

  test('invalidates a fault retry when the connected output is no longer current', async () => {
    const nodes: Array<{ onprocessorerror: (() => void) | null }> = []
    let current = true
    class FakeAudioWorkletNode {
      port = { onmessage: null, postMessage: () => {}, close: () => {} }
      onprocessorerror: (() => void) | null = null
      disconnect = () => {}

      constructor() {
        nodes.push(this)
      }
    }
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
    Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 1 })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
    const context = Object.assign(Object.create(null), {
      audioWorklet: { addModule: () => Promise.resolve() },
    })
    const gain = Object.assign(Object.create(null), { connect: () => {} })
    const runtime = createMeteringRuntime()
    runtime.reconnectTrackMeters(context, 'track-1', gain, () => current)
    await Bun.sleep(0)

    nodes[0].onprocessorerror?.()
    current = false
    await Bun.sleep(0)

    expect(nodes).toHaveLength(1)
  })

  test('does not construct a node when registration resolves after track disposal or close', async () => {
    let resolveRegistration = () => {}
    let constructions = 0
    class FakeAudioWorkletNode {
      constructor() {
        constructions += 1
      }
    }
    Object.defineProperty(globalThis, 'AudioWorkletNode', { configurable: true, value: FakeAudioWorkletNode })
    const context = Object.assign(Object.create(null), {
      audioWorklet: {
        addModule: () => new Promise<void>((resolve) => { resolveRegistration = resolve }),
      },
    })
    const gain = Object.assign(Object.create(null), { connect: () => {} })

    const disposedRuntime = createMeteringRuntime()
    disposedRuntime.reconnectTrackMeters(context, 'track-1', gain, () => true)
    disposedRuntime.disposeTrack('track-1')
    resolveRegistration()
    await Promise.resolve()
    expect(constructions).toBe(0)

    let resolveCloseRegistration = () => {}
    const closeContext = Object.assign(Object.create(null), {
      audioWorklet: {
        addModule: () => new Promise<void>((resolve) => { resolveCloseRegistration = resolve }),
      },
    })
    const closedRuntime = createMeteringRuntime()
    closedRuntime.reconnectTrackMeters(closeContext, 'track-2', gain, () => true)
    closedRuntime.close()
    resolveCloseRegistration()
    await Promise.resolve()
    expect(constructions).toBe(0)
  })
})
