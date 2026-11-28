import {
  readWriterOutboundMessage,
  type WriterInboundMessage,
  type WriterOutboundMessage,
} from '../../../packages/audio-engine/src/recording/recording-protocol'

export type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export const deferred = <T = void>(): Deferred<T> => {
  let resolve = (_value: T) => {}
  let reject = (_error: Error) => {}

  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })

  return { promise, resolve, reject }
}

export const createRecordingWriterWorker = (): Worker =>
  new Worker(new URL('../../workers/recording-writer-worker.ts', import.meta.url), { type: 'module' })

export type RecordingWriterEndpoint = {
  postMessage: (message: WriterInboundMessage, transfer?: readonly ArrayBuffer[]) => void
  setMessageHandler: (handler: (message: WriterOutboundMessage | null) => void) => void
  terminate: () => void
}

export const createBrowserRecordingWriter = (): RecordingWriterEndpoint => {
  const worker = createRecordingWriterWorker()

  return {
    postMessage: (message, transfer = []) => worker.postMessage(message, [...transfer]),
    setMessageHandler: (handler) => {
      worker.onmessage = (event: MessageEvent<unknown>) => handler(readWriterOutboundMessage(event.data))
    },
    terminate: () => worker.terminate(),
  }
}
