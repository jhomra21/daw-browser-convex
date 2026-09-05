import { expect, test } from 'bun:test'

import { decodeAudioPages, decodedSampleStartFrame, type DecodedAudioPage } from './media-pages'

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

const collectPages = async (
  source: Parameters<typeof decodeAudioPages>[0],
  options: Parameters<typeof decodeAudioPages>[1] = { pageFrames: 2 },
) => {
  const pages: DecodedAudioPage[] = []
  for await (const page of decodeAudioPages(source, options)) pages.push(page)
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

test('clips an exact inclusive-start exclusive-end frame range', async () => {
  const pages = await collectPages(dataUrl(wave()), {
    startSec: 1 / 48_000,
    endSec: 4 / 48_000,
    pageFrames: 2,
  })

  expect(pageSummary(pages)).toEqual([
    { startFrame: 1, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 3, frameCount: 1, sampleRate: 48_000, channelCount: 1 },
  ])
  expect(pages.flatMap((page) => [...(page.planes[0] ?? [])])).toEqual([
    2000 / 32768,
    3000 / 32768,
    4000 / 32768,
  ])
})

test('prefers exact integer frame bounds over seconds rounding', async () => {
  const pages = await collectPages(dataUrl(wave()), {
    startSec: 7 / 48_000,
    endSec: 19 / 48_000,
    startFrame: 1,
    endFrame: 4,
    pageFrames: 2,
  })

  expect(pageSummary(pages)).toEqual([
    { startFrame: 1, frameCount: 2, sampleRate: 48_000, channelCount: 1 },
    { startFrame: 3, frameCount: 1, sampleRate: 48_000, channelCount: 1 },
  ])
})

test('concatenates adjacent ranges without duplicate or omitted frames', async () => {
  const whole = await collectPages(dataUrl(wave()), { pageFrames: 2 })
  const first = await collectPages(dataUrl(wave()), {
    startSec: 0,
    endSec: 2 / 48_000,
    pageFrames: 2,
  })
  const second = await collectPages(dataUrl(wave()), {
    startSec: 2 / 48_000,
    endSec: 5 / 48_000,
    pageFrames: 2,
  })

  expect(first.flatMap((page) => [...(page.planes[0] ?? [])]).concat(
    second.flatMap((page) => [...(page.planes[0] ?? [])]),
  )).toEqual(whole.flatMap((page) => [...(page.planes[0] ?? [])]))
  expect(first.at(-1)?.startFrame).toBe(0)
  expect(second[0]?.startFrame).toBe(2)
  expect(second.at(-1)?.frameCount).toBe(1)
})

test('honors cancellation before media decoding starts', async () => {
  const controller = new AbortController()
  controller.abort()

  await expect(collectPages(dataUrl(wave()), {
    pageFrames: 2,
    signal: controller.signal,
  })).rejects.toBeDefined()
})

test('bounds a stalled remote request without weakening explicit cancellation', async () => {
  const fetchCalls: number[] = []
  const pages = decodeAudioPages('https://stall.example/audio.wav', {
    remoteRequestTimeoutMs: 10,
    remoteMaxRetries: 0,
    fetchFn: Object.assign(async (_input: URL | RequestInfo, init?: RequestInit) => {
      fetchCalls.push(1)
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }, { preconnect: globalThis.fetch.preconnect }),
  })

  await expect(pages.next()).rejects.toThrow('timed out')
  expect(fetchCalls).toEqual([1])
})

test('stops retrying a remote source after the configured finite retry count', async () => {
  let fetchCalls = 0
  const pages = decodeAudioPages('https://retry.example/audio.wav', {
    remoteRequestTimeoutMs: 100,
    remoteMaxRetries: 0,
    fetchFn: Object.assign(async () => {
      fetchCalls += 1
      throw new Error('retryable failure')
    }, { preconnect: globalThis.fetch.preconnect }),
  })

  await expect(pages.next()).rejects.toThrow('retryable failure')
  expect(fetchCalls).toBe(1)
})

test('anchors decoded samples to the first media timestamp', () => {
  expect(decodedSampleStartFrame(10.25, 10.25, 48_000)).toBe(0)
  expect(decodedSampleStartFrame(10.25 + 1 / 48_000, 10.25, 48_000)).toBe(1)
  expect(decodedSampleStartFrame(12.25, 10.25, 48_000)).toBe(96_000)
  expect(decodedSampleStartFrame(-1.75, -2.0, 48_000)).toBe(12_000)
  expect(decodedSampleStartFrame(3.5, 3.5, 48_000)).toBe(0)
})
