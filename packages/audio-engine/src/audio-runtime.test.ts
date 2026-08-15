import { afterEach, expect, test } from 'bun:test'
import { decodeAudioData } from './audio-runtime'

const originalOfflineAudioContext = globalThis.OfflineAudioContext

const writeAscii = (view: DataView, offset: number, value: string) => {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
}

const createFloatStereoWav = (sampleRate: number, frameCount: number) => {
  const dataBytes = frameCount * 2 * Float32Array.BYTES_PER_ELEMENT
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 3, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2 * Float32Array.BYTES_PER_ELEMENT, true)
  view.setUint16(32, 2 * Float32Array.BYTES_PER_ELEMENT, true)
  view.setUint16(34, 32, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return buffer
}

class TestOfflineAudioContext {
  readonly sampleRate: number

  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate
  }

  async decodeAudioData(arrayBuffer: ArrayBuffer) {
    const sourceRate = new DataView(arrayBuffer).getUint32(24, true)
    const sourceFrames = new DataView(arrayBuffer).getUint32(40, true) / (2 * Float32Array.BYTES_PER_ELEMENT)
    const outputFrames = Math.round(sourceFrames * this.sampleRate / sourceRate)
    return new TestDecodedAudioBuffer(this.sampleRate, outputFrames)
  }
}

class TestDecodedAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly numberOfChannels = 2
  readonly sampleRate: number
  readonly length: number

  constructor(sampleRate: number, length: number) {
    this.sampleRate = sampleRate
    this.length = length
    this.duration = length / sampleRate
  }

  copyFromChannel(destination: Float32Array, _channelNumber: number, _bufferOffset?: number) {
    destination.fill(0)
  }

  copyToChannel(_source: Float32Array, _channelNumber: number, _bufferOffset?: number) {}

  getChannelData(_channelNumber: number) {
    return new Float32Array(this.length)
  }
}

afterEach(() => {
  if (originalOfflineAudioContext) Object.defineProperty(globalThis, 'OfflineAudioContext', {
    configurable: true,
    value: originalOfflineAudioContext,
  })
  else Reflect.deleteProperty(globalThis, 'OfflineAudioContext')
})

test('decodes retained 48 kHz stereo bytes at the explicit persisted rate', async () => {
  Object.defineProperty(globalThis, 'OfflineAudioContext', {
    configurable: true,
    value: TestOfflineAudioContext,
  })
  const encoded = createFloatStereoWav(48_000, 5_857)
  const atPersisted44k = await decodeAudioData(null, encoded, 44_100)
  const atPersisted48k = await decodeAudioData(null, encoded, 48_000)

  expect(atPersisted44k.sampleRate).toBe(44_100)
  expect(atPersisted44k.length).toBe(5_381)
  expect(atPersisted48k.sampleRate).toBe(48_000)
  expect(atPersisted48k.length).toBe(5_857)
})

test('uses canonical 44.1 kHz when no persisted target exists', async () => {
  Object.defineProperty(globalThis, 'OfflineAudioContext', {
    configurable: true,
    value: TestOfflineAudioContext,
  })
  const decoded = await decodeAudioData(null, createFloatStereoWav(48_000, 5_857))
  expect(decoded.sampleRate).toBe(44_100)
  expect(decoded.length).toBe(5_381)
})
