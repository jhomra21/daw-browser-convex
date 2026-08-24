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
  const output = new Output({
    format: new WavOutputFormat(),
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
      const data = new Uint8Array(block.frameCount * input.channelCount * Float32Array.BYTES_PER_ELEMENT)
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
      encodedFrames += block.frameCount
      if (encodedFrames > input.capturedFrames) throw new Error('Recording PCM frame count changed.')
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
