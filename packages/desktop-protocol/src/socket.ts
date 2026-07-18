import { desktopFrameSchemaV1, maxDesktopFrameBytes, type DesktopFrameV1 } from "./index"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const encodeDesktopFrame = (frame: DesktopFrameV1): Uint8Array => {
  const payload = encoder.encode(JSON.stringify(frame))
  if (payload.byteLength > maxDesktopFrameBytes) throw new Error("Desktop frame exceeds the size limit.")
  const result = new Uint8Array(payload.byteLength + 4)
  new DataView(result.buffer).setUint32(0, payload.byteLength)
  result.set(payload, 4)
  return result
}

export const createDesktopFrameDecoder = (onFrame: (frame: DesktopFrameV1) => void) => {
  let buffered = new Uint8Array()
  return (chunk: Uint8Array) => {
    const merged = new Uint8Array(buffered.byteLength + chunk.byteLength)
    merged.set(buffered)
    merged.set(chunk, buffered.byteLength)
    buffered = merged
    while (buffered.byteLength >= 4) {
      const size = new DataView(buffered.buffer, buffered.byteOffset, 4).getUint32(0)
      if (size > maxDesktopFrameBytes) throw new Error("Desktop frame exceeds the size limit.")
      if (buffered.byteLength < size + 4) return
      let value: unknown
      try {
        value = JSON.parse(decoder.decode(buffered.subarray(4, size + 4)))
      } catch {
        throw new Error("Desktop frame is not JSON.")
      }
      onFrame(desktopFrameSchemaV1.parse(value))
      buffered = buffered.slice(size + 4)
    }
  }
}
