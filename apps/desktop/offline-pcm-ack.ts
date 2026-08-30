import type { OfflinePcmAck } from "./offline-pcm-protocol"
import type { NativeOfflinePcmChunk } from "@daw-browser/audio-engine/native-host-wire"

type OfflinePcmAckExpectation = {
  jobId: string
  sequence: number
  endFrame: number
}

type PendingOfflinePcmAck = OfflinePcmAckExpectation & {
  resolve: () => void
  reject: (error: Error) => void
}

export type OfflinePcmAckTracker = {
  begin(expected: OfflinePcmAckExpectation): Promise<void>
  acknowledge(value: OfflinePcmAck): boolean
  cancel(error: Error): void
  hasPending(): boolean
}

export const deliverOfflinePcmChunk = async (
  jobId: string,
  sequence: number,
  chunk: NativeOfflinePcmChunk,
  listener: (chunk: NativeOfflinePcmChunk) => void | Promise<void>,
  sendAck: (ack: OfflinePcmAck) => void,
) => {
  const ack: OfflinePcmAck = {
    jobId,
    sequence,
    endFrame: chunk.startFrame + chunk.frameCount,
  }
  await listener(chunk)
  sendAck(ack)
}

export const createOfflinePcmAckTracker = (): OfflinePcmAckTracker => {
  let pending: PendingOfflinePcmAck | undefined

  return {
    begin(expected) {
      if (pending) throw new Error("An offline PCM acknowledgement is already pending.")
      const deferred = Promise.withResolvers<void>()
      pending = { ...expected, resolve: deferred.resolve, reject: deferred.reject }
      return deferred.promise
    },
    acknowledge(value) {
      if (!pending
        || pending.jobId !== value.jobId
        || pending.sequence !== value.sequence
        || pending.endFrame !== value.endFrame) return false
      const current = pending
      pending = undefined
      current.resolve()
      return true
    },
    cancel(error) {
      const current = pending
      pending = undefined
      current?.reject(error)
    },
    hasPending: () => pending !== undefined,
  }
}
