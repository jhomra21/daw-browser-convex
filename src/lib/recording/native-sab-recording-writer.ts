import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_QUEUED_BLOCKS,
  readWriterOutboundMessage,
  type WriterInboundMessage,
  type WriterOutboundMessage,
} from '../../../packages/audio-engine/src/recording/recording-protocol'
import {
  createRecorderSabRingBuffers,
  createRecorderSabRingProducer,
} from '../../../packages/audio-engine/src/recording/sab-ring-buffer'

type WorkerEndpoint = {
  postMessage: (message: WriterInboundMessage) => void
  setMessageHandler: (handler: (message: WriterOutboundMessage | null) => void) => void
  setErrorHandler?: (handler: (error: Error) => void) => void
  terminate: () => void
}

export const benchmarkWorkerAssetUrl = (asset: URL, page: URL) => (
  asset.protocol === 'daw:' && asset.hostname === 'app'
  && page.protocol === 'daw:' && page.hostname === 'app'
)

const deferred = <T>() => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export const createNativeSabRecordingWriter = (input: {
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
  worker?: WorkerEndpoint
  timeoutMs?: number
  onFailure?: (error: Error) => void
}) => {
  const buffers = createRecorderSabRingBuffers()
  const producer = createRecorderSabRingProducer(buffers, RECORDER_MAX_QUEUED_BLOCKS)
  const worker = input.worker ?? createBrowserWorker()
  const ready = deferred<void>()
  let pending: ReturnType<typeof deferred<{ capturedFrames: number }>> | undefined
  let state: 'starting' | 'open' | 'closing' | 'closed' = 'starting'
  let terminal: 'finalize' | 'abort' | undefined
  let booted = false
  let expectedSequence = 0
  let deadline: ReturnType<typeof setTimeout> | undefined
  const clearDeadline = () => { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined }
  const fail = (message: string) => {
    if (state === 'closed') return
    state = 'closed'
    clearDeadline()
    const error = new Error(message)
    ready.reject(error)
    pending?.reject(error)
    pending = undefined
    worker.terminate()
    input.onFailure?.(error)
  }
  const armDeadline = (phase: string) => {
    // The atomic read index bounds queued blocks, but append or finalization can stall after pop.
    deadline = setTimeout(() => fail(`Native SAB writer ${phase === 'startup' && booted ? 'storage startup' : phase} timed out.`), input.timeoutMs ?? 2_000)
  }
  worker.setMessageHandler((value) => {
    const message = readWriterOutboundMessage(value)
    if (!message) return fail('Malformed native SAB writer response.')
    if (message.generation !== input.generation || message.sessionId !== input.sessionId || state === 'closed') return
    if (message.type === 'failure') return fail(message.reason)
    if (message.type === 'boot' && state === 'starting' && !booted) {
      booted = true
      return
    }
    if (message.type === 'ready' && state === 'starting') {
      clearDeadline()
      state = 'open'
      ready.resolve()
      return
    }
    if (state === 'closing' && pending &&
      ((terminal === 'finalize' && message.type === 'finalized') || (terminal === 'abort' && message.type === 'aborted'))) {
      clearDeadline()
      state = 'closed'
      const completion = pending
      pending = undefined
      worker.terminate()
      completion.resolve({ capturedFrames: message.type === 'finalized' ? message.capturedFrames : 0 })
      return
    }
    fail('Unexpected native SAB writer response.')
  })
  worker.setErrorHandler?.((error) => fail(`Native SAB writer ${error.message}.`))
  armDeadline('startup')
  worker.postMessage({
    type: 'start-sab', generation: input.generation, sessionId: input.sessionId,
    sampleRate: input.sampleRate, channelCount: input.channelCount,
    ...buffers,
  })

  const write = (block: {
    sequence: number
    frameCount: number
    channelCount: number
    planes: readonly Float32Array[]
  }) => {
    if (state !== 'open' || block.sequence !== expectedSequence || block.channelCount !== input.channelCount ||
      block.planes.length !== input.channelCount || !Number.isInteger(block.frameCount) ||
      block.frameCount < 1 || block.frameCount > RECORDER_BLOCK_FRAMES ||
      block.planes.some((plane) => plane.length !== block.frameCount)) {
      fail('Invalid native SAB recording block.')
      throw new Error('Invalid native SAB recording block.')
    }
    const wasEmpty = producer.stats().occupancy === 0
    if (producer.stats().occupancy >= RECORDER_MAX_QUEUED_BLOCKS) {
      fail('Native SAB recording writer exceeded its hard bound.')
      throw new Error('Native SAB recording writer exceeded its hard bound.')
    }
    if (!producer.push(block.planes, block.frameCount)) {
      fail('Native SAB recording writer exceeded its hard bound.')
      throw new Error('Native SAB recording writer exceeded its hard bound.')
    }
    expectedSequence += 1
    // The notification wakes waitAsync consumers; this one message also wakes
    // workers without waitAsync when the ring transitions from empty.
    if (wasEmpty) worker.postMessage({
      type: 'wake', generation: input.generation, sessionId: input.sessionId,
    })
  }
  const finish = async (type: 'finalize' | 'abort', capturedFrames?: number) => {
    await ready.promise
    if (state !== 'open') throw new Error('Native SAB writer is not open.')
    state = 'closing'
    terminal = type
    pending = deferred<{ capturedFrames: number }>()
    armDeadline(type)
    if (type === 'finalize') {
      worker.postMessage({
        type, generation: input.generation, sessionId: input.sessionId, capturedFrames,
      })
    } else {
      worker.postMessage({ type, generation: input.generation, sessionId: input.sessionId })
    }
    return pending.promise
  }
  return {
    ready: ready.promise,
    write,
    finalize: (capturedFrames: number) => finish('finalize', capturedFrames),
    abort: () => finish('abort').then(() => undefined),
    terminate: () => fail('Native SAB writer terminated.'),
    stats: producer.stats,
  }
}

export const createBrowserWorker = (injected?: Worker, onTerminate?: () => void): WorkerEndpoint => {
  const worker = injected ?? new Worker(new URL('../../workers/recording-writer-worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage: (message) => worker.postMessage(message),
    setMessageHandler: (handler) => { worker.onmessage = (event: MessageEvent<unknown>) => handler(readWriterOutboundMessage(event.data)) },
    setErrorHandler: (handler) => {
      worker.onerror = (event) => {
        // Worker source locations and exception bodies may contain private paths.
        const category = /SecurityError|ReferenceError|SyntaxError|TypeError|NetworkError/.exec(event.message)?.[0]
          ?? (event.error instanceof Error && /^(SecurityError|ReferenceError|SyntaxError|TypeError|NetworkError)$/.test(event.error.name)
            ? event.error.name : 'unknown')
        const source = /\/(recording-writer-worker-[\w-]+\.js)$/.exec(event.filename)?.[1] ?? 'unavailable'
        const line = Number.isSafeInteger(event.lineno) ? event.lineno : 0
        const column = Number.isSafeInteger(event.colno) ? event.colno : 0
        handler(new Error(`worker-load-failed:${category}:${source}:${line}:${column}`))
      }
      worker.onmessageerror = () => handler(new Error('worker-message-failed'))
    },
    terminate: () => { worker.terminate(); onTerminate?.() },
  }
}
