import { describe, expect, test } from 'bun:test'
import { encodePlanarFloat32Wav, type PlanarAudioBlock, type WavOutputSink } from './encode-wav'

const outputSink = () => {
  let bytes = new Uint8Array()
  let aborted = false
  const sink: WavOutputSink = {
    write: async (chunk) => {
      const required = chunk.position + chunk.data.byteLength
      if (required > bytes.byteLength) {
        const expanded = new Uint8Array(required)
        expanded.set(bytes)
        bytes = expanded
      }
      bytes.set(chunk.data, chunk.position)
    },
    close: async () => undefined,
    abort: async () => {
      aborted = true
    },
  }
  return { sink, bytes: () => bytes, aborted: () => aborted }
}

const blocks = async function* (items: readonly PlanarAudioBlock[]) {
  for (const item of items) yield item
}

const findChunk = (bytes: Uint8Array, name: string) => {
  const marker = new TextEncoder().encode(name)
  for (let offset = 0; offset <= bytes.length - marker.length; offset += 1) {
    if (marker.every((value, index) => bytes[offset + index] === value)) return offset
  }
  return -1
}

const wavSamples = (bytes: Uint8Array) => {
  const dataOffset = findChunk(bytes, 'data')
  if (dataOffset < 0) throw new Error('Missing WAV data chunk.')
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset + 8)
  return Array.from({ length: view.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true))
}

describe('planar float32 WAV encoder', () => {
  test('encodes mono samples with canonical timing and duration headers', async () => {
    const output = outputSink()
    await encodePlanarFloat32Wav({
      sampleRate: 8000,
      channelCount: 1,
      capturedFrames: 3,
      blocks: blocks([{ frameCount: 3, channels: [new Float32Array([0.25, -0.5, 1])] }]),
      sink: output.sink,
    })
    const bytes = output.bytes()
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE')
    expect(wavSamples(bytes)).toEqual([0.25, -0.5, 1])
  })

  test('preserves stereo channel isolation and an unequal final block', async () => {
    const output = outputSink()
    await encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 2,
      capturedFrames: 5,
      blocks: blocks([
        { frameCount: 3, channels: [new Float32Array([1, 2, 3]), new Float32Array([10, 20, 30])] },
        { frameCount: 2, channels: [new Float32Array([4, 5]), new Float32Array([40, 50])] },
      ]),
      sink: output.sink,
    })
    expect(wavSamples(output.bytes())).toEqual([1, 10, 2, 20, 3, 30, 4, 40, 5, 50])
  })

  test('rejects zero length, corrupt framing, and changed frame totals', async () => {
    await expect(encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 0,
      blocks: blocks([]),
      sink: outputSink().sink,
    })).rejects.toThrow('no audio frames')
    await expect(encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 2,
      capturedFrames: 2,
      blocks: blocks([{ frameCount: 2, channels: [new Float32Array(2)] }]),
      sink: outputSink().sink,
    })).rejects.toThrow('block is invalid')
    await expect(encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 2,
      blocks: blocks([{ frameCount: 1, channels: [new Float32Array(1)] }]),
      sink: outputSink().sink,
    })).rejects.toThrow('frame count changed')
  })

  test('aborts the sink after source and sink failures', async () => {
    const sourceFailure = outputSink()
    async function* failedBlocks() {
      yield { frameCount: 1, channels: [new Float32Array([1])] }
      throw new Error('reader-failed')
    }
    await expect(encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 2,
      blocks: failedBlocks(),
      sink: sourceFailure.sink,
    })).rejects.toThrow('reader-failed')
    expect(sourceFailure.aborted()).toBe(true)

    let sinkAborted = false
    await expect(encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 1,
      blocks: blocks([{ frameCount: 1, channels: [new Float32Array([1])] }]),
      sink: {
        write: async () => { throw new Error('sink-failed') },
        close: async () => undefined,
        abort: async () => { sinkAborted = true },
      },
    })).rejects.toThrow('sink-failed')
    expect(sinkAborted).toBe(true)
  })

  test('consumes blocks incrementally instead of collecting the take', async () => {
    const output = outputSink()
    let activeReads = 0
    let maxActiveReads = 0
    async function* measuredBlocks() {
      for (let index = 0; index < 32; index += 1) {
        activeReads += 1
        maxActiveReads = Math.max(maxActiveReads, activeReads)
        yield { frameCount: 1, channels: [new Float32Array([index])] }
        activeReads -= 1
      }
    }
    await encodePlanarFloat32Wav({
      sampleRate: 48000,
      channelCount: 1,
      capturedFrames: 32,
      blocks: measuredBlocks(),
      sink: output.sink,
    })
    expect(maxActiveReads).toBe(1)
  })
})
