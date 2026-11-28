import { readFile, writeFile } from "node:fs/promises"

export type Pcm = { sampleRate: number; channels: number; samples: Float32Array }

// Chunk-aware reader for the live tap's IEEE float and fixture PCM WAVs.
export const readWav = async (file: string): Promise<Pcm> => {
  const bytes = await readFile(file)
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`Not a RIFF/WAVE: ${file}`)
  let format = 0, channels = 0, sampleRate = 0, bits = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4)
    const length = bytes.readUInt32LE(offset + 4), body = offset + 8
    if (body + length > bytes.length) throw new Error("Truncated WAV")
    if (kind === "fmt ") {
      format = bytes.readUInt16LE(body); channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4); bits = bytes.readUInt16LE(body + 14)
      if (format === 65534 && length >= 40) format = bytes.readUInt16LE(body + 24)
    }
    if (kind === "data") {
      if (!channels || !sampleRate || !((format === 3 && bits === 32) || (format === 1 && bits === 16))
        || length % (channels * bits / 8)) throw new Error("Unsupported acceptance WAV format")
      const samples = new Float32Array(length / (bits / 8))
      for (let index = 0; index < samples.length; index++)
        samples[index] = format === 3 ? bytes.readFloatLE(body + index * 4) : bytes.readInt16LE(body + index * 2) / 32768
      return { sampleRate, channels, samples }
    }
    offset = body + length + (length & 1)
  }
  throw new Error("WAV missing data chunk")
}

export const writeWav = async (file: string, pcm: Pcm) => {
  const bytes = Buffer.alloc(44 + pcm.samples.length * 4)
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(pcm.channels, 22)
  bytes.writeUInt32LE(pcm.sampleRate, 24); bytes.writeUInt32LE(pcm.sampleRate * pcm.channels * 4, 28)
  bytes.writeUInt16LE(pcm.channels * 4, 32); bytes.writeUInt16LE(32, 34)
  bytes.write("data", 36); bytes.writeUInt32LE(pcm.samples.length * 4, 40)
  for (let index = 0; index < pcm.samples.length; index++) bytes.writeFloatLE(pcm.samples[index] ?? 0, 44 + index * 4)
  await writeFile(file, bytes, { mode: 0o600 })
}
