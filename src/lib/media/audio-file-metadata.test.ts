import { expect, test } from 'bun:test'

import { readAudioFileMetadata } from './audio-file-metadata'

const writeAscii = (bytes: Uint8Array, offset: number, value: string) => {
  bytes.set(new TextEncoder().encode(value), offset)
}

const tinyWave = () => {
  const bytes = new Uint8Array(48)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, 40, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 48_000, true)
  view.setUint32(28, 96_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, 4, true)
  view.setInt16(44, 1000, true)
  view.setInt16(46, -1000, true)
  return bytes
}

class WholeFileReadForbidden extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('whole-file-array-buffer-read'))
  }
}

test('reads audio metadata without calling File.arrayBuffer()', async () => {
  const file = new WholeFileReadForbidden([tinyWave()], 'tiny.wav', { type: 'audio/wav' })

  await expect(readAudioFileMetadata(file)).resolves.toEqual({
    durationSec: 2 / 48_000,
    sampleRate: 48_000,
    channelCount: 1,
  })
})
