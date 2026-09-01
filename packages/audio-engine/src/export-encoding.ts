import {
  AudioBufferSource,
  BufferTarget,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny'
import { getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'
import {
  createExportAudioOutputFormat,
  getExportAudioCodec,
  getExportAudioQuality,
} from './export-audio-support'
import { createWavQuantizer, type WavEncodingSettings } from './export-fidelity'

export type EncodeAudioBufferTarget =
  | { mode: 'buffer' }
  | {
    mode: 'stream'
    writable: WritableStream<StreamTargetChunk>
    close?: () => Promise<void>
    abort?: (reason?: ExportAbortReason) => Promise<void>
  }

export type EncodeAudioBufferOptions = {
  format?: ExportAudioFormat
  bitrate?: number
  target?: EncodeAudioBufferTarget
  signal?: AbortSignal
  onWrite?: (sizeBytes: number) => void
  wav?: WavEncodingSettings
  ditherSeed?: number
}

type ExportResult = {
  blob?: Blob
  format: ExportAudioFormat
  durationSec: number
  sampleRate: number
  sizeBytes: number
}

type EncodeTargetState = {
  target: Target
  close: () => Promise<void>
  abort: (reason?: ExportAbortReason) => Promise<void>
}

type ExportAbortReason = Error | string | null

type WavQuantizer = ReturnType<typeof createWavQuantizer>

const throwIfAborted = (signal: AbortSignal | undefined): void => signal?.throwIfAborted()

const createManagedWritable = (
  target: Extract<EncodeAudioBufferTarget, { mode: 'stream' }>,
  abortTarget: (reason?: ExportAbortReason) => Promise<void>,
): WritableStream<StreamTargetChunk> => {
  if (!target.close && !target.abort) return target.writable
  let writer: WritableStreamDefaultWriter<StreamTargetChunk> | undefined
  return new WritableStream<StreamTargetChunk>({
    start() {
      writer = target.writable.getWriter()
    },
    write(chunk) {
      if (!writer) throw new Error('Export stream writer was not initialized.')
      return writer.write(chunk)
    },
    close() {
      writer?.releaseLock()
    },
    abort(reason) {
      writer?.releaseLock()
      return abortTarget(reason)
    },
  })
}

const createEncodeTarget = (target: EncodeAudioBufferTarget | undefined): EncodeTargetState => {
  if (target?.mode !== 'stream') {
    return {
      target: new BufferTarget(),
      close: async () => {},
      abort: async () => {},
    }
  }
  let aborted = false
  const abortTarget = async (reason?: ExportAbortReason) => {
    if (aborted) return
    aborted = true
    await target.abort?.(reason)
  }
  return {
    target: new StreamTarget(createManagedWritable(target, abortTarget), { chunked: true }),
    close: target.close ?? (async () => {}),
    abort: abortTarget,
  }
}

const getBufferTargetBlob = (target: Target, mimeType: string): Blob | undefined => {
  if (!(target instanceof BufferTarget) || !target.buffer) return
  return new Blob([target.buffer], { type: mimeType })
}

const validateAudioChunk = (
  chunk: AudioBuffer,
  sampleRate: number | undefined,
  channelCount: number | undefined,
) => {
  if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate <= 0
    || !Number.isSafeInteger(chunk.numberOfChannels) || chunk.numberOfChannels <= 0
    || !Number.isSafeInteger(chunk.length) || chunk.length <= 0) {
    throw new Error('Export audio chunk metadata is invalid.')
  }
  if (sampleRate !== undefined && chunk.sampleRate !== sampleRate) {
    throw new Error('Export audio chunk sample rate changed during encoding.')
  }
  if (channelCount !== undefined && chunk.numberOfChannels !== channelCount) {
    throw new Error('Export audio chunk channel count changed during encoding.')
  }
}

const quantizeAudioChunk = (
  chunk: AudioBuffer,
  quantizers: readonly WavQuantizer[],
) => {
  const output = new AudioBuffer({
    numberOfChannels: chunk.numberOfChannels,
    length: chunk.length,
    sampleRate: chunk.sampleRate,
  })
  for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
    const source = chunk.getChannelData(channel)
    const destination = output.getChannelData(channel)
    const quantize = quantizers[channel]
    if (!quantize) throw new Error('Export WAV quantizer channel is missing.')
    for (let frame = 0; frame < chunk.length; frame += 1) destination[frame] = quantize(source[frame] ?? 0)
  }
  return output
}

function* splitAudioBuffer(buffer: AudioBuffer, maximumFrames: number): Generator<AudioBuffer> {
  for (let startFrame = 0; startFrame < buffer.length; startFrame += maximumFrames) {
    const frameCount = Math.min(maximumFrames, buffer.length - startFrame)
    const chunk = new AudioBuffer({
      numberOfChannels: buffer.numberOfChannels,
      length: frameCount,
      sampleRate: buffer.sampleRate,
    })
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      chunk.getChannelData(channel).set(buffer.getChannelData(channel).subarray(startFrame, startFrame + frameCount))
    }
    yield chunk
  }
}

export async function encodeAudioChunks(
  chunks: Iterable<AudioBuffer> | AsyncIterable<AudioBuffer>,
  options: EncodeAudioBufferOptions = {},
): Promise<ExportResult> {
  const format = options.format ?? 'wav'
  const metadata = getExportAudioFormatMetadata(format)
  const encodeTarget = createEncodeTarget(options.target)
  const output = new Output({ format: createExportAudioOutputFormat(format), target: encodeTarget.target })
  let sizeBytes = 0
  encodeTarget.target.on('write', ({ end }) => {
    throwIfAborted(options.signal)
    sizeBytes = Math.max(sizeBytes, end)
    options.onWrite?.(sizeBytes)
  })
  const wav = options.wav ?? { codec: 'pcm-s16', dither: 'none' }
  const src = new AudioBufferSource({
    codec: format === 'wav' ? wav.codec : getExportAudioCodec(format),
    quality: getExportAudioQuality(format, options.bitrate),
  })
  let sampleRate: number | undefined
  let channelCount: number | undefined
  let totalFrames = 0
  let quantizers: WavQuantizer[] | undefined
  try {
    throwIfAborted(options.signal)
    output.addAudioTrack(src)
    await output.start()
    for await (const chunk of chunks) {
      throwIfAborted(options.signal)
      validateAudioChunk(chunk, sampleRate, channelCount)
      sampleRate ??= chunk.sampleRate
      channelCount ??= chunk.numberOfChannels
      if (totalFrames > Number.MAX_SAFE_INTEGER - chunk.length) {
        throw new Error('Export audio frame count exceeds exact JavaScript integer range.')
      }
      totalFrames += chunk.length
      if (format === 'wav' && wav.codec !== 'pcm-f32') {
        quantizers ??= Array.from(
          { length: chunk.numberOfChannels },
          (_, channel) => createWavQuantizer(wav, (options.ditherSeed ?? 0) + channel),
        )
        await src.add(quantizeAudioChunk(chunk, quantizers))
      } else {
        await src.add(chunk)
      }
    }
    if (sampleRate === undefined || channelCount === undefined || totalFrames === 0) {
      throw new Error('Export audio chunk stream produced no audio frames.')
    }
    src.close()
    await output.finalize()
    throwIfAborted(options.signal)
    await encodeTarget.close()
  } catch (error) {
    if (output.state !== 'canceled' && output.state !== 'finalized') {
      try { await output.cancel() } catch {}
    }
    const abortReason = error instanceof Error ? error : String(error)
    try { await encodeTarget.abort(abortReason) } catch {}
    throw error
  }
  const blob = getBufferTargetBlob(encodeTarget.target, metadata.mimeType)
  return {
    blob,
    format,
    durationSec: totalFrames / sampleRate,
    sampleRate,
    sizeBytes: blob?.size ?? sizeBytes,
  }
}

export async function encodeAudioBuffer(buffer: AudioBuffer, options: EncodeAudioBufferOptions = {}): Promise<ExportResult> {
  const format = options.format ?? 'wav'
  const wav = options.wav ?? { codec: 'pcm-s16', dither: 'none' }
  if (format === 'wav' && wav.codec !== 'pcm-f32') {
    const chunkFrames = Math.max(1, Math.round(buffer.sampleRate))
    return encodeAudioChunks(splitAudioBuffer(buffer, chunkFrames), options)
  }
  return encodeAudioChunks([buffer], options)
}
