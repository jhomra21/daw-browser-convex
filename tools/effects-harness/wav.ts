/** Writes 32-bit float WAV (format 3). */
export const wavBytes = (channels: readonly Float32Array[], rate: number) => {
  const frames = channels[0].length
  const dataBytes = frames * channels.length * 4
  const out = new DataView(new ArrayBuffer(44 + dataBytes))
  const text = (offset: number, value: string) => [...value].forEach((char, i) => out.setUint8(offset + i, char.charCodeAt(0)))
  text(0, 'RIFF')
  out.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVEfmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 3, true)
  out.setUint16(22, channels.length, true)
  out.setUint32(24, rate, true)
  out.setUint32(28, rate * channels.length * 4, true)
  out.setUint16(32, channels.length * 4, true)
  out.setUint16(34, 32, true)
  text(36, 'data')
  out.setUint32(40, dataBytes, true)

  for (let frame = 0; frame < frames; frame += 1) {
    channels.forEach((channel, index) => out.setFloat32(44 + (frame * channels.length + index) * 4, channel[frame], true))
  }

  return new Uint8Array(out.buffer)
}
