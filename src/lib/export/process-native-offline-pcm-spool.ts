import type { ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import {
  analyzeExportAudioChunks,
  createStreamingExportAnalysisReport,
  findAutomaticTailEndFrameInChunks,
  type StreamingExportAnalysis,
} from '@daw-browser/audio-engine/streaming-export-fidelity'

import type { ExportRenderSettings } from '~/lib/export/export-settings'
import type { NativeOfflinePcmSpoolSession } from '~/lib/export/native-offline-pcm-spool'

export class NativeOfflineStreamingLimiterRequiredError extends Error {
  constructor() {
    super('Native duration-independent export still requires a streaming true-peak limiter for this normalization mode.')
    this.name = 'NativeOfflineStreamingLimiterRequiredError'
  }
}

export type ProcessedNativeOfflinePcmSpool = {
  endFrame: number
  gain: number
  analysis: ExportAnalysisReport
  replay: () => AsyncGenerator<AudioBuffer>
}

const linearFromDb = (value: number) => 10 ** (value / 20)
const dbFromLinear = (value: number) => value > 0 ? 20 * Math.log10(value) : Number.NEGATIVE_INFINITY

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

  const analyze = (gain = 1): Promise<StreamingExportAnalysis> => analyzeExportAudioChunks(
    input.spool.replay({ endFrame, gain, signal: input.signal }),
    metadata,
    input.signal,
  )

  let gainDb = 0
  let analysis = await analyze()
  const normalization = input.render.normalization
  if (normalization.mode === 'sample-peak' && analysis.samplePeak > 0) {
    gainDb = normalization.targetDbfs - dbFromLinear(analysis.samplePeak)
    if (gainDb !== 0) analysis = await analyze(linearFromDb(gainDb))
  } else if (normalization.mode === 'loudness') {
    if (normalization.limiting === 'true-peak') throw new NativeOfflineStreamingLimiterRequiredError()
    for (let pass = 0; pass < 4 && analysis.loudness.integratedLufs !== null; pass += 1) {
      const correctionDb = normalization.targetLufs - analysis.loudness.integratedLufs
      if (Math.abs(correctionDb) <= 0.2) break
      gainDb += correctionDb
      analysis = await analyze(linearFromDb(gainDb))
    }
    if (analysis.loudness.integratedLufs === null) {
      throw new Error(`Loudness normalization achieved no measurable LUFS, outside the 0.20 LU tolerance for ${normalization.targetLufs.toFixed(2)} LUFS.`)
    }
  }

  const gain = linearFromDb(gainDb)
  return {
    endFrame,
    gain,
    analysis: createStreamingExportAnalysisReport({
      analysis,
      gainDb,
      limited: false,
      ceilingConstrained: false,
    }),
    replay: () => input.spool.replay({ endFrame, gain, signal: input.signal }),
  }
}
