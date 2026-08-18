import {
  AudioBufferSource,
  BufferTarget,
  Output,
  StreamTarget,
  type StreamTargetChunk,
  type Target,
} from 'mediabunny'
import { getExportAudioFormatMetadata, type ExportAudioFormat } from '@daw-browser/shared'
import { createExportAudioOutputFormat, getExportAudioCodec, getExportAudioDefaultBitrate } from './export-audio-support'
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

export async function encodeAudioBuffer(buffer: AudioBuffer, options: EncodeAudioBufferOptions = {}): Promise<ExportResult> {
  const format = options.format ?? 'wav'
  const metadata = getExportAudioFormatMetadata(format)
  const encodeTarget = createEncodeTarget(options.target)
  const output = new Output({ format: createExportAudioOutputFormat(format), target: encodeTarget.target })
  let sizeBytes = 0
  encodeTarget.target.onwrite = (_start, end) => {
    throwIfAborted(options.signal)
    sizeBytes = Math.max(sizeBytes, end)
    options.onWrite?.(sizeBytes)
  }
  const wav = options.wav ?? { codec: 'pcm-s16', dither: 'none' }
  const src = new AudioBufferSource({
    codec: format === 'wav' ? wav.codec : getExportAudioCodec(format),
    bitrate: options.bitrate ?? getExportAudioDefaultBitrate(format),
  })
  try {
    throwIfAborted(options.signal)
    output.addAudioTrack(src)
    await output.start()
    if (format === 'wav' && wav.codec !== 'pcm-f32') {
      const chunkFrames = Math.max(1, Math.round(buffer.sampleRate))
      const quantizers = Array.from(
        { length: buffer.numberOfChannels },
        (_, channel) => createWavQuantizer(wav, (options.ditherSeed ?? 0) + channel),
      )
      for (let startFrame = 0; startFrame < buffer.length; startFrame += chunkFrames) {
        throwIfAborted(options.signal)
        const frameCount = Math.min(chunkFrames, buffer.length - startFrame)
        const chunk = new AudioBuffer({
          numberOfChannels: buffer.numberOfChannels,
          length: frameCount,
          sampleRate: buffer.sampleRate,
        })
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const source = buffer.getChannelData(channel)
          const destination = chunk.getChannelData(channel)
          const quantize = quantizers[channel]
          for (let frame = 0; frame < frameCount; frame += 1) destination[frame] = quantize(source[startFrame + frame])
        }
        await src.add(chunk)
      }
    } else {
      await src.add(buffer)
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
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    sizeBytes: blob?.size ?? sizeBytes,
  }
}
