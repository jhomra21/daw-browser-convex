import { expect, test } from 'bun:test'

import { decodeAudioPages, type DecodedAudioPage } from './media-pages'

const writeAscii = (bytes: Uint8Array, offset: number, value: string) => {
  bytes.set(new TextEncoder().encode(value), offset)
}

const wave = () => {
  const frames = 5
  const bytes = new Uint8Array(44 + frames * 2)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.byteLength - 8, true)
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
  view.setUint32(40, frames * 2, true)
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * 2, (frame + 1) * 1000, true)
  }
  return bytes
}

const dataUrl = (bytes: Uint8Array) => {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  return `data:audio/wav;base64,${btoa(binary)}`
}

class WholeFileReadForbidden extends File {
  override arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.reject(new Error('whole-file-array-buffer-read'))
  }
}

const pageSummary = (pages: DecodedAudioPage[]) => pages.map((page) => ({
  startFrame: page.startFrame,
  frameCount: page.frameCount,
  sampleRate: page.sampleRate,
  channelCount: page.channelCount,
}))

const collectPages = async (source: Parameters<typeof decodeAudioPages>[0]) => {
  const pages: DecodedAudioPage[] = []
  for await (const page of decodeAudioPages(source, { pageFrames: 2 })) pages.push(page)
  return pages
}

test('splits decoded media into fixed-size pages without File.arrayBuffer()', async () => {
  const file = new WholeFileReadForbidden([wave()], 'paged.wav', { type: 'audio/wav' })
  const pages = await collectPages(file)

  expect(pageSummary(pages)).toEqual([
    { startFrame: 0, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 2, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 4, frameCount: 1, sampleRate: 48_000, channelCount: 1 },
  ])
  expect(pages.every((page) => page.planes.every((plane) => plane.length <= 2))).toBe(true)
})

test('decodes URL-backed media through the same bounded page path', async () => {
  const pages = await collectPages(dataUrl(wave()))

  expect(pageSummary(pages)).toEqual([
    { startFrame: 0, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 2, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 4, frameCount: 1, sampleRate: 48_000, channelCount: 1 },
  ])
})
