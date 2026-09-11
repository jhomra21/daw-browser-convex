import type { ExportAudioFormat } from "@daw-browser/shared"
import { getExportRangeBounds, type ExportRange } from "@daw-browser/audio-engine/export-range"
import { getExportTailMaximumSec } from "@daw-browser/audio-engine/export-fidelity"
import type { ExportEncodingSettings, ExportRenderSettings } from "~/lib/export/export-settings"
const maximumRiffBytes = 0xffff_ffff - 44
const maximumWebAudioFrames = 0xffff_ffff
const boundedEncoderOverheadBytes = 16 * 1024 * 1024

type PreflightInput = {
  tracks: readonly { clips: readonly { startSec: number; duration: number }[] }[]
  range: ExportRange
  formats: readonly ExportAudioFormat[]
  render: ExportRenderSettings
  encoding: ExportEncodingSettings
  stemCount: number
  resourceLimits?: {
    maximumFiles: number
    streaming: true
  }
}

type ExportResourcePreflight = {
  outputCount: number
  aggregateBytes: number
  sourceStartSec: number
  sourceEndSec: number
  renderEndSec: number
}

const pcmBytesPerSample = (codec: ExportEncodingSettings["wav"]["codec"]) =>
  codec === "pcm-s16" ? 2 : codec === "pcm-s24" ? 3 : 4

const estimateFormatBytes = (
  format: ExportAudioFormat,
  frames: number,
  durationSec: number,
  render: ExportRenderSettings,
  encoding: ExportEncodingSettings,
) => {
  if (format === "wav") {
    const bytes = frames * render.numberOfChannels * pcmBytesPerSample(encoding.wav.codec) + 44
    if (bytes > maximumRiffBytes) throw new Error("WAV export exceeds the RIFF 4 GiB limit.")
    return bytes
  }
  if (format === "flac") {
    return frames * render.numberOfChannels * 4 + boundedEncoderOverheadBytes
  }
  const bitrate = format === "mp3"
    ? encoding.bitrateByFormat.mp3 ?? 192_000
    : encoding.bitrateByFormat["ogg-opus"] ?? 128_000
  return Math.ceil(durationSec * bitrate / 8 + boundedEncoderOverheadBytes)
}

export const preflightExportResources = (input: PreflightInput): ExportResourcePreflight => {
  const formats = [...new Set(input.formats)]
  const outputCount = input.stemCount * formats.length
  if (!Number.isSafeInteger(outputCount) || outputCount < 1) throw new Error("Export does not produce any output files.")
  if (input.resourceLimits && outputCount > input.resourceLimits.maximumFiles) {
    throw new Error(`Export produces more than ${input.resourceLimits.maximumFiles} output files.`)
  }
  const source = getExportRangeBounds(input.tracks, input.range)
  const renderEndSec = source.endSec + getExportTailMaximumSec(input.render.tail)
  const durationSec = renderEndSec - source.startSec
  const frames = Math.ceil(durationSec * input.render.sampleRate)
  if (
    !Number.isFinite(source.startSec)
    || !Number.isFinite(source.endSec)
    || !Number.isFinite(renderEndSec)
    || !Number.isSafeInteger(frames)
    || frames < 1
    || frames > maximumWebAudioFrames
  ) {
    throw new Error("Export range exceeds the Web Audio render length.")
  }
  const perStem = formats.reduce(
    (total, format) => total + estimateFormatBytes(format, frames, durationSec, input.render, input.encoding),
    0,
  )
  const aggregateBytes = Math.ceil(perStem * input.stemCount)
  if (!Number.isSafeInteger(aggregateBytes)) throw new Error("Export output estimate is too large.")
  return {
    outputCount,
    aggregateBytes,
    sourceStartSec: source.startSec,
    sourceEndSec: source.endSec,
    renderEndSec,
  }
}
