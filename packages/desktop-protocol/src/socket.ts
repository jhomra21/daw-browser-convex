import { desktopFrameSchema, maxDesktopFrameBytes, type DesktopFrame } from "./index"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export const desktopFrameHeaderBytes = 4

export const encodeDesktopFrame = (frame: DesktopFrame): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(frame))
  if (payload.byteLength > maxDesktopFrameBytes) throw new Error("Desktop frame exceeds the size limit.")
  const result = new Uint8Array(payload.byteLength + desktopFrameHeaderBytes)
  new DataView(result.buffer).setUint32(0, payload.byteLength)
  result.set(payload, desktopFrameHeaderBytes)
  return result
}

export const createDesktopFrameDecoder = (
  onFrame: (frame: DesktopFrame, encodedFrameByteLength: number) => void,
) => {
  let buffered = new Uint8Array()
  return (chunk: Uint8Array) => {
    const merged = new Uint8Array(buffered.byteLength + chunk.byteLength)
    merged.set(buffered)
    merged.set(chunk, buffered.byteLength)
    buffered = merged
    while (buffered.byteLength >= desktopFrameHeaderBytes) {
      const size = new DataView(buffered.buffer, buffered.byteOffset, desktopFrameHeaderBytes).getUint32(0)
      if (size > maxDesktopFrameBytes) throw new Error("Desktop frame exceeds the size limit.")
      if (buffered.byteLength < size + desktopFrameHeaderBytes) return
      let value: unknown
      try {
        value = JSON.parse(decoder.decode(buffered.subarray(desktopFrameHeaderBytes, size + desktopFrameHeaderBytes)))
      } catch {
        throw new Error("Desktop frame is not JSON.")
      }
      onFrame(desktopFrameSchema.parse(value), size + desktopFrameHeaderBytes)
      buffered = buffered.slice(size + desktopFrameHeaderBytes)
    }
  }
}
