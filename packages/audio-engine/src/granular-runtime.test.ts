import { describe, expect, test } from 'bun:test'
import { createDefaultGranularParams } from '@daw-browser/shared'
import { createGranularRuntime } from './granular-runtime'

class FakeAudioBuffer {
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  private readonly channels: Float32Array[]
  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length
    this.numberOfChannels = options.numberOfChannels
    this.sampleRate = options.sampleRate
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length))
  }
  getChannelData(channel: number) { return this.channels[channel] ?? this.channels[0] }
}

describe('granular runtime transfer contract', () => {
  test('configures stereo node params and schedules deterministic MIDI gates', async () => {
    const scheduled: Record<string, Array<[number, number]>> = {}
    const parameter = (name: string): AudioParam => ({
      automationRate: 'a-rate',
      defaultValue: 0,
      maxValue: 1,
      minValue: 0,
      value: 0,
      cancelAndHoldAtTime: () => parameter(name),
      cancelScheduledValues: () => parameter(name),
      exponentialRampToValueAtTime: () => parameter(name),
      linearRampToValueAtTime: () => parameter(name),
      setTargetAtTime: () => parameter(name),
      setValueAtTime: (value: number, time: number) => {
        ;(scheduled[name] ??= []).push([value, time])
        return parameter(name)
      },
      setValueCurveAtTime: () => parameter(name),
    })
    const parameters = new Map([
      ['grainSizeMs', parameter('grainSizeMs')],
      ['densityHz', parameter('densityHz')],
      ['position', parameter('position')],
      ['spray', parameter('spray')],
      ['pitchSemitones', parameter('pitchSemitones')],
      ['reverseProbability', parameter('reverseProbability')],
      ['stereoSpread', parameter('stereoSpread')],
      ['gate', parameter('gate')],
    ])
    const messages: unknown[] = []
    const node = {
      parameters,
      connect: () => {},
      disconnect: () => {},
      onprocessorerror: null,
      port: {
        onmessage: null,
        postMessage: (message: unknown) => messages.push(message),
        close: () => {},
      },
    }
    const runtime = await createGranularRuntime({
      context: { currentTime: 2 },
      params: { ...createDefaultGranularParams(), seed: 77 },
      createNode: () => node,
    })
    runtime.resetSeed()
    runtime.scheduleNote({
      when: 4,
      durationSec: 0.5,
      timelineStartSec: 8,
      timelineToCtxTime: (timeSec) => timeSec - 4,
      automationEnvelopes: [],
    })
    runtime.scheduleNote({
      when: 4.25,
      durationSec: 0.5,
      timelineStartSec: 8.25,
      timelineToCtxTime: (timeSec) => timeSec - 4,
      automationEnvelopes: [],
    })

    expect(messages).toContainEqual({ type: 'reset-seed', version: 1, seed: 77 })
    expect(scheduled.gate).toEqual([[0, 2], [1, 4], [0, 4.5], [1, 4.25], [0, 4.75]])
    expect(scheduled.densityHz).toEqual([[12, 2]])
    expect(scheduled.stereoSpread).toEqual([[0.5, 2]])
    runtime.close()
  })

  test('acks transfers, deduplicates identity, freezes, releases, faults, and closes idempotently', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: FakeAudioBuffer })
    const messages: unknown[] = []
    const transfers: Transferable[][] = []
    let onmessage: ((event: MessageEvent) => void) | null = null
    let disconnected = 0
    let released = 0
    const node = {
      parameters: new Map(),
      connect: () => {},
      disconnect: () => { disconnected += 1 },
      onprocessorerror: null,
      port: {
        get onmessage() { return onmessage },
        set onmessage(value) { onmessage = value },
        postMessage: (message: unknown, options?: StructuredSerializeOptions | Transferable[]) => {
          messages.push(message)
          if (Array.isArray(options)) transfers.push(options)
        },
        close: () => {},
      },
    }
    const runtime = await createGranularRuntime({
      context: { currentTime: 0 },
      params: createDefaultGranularParams(),
      createNode: () => node,
      resourceObserver: { acquire: () => () => { released += 1 } },
    })
    const buffer = new AudioBuffer({ length: 4, numberOfChannels: 2, sampleRate: 48_000 })
    const install = runtime.installSample({ assetKey: 'asset', buffer })
    expect(messages[0]).toMatchObject({ type: 'install' })
    expect(transfers[0]).toHaveLength(2)
    node.port.onmessage?.(new MessageEvent('message', { data: { type: 'installed', version: 1, generation: 1 } }))
    await install
    await runtime.installSample({ assetKey: 'asset', buffer })
    expect(messages).toHaveLength(1)
    runtime.setFrozen(true)
    runtime.resetSeed(9)
    runtime.releaseSample()
    expect(messages).toEqual([
      expect.objectContaining({ type: 'install' }),
      expect.objectContaining({ type: 'freeze' }),
      expect.objectContaining({ type: 'reset-seed' }),
      expect.objectContaining({ type: 'release' }),
    ])
    runtime.close()
    runtime.close()
    expect(disconnected).toBe(1)
    expect(released).toBe(1)
  })

  test('force-stops only the matching live gate while preserving other live and clip intervals', async () => {
    const scheduled: Array<[number, number]> = []
    const gate: AudioParam = {
      automationRate: 'a-rate',
      defaultValue: 0,
      maxValue: 1,
      minValue: 0,
      value: 0,
      cancelAndHoldAtTime: () => gate,
      cancelScheduledValues: () => gate,
      exponentialRampToValueAtTime: () => gate,
      linearRampToValueAtTime: () => gate,
      setTargetAtTime: () => gate,
      setValueAtTime: (value, time) => {
        scheduled.push([value, time])
        return gate
      },
      setValueCurveAtTime: () => gate,
    }
    const runtime = await createGranularRuntime({
      context: { currentTime: 2 },
      params: createDefaultGranularParams(),
      createNode: () => ({
        parameters: new Map([['gate', gate]]),
        connect: () => {},
        disconnect: () => {},
        onprocessorerror: null,
        port: { onmessage: null, postMessage: () => {}, close: () => {} },
      }),
    })

    runtime.scheduleNote({ clipId: 'live:one', when: 4, durationSec: 1, timelineStartSec: 0, timelineToCtxTime: (time) => time, automationEnvelopes: [] })
    runtime.scheduleNote({ clipId: 'live:two', when: 5.5, durationSec: 1, timelineStartSec: 0, timelineToCtxTime: (time) => time, automationEnvelopes: [] })
    runtime.scheduleNote({ clipId: 'transport', when: 7, durationSec: 1, timelineStartSec: 0, timelineToCtxTime: (time) => time, automationEnvelopes: [] })
    runtime.stopClip('live:one')

    expect(scheduled.slice(-5)).toEqual([[0, 2], [1, 5.5], [0, 6.5], [1, 7], [0, 8]])
    runtime.close()
  })

  test('rejects oversize, install errors, stale acknowledgements, and pending work on close', async () => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: FakeAudioBuffer })
    let onmessage: ((event: MessageEvent) => void) | null = null
    const faults: string[] = []
    const node = {
      parameters: new Map(),
      connect: () => {},
      disconnect: () => {},
      onprocessorerror: null,
      port: {
        get onmessage() { return onmessage },
        set onmessage(value) { onmessage = value },
        postMessage: () => {},
        close: () => {},
      },
    }
    const runtime = await createGranularRuntime({
      context: { currentTime: 0 },
      params: { ...createDefaultGranularParams(), maxDecodedBytes: 1024 * 1024 },
      createNode: () => node,
      onFault: (code) => faults.push(code),
    })
    const oversized = new AudioBuffer({ length: 200_000, numberOfChannels: 2, sampleRate: 48_000 })
    await expect(runtime.installSample({ assetKey: 'large', buffer: oversized })).rejects.toThrow('byte limit')
    const buffer = new AudioBuffer({ length: 4, numberOfChannels: 2, sampleRate: 48_000 })
    const failed = runtime.installSample({ assetKey: 'asset', buffer })
    node.port.onmessage?.(new MessageEvent('message', { data: { type: 'installed', version: 1, generation: 0 } }))
    node.port.onmessage?.(new MessageEvent('message', { data: { type: 'error', version: 1, generation: 1, code: 'decode-failed' } }))
    await expect(failed).rejects.toThrow('decode-failed')
    const pending = runtime.installSample({ assetKey: 'asset-2', buffer })
    runtime.close()
    await expect(pending).rejects.toThrow('closed')
    expect(faults).toEqual(['sample-too-large', 'decode-failed'])
  })
})
