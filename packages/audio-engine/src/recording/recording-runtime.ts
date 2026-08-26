import { loadWorkletModule } from '../worklet-loader'
import { recorderWorklet, resolveWorkletModuleUrl } from '../worklet-manifest'
import {
  readRecorderOutboundMessage,
  type RecorderBlockMessage,
  type RecorderOutboundMessage,
  type RecorderReturnMessage,
} from './recording-protocol'
import { observeResource, type ResourceObserver } from '../runtime-diagnostics'

export type RecordingMonitorMode = 'off' | 'auto' | 'on'

export type RecordingEpoch = {
  timelineFrame: number
  contextFrame: number
}

export type RecordingRuntimeStatus =
  | { state: 'idle' }
  | { state: 'recording'; sessionId: string; muted: boolean; rms: number; peak: number; contextFrame: number }
  | { state: 'complete'; sessionId: string; stopContextFrame: number; capturedFrames: number }
  | { state: 'cancelled'; sessionId: string }
  | { state: 'failed'; sessionId: string; reason: string }

type RecordingWorkletNode = AudioNode & {
  port: MessagePort
  onprocessorerror?: ((event: ErrorEvent) => void) | null
}

type RecordingSession = {
  sessionId: string
  context: AudioContext
  source: MediaStreamAudioSourceNode
  worklet: RecordingWorkletNode
  monitorGain: GainNode | null
  disconnectMonitor: (() => void) | null
  track: MediaStreamTrack
  onEnded: () => void
  onMute: () => void
  onUnmute: () => void
  onContextStateChange: () => void
  generation: number
  stopContextFrame: number | null
  stopPromise: Promise<void> | null
  resolveStop: (() => void) | null
  monitorFadeTimer: ReturnType<typeof setTimeout> | null
  monitorFadePromise: Promise<void> | null
  finalizeTimer: ReturnType<typeof setTimeout> | null
  terminal: boolean
  transport: RecordingCaptureTransport | null
  faultGeneration: number
  releaseResources: () => void
}

type RecordingRuntimeOptions = {
  getContext: () => AudioContext | null
  connectMonitor: (trackId: string, source: AudioNode) => () => void
  loadWorklet?: (context: AudioContext) => Promise<void>
  createWorkletNode?: (context: AudioContext, channelCount: number) => RecordingWorkletNode
  getFaultGeneration?: () => number
  onFault?: (generation: number, code: string) => void
  finalizeTimeoutMs?: number
  resourceObserver?: ResourceObserver
}

export type RecordingCaptureTransport = {
  ready: Promise<void>
  finalize: () => Promise<{ capturedFrames: number }>
  abort: () => Promise<void>
  terminate: () => void
}

type RecordingWorkletMessage =
  | {
    type: 'configure'
    generation: number
    sessionId: string
    channelCount: number
    inputChannels: readonly number[]
    gain: number
    polarity: 1 | -1
    epoch: RecordingEpoch
    punchStartFrame: number
    punchEndFrame: number | null
  }
  | {
    type: 'initialize-sab'
    generation: number
    sessionId: string
    state: SharedArrayBuffer
    frameCounts: SharedArrayBuffer
    samples: SharedArrayBuffer
  }
  | RecorderBlockMessage
  | { type: 'finalize'; generation: number; sessionId: string; stopContextFrame?: number }
  | RecorderReturnMessage

export type RecordingMessageEndpoint = {
  postMessage: (message: RecordingWorkletMessage, transfer?: readonly ArrayBuffer[]) => void
  setMessageHandler: (handler: (message: RecorderOutboundMessage | null) => void) => void
}

export type StartRecordingCaptureOptions = {
  sessionId: string
  stream: MediaStream
  trackId: string
  layout: 'mono' | 'stereo'
  inputChannel: number
  gain: number
  polarity: 1 | -1
  monitor: RecordingMonitorMode
  armed: boolean
  epoch: RecordingEpoch
  punchInContextFrame: number
  punchOutContextFrame?: number
  createTransport?: (input: {
    generation: number
    sessionId: string
    sampleRate: number
    channelCount: number
    worklet: RecordingMessageEndpoint
  }) => RecordingCaptureTransport
}

const MONITOR_FADE_SEC = 0.005
const FINALIZE_TIMEOUT_MS = 5_000

const defaultCreateWorkletNode = (context: AudioContext, channelCount: number): RecordingWorkletNode =>
  new AudioWorkletNode(context, recorderWorklet.processorName, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [channelCount],
    channelCountMode: 'explicit',
    channelCount,
  })

const frameAtCurrentTime = (context: AudioContext) => Math.max(0, Math.floor(context.currentTime * context.sampleRate))

export const createRecordingRuntime = (options: RecordingRuntimeOptions) => {
  let active: RecordingSession | null = null
  let starting = false
  const listeners = new Set<(status: RecordingRuntimeStatus) => void>()
  let status: RecordingRuntimeStatus = { state: 'idle' }
  let generation = 0

  const publish = (next: RecordingRuntimeStatus) => {
    status = next
    for (const listener of listeners) listener(next)
  }

  const disconnect = (session: RecordingSession) => {
    if (session.monitorFadeTimer !== null) {
      clearTimeout(session.monitorFadeTimer)
      session.monitorFadeTimer = null
    }
    if (session.finalizeTimer !== null) {
      clearTimeout(session.finalizeTimer)
      session.finalizeTimer = null
    }
    session.track.removeEventListener('ended', session.onEnded)
    session.track.removeEventListener('mute', session.onMute)
    session.track.removeEventListener('unmute', session.onUnmute)
    session.context.removeEventListener('statechange', session.onContextStateChange)
    session.worklet.port.onmessage = null
    session.worklet.onprocessorerror = null
    session.transport?.terminate()
    session.disconnectMonitor?.()
    try { session.monitorGain?.disconnect() } catch {}
    try { session.source.disconnect() } catch {}
    try { session.worklet.disconnect() } catch {}
    session.releaseResources()
  }

  const finishTerminal = async (
    session: RecordingSession,
    next: RecordingRuntimeStatus,
    waitForMonitorFade = false,
  ) => {
    if (session.terminal) return
    session.terminal = true
    if (active === session) active = null
    if (waitForMonitorFade) await session.monitorFadePromise
    disconnect(session)
    publish(next)
    session.resolveStop?.()
  }

  const fail = (session: RecordingSession, reason: string, releaseImmediately = false) => {
    options.onFault?.(session.faultGeneration, reason)
    const transport = session.transport
    if (!transport || releaseImmediately) {
      if (transport) void transport.abort().catch(() => undefined)
      void finishTerminal(session, { state: 'failed', sessionId: session.sessionId, reason })
      return
    }
    void (async () => {
      await transport.abort().catch(() => undefined)
      await finishTerminal(session, { state: 'failed', sessionId: session.sessionId, reason })
    })()
  }

  const start = async (input: StartRecordingCaptureOptions) => {
    if (active || starting) throw new Error('A recording session is already active.')
    starting = true
    let session: RecordingSession | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let worklet: RecordingWorkletNode | null = null
    let monitorGain: GainNode | null = null
    let disconnectMonitor: (() => void) | null = null
    let track: MediaStreamTrack | null = null
    let onEnded: (() => void) | null = null
    let onMute: (() => void) | null = null
    let onUnmute: (() => void) | null = null
    let onContextStateChange: (() => void) | null = null
    let context: AudioContext | null = null
    const releases: Array<() => void> = []
    const releaseResources = () => {
      for (const release of releases.splice(0).reverse()) release()
    }
    try {
    context = options.getContext()
    if (!context || context.state !== 'running') throw new Error('Recording requires an active AudioContext.')
    if (!Number.isSafeInteger(input.epoch.timelineFrame) || input.epoch.timelineFrame < 0 ||
      !Number.isSafeInteger(input.epoch.contextFrame) || input.epoch.contextFrame < 0) {
      throw new Error('Recording epoch is invalid.')
    }
    const tracks = input.stream.getAudioTracks()
    if (tracks.length !== 1) throw new Error('Recording requires exactly one audio input track.')
    track = tracks[0] ?? null
    if (!track || track.readyState === 'ended') throw new Error('Recording input track is unavailable.')
    const availableChannels = track.getSettings().channelCount ?? 1
    const inputChannels = input.layout === 'stereo'
      ? [input.inputChannel, input.inputChannel + 1]
      : [input.inputChannel]
    if (inputChannels.some((channel) => channel < 0 || channel >= availableChannels)) {
      throw new Error('Selected recording input channels are unavailable.')
    }
    if (!Number.isFinite(input.gain) || input.gain < 0) throw new Error('Recording gain is invalid.')
    if (input.polarity !== 1 && input.polarity !== -1) throw new Error('Recording polarity is invalid.')
    if (!Number.isSafeInteger(input.punchInContextFrame) || input.punchInContextFrame < input.epoch.contextFrame) {
      throw new Error('Recording punch-in frame is invalid.')
    }
    if (input.punchOutContextFrame !== undefined &&
      (!Number.isSafeInteger(input.punchOutContextFrame) || input.punchOutContextFrame < input.punchInContextFrame)) {
      throw new Error('Recording punch-out frame is invalid.')
    }

    await (options.loadWorklet ?? ((ctx) => loadWorkletModule(ctx, resolveWorkletModuleUrl(recorderWorklet.modulePath))))(context)
    source = context.createMediaStreamSource(input.stream)
    releases.push(observeResource(options.resourceObserver, 'media-streams', input.stream))
    releases.push(observeResource(options.resourceObserver, 'media-stream-sources', source))
    worklet = (options.createWorkletNode ?? defaultCreateWorkletNode)(context, inputChannels.length)
    releases.push(observeResource(options.resourceObserver, 'audio-worklet-nodes', worklet))
    const captureContext = context
    const captureTrack = track
    const captureWorklet = worklet
    const captureSource = source
    const currentGeneration = generation
    generation += 1
    onEnded = () => {
      if (session) fail(session, 'recording-device-ended')
    }
    onMute = () => {
      if (!session) return
      if (active !== session || session.terminal) return
      publish({ state: 'recording', sessionId: input.sessionId, muted: true, rms: 0, peak: 0, contextFrame: frameAtCurrentTime(captureContext) })
    }
    onUnmute = () => {
      if (!session) return
      if (active !== session || session.terminal) return
      publish({ state: 'recording', sessionId: input.sessionId, muted: false, rms: 0, peak: 0, contextFrame: frameAtCurrentTime(captureContext) })
    }
    onContextStateChange = () => {
      if (session && context?.state === 'closed') fail(session, 'audio-context-closed')
    }

    const establishedSession: RecordingSession = {
      sessionId: input.sessionId,
      context: captureContext,
      source: captureSource,
      worklet: captureWorklet,
      monitorGain: null,
      disconnectMonitor: null,
      track: captureTrack,
      onEnded,
      onMute,
      onUnmute,
      onContextStateChange,
      generation: currentGeneration,
      stopContextFrame: null,
      stopPromise: null,
      resolveStop: null,
      monitorFadeTimer: null,
      monitorFadePromise: null,
      finalizeTimer: null,
      terminal: false,
      transport: null,
      faultGeneration: options.getFaultGeneration?.() ?? 0,
      releaseResources,
    }
    session = establishedSession
    active = establishedSession
    captureTrack.addEventListener('ended', onEnded)
    captureTrack.addEventListener('mute', onMute)
    captureTrack.addEventListener('unmute', onUnmute)
    captureContext.addEventListener('statechange', onContextStateChange)
    let transportMessageHandler: ((message: RecorderOutboundMessage | null) => void) | null = null
    establishedSession.transport = input.createTransport?.({
      generation: currentGeneration,
      sessionId: input.sessionId,
      sampleRate: captureContext.sampleRate,
      channelCount: inputChannels.length,
      worklet: {
        postMessage: (message, transfer = []) => captureWorklet.port.postMessage(message, [...transfer]),
        setMessageHandler: (handler) => {
          transportMessageHandler = handler
        },
      },
    }) ?? null
    if (establishedSession.transport) {
      releases.push(observeResource(options.resourceObserver, 'workers', establishedSession.transport))
    }
    if (establishedSession.transport) await establishedSession.transport.ready
    captureWorklet.onprocessorerror = () => {
      if (active !== establishedSession || establishedSession.terminal) return
      fail(establishedSession, 'recording-processor-error', true)
    }
    captureWorklet.port.onmessage = (event) => {
      const message = readRecorderOutboundMessage(event.data)
      if (!message) {
        transportMessageHandler?.(null)
        return
      }
      if (message.generation !== currentGeneration || message.sessionId !== input.sessionId) return
      if (message.type === 'meter') {
        publish({
          state: 'recording',
          sessionId: input.sessionId,
          muted: captureTrack.muted,
          rms: message.rms,
          peak: message.peak,
          contextFrame: frameAtCurrentTime(captureContext),
        })
        return
      }
      if (message.type === 'block') {
        const samples = new Float32Array(message.buffer)
        let sum = 0
        let peak = 0
        const sampleCount = message.frameCount * message.channelCount
        for (let channel = 0; channel < message.channelCount; channel += 1) {
          const offset = channel * 2048
          for (let frame = 0; frame < message.frameCount; frame += 1) {
            const value = samples[offset + frame] ?? 0
            sum += value * value
            peak = Math.max(peak, Math.abs(value))
          }
        }
        publish({
          state: 'recording',
          sessionId: input.sessionId,
          muted: captureTrack.muted,
          rms: sampleCount > 0 ? Math.sqrt(sum / sampleCount) : 0,
          peak,
          contextFrame: frameAtCurrentTime(captureContext),
        })
        if (transportMessageHandler) {
          transportMessageHandler(message)
        } else {
          const returned: RecorderReturnMessage = {
            type: 'return',
            generation: currentGeneration,
            sessionId: input.sessionId,
            blockId: message.blockId,
            buffer: message.buffer,
          }
          captureWorklet.port.postMessage(returned, [message.buffer])
        }
        return
      }
      if (message.type === 'failure') {
        transportMessageHandler?.(message)
        fail(establishedSession, message.reason)
        return
      }
      if (transportMessageHandler) {
        transportMessageHandler(message)
        return
      }
      const stopContextFrame = establishedSession.stopContextFrame ?? frameAtCurrentTime(captureContext)
      void finishTerminal(establishedSession, {
        state: 'complete',
        sessionId: establishedSession.sessionId,
        stopContextFrame,
        capturedFrames: message.capturedFrames,
      }, true)
    }

    captureSource.connect(captureWorklet)
    const shouldMonitor = input.monitor === 'on' || (input.monitor === 'auto' && input.armed)
    if (shouldMonitor) {
      monitorGain = captureContext.createGain()
      releases.push(observeResource(options.resourceObserver, 'monitor-paths', monitorGain))
      const now = captureContext.currentTime
      monitorGain.gain.setValueAtTime(0, now)
      monitorGain.gain.linearRampToValueAtTime(1, now + MONITOR_FADE_SEC)
      captureWorklet.connect(monitorGain)
      establishedSession.monitorGain = monitorGain
      disconnectMonitor = options.connectMonitor(input.trackId, monitorGain)
      establishedSession.disconnectMonitor = disconnectMonitor
    }
    captureWorklet.port.postMessage({
      type: 'configure',
      generation: currentGeneration,
      sessionId: input.sessionId,
      channelCount: inputChannels.length,
      inputChannels,
      gain: input.gain,
      polarity: input.polarity,
      epoch: input.epoch,
      punchStartFrame: input.punchInContextFrame,
      punchEndFrame: input.punchOutContextFrame ?? null,
    })
    publish({
      state: 'recording',
      sessionId: input.sessionId,
      muted: captureTrack.muted,
      rms: 0,
      peak: 0,
      contextFrame: frameAtCurrentTime(captureContext),
    })
    } catch (error) {
      await session?.transport?.abort().catch(() => undefined)
      session?.transport?.terminate()
      if (track && onEnded) track.removeEventListener('ended', onEnded)
      if (track && onMute) track.removeEventListener('mute', onMute)
      if (track && onUnmute) track.removeEventListener('unmute', onUnmute)
      if (context && onContextStateChange) context.removeEventListener('statechange', onContextStateChange)
      if (worklet) worklet.port.onmessage = null
      try { disconnectMonitor?.() } catch {}
      try { monitorGain?.disconnect() } catch {}
      try { source?.disconnect() } catch {}
      try { worklet?.disconnect() } catch {}
      releaseResources()
      if (active === session) active = null
      status = { state: 'idle' }
      throw error
    } finally {
      starting = false
    }
  }

  const stop = () => {
    const session = active
    if (!session || session.terminal) return Promise.resolve()
    if (session.stopPromise) return session.stopPromise
    const stopContextFrame = frameAtCurrentTime(session.context)
    session.stopContextFrame = stopContextFrame
    if (session.monitorGain) {
      const now = session.context.currentTime
      session.monitorGain.gain.cancelScheduledValues(now)
      session.monitorGain.gain.setValueAtTime(session.monitorGain.gain.value, now)
      session.monitorGain.gain.linearRampToValueAtTime(0, now + MONITOR_FADE_SEC)
      session.monitorFadePromise = new Promise<void>((resolve) => {
        session.monitorFadeTimer = setTimeout(() => {
          session.monitorFadeTimer = null
          resolve()
        }, MONITOR_FADE_SEC * 1000)
      })
    }
    session.stopPromise = new Promise<void>((resolve) => {
      session.resolveStop = resolve
    })
    session.finalizeTimer = setTimeout(() => {
      fail(session, 'recording-finalize-timeout', true)
    }, options.finalizeTimeoutMs ?? FINALIZE_TIMEOUT_MS)
    if (session.transport) {
      void session.transport.finalize().then((descriptor) => finishTerminal(session, {
        state: 'complete',
        sessionId: session.sessionId,
        stopContextFrame,
        capturedFrames: descriptor.capturedFrames,
      }, true)).catch((error) => fail(
        session,
        error instanceof Error ? error.message : 'recording-transport-failed',
        true,
      ))
      return session.stopPromise
    }
    session.worklet.port.postMessage({
      type: 'finalize',
      generation: session.generation,
      sessionId: session.sessionId,
      stopContextFrame,
    })
    return session.stopPromise
  }

  const cancel = () => {
    const session = active
    if (!session || session.terminal) return
    if (session.transport) void session.transport.abort().catch(() => undefined)
    void finishTerminal(session, { state: 'cancelled', sessionId: session.sessionId })
  }

  return {
    start,
    stop,
    cancel,
    getStatus: () => status,
    subscribe: (listener: (next: RecordingRuntimeStatus) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
