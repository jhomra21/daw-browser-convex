import {
  createRecorderSabRingBuffers,
  type RecorderSabRingBuffers,
} from '../../../packages/audio-engine/src/recording/sab-ring-buffer'
import {
  readRecorderOutboundMessage,
  readWriterOutboundMessage,
  type WriterInboundMessage,
} from '../../../packages/audio-engine/src/recording/recording-protocol'
import type { RecordingCaptureTransport } from '../../../packages/audio-engine/src/recording/recording-runtime'

type MessageEndpoint = {
  postMessage: (message: unknown) => void
  setMessageHandler: (handler: (message: unknown) => void) => void
}

type WorkerEndpoint = MessageEndpoint & {
  terminate: () => void
}

type RecordingSabTransportOptions = {
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
  worklet: MessageEndpoint
  buffers?: RecorderSabRingBuffers
  worker?: WorkerEndpoint
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export const createRecordingSabTransport = (
  options: RecordingSabTransportOptions,
): RecordingCaptureTransport => {
  const buffers = options.buffers ?? createRecorderSabRingBuffers()
  const worker = options.worker ?? createBrowserRecordingWriter()
  const ready = deferred<void>()
  let completion: Deferred<{ capturedFrames: number }> | null = null
  let state: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting'
  let terminal: 'finalize' | 'abort' | null = null
  let terminalError: Error | null = null

  const fail = (reason: string, abortWriter = true) => {
    if (state === 'closed' || state === 'failed') return
    const shouldAbortWriter = abortWriter && state !== 'starting'
    state = 'failed'
    const error = new Error(reason)
    terminalError = error
    ready.reject(error)
    completion?.reject(error)
    completion = null
    if (shouldAbortWriter) {
      worker.postMessage({
        type: 'abort',
        generation: options.generation,
        sessionId: options.sessionId,
      })
    } else {
      worker.terminate()
    }
  }

  const startMessage: WriterInboundMessage = {
    type: 'start-sab',
    generation: options.generation,
    sessionId: options.sessionId,
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
    state: buffers.state,
    frameCounts: buffers.frameCounts,
    samples: buffers.samples,
  }
  worker.setMessageHandler((value) => {
    const message = readWriterOutboundMessage(value)
    if (!message) return fail('Malformed recording writer message.', false)
    if (message.generation !== options.generation || message.sessionId !== options.sessionId) return
    if (state === 'failed') {
      if (message.type === 'aborted' || message.type === 'failure') worker.terminate()
      return
    }
    if (message.type === 'ready') {
      if (state !== 'starting') return fail('Unexpected recording writer ready message.')
      state = 'open'
      ready.resolve()
      return
    }
    if (message.type === 'failure') return fail(message.reason, false)
    if (message.type === 'return') return fail('SAB writer returned a transferable block.')
    if (state !== 'closing' || !completion || !terminal) {
      return fail('Unexpected recording writer terminal response.')
    }
    if (
      (terminal === 'finalize' && message.type !== 'finalized') ||
      (terminal === 'abort' && message.type !== 'aborted')
    ) return fail('Recording writer terminal response mismatch.')
    const pending = completion
    completion = null
    state = 'closed'
    worker.terminate()
    pending.resolve({
      capturedFrames: message.type === 'finalized' ? message.capturedFrames : 0,
    })
  })

  options.worklet.setMessageHandler((value) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      value.type === 'sab-notify'
    ) {
      if (
        'generation' in value &&
        value.generation === options.generation &&
        'sessionId' in value &&
        value.sessionId === options.sessionId
      ) {
        worker.postMessage({
          type: 'wake',
          generation: options.generation,
          sessionId: options.sessionId,
        })
      }
      return
    }
    const message = readRecorderOutboundMessage(value)
    if (!message) return fail('Malformed recorder worklet message.')
    if (message.generation !== options.generation || message.sessionId !== options.sessionId) return
    if (message.type === 'meter') return
    if (message.type === 'block') return fail('Recorder emitted a transferable block during SAB capture.')
    if (message.type === 'failure') return fail(message.reason)
    if (state !== 'closing' || terminal !== 'finalize' || !completion) {
      return fail('Unexpected recorder completion.')
    }
    worker.postMessage({
      type: 'finalize',
      generation: options.generation,
      sessionId: options.sessionId,
      capturedFrames: message.capturedFrames,
    })
  })

  worker.postMessage(startMessage)

  ready.promise.then(() => {
    options.worklet.postMessage({
      type: 'initialize-sab',
      generation: options.generation,
      sessionId: options.sessionId,
      state: buffers.state,
      frameCounts: buffers.frameCounts,
      samples: buffers.samples,
    })
  }).catch(() => undefined)

  const finish = async (type: 'finalize' | 'abort') => {
    if (state === 'starting') await ready.promise
    if (state === 'failed' && terminalError) throw terminalError
    if (state !== 'open') throw new Error('Recording transport is not open.')
    state = 'closing'
    terminal = type
    completion = deferred<{ capturedFrames: number }>()
    if (type === 'finalize') {
      options.worklet.postMessage({
        type: 'finalize',
        generation: options.generation,
        sessionId: options.sessionId,
      })
    } else {
      worker.postMessage({
        type: 'abort',
        generation: options.generation,
        sessionId: options.sessionId,
      })
    }
    return completion.promise
  }

  return {
    ready: ready.promise,
    finalize: () => finish('finalize'),
    abort: async () => {
      await finish('abort')
    },
    terminate: () => {
      if (state === 'closed' || state === 'failed') return
      fail('Recording transport terminated.')
    },
  }
}

const createBrowserRecordingWriter = (): WorkerEndpoint => {
  const worker = new Worker(new URL('../../workers/recording-writer-worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage: (message) => worker.postMessage(message),
    setMessageHandler: (handler) => {
      worker.onmessage = (event: MessageEvent<unknown>) => handler(event.data)
    },
    terminate: () => worker.terminate(),
  }
}
