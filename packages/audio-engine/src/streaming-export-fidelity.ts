import type {
  ExportAnalysisReport,
  ExportTailPolicy,
} from './export-fidelity'
import type { LoudnessAnalysis } from './loudness-analyzer'
import { createStreamingLoudnessAnalyzer } from './streaming-loudness-analyzer'

export type StreamingExportAudioChunk = {
  numberOfChannels: number
  length: number
  sampleRate: number
  getChannelData: (channel: number) => Float32Array<ArrayBufferLike>
}

export type StreamingExportAnalysis = {
  loudness: LoudnessAnalysis
  samplePeak: number
}

type StreamingExportMetadata = {
  sampleRate: number
  channelCount: number
}

const linearFromDb = (value: number) => 10 ** (value / 20)
const dbFromLinear = (value: number) => value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY

const validateMetadata = (metadata: StreamingExportMetadata) => {
  if (!Number.isFinite(metadata.sampleRate) || metadata.sampleRate <= 0
    || !Number.isSafeInteger(metadata.channelCount)
    || metadata.channelCount < 1
    || metadata.channelCount > 2) {
    throw new Error('Streaming export analysis metadata is invalid.')
  }
}

const validateChunk = (chunk: StreamingExportAudioChunk, metadata: StreamingExportMetadata) => {
  if (chunk.sampleRate !== metadata.sampleRate
    || chunk.numberOfChannels !== metadata.channelCount
    || !Number.isSafeInteger(chunk.length)
    || chunk.length <= 0) {
    throw new Error('Streaming export analysis chunk metadata is invalid.')
  }
  for (let channel = 0; channel < metadata.channelCount; channel += 1) {
    if (chunk.getChannelData(channel).length !== chunk.length) {
      throw new Error('Streaming export analysis chunk channel length is invalid.')
    }
  }
}

export const analyzeExportAudioChunks = async (
  chunks: Iterable<StreamingExportAudioChunk> | AsyncIterable<StreamingExportAudioChunk>,
  metadata: StreamingExportMetadata,
  signal?: AbortSignal,
): Promise<StreamingExportAnalysis> => {
  validateMetadata(metadata)
  const loudness = createStreamingLoudnessAnalyzer(metadata)
  let samplePeak = 0
  let totalFrames = 0

  for await (const chunk of chunks) {
    signal?.throwIfAborted()
    validateChunk(chunk, metadata)
    loudness.append(chunk, signal)
    for (let channel = 0; channel < metadata.channelCount; channel += 1) {
      const samples = chunk.getChannelData(channel)
      for (let frame = 0; frame < samples.length; frame += 1) {
        if ((frame & 16383) === 0) signal?.throwIfAborted()
        samplePeak = Math.max(samplePeak, Math.abs(samples[frame] ?? 0))
      }
    }
    if (totalFrames > Number.MAX_SAFE_INTEGER - chunk.length) {
      throw new Error('Streaming export analysis frame count exceeded exact integer range.')
    }
    totalFrames += chunk.length
  }
  if (totalFrames === 0) throw new Error('Streaming export analysis produced no audio frames.')
  return { loudness: loudness.finish(signal), samplePeak }
}

export const findAutomaticTailEndFrameInChunks = async (
  chunks: Iterable<StreamingExportAudioChunk> | AsyncIterable<StreamingExportAudioChunk>,
  input: StreamingExportMetadata & {
    sourceEndFrame: number
    policy: Extract<ExportTailPolicy, { mode: 'automatic' }>
    signal?: AbortSignal
  },
): Promise<number> => {
  validateMetadata(input)
  if (!Number.isSafeInteger(input.sourceEndFrame) || input.sourceEndFrame < 0) {
    throw new Error('Streaming automatic-tail source end frame is invalid.')
  }
  const threshold = linearFromDb(input.policy.thresholdDbfs)
  const holdFrames = Math.max(1, Math.ceil(input.policy.holdSec * input.sampleRate))
  let quietFrames = 0
  let totalFrames = 0

  for await (const chunk of chunks) {
    input.signal?.throwIfAborted()
    validateChunk(chunk, input)
    const channels = Array.from(
      { length: input.channelCount },
      (_, channel) => chunk.getChannelData(channel),
    )
    for (let localFrame = 0; localFrame < chunk.length; localFrame += 1) {
      const frame = totalFrames + localFrame
      if (frame < input.sourceEndFrame) continue
      if ((frame & 4095) === 0) input.signal?.throwIfAborted()
      let peak = 0
      for (let channel = 0; channel < input.channelCount; channel += 1) {
        peak = Math.max(peak, Math.abs(channels[channel]?.[localFrame] ?? 0))
      }
      quietFrames = peak <= threshold ? quietFrames + 1 : 0
      if (quietFrames >= holdFrames) return frame + 1
    }
    if (totalFrames > Number.MAX_SAFE_INTEGER - chunk.length) {
      throw new Error('Streaming automatic-tail frame count exceeded exact integer range.')
    }
    totalFrames += chunk.length
  }
  return totalFrames
}

export const createStreamingExportAnalysisReport = (input: {
  analysis: StreamingExportAnalysis
  gainDb: number
  limited: boolean
  ceilingConstrained: boolean
}): ExportAnalysisReport => ({
  integratedLufs: input.analysis.loudness.integratedLufs,
  momentaryMaxLufs: input.analysis.loudness.momentaryMaxLufs,
  shortTermMaxLufs: input.analysis.loudness.shortTermMaxLufs,
  loudnessRangeLu: input.analysis.loudness.loudnessRangeLu,
  truePeakDbtp: input.analysis.loudness.truePeakDbtp,
  samplePeakDbfs: input.analysis.samplePeak === 0 ? null : dbFromLinear(input.analysis.samplePeak),
  gainDb: input.gainDb,
  limited: input.limited,
  ceilingConstrained: input.ceilingConstrained,
})
