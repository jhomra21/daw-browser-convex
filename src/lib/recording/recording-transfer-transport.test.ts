import { describe, expect, test } from 'bun:test'
import { createRecordingTransferTransport } from './recording-transfer-transport'

const endpoint = (transferMessages = false) => {
  let handler = (_message: unknown) => {}
  const messages: unknown[] = []
  return {
    messages,
    postMessage: (message: unknown, transfer: readonly ArrayBuffer[] = []) => {
      messages.push(transferMessages ? structuredClone(message, { transfer: [...transfer] }) : message)
    },
    setMessageHandler: (next: (message: unknown) => void) => {
      handler = next
    },
    receive: (message: unknown) => handler(message),
  }
}

describe('recording transfer transport', () => {
  test('finalizes only after worklet completion and the final returned block', async () => {
    const worklet = endpoint(true)
    const worker = endpoint(true)
    let terminations = 0
    const queuedFrames: number[] = []
    const transport = createRecordingTransferTransport({
      generation: 2,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      onDiagnostics: (diagnostics) => queuedFrames.push(diagnostics.queuedFrames),
      worker: { ...worker, terminate: () => {
        terminations += 1
      } },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'old' })
    worker.receive({ type: 'ready', generation: 2, sessionId: 'take' })
    await transport.ready
    const buffer = new ArrayBuffer(2048 * Float32Array.BYTES_PER_ELEMENT)
    worklet.receive({
      type: 'block',
      generation: 2,
      sessionId: 'take',
      blockId: 0,
      sequence: 0,
      frameCount: 1,
      channelCount: 1,
      buffer,
    })
    expect(queuedFrames).toEqual([1])
    expect(buffer.byteLength).toBe(0)
    const finishing = transport.finalize()
    expect(worklet.messages.at(-1)).toMatchObject({ type: 'finalize' })
    const transferredBlock = worker.messages.at(-1)
    if (
      typeof transferredBlock !== 'object' ||
      transferredBlock === null ||
      !('buffer' in transferredBlock) ||
      !(transferredBlock.buffer instanceof ArrayBuffer)
    ) throw new Error('Missing transferred recorder block.')
    worklet.receive({
      type: 'complete',
      generation: 2,
      sessionId: 'take',
      capturedFrames: 1,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    expect(worker.messages.at(-1)).not.toMatchObject({ type: 'finalize' })
    worker.receive({ type: 'return', generation: 2, sessionId: 'take', blockId: 0, buffer: transferredBlock.buffer })
    expect(queuedFrames).toEqual([1, 0])
    expect(transferredBlock.buffer.byteLength).toBe(0)
    expect(worker.messages.at(-1)).toMatchObject({ type: 'finalize' })
    worker.receive({ type: 'finalized', generation: 2, sessionId: 'take', capturedFrames: 1 })
    await expect(finishing).resolves.toEqual({ capturedFrames: 1 })
    expect(terminations).toBe(1)
    expect(worklet.messages.at(-1)).toMatchObject({ type: 'return', blockId: 0 })
  })

  test('aborts when the writer confirms the requested abort', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    let terminations = 0
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => {
        terminations += 1
      } },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'take' })
    await transport.ready
    const aborting = transport.abort()
    expect(worker.messages.at(-1)).toMatchObject({ type: 'abort' })
    worker.receive({ type: 'aborted', generation: 1, sessionId: 'take' })
    await aborting
    expect(terminations).toBe(1)
  })

  test('rejects finalize when the writer reports aborted', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => undefined },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'take' })
    await transport.ready
    const finishing = transport.finalize()
    worker.receive({ type: 'aborted', generation: 1, sessionId: 'take' })
    await expect(finishing).rejects.toThrow('Recording writer aborted after finalize was requested.')
  })

  test('rejects abort when the writer reports finalized', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => undefined },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'take' })
    await transport.ready
    const aborting = transport.abort()
    worker.receive({ type: 'finalized', generation: 1, sessionId: 'take', capturedFrames: 0 })
    await expect(aborting).rejects.toThrow('Recording writer finalized after abort was requested.')
  })

  test('terminates deterministically on malformed worker output', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    let terminations = 0
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => {
        terminations += 1
      } },
    })
    worker.receive({ malformed: true })
    await expect(transport.ready).rejects.toThrow('Malformed recording writer message.')
    expect(terminations).toBe(1)
  })

  test('propagates worklet failure and rejects completion', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => undefined },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'take' })
    await transport.ready
    const finishing = transport.finalize()
    worklet.receive({
      type: 'failure',
      generation: 1,
      sessionId: 'take',
      reason: 'recorder-overrun',
      capturedFrames: 0,
      droppedFrames: 1,
      droppedBlocks: 1,
    })
    await expect(finishing).rejects.toThrow('recorder-overrun')
  })

  test('terminate settles startup, capture, and closing promises', async () => {
    const startupWorklet = endpoint()
    const startupWorker = endpoint()
    const startup = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'startup',
      sampleRate: 48000,
      channelCount: 1,
      worklet: startupWorklet,
      worker: { ...startupWorker, terminate: () => undefined },
    })
    startup.terminate()
    await expect(startup.ready).rejects.toThrow('terminated')

    const openWorklet = endpoint()
    const openWorker = endpoint()
    const open = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'open',
      sampleRate: 48000,
      channelCount: 1,
      worklet: openWorklet,
      worker: { ...openWorker, terminate: () => undefined },
    })
    openWorker.receive({ type: 'ready', generation: 1, sessionId: 'open' })
    await open.ready
    open.terminate()
    await expect(open.finalize()).rejects.toThrow('not open')

    const closingWorklet = endpoint()
    const closingWorker = endpoint()
    const closing = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'closing',
      sampleRate: 48000,
      channelCount: 1,
      worklet: closingWorklet,
      worker: { ...closingWorker, terminate: () => undefined },
    })
    closingWorker.receive({ type: 'ready', generation: 1, sessionId: 'closing' })
    await closing.ready
    const finishing = closing.finalize()
    closing.terminate()
    await expect(finishing).rejects.toThrow('terminated')
  })

  test('rejects channel mismatch and blocks after completion', async () => {
    const worklet = endpoint()
    const worker = endpoint()
    const transport = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'take',
      sampleRate: 48000,
      channelCount: 1,
      worklet,
      worker: { ...worker, terminate: () => undefined },
    })
    worker.receive({ type: 'ready', generation: 1, sessionId: 'take' })
    await transport.ready
    worklet.receive({
      type: 'block',
      generation: 1,
      sessionId: 'take',
      blockId: 0,
      sequence: 0,
      frameCount: 1,
      channelCount: 2,
      buffer: new ArrayBuffer(2048 * 2 * Float32Array.BYTES_PER_ELEMENT),
    })
    await expect(transport.finalize()).rejects.toThrow('not open')

    const completeWorklet = endpoint()
    const completeWorker = endpoint()
    const complete = createRecordingTransferTransport({
      generation: 1,
      sessionId: 'complete',
      sampleRate: 48000,
      channelCount: 1,
      worklet: completeWorklet,
      worker: { ...completeWorker, terminate: () => undefined },
    })
    completeWorker.receive({ type: 'ready', generation: 1, sessionId: 'complete' })
    await complete.ready
    const finishing = complete.finalize()
    completeWorklet.receive({
      type: 'complete',
      generation: 1,
      sessionId: 'complete',
      capturedFrames: 0,
      droppedFrames: 0,
      droppedBlocks: 0,
    })
    completeWorklet.receive({
      type: 'block',
      generation: 1,
      sessionId: 'complete',
      blockId: 0,
      sequence: 0,
      frameCount: 1,
      channelCount: 1,
      buffer: new ArrayBuffer(2048 * Float32Array.BYTES_PER_ELEMENT),
    })
    await expect(finishing).rejects.toThrow('after completion')
  })
})
