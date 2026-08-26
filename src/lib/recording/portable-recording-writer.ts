import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_QUEUED_BLOCKS,
  readWriterOutboundMessage,
  type RecorderBlockMessage,
  type WriterInboundMessage,
  type WriterOutboundMessage,
} from '@daw-browser/audio-engine/recording-protocol'
import type { PortableWasmStatusMessage } from '@daw-browser/audio-engine/portable-wasm-protocol'

type WorkerEndpoint = {
  postMessage: (message: WriterInboundMessage, transfer?: readonly ArrayBuffer[]) => void
  setMessageHandler: (handler: (message: WriterOutboundMessage | null) => void) => void
  terminate: () => void
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

const deferred = <T = void>(): Deferred<T> => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const portableRecordingWriterTimeoutMs = 2_000

export const createPortableRecordingWriter = (input: {
  generation: number
  sessionId: string
  sampleRate: number
  channelCount: number
  worker?: WorkerEndpoint
  onQueuedFrames?: (frames: number) => void
  timeoutMs?: number
}) => {
  const worker = input.worker ?? createBrowserRecordingWriter()
  const bufferBytes = RECORDER_BLOCK_FRAMES * input.channelCount * Float32Array.BYTES_PER_ELEMENT
  const available = Array.from(
    { length: RECORDER_MAX_QUEUED_BLOCKS },
    () => new ArrayBuffer(bufferBytes),
  )
  const queuedFrameCounts: number[] = []
  let queuedFrames = 0
  let state: 'starting' | 'open' | 'closing' | 'closed' | 'failed' = 'starting'
  let nextBlockId = 0
  const ready = deferred()
  let completion: Deferred<{ capturedFrames: number }> | undefined
  let requestedCapturedFrames = 0
  let terminalRequest: 'finalize' | 'abort' | undefined
  let terminalMessageSent = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = input.timeoutMs ?? portableRecordingWriterTimeoutMs

  const clearDeadline = () => {
    if (deadline === undefined) return
    clearTimeout(deadline)
    deadline = undefined
  }

  const fail = (message: string) => {
    if (state === 'closed' || state === 'failed') return
    clearDeadline()
    state = 'failed'
    const error = new Error(message)
    ready.reject(error)
    completion?.reject(error)
    completion = undefined
    worker.terminate()
  }

  const requestWriterFinalize = () => {
    if (state !== 'closing' || queuedFrameCounts.length !== 0 || terminalMessageSent) return
    terminalMessageSent = true
    deadline = setTimeout(() => fail('Portable recording writer finalization timed out.'), timeoutMs)
    worker.postMessage({
      type: 'finalize',
      generation: input.generation,
      sessionId: input.sessionId,
      capturedFrames: requestedCapturedFrames,
    } satisfies WriterInboundMessage)
  }

  worker.setMessageHandler((message) => {
    if (!message) {
      fail('Malformed portable recording writer message.')
      return
    }
    if (message.generation !== input.generation || message.sessionId !== input.sessionId) return
    if (message.type === 'ready') {
      if (state !== 'starting') return fail('Unexpected portable recording writer ready message.')
      clearDeadline()
      state = 'open'
      ready.resolve()
      return
    }
    if (message.type === 'return') {
      if ((state !== 'open' && state !== 'closing') || queuedFrameCounts.length === 0) {
        fail('Unexpected portable recording buffer return.')
        return
      }
      available.push(message.buffer)
      queuedFrames -= queuedFrameCounts.shift()!
      input.onQueuedFrames?.(queuedFrames)
      requestWriterFinalize()
      return
    }
    if (message.type === 'failure') {
      fail(message.reason)
      return
    }
    if (state !== 'closing' || !completion) {
      fail('Unexpected portable recording writer terminal response.')
      return
    }
    if ((terminalRequest === 'finalize' && message.type !== 'finalized')
      || (terminalRequest === 'abort' && message.type !== 'aborted')) {
      fail('Portable recording writer returned the wrong terminal response.')
      return
    }
    const pending = completion
    clearDeadline()
    completion = undefined
    terminalRequest = undefined
    terminalMessageSent = false
    state = 'closed'
    worker.terminate()
    pending.resolve({ capturedFrames: message.type === 'finalized' ? message.capturedFrames : 0 })
  })

  deadline = setTimeout(() => fail('Portable recording writer startup timed out.'), timeoutMs)
  worker.postMessage({
    type: 'start',
    generation: input.generation,
    sessionId: input.sessionId,
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
  } satisfies WriterInboundMessage)

  const write = (block: Extract<PortableWasmStatusMessage, { type: 'recording-capture-block' }>) => {
    if (state !== 'open' || block.channelCount !== input.channelCount || block.planes.length !== input.channelCount) {
      throw new Error('Portable recording block arrived outside an open compatible session.')
    }
    const buffer = available.pop()
    if (!buffer) throw new Error('Portable recording writer queue exceeded its hard bound.')
    const samples = new Float32Array(buffer)
    for (let channel = 0; channel < input.channelCount; channel += 1) {
      const plane = block.planes[channel]
      if (!plane || plane.length !== block.frameCount) {
        available.push(buffer)
        throw new Error('Portable recording block payload is invalid.')
      }
      samples.set(plane, channel * RECORDER_BLOCK_FRAMES)
    }
    const message: RecorderBlockMessage = {
      type: 'block',
      generation: input.generation,
      sessionId: input.sessionId,
      blockId: nextBlockId,
      sequence: block.sequence,
      frameCount: block.frameCount,
      channelCount: block.channelCount,
      buffer,
    }
    nextBlockId += 1
    queuedFrameCounts.push(block.frameCount)
    queuedFrames += block.frameCount
    input.onQueuedFrames?.(queuedFrames)
    worker.postMessage(message, [buffer])
  }

  const finalize = async (capturedFrames: number) => {
    await ready.promise
    if (state !== 'open') throw new Error('Portable recording writer is not open.')
    state = 'closing'
    terminalRequest = 'finalize'
    terminalMessageSent = false
    requestedCapturedFrames = capturedFrames
    completion = deferred<{ capturedFrames: number }>()
    requestWriterFinalize()
    return completion.promise
  }

  const abort = (): Promise<void> => {
    if (state === 'starting') return ready.promise.then(abort, () => undefined)
    if (state !== 'open') return Promise.resolve()
    state = 'closing'
    terminalRequest = 'abort'
    terminalMessageSent = true
    completion = deferred<{ capturedFrames: number }>()
    deadline = setTimeout(() => fail('Portable recording writer abort timed out.'), timeoutMs)
    worker.postMessage({
      type: 'abort',
      generation: input.generation,
      sessionId: input.sessionId,
    } satisfies WriterInboundMessage)
    return completion.promise.then(() => undefined, () => undefined)
  }

  const terminate = () => {
    if (state === 'closed' || state === 'failed') return
    clearDeadline()
    const error = new Error('Portable recording writer terminated.')
    ready.reject(error)
    completion?.reject(error)
    completion = undefined
    terminalRequest = undefined
    terminalMessageSent = false
    state = 'closed'
    worker.terminate()
  }

  return { ready: ready.promise, write, finalize, abort, terminate }
}

const createBrowserRecordingWriter = (): WorkerEndpoint => {
  const worker = new Worker(new URL('../../workers/recording-writer-worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, [...transfer]),
    setMessageHandler: (handler) => {
      worker.onmessage = (event: MessageEvent<unknown>) => handler(readWriterOutboundMessage(event.data))
    },
    terminate: () => worker.terminate(),
  }
}
