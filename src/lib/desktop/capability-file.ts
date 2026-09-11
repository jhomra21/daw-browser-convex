import { desktopCapabilityMaximumChunkBytes } from '@daw-browser/desktop-protocol'

type CapabilityFileSource = {
  requestId: string
  token: string
  size: number
  readChunk: (requestId: string, token: string, offset: number, length: number) => Promise<Uint8Array>
  signal: AbortSignal
}

const capabilityFileMarker = Symbol("capability-file")

type CapabilityFileRange = {
  start: number
  end: number
}

const normalizeIndex = (value: number | undefined, size: number, fallback: number) => {
  if (value === undefined) return fallback
  if (value < 0) return Math.max(size + value, 0)
  return Math.min(value, size)
}

export class CapabilityFile extends File {
  readonly [capabilityFileMarker] = true
  readonly name: string
  readonly lastModified: number
  private readonly source: CapabilityFileSource
  private readonly range: CapabilityFileRange

  constructor(
    source: CapabilityFileSource,
    name: string,
    type: string,
    lastModified = 0,
    range: CapabilityFileRange = { start: 0, end: source.size },
  ) {
    super([], name, { type, lastModified })
    this.source = source
    this.name = name
    this.lastModified = lastModified
    this.range = range
  }

  override get size() {
    return this.range.end - this.range.start
  }

  override slice(start?: number, end?: number, contentType?: string): Blob {
    const relativeStart = normalizeIndex(start, this.size, 0)
    const relativeEnd = Math.max(relativeStart, normalizeIndex(end, this.size, this.size))
    return new CapabilityFile(
      this.source,
      this.name,
      contentType === undefined ? this.type : contentType,
      this.lastModified,
      {
        start: this.range.start + relativeStart,
        end: this.range.start + relativeEnd,
      },
    )
  }

  private async readRange(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    this.source.signal.throwIfAborted()
    const bytes = await this.source.readChunk(
      this.source.requestId,
      this.source.token,
      offset,
      length,
    )
    this.source.signal.throwIfAborted()
    if (bytes.byteLength !== length) {
      throw new Error('The selected file changed while it was being read.')
    }
    const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
    copy.set(bytes)
    return copy
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = this.range.start
    return new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull: async (controller) => {
        try {
          if (offset >= this.range.end) {
            controller.close()
            return
          }
          const length = Math.min(
            desktopCapabilityMaximumChunkBytes,
            this.range.end - offset,
          )
          const bytes = await this.readRange(offset, length)
          offset += length
          controller.enqueue(bytes)
        } catch (error) {
          controller.error(error)
        }
      },
    })
  }

  override async arrayBuffer() {
    const bytes = new Uint8Array(this.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const length = Math.min(desktopCapabilityMaximumChunkBytes, bytes.byteLength - offset)
      bytes.set(await this.readRange(this.range.start + offset, length), offset)
      offset += length
    }
    return bytes.buffer
  }
}

export const isCapabilityFile = (file: File): file is CapabilityFile => (
  file instanceof CapabilityFile
)
