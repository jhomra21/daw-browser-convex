import { describe, expect, test } from 'bun:test'
import { createRecordingRuntime, type RecordingMonitorMode, type StartRecordingCaptureOptions } from './recording-runtime'

const eventTarget = () => {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener: (type: string, listener: () => void) => {
      const current = listeners.get(type) ?? new Set()
      current.add(listener)
      listeners.set(type, current)
    },
    removeEventListener: (type: string, listener: () => void) => listeners.get(type)?.delete(listener),
    dispatch: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  }
}

const graph = () => {
  const contextEvents = eventTarget()
  const trackEvents = eventTarget()
  const connections: unknown[] = []
  const disconnections: unknown[] = []
  const ramps: number[] = []
  const source = Object.assign(Object.create(null), {
    connect: (target: unknown) => connections.push(target),
    disconnect: () => disconnections.push(source),
  })
  const gain = Object.assign(Object.create(null), {
    gain: {
      value: 1,
      setValueAtTime: () => undefined,
      linearRampToValueAtTime: (value: number) => ramps.push(value),
      cancelScheduledValues: () => undefined,
    },
    connect: (target: unknown) => connections.push(target),
    disconnect: () => disconnections.push(gain),
  })
  const messages: unknown[] = []
  const port = Object.assign(Object.create(null), {
    onmessage: null,
    messages,
    postMessage(message: unknown) {
      port.messages.push(message)
    },
  })
  const worklet = Object.assign(Object.create(null), {
    port,
    connect: (target: unknown) => connections.push(target),
    disconnect: () => disconnections.push(worklet),
  })
  const track = Object.assign(Object.create(null), trackEvents, {
    readyState: 'live',
    muted: false,
    getSettings: () => ({ channelCount: 2 }),
  })
  const stream = Object.assign(Object.create(null), {
    getAudioTracks: () => [track],
  })
  const context = Object.assign(Object.create(null), contextEvents, {
    state: 'running',
    currentTime: 2,
    sampleRate: 48_000,
    createMediaStreamSource: () => source,
    createGain: () => gain,
  })
  return { context, track, stream, source, gain, worklet, port, connections, disconnections, ramps }
}

const startOptions = (stream: MediaStream): StartRecordingCaptureOptions => ({
  sessionId: 'take-1',
  stream,
  trackId: 'track-1',
  layout: 'mono',
  inputChannel: 0,
  gain: 1,
  polarity: 1,
  monitor: 'auto',
  armed: true,
  epoch: { timelineFrame: 48_000, contextFrame: 96_000 },
  punchInContextFrame: 96_000,
})

describe('recording runtime', () => {
  test('uses the shared context, creates one source, and monitors through the mixer seam', async () => {
    const fake = graph()
    let sourceCreations = 0
    fake.context.createMediaStreamSource = () => {
      sourceCreations += 1
      return fake.source
    }
    let monitorTrack = ''
    const runtime = createRecordingRuntime({
      getContext: () => fake.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => fake.worklet,
      connectMonitor: (trackId) => {
        monitorTrack = trackId
        return () => undefined
      },
    })
    await runtime.start(startOptions(fake.stream))
    expect(sourceCreations).toBe(1)
    expect(monitorTrack).toBe('track-1')
    expect(fake.connections).toContain(fake.worklet)
    expect(fake.connections).toContain(fake.gain)
    expect(fake.ramps).toEqual([1])
  })

  test('enforces one session, validates channels, reports mute, and tears down device loss', async () => {
    const fake = graph()
    const statuses: string[] = []
    const runtime = createRecordingRuntime({
      getContext: () => fake.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => fake.worklet,
      connectMonitor: () => () => undefined,
    })
    runtime.subscribe((status) => statuses.push(status.state === 'failed' ? status.reason : status.state))
    await runtime.start(startOptions(fake.stream))
    await expect(runtime.start(startOptions(fake.stream))).rejects.toThrow('already active')
    fake.track.dispatch('mute')
    expect(runtime.getStatus()).toMatchObject({ state: 'recording', muted: true })
    fake.track.dispatch('ended')
    expect(statuses).toContain('recording-device-ended')
    expect(fake.disconnections.length).toBeGreaterThan(1)

    const invalid = graph()
    const invalidRuntime = createRecordingRuntime({
      getContext: () => invalid.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => invalid.worklet,
      connectMonitor: () => () => undefined,
    })
    await expect(invalidRuntime.start({
      ...startOptions(invalid.stream),
      layout: 'stereo',
      inputChannel: 1,
    })).rejects.toThrow('unavailable')
  })

  test('reserves startup synchronously and rolls back every allocated graph resource after setup failure', async () => {
    const fake = graph()
    let releaseLoad: (() => void) | undefined
    const loading = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    const runtime = createRecordingRuntime({
      getContext: () => fake.context,
      loadWorklet: () => loading,
      createWorkletNode: () => fake.worklet,
      connectMonitor: () => {
        throw new Error('monitor-routing-failed')
      },
    })
    const firstStart = runtime.start(startOptions(fake.stream))
    await expect(runtime.start(startOptions(fake.stream))).rejects.toThrow('already active')
    releaseLoad?.()
    await expect(firstStart).rejects.toThrow('monitor-routing-failed')
    expect(fake.port.onmessage).toBeNull()
    expect(fake.disconnections).toContain(fake.source)
    expect(fake.disconnections).toContain(fake.worklet)
    expect(fake.disconnections).toContain(fake.gain)

    const retry = graph()
    const retryRuntime = createRecordingRuntime({
      getContext: () => retry.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => retry.worklet,
      connectMonitor: () => () => undefined,
    })
    await retryRuntime.start(startOptions(retry.stream))
    expect(retryRuntime.getStatus()).toMatchObject({ state: 'recording' })
  })

  test('configures epoch and punch before capture and finalizes at the synchronous context frame', async () => {
    const fake = graph()
    const runtime = createRecordingRuntime({
      getContext: () => fake.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => fake.worklet,
      connectMonitor: () => () => undefined,
    })
    await runtime.start({
      ...startOptions(fake.stream),
      punchOutContextFrame: 144_000,
    })
    expect(fake.port.messages[0]).toMatchObject({
      type: 'configure',
      epoch: { timelineFrame: 48_000, contextFrame: 96_000 },
      punchStartFrame: 96_000,
      punchEndFrame: 144_000,
    })
    fake.context.currentTime = 2.5
    const stopping = runtime.stop()
    expect(runtime.stop()).toBe(stopping)
    expect(fake.port.messages.at(-1)).toMatchObject({ type: 'finalize', stopContextFrame: 120_000 })
    fake.port.onmessage?.({ data: {
      type: 'complete',
      generation: 0,
      sessionId: 'take-1',
      capturedFrames: 24_000,
      droppedFrames: 0,
      droppedBlocks: 0,
    } })
    await stopping
    expect(runtime.getStatus()).toEqual({
      state: 'complete',
      sessionId: 'take-1',
      stopContextFrame: 120_000,
      capturedFrames: 24_000,
    })
    expect(fake.ramps).toEqual([1, 0])
  })

  test('waits for the audible monitor fade before disconnecting and resolves stop once', async () => {
    const fake = graph()
    let monitorDisconnects = 0
    const runtime = createRecordingRuntime({
      getContext: () => fake.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => fake.worklet,
      connectMonitor: () => () => {
        monitorDisconnects += 1
      },
    })
    await runtime.start(startOptions(fake.stream))
    const stopping = runtime.stop()
    fake.port.onmessage?.({ data: {
      type: 'complete',
      generation: 0,
      sessionId: 'take-1',
      capturedFrames: 0,
      droppedFrames: 0,
      droppedBlocks: 0,
    } })
    expect(monitorDisconnects).toBe(0)
    await stopping
    expect(monitorDisconnects).toBe(1)
    runtime.cancel()
    expect(monitorDisconnects).toBe(1)
  })

  test('off and unarmed auto monitoring never connect to the mixer', async () => {
    const modes: readonly RecordingMonitorMode[] = ['off', 'auto']
    for (const monitor of modes) {
      const fake = graph()
      let monitorConnections = 0
      const runtime = createRecordingRuntime({
        getContext: () => fake.context,
        loadWorklet: async () => undefined,
        createWorkletNode: () => fake.worklet,
        connectMonitor: () => {
          monitorConnections += 1
          return () => undefined
        },
      })
      await runtime.start({ ...startOptions(fake.stream), monitor, armed: false })
      expect(monitorConnections).toBe(0)
      runtime.cancel()
    }
  })

  test('uses transport frame totals and handles startup, finalize, cancel, and returned block routing', async () => {
    const success = graph()
    const routed: unknown[] = []
    const runtime = createRecordingRuntime({
      getContext: () => success.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => success.worklet,
      connectMonitor: () => () => undefined,
    })
    await runtime.start({
      ...startOptions(success.stream),
      createTransport: ({ worklet }) => {
        worklet.setMessageHandler((message) => routed.push(message))
        return {
          ready: Promise.resolve(),
          finalize: async () => ({ capturedFrames: 321 }),
          abort: async () => undefined,
          terminate: () => undefined,
        }
      },
    })
    const blockMessage = {
      type: 'block',
      generation: 0,
      sessionId: 'take-1',
      blockId: 0,
      sequence: 0,
      frameCount: 1,
      channelCount: 1,
      buffer: new ArrayBuffer(2048 * Float32Array.BYTES_PER_ELEMENT),
    }
    success.port.onmessage?.({ data: {
      type: 'meter',
      generation: 0,
      sessionId: 'take-1',
      rms: 0.25,
      peak: 0.75,
    } })
    expect(runtime.getStatus()).toMatchObject({ state: 'recording', rms: 0.25, peak: 0.75 })
    success.port.onmessage?.({ data: blockMessage })
    expect(routed).toEqual([blockMessage])
    await runtime.stop()
    expect(runtime.getStatus()).toMatchObject({ state: 'complete', capturedFrames: 321 })
    const startup = graph()
    const startupRuntime = createRecordingRuntime({
      getContext: () => startup.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => startup.worklet,
      connectMonitor: () => () => undefined,
    })
    await expect(startupRuntime.start({
      ...startOptions(startup.stream),
      createTransport: () => ({
        ready: Promise.reject(new Error('startup-failed')),
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => undefined,
        terminate: () => undefined,
      }),
    })).rejects.toThrow('startup-failed')
    expect(startup.disconnections).toContain(startup.worklet)

    const finalize = graph()
    const finalizeRuntime = createRecordingRuntime({
      getContext: () => finalize.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => finalize.worklet,
      connectMonitor: () => () => undefined,
    })
    await finalizeRuntime.start({
      ...startOptions(finalize.stream),
      createTransport: () => ({
        ready: Promise.resolve(),
        finalize: async () => { throw new Error('finalize-failed') },
        abort: async () => undefined,
        terminate: () => undefined,
      }),
    })
    await finalizeRuntime.stop()
    expect(finalizeRuntime.getStatus()).toMatchObject({ state: 'failed', reason: 'finalize-failed' })

    const cancelled = graph()
    let aborts = 0
    const cancelRuntime = createRecordingRuntime({
      getContext: () => cancelled.context,
      loadWorklet: async () => undefined,
      createWorkletNode: () => cancelled.worklet,
      connectMonitor: () => () => undefined,
    })
    await cancelRuntime.start({
      ...startOptions(cancelled.stream),
      createTransport: () => ({
        ready: Promise.resolve(),
        finalize: async () => ({ capturedFrames: 0 }),
        abort: async () => { aborts += 1 },
        terminate: () => undefined,
      }),
    })
    cancelRuntime.cancel()
    await Promise.resolve()
    expect(aborts).toBe(1)
    expect(cancelRuntime.getStatus()).toMatchObject({ state: 'cancelled' })
  })
})
