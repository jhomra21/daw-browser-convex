import {
  AudioSample,
  AudioSampleSource,
  Output,
  StreamTarget,
  WavOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'

export type PlanarAudioBlock = {
  frameCount: number
  channels: readonly Float32Array[]
}

export type WavOutputSink = {
  write: (chunk: StreamTargetChunk) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

const PCM_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT
const RIFF_MAX_CONTAINER_BYTES = 2 ** 32
const RIFF_HEADER_BYTES = 44

export type WavContainerKind = 'riff' | 'rf64'

const validateLogicalPcmSize = (input: {
  channelCount: number
  capturedFrames: number
}): bigint => {
  if (
    !Number.isSafeInteger(input.channelCount)
    || input.channelCount < 1
    || !Number.isSafeInteger(input.capturedFrames)
    || input.capturedFrames < 1
  ) throw new Error('Recording PCM size arithmetic is invalid.')
  return BigInt(input.capturedFrames) * BigInt(input.channelCount) * BigInt(PCM_BYTES_PER_SAMPLE)
}

export const getWavContainerKind = (input: {
  channelCount: number
  capturedFrames: number
}): WavContainerKind => (
  validateLogicalPcmSize(input) + BigInt(RIFF_HEADER_BYTES) >= BigInt(RIFF_MAX_CONTAINER_BYTES)
    ? 'rf64'
    : 'riff'
)

export const createWavOutputFormat = (input: {
  channelCount: number
  capturedFrames: number
}): WavOutputFormat => (
  new WavOutputFormat({ large: getWavContainerKind(input) === 'rf64' })
)

export const supportsPlanarFloat32WavEncoding = (): boolean =>
  new WavOutputFormat().getSupportedAudioCodecs().includes('pcm-f32')

export const encodePlanarFloat32Wav = async (input: {
  sampleRate: number
  channelCount: number
  capturedFrames: number
  blocks: AsyncIterable<PlanarAudioBlock>
  sink: WavOutputSink
}): Promise<{ capturedFrames: number }> => {
  if (input.capturedFrames === 0) throw new Error('Recording contained no audio frames.')
  const format = createWavOutputFormat(input)
  const output = new Output({
    format,
    target: new StreamTarget(new WritableStream<StreamTargetChunk>(input.sink)),
  })
  const source = new AudioSampleSource({
    codec: 'pcm-f32',
  })
  output.addAudioTrack(source)
  let encodedFrames = 0
  try {
    await output.start()
    for await (const block of input.blocks) {
      if (
        block.frameCount < 1
        || block.channels.length !== input.channelCount
        || block.channels.some((channel) => channel.length !== block.frameCount)
      ) throw new Error('Recording PCM block is invalid.')
      const sampleBytes = block.frameCount * input.channelCount * PCM_BYTES_PER_SAMPLE
      if (!Number.isSafeInteger(sampleBytes)) throw new Error('Recording PCM block size arithmetic is invalid.')
      const nextEncodedFrames = encodedFrames + block.frameCount
      if (!Number.isSafeInteger(nextEncodedFrames) || nextEncodedFrames > input.capturedFrames) {
        throw new Error('Recording PCM frame count changed.')
      }
      const data = new Uint8Array(sampleBytes)
      let offset = 0
      for (const channel of block.channels) {
        data.set(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength), offset)
        offset += channel.byteLength
      }
      const sample = new AudioSample({
        format: 'f32-planar',
        sampleRate: input.sampleRate,
        numberOfChannels: input.channelCount,
        timestamp: encodedFrames / input.sampleRate,
        data,
      })
      try {
        await source.add(sample)
      } finally {
        sample.close()
      }
      encodedFrames = nextEncodedFrames
    }
    if (encodedFrames !== input.capturedFrames) throw new Error('Recording PCM frame count changed.')
    await output.finalize()
    return { capturedFrames: encodedFrames }
  } catch (error) {
    await output.cancel().catch(() => undefined)
    await input.sink.abort().catch(() => undefined)
    throw error
  }
}
