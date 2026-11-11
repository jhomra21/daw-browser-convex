import { createRecordingTempStorage, decodePlanarPcmBlocks } from "./recording-temp-storage"
import type { NativeRecordingScope, NativeRecordingSpoolBridge, NativeRecordingTake, NativeRecordingImportedTake } from "~/types/desktop-bridge"

const verifyCanonicalFileSize = async (sessionId: string) => {
  const root = await navigator.storage.getDirectory()
  const recordings = await root.getDirectoryHandle("recording-sessions")
  const session = await recordings.getDirectoryHandle(sessionId)
  return (await (await session.getFileHandle("capture.pcm")).getFile()).size
}

// The native layout is the existing OPFS block format, including tightly packed
// short stereo tails. One <=1MiB chunk and one maximum partial block are retained;
// appends are awaited, never queued for an entire take.
export const importNativeRecordingSpool = async (input: {
  bridge: NativeRecordingSpoolBridge
  scope: NativeRecordingScope
  take: NativeRecordingTake
  sessionId: string
  expectedSampleRateHz: number
  isCurrent: () => boolean
  storage?: ReturnType<typeof createRecordingTempStorage>
  verifyFileSize?: (sessionId: string) => Promise<number>
}) => {
  const { take } = input
  const assertCurrent = () => { if (!input.isCurrent()) throw new Error("Recording import scope changed; recording source retained.") }
  assertCurrent()
  const frames = take.frames
  const bytes = take.bytes
  const blocks = take.blocks
  const sampleRate = take.sampleRateHz
  if (take.state !== "complete" || frames === null || bytes === null || blocks === null || sampleRate === null
    || !Number.isSafeInteger(frames) || frames < 0 || !Number.isSafeInteger(bytes) || bytes < 0
    || !Number.isSafeInteger(blocks) || blocks < 0 || !Number.isSafeInteger(sampleRate)
    || sampleRate < 8000 || sampleRate > 384000 || sampleRate !== input.expectedSampleRateHz
    || (take.channelCount !== 1 && take.channelCount !== 2)
    || !Number.isSafeInteger(4 * blocks + 4 * frames * take.channelCount)
    || bytes !== 4 * blocks + 4 * frames * take.channelCount
    || (frames === 0 ? blocks !== 0 : blocks < 1 || blocks > frames) || frames > blocks * 2048)
    throw new Error("Recording Complete format or totals mismatch; native source retained.")
  const storage = input.storage ?? createRecordingTempStorage()
  const session = await storage.createSession({ sessionId: input.sessionId, sampleRate, channelCount: take.channelCount })
  try {
    const partial = new Uint8Array(4 + 2048 * take.channelCount * 4)
    let partialBytes = 0
    let blockBytes = 4
    let offset = 0
    let parsedFrames = 0
    let parsedBlocks = 0
    while (offset < bytes) {
      assertCurrent()
      const length = Math.min(1048576, bytes - offset)
      const chunk = await input.bridge.read(input.scope, take.takeId, offset, length)
      assertCurrent()
      if (chunk.byteLength < 1 || chunk.byteLength > length) throw new Error("Recording source read was truncated or oversized.")
      offset += chunk.byteLength
      let cursor = 0
      while (cursor < chunk.byteLength) {
        const copied = Math.min(blockBytes - partialBytes, chunk.byteLength - cursor)
        partial.set(chunk.subarray(cursor, cursor + copied), partialBytes)
        cursor += copied
        partialBytes += copied
        if (partialBytes !== blockBytes) continue
        if (blockBytes === 4) {
          const frameCount = new DataView(partial.buffer).getUint32(0, true)
          if (frameCount < 1 || frameCount > 2048) throw new Error("Recording source block is malformed.")
          blockBytes = 4 + frameCount * take.channelCount * 4
          continue
        }
        const block = decodePlanarPcmBlocks(partial.subarray(0, blockBytes), take.channelCount)[0]
        if (!block) throw new Error("Recording source block is malformed.")
        parsedFrames += block.frameCount
        parsedBlocks += 1
        if (parsedFrames > frames || parsedBlocks > blocks) throw new Error("Recording source totals exceeded Complete proof.")
        assertCurrent()
        await session.append(block.channels)
        partialBytes = 0
        blockBytes = 4
      }
    }
    if (partialBytes !== 0 || parsedFrames !== frames || parsedBlocks !== blocks)
      throw new Error("Recording source frame/block/byte totals mismatch.")
    // EOF alone is not import success. Verify no extra source data, finalize via
    // the canonical writer, reopen its descriptor and inspect the actual file.
    assertCurrent()
    if ((await input.bridge.read(input.scope, take.takeId, bytes, 1)).byteLength !== 0)
      throw new Error("Recording source contains unexpected trailing data.")
    assertCurrent()
    const descriptor = await session.finalize()
    const canonical = await storage.open(input.sessionId)
    const size = await (input.verifyFileSize ?? verifyCanonicalFileSize)(input.sessionId)
    assertCurrent()
    if (!canonical || descriptor.version !== 1 || canonical.version !== 1
      || descriptor.format !== "planar-float32-blocks" || canonical.format !== descriptor.format
      || descriptor.sessionId !== input.sessionId || canonical.sessionId !== input.sessionId
      || descriptor.sampleRate !== sampleRate || canonical.sampleRate !== sampleRate
      || descriptor.channelCount !== take.channelCount || canonical.channelCount !== take.channelCount
      || descriptor.capturedFrames !== frames || canonical.capturedFrames !== frames
      || descriptor.byteLength !== bytes || canonical.byteLength !== bytes || size !== bytes
      || descriptor.finalizedAtMs === null || canonical.finalizedAtMs !== descriptor.finalizedAtMs
      || !Number.isSafeInteger(descriptor.finalizedAtMs) || descriptor.finalizedAtMs < descriptor.createdAtMs)
      throw new Error("Recording canonical finalized descriptor or file size mismatch.")
    const nativeTake: NativeRecordingImportedTake = { scope: { ...input.scope }, takeId: take.takeId,
      acknowledgment: { reason: "imported", sessionId: canonical.sessionId, frames, bytes, blocks,
        sampleRateHz: sampleRate, channelCount: take.channelCount, finalized: true } }
    // OPFS is temporary staging. WAV/asset/clip persistence may still fail or be
    // queued, so source ownership is handed to the per-take save path, not freed.
    return { ...canonical, nativeTake }
  } catch (error) {
    // Abort removes only this writer's unfinalized OPFS destination.
    // Finalized staging and the authoritative native source survive import failure.
    await session.abort().catch(() => undefined)
    throw error
  }
}
