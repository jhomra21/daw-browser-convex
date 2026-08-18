import { applyExportNormalization, findAutomaticTailEndFrame, type ExportAnalysisReport } from '@daw-browser/audio-engine/export-fidelity'
import type { ExportRenderSettings } from '~/lib/export/export-settings'

type ProcessedRenderedExport = {
  buffer: AudioBuffer
  analysis: ExportAnalysisReport
}

const trimAutomaticTail = (
  rendered: AudioBuffer,
  sourceDurationSec: number,
  tail: ExportRenderSettings['tail'],
  signal: AbortSignal,
): AudioBuffer => {
  if (tail.mode !== 'automatic') return rendered
  const sourceFrames = Math.ceil(sourceDurationSec * rendered.sampleRate)
  const endFrame = findAutomaticTailEndFrame(rendered, sourceFrames, tail, signal)
  if (endFrame >= rendered.length) return rendered
  const trimmed = new AudioBuffer({
    numberOfChannels: rendered.numberOfChannels,
    length: endFrame,
    sampleRate: rendered.sampleRate,
  })
  for (let channel = 0; channel < rendered.numberOfChannels; channel += 1) {
    trimmed.getChannelData(channel).set(rendered.getChannelData(channel).subarray(0, endFrame))
  }
  return trimmed
}

export const processRenderedExport = (input: {
  rendered: AudioBuffer
  sourceDurationSec: number
  render: ExportRenderSettings
  signal: AbortSignal
}): ProcessedRenderedExport => {
  const buffer = trimAutomaticTail(input.rendered, input.sourceDurationSec, input.render.tail, input.signal)
  return {
    buffer,
    analysis: applyExportNormalization(buffer, input.render.normalization, input.signal),
  }
}
