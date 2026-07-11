/// <reference lib="webworker" />

import { createRecordingTempStorage } from '../lib/recording/recording-temp-storage'
import { createRecordingWriterHandler } from '../lib/recording/recording-writer-core'

declare const self: DedicatedWorkerGlobalScope

const handler = createRecordingWriterHandler(
  createRecordingTempStorage(),
  (message, transfer = []) => self.postMessage(message, [...transfer]),
)

self.onmessage = (event: MessageEvent<unknown>) => handler.handle(event.data)
