import { readFile, stat } from "node:fs/promises"
import type { Readable } from "node:stream"
import { controlLimitsV1 } from "@daw-browser/control"
import { decodeJsonlLines, type JsonlLine } from "@daw-browser/control-sdk"

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin: () => Promise<string>;
  readLines?: () => AsyncIterable<JsonlLine>;
}

export const readStdinChunks = (stdin: Readable): AsyncIterable<Uint8Array> => {
  // Keep one chunk outside the stream's own high-water buffer while the decoder
  // waits for the async RPC consumer; resume only when that chunk is consumed.
  let pendingChunk: Uint8Array | undefined
  let ended = false
  let failure: Error | undefined
  let wake: (() => void) | undefined
  const onData = (chunk: string | Buffer) => {
    if (pendingChunk !== undefined) {
      failure = new Error("Stdin backpressure queue overflow.")
      stdin.pause()
      wake?.()
      wake = undefined
      return
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pendingChunk = bytes
    stdin.pause()
    wake?.()
    wake = undefined
  }
  const onEnd = () => {
    ended = true
    wake?.()
    wake = undefined
  }
  const onError = (error: Error) => {
    failure = error
    wake?.()
    wake = undefined
  }
  stdin.pause()
  const iterator = (async function* () {
    stdin.on("data", onData)
    stdin.once("end", onEnd)
    stdin.once("error", onError)
    try {
      stdin.resume()
      while (!ended || pendingChunk !== undefined) {
        if (failure) throw failure
        const chunk = pendingChunk
        pendingChunk = undefined
        if (chunk) {
          yield chunk
          if (pendingChunk === undefined) stdin.resume()
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stdin.removeListener("data", onData)
      stdin.removeListener("end", onEnd)
      stdin.removeListener("error", onError)
      stdin.pause()
    }
  })()
  return iterator
}

export const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readStdin: async () => {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > controlLimitsV1.maxSerializedBodyBytes) throw new Error("Request input exceeds the size limit.")
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString("utf8")
  },
  readLines: () => decodeJsonlLines(readStdinChunks(process.stdin)),
}

export const option = (arguments_: string[], name: string) => {
  const index = arguments_.indexOf(name)
  if (index === -1) return undefined
  const value = arguments_[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing ${name} value.`)
  return value
}

export const jsonRequest = async (source: string, io: CliIo) => {
  const content = source === "-" ? await io.readStdin() : await (async () => {
    const info = await stat(source)
    if (!info.isFile() || info.size > controlLimitsV1.maxSerializedBodyBytes) throw new Error("Request input exceeds the size limit.")
    return readFile(source, "utf8")
  })()
  try {
    return JSON.parse(content)
  } catch {
    throw new Error("Request input is not valid JSON.")
  }
}
