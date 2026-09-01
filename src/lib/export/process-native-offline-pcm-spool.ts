import type { ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import {
  analyzeExportAudioChunks,
  createStreamingExportAnalysisReport,
  findAutomaticTailEndFrameInChunks,
  type StreamingExportAnalysis,
} from '@daw-browser/audio-engine/streaming-export-fidelity'
import { createStreamingTruePeakLimiter } from '@daw-browser/audio-engine/streaming-true-peak-limiter'

import type { ExportRenderSettings } from '~/lib/export/export-settings'
import type { NativeOfflinePcmSpoolSession } from '~/lib/export/native-offline-pcm-spool'

export type ProcessedNativeOfflinePcmSpool = {
  endFrame: number
  analysis: ExportAnalysisReport
  replay: () => AsyncGenerator<AudioBuffer>
}

type ProcessingStage = {
  gain: number
  truePeakCeilingDbtp?: number
}

type Pipeline = {
  chunks: AsyncIterable<AudioBuffer>
  limiters: ReturnType<typeof createStreamingTruePeakLimiter>[]
}

const linearFromDb = (value: number) => 10 ** (value / 20)
const dbFromLinear = (value: number) => value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY

async function* applyGainToChunks(
  chunks: AsyncIterable<AudioBuffer>,
  gain: number,
  signal: AbortSignal,
): AsyncGenerator<AudioBuffer> {
  for await (const chunk of chunks) {
    signal.throwIfAborted()
    if (gain !== 1) {
      for (let channel = 0; channel < chunk.numberOfChannels; channel += 1) {
        const samples = chunk.getChannelData(channel)
        for (let frame = 0; frame < samples.length; frame += 1) {
          if ((frame & 16383) === 0) signal.throwIfAborted()
          samples[frame] = (samples[frame] ?? 0) * gain
        }
      }
    }
    yield chunk
  }
}

export const processNativeOfflinePcmSpool = async (input: {
  spool: NativeOfflinePcmSpoolSession
  sourceDurationSec: number
  render: ExportRenderSettings
  signal: AbortSignal
}): Promise<ProcessedNativeOfflinePcmSpool> => {
  input.signal.throwIfAborted()
  const descriptor = await input.spool.finalize()
  if (descriptor.sampleRate !== input.render.sampleRate
    || descriptor.channelCount !== input.render.numberOfChannels
    || !Number.isFinite(input.sourceDurationSec)
    || input.sourceDurationSec < 0) {
    throw new Error('Native offline PCM spool does not match export settings.')
  }
  const metadata = {
    sampleRate: descriptor.sampleRate,
    channelCount: descriptor.channelCount,
  }
  const sourceEndFrame = Math.min(
    descriptor.totalFrames,
    Math.ceil(input.sourceDurationSec * descriptor.sampleRate),
  )
  const endFrame = input.render.tail.mode === 'automatic'
    ? await findAutomaticTailEndFrameInChunks(input.spool.replay({ signal: input.signal }), {
      ...metadata,
      sourceEndFrame,
      policy: input.render.tail,
      signal: input.signal,
    })
    : descriptor.totalFrames

  const createPipeline = (stages: readonly ProcessingStage[]): Pipeline => {
    let chunks: AsyncIterable<AudioBuffer> = input.spool.replay({ endFrame, signal: input.signal })
    const limiters: ReturnType<typeof createStreamingTruePeakLimiter>[] = []
    for (const stage of stages) {
      chunks = applyGainToChunks(chunks, stage.gain, input.signal)
      if (stage.truePeakCeilingDbtp === undefined) continue
      const limiter = createStreamingTruePeakLimiter({
        sampleRate: descriptor.sampleRate,
        channelCount: descriptor.channelCount,
        ceilingDbtp: stage.truePeakCeilingDbtp,
      })
      chunks = limiter.transform(chunks, input.signal)
      limiters.push(limiter)
    }
    return { chunks, limiters }
  }

  const analyze = async (stages: readonly ProcessingStage[]) => {
    const pipeline = createPipeline(stages)
    const analysis = await analyzeExportAudioChunks(pipeline.chunks, metadata, input.signal)
    return {
      analysis,
      limited: pipeline.limiters.some((limiter) => limiter.wasLimited()),
    }
  }

  const stages: ProcessingStage[] = []
  let gainDb = 0
  let analyzed = await analyze(stages)
  let analysis: StreamingExportAnalysis = analyzed.analysis
  let limited = analyzed.limited
  const normalization = input.render.normalization

  if (normalization.mode === 'sample-peak' && analysis.samplePeak > 0) {
    gainDb = normalization.targetDbfs - dbFromLinear(analysis.samplePeak)
    if (gainDb !== 0) {
      stages.push({ gain: linearFromDb(gainDb) })
      analyzed = await analyze(stages)
      analysis = analyzed.analysis
      limited = analyzed.limited
    }
  } else if (normalization.mode === 'loudness') {
    for (let pass = 0; pass < 4 && analysis.loudness.integratedLufs !== null; pass += 1) {
      const correctionDb = normalization.targetLufs - analysis.loudness.integratedLufs
      if (Math.abs(correctionDb) <= 0.2) break
      gainDb += correctionDb
      stages.push({
        gain: linearFromDb(correctionDb),
        truePeakCeilingDbtp: normalization.limiting === 'true-peak'
          ? normalization.truePeakCeilingDbtp
          : undefined,
      })
      analyzed = await analyze(stages)
      analysis = analyzed.analysis
      limited = analyzed.limited
    }
    if (analysis.loudness.integratedLufs === null) {
      throw new Error(`Loudness normalization achieved no measurable LUFS, outside the 0.20 LU tolerance for ${normalization.targetLufs.toFixed(2)} LUFS.`)
    }
    if (normalization.limiting === 'true-peak'
      && analysis.loudness.truePeakDbtp !== null
      && analysis.loudness.truePeakDbtp > normalization.truePeakCeilingDbtp + 0.1) {
      throw new Error(`Loudness normalization achieved ${analysis.loudness.truePeakDbtp.toFixed(2)} dBTP, above the ${normalization.truePeakCeilingDbtp.toFixed(2)} dBTP ceiling (+0.10 dB tolerance).`)
    }
  }

  const ceilingConstrained = normalization.mode === 'loudness'
    && analysis.loudness.integratedLufs !== null
    && Math.abs(analysis.loudness.integratedLufs - normalization.targetLufs) > 0.2
    && normalization.limiting === 'true-peak'

  return {
    endFrame,
    analysis: createStreamingExportAnalysisReport({
      analysis,
      gainDb,
      limited,
      ceilingConstrained,
    }),
    replay: () => createPipeline(stages).chunks[Symbol.asyncIterator](),
  }
}
