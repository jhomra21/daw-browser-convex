import { readFile, stat } from "node:fs/promises"
import { controlLimitsV1 } from "@daw-browser/control"

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readStdin: () => Promise<string>;
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
