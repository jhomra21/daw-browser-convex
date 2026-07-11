import {
  RECORDER_MAX_QUEUED_BLOCKS,
  readRecorderOutboundMessage,
  readWriterOutboundMessage,
  type WriterInboundMessage,
} from '../../../packages/audio-engine/src/recording/recording-protocol'

type MessageEndpoint = {
  postMessage: (message: unknown, transfer?: readonly ArrayBuffer[]) => void
  setMessageHandler: (handler: (message: unknown) => void) => void
}

type WorkerEndpoint = MessageEndpoint & {
  terminate: () => void
}

type RecordingTransferTransportOptions = {
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
  worklet: MessageEndpoint
  worker?: WorkerEndpoint
}

type Deferred = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

const deferred = (): Deferred => {
  let resolve = () => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

export const createRecordingTransferTransport = (options: RecordingTransferTransportOptions) => {
  const worker = options.worker ?? createBrowserRecordingWriter()
  let queuedBlocks = 0
  let state: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting'
  const ready = deferred()
  let completion: Deferred | null = null
  let workletComplete = false
  let writerTerminal = false
  let requestedTerminal: 'finalized' | 'aborted' | null = null

  const settleCompletion = () => {
    if (
      state !== 'closing' ||
      !completion ||
      !writerTerminal ||
      (requestedTerminal === 'finalized' && (!workletComplete || queuedBlocks !== 0))
    ) return
    const pending = completion
    completion = null
    state = 'closed'
    pending.resolve()
    worker.terminate()
  }

  const terminate = () => {
    if (state === 'closed' || state === 'failed') return
    const error = new Error('Recording transport terminated.')
    ready.reject(error)
    completion?.reject(error)
    completion = null
    state = 'closed'
    worker.terminate()
  }

  const fail = (reason: string) => {
    if (state === 'failed' || state === 'closed') return
    state = 'failed'
    const error = new Error(reason)
    ready.reject(error)
    completion?.reject(error)
    completion = null
    worker.terminate()
  }

  options.worklet.setMessageHandler((value) => {
    const message = readRecorderOutboundMessage(value)
    if (!message) {
      fail('Malformed recorder worklet message.')
      return
    }
    if (message.generation !== options.generation || message.sessionId !== options.sessionId) return
    if (message.type === 'failure') {
      fail(message.reason)
      return
    }
    if (message.type === 'complete') {
      if (state !== 'closing' || requestedTerminal !== 'finalized' || workletComplete) {
        fail('Unexpected recorder completion.')
        return
      }
      workletComplete = true
      if (queuedBlocks === 0) {
        worker.postMessage({
          type: 'finalize',
          generation: options.generation,
          sessionId: options.sessionId,
        })
      }
      settleCompletion()
      return
    }
    if (state !== 'open' && state !== 'closing') {
      fail('Recorder emitted a block outside an open session.')
      return
    }
    if (workletComplete || message.channelCount !== options.channelCount) {
      fail(workletComplete ? 'Recorder emitted a block after completion.' : 'Recorder block channel count changed.')
      return
    }
    queuedBlocks += 1
    if (queuedBlocks > RECORDER_MAX_QUEUED_BLOCKS) {
      fail('Recording writer queue exceeded its hard bound.')
      return
    }
    worker.postMessage(message, [message.buffer])
  })

  worker.setMessageHandler((value) => {
    const message = readWriterOutboundMessage(value)
    if (!message) {
      fail('Malformed recording writer message.')
      return
    }
    if (message.generation !== options.generation || message.sessionId !== options.sessionId) return
    if (message.type === 'ready') {
      if (state !== 'starting') return fail('Unexpected recording writer ready message.')
      state = 'open'
      ready.resolve()
      return
    }
    if (message.type === 'return') {
      if (queuedBlocks === 0 || (state !== 'open' && state !== 'closing')) {
        fail('Unexpected recording buffer return.')
        return
      }
      queuedBlocks -= 1
      options.worklet.postMessage(message, [message.buffer])
      if (state === 'closing' && requestedTerminal === 'finalized' && workletComplete && queuedBlocks === 0) {
        worker.postMessage({
          type: 'finalize',
          generation: options.generation,
          sessionId: options.sessionId,
        })
      }
      return
    }
    if (message.type === 'failure') {
      fail(message.reason)
      return
    }
    if (state !== 'closing' || !requestedTerminal) {
      fail('Unexpected recording writer terminal response.')
      return
    }
    if (message.type !== requestedTerminal) {
      fail(`Recording writer ${message.type} after ${requestedTerminal === 'finalized' ? 'finalize' : 'abort'} was requested.`)
      return
    }
    if (message.type === 'finalized' && (!workletComplete || queuedBlocks !== 0)) {
      fail('Recording writer completed with queued blocks.')
      return
    }
    writerTerminal = true
    settleCompletion()
  })

  const startMessage: WriterInboundMessage = {
    type: 'start',
    generation: options.generation,
    sessionId: options.sessionId,
    sampleRate: options.sampleRate,
    channelCount: options.channelCount,
  }
  worker.postMessage(startMessage)

  const finish = async (type: 'finalize' | 'abort') => {
    if (state === 'starting') await ready.promise
    if (state !== 'open') throw new Error('Recording transport is not open.')
    state = 'closing'
    completion = deferred()
    requestedTerminal = type === 'finalize' ? 'finalized' : 'aborted'
    if (type === 'finalize') {
      options.worklet.postMessage({
        type: 'finalize',
        generation: options.generation,
        sessionId: options.sessionId,
      })
    } else {
      worker.postMessage({
        type,
        generation: options.generation,
        sessionId: options.sessionId,
      })
    }
    await completion.promise
  }

  return {
    ready: ready.promise,
    finalize: () => finish('finalize'),
    abort: () => finish('abort'),
    terminate,
  }
}

const createBrowserRecordingWriter = (): WorkerEndpoint => {
  const worker = new Worker(new URL('../../workers/recording-writer-worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, [...transfer]),
    setMessageHandler: (handler) => {
      worker.onmessage = (event: MessageEvent<unknown>) => handler(event.data)
    },
    terminate: () => worker.terminate(),
  }
}
