import {
  RECORDER_BLOCK_FRAMES,
  RECORDER_MAX_QUEUED_BLOCKS,
  readWriterInboundMessage,
  type RecorderBlockMessage,
  type WriterOutboundMessage,
} from '../../../packages/audio-engine/src/recording/recording-protocol'
import {
  createRecorderSabRingConsumer,
  type RecorderSabRingBuffers,
} from '../../../packages/audio-engine/src/recording/sab-ring-buffer'

type WriterSession = {
  append: (channels: readonly Float32Array[]) => Promise<void>
  appendPlanar?: (buffer: ArrayBuffer, frameCount: number) => Promise<void>
  finalize: () => Promise<{ capturedFrames: number }>
  abort: () => Promise<void>
}

export type RecordingWriterStorage = {
  createSession: (input: {
    sessionId: string
    sampleRate: number
    channelCount: number
  }) => Promise<WriterSession>
}

type RecordingWriterOutput = (message: WriterOutboundMessage, transfer?: readonly ArrayBuffer[]) => void

export const createRecordingWriterHandler = (
  storage: RecordingWriterStorage,
  output: RecordingWriterOutput,
) => {
  let generation = -1
  let sessionId = ''
  let session: WriterSession | null = null
  let state: 'idle' | 'open' | 'closing' | 'closed' | 'failed' = 'idle'
  let queuedBlocks = 0
  let expectedSequence = 0
  let operations = Promise.resolve()
  let failureCleanup: Promise<void> | null = null
  let canonicalChannelCount = 0
  let abortScheduled = false
  let sabConsumer: ReturnType<typeof createRecorderSabRingConsumer> | null = null
  const hasFailed = () => state === 'failed'

  const transitionToFailure = (reason: string) => {
    if (state === 'failed' || state === 'closed') return
    state = 'failed'
    if (abortScheduled) return
    abortScheduled = true
    failureCleanup = operations.then(async () => {
      queuedBlocks = 0
      try {
        await session?.abort()
      } catch {
        // Preserve the originating failure after cleanup has settled.
      }
      output({ type: 'failure', generation: Math.max(generation, 0), sessionId, reason })
    }).catch(() => {
      queuedBlocks = 0
    })
  }

  const appendBlock = async (message: RecorderBlockMessage) => {
    if (!session) throw new Error('recording-session-not-open')
    if (hasFailed()) return
    if (message.sequence !== expectedSequence) throw new Error('recording-block-out-of-order')
    if (message.channelCount !== canonicalChannelCount) throw new Error('recording-channel-layout-mismatch')
    expectedSequence += 1
    if (session.appendPlanar) {
      await session.appendPlanar(message.buffer, message.frameCount)
    } else {
      const planar = new Float32Array(message.buffer)
      const channels: Float32Array[] = []
      for (let channel = 0; channel < message.channelCount; channel += 1) {
        channels.push(planar.subarray(channel * RECORDER_BLOCK_FRAMES, channel * RECORDER_BLOCK_FRAMES + message.frameCount))
      }
      await session.append(channels)
    }
    if (hasFailed()) return
    output({
      type: 'return',
      generation,
      sessionId,
      blockId: message.blockId,
      buffer: message.buffer,
    }, [message.buffer])
  }

  const drainSab = async () => {
    if (!sabConsumer || !session) return
    while (true) {
      const block = sabConsumer.pop()
      if (!block) return
      if (block.sequence !== expectedSequence) throw new Error('recording-block-out-of-order')
      expectedSequence += 1
      await session.append(block.channels)
      if (hasFailed()) return
    }
  }

  const scheduleSabDrain = () => {
    operations = operations.then(drainSab).catch((error) => {
      transitionToFailure(error instanceof Error ? error.message : 'write-failed')
    })
  }

  const waitForSabData = async () => {
    while (state === 'open') {
      await sabConsumer?.waitForData()
      if (state !== 'open') return
      scheduleSabDrain()
      await operations
    }
  }

  const handle = <Message,>(value: Message) => {
    const message = readWriterInboundMessage(value)
    if (!message) {
      transitionToFailure('malformed-message')
      return
    }
    if (message.type === 'start' || message.type === 'start-sab') {
      if (state !== 'idle') {
        transitionToFailure('duplicate-start')
        return
      }
      generation = message.generation
      sessionId = message.sessionId
      canonicalChannelCount = message.channelCount
      if (message.type === 'start-sab') {
        const buffers: RecorderSabRingBuffers = {
          state: message.state,
          frameCounts: message.frameCounts,
          samples: message.samples,
        }
        try {
          sabConsumer = createRecorderSabRingConsumer(buffers, message.channelCount)
        } catch (error) {
          transitionToFailure(error instanceof Error ? error.message : 'invalid-sab-configuration')
          return
        }
      }
      state = 'closing'
      operations = storage.createSession(message).then((created) => {
        session = created
        if (hasFailed()) return
        state = 'open'
        output({ type: 'ready', generation, sessionId })
        if (sabConsumer && 'waitAsync' in Atomics) {
          void waitForSabData()
        }
      }).catch((error) => transitionToFailure(error instanceof Error ? error.message : 'start-failed'))
      return
    }
    if (message.generation !== generation || message.sessionId !== sessionId) return
    if (message.type === 'wake') {
      if (state === 'open' && sabConsumer) scheduleSabDrain()
      return
    }
    if (message.type === 'block') {
      if (state !== 'open' || message.channelCount < 1) {
        transitionToFailure('recording-session-not-open')
        return
      }
      if (message.channelCount !== canonicalChannelCount) {
        transitionToFailure('recording-channel-layout-mismatch')
        return
      }
      queuedBlocks += 1
      if (queuedBlocks > RECORDER_MAX_QUEUED_BLOCKS) {
        queuedBlocks -= 1
        transitionToFailure('writer-queue-overflow')
        return
      }
      operations = operations.then(async () => {
        try {
          await appendBlock(message)
        } catch (error: unknown) {
          transitionToFailure(error instanceof Error ? error.message : 'write-failed')
        } finally {
          queuedBlocks -= 1
        }
      })
      return
    }
    if (message.type === 'finalize') {
      if (state !== 'open') {
        transitionToFailure('recording-session-not-open')
        return
      }
      state = 'closing'
      sabConsumer?.notify()
      operations = operations.then(drainSab).then(async () => {
        if (hasFailed()) return
        if (!session) throw new Error('recording-session-not-open')
        const stats = sabConsumer?.stats()
        if (stats && (stats.droppedFrames > 0 || stats.droppedBlocks > 0)) {
          throw new Error('recorder-overrun')
        }
        const descriptor = await session.finalize()
        if (hasFailed()) return
        if (
          message.capturedFrames !== undefined &&
          descriptor.capturedFrames !== message.capturedFrames
        ) throw new Error('Recording SAB captured frame count mismatch.')
        state = 'closed'
        output({ type: 'finalized', generation, sessionId, capturedFrames: descriptor.capturedFrames })
      }).catch((error) => transitionToFailure(error instanceof Error ? error.message : 'finalize-failed'))
      return
    }
    if (state === 'closed' || state === 'failed') return
    state = 'closing'
    operations = operations.then(async () => {
      if (hasFailed()) return
      await session?.abort()
      if (hasFailed()) return
      state = 'closed'
      output({ type: 'aborted', generation, sessionId })
    }).catch((error) => transitionToFailure(error instanceof Error ? error.message : 'abort-failed'))
  }

  return {
    handle,
    testing: {
      settled: async () => {
        await operations
        await failureCleanup
      },
      snapshot: () => ({ state, queuedBlocks }),
    },
  }
}
