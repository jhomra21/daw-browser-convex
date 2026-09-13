import type { AudioPcmSourceDescriptor, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import {
  peakAssetFormatVersion,
  type PeakAssetRecord,
  type PeakChunkRecord,
  type PeakLevelRecord,
  type WaveformSourceIdentity,
  type WaveformPeakChunkData,
} from './types'
import { resamplePeakChannels } from './resample-peak-pairs'

export const PEAK_LEVELS_PER_SECOND = [400, 100, 25]
export const MAX_CHUNK_DURATION_SEC = 2
export const SILENCE_BYTE = 128

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function quantizeSample(value: number) {
  return Math.max(0, Math.min(255, Math.round((clampSample(value) + 1) * 127.5)))
}

export const encodePeakByte = quantizeSample

export function decodePeakByte(value: number) {
  return value / 127.5 - 1
}

export function getPeakChunkRecord(
  assetKey: string,
  level: PeakLevelRecord,
  record: Pick<PeakAssetRecord, 'durationSec' | 'channelCount' | 'sourceIdentity'>,
  chunkIndex: number,
): PeakChunkRecord {
  const safeStart = Number((chunkIndex * level.chunkDurationSec).toFixed(6))
  const safeEnd = Number(Math.min(record.durationSec, safeStart + level.chunkDurationSec).toFixed(6))
  const sourceToken = record.sourceIdentity?.identity
    ? `:${encodeURIComponent(record.sourceIdentity.identity)}`
    : ''
  return {
    chunkKey: `${assetKey}:${level.peaksPerSecond}${sourceToken}:${chunkIndex}`,
    chunkIndex,
    startSec: safeStart,
    endSec: safeEnd,
    peakCount: getPeakCount(safeStart, safeEnd, level.peaksPerSecond),
    channelCount: record.channelCount,
  }
}

export function getPeakCount(chunkStartSec: number, chunkEndSec: number, peaksPerSecond: number) {
  return Math.max(1, Math.ceil((chunkEndSec - chunkStartSec) * peaksPerSecond))
}

function updatePeakPairs(
  minimums: readonly Float32Array[],
  maximums: readonly Float32Array[],
  page: DecodedAudioPage,
  chunkStartFrame: number,
  chunkEndFrame: number,
) {
  const peakCount = minimums[0]?.length ?? 0
  const ratio = (chunkEndFrame - chunkStartFrame) / peakCount
  const pageEndFrame = page.startFrame + page.frameCount
  const firstPeak = Math.max(0, Math.floor((page.startFrame - chunkStartFrame) / ratio))
  const lastPeak = Math.min(peakCount, Math.ceil((pageEndFrame - chunkStartFrame) / ratio))
  const channels = page.planes.length
  for (let index = firstPeak; index < lastPeak; index++) {
    const binStart = chunkStartFrame + Math.floor(index * ratio)
    const binEnd = Math.max(binStart + 1, Math.min(chunkEndFrame, chunkStartFrame + Math.ceil((index + 1) * ratio)))
    const start = Math.max(binStart, page.startFrame)
    const end = Math.min(binEnd, pageEndFrame)
    if (end <= start) continue
    for (let channel = 0; channel < channels; channel++) {
      let min = minimums[channel]![index]!
      let max = maximums[channel]![index]!
      for (let frame = start; frame < end; frame++) {
        const pageFrame = frame - page.startFrame
        const value = page.planes[channel]?.[pageFrame] ?? 0
        if (value < min) min = value
        if (value > max) max = value
      }
      minimums[channel]![index] = min
      maximums[channel]![index] = max
    }
  }
}

async function extractChunkPeaks(
  source: AudioPcmSourceDescriptor,
  chunk: PeakChunkRecord,
  signal?: AbortSignal,
) {
  const startFrame = Math.max(0, Math.floor(chunk.startSec * source.sampleRate))
  const endFrame = Math.max(startFrame, Math.min(source.frameCount, Math.ceil(chunk.endSec * source.sampleRate)))
  const data = Array.from({ length: source.channelCount }, () => new Uint8Array(chunk.peakCount * 2))
  const minimums = data.map(() => {
    const values = new Float32Array(chunk.peakCount)
    values.fill(1)
    return values
  })
  const maximums = data.map(() => {
    const values = new Float32Array(chunk.peakCount)
    values.fill(-1)
    return values
  })
  if (endFrame > startFrame) {
    for await (const page of source.readPages({ startFrame, endFrame, signal })) {
      signal?.throwIfAborted()
      updatePeakPairs(minimums, maximums, page, startFrame, endFrame)
    }
  }
  for (let index = 0; index < chunk.peakCount; index++) {
    for (let channel = 0; channel < source.channelCount; channel++) {
      data[channel]![index * 2] = quantizeSample(minimums[channel]![index]!)
      data[channel]![index * 2 + 1] = quantizeSample(maximums[channel]![index]!)
    }
  }
  return data satisfies WaveformPeakChunkData
}

function resampleChunkPeaks(
  source: WaveformPeakChunkData,
  assetKey: string,
  level: PeakLevelRecord,
  record: Pick<PeakAssetRecord, 'durationSec' | 'channelCount' | 'sourceIdentity'>,
  chunkIndex: number,
) {
  const chunk = getPeakChunkRecord(assetKey, level, record, chunkIndex)
  return {
    meta: chunk,
    data: resamplePeakChannels(source, chunk.peakCount),
  }
}

export type ExtractedPeakChunk = {
  chunks: Array<{ meta: PeakChunkRecord; data: WaveformPeakChunkData }>
}

export function createPeakAssetRecord(
  source: Pick<AudioPcmSourceDescriptor, 'durationSec' | 'sampleRate' | 'channelCount'>,
  assetKey: string,
  sourceIdentity?: WaveformSourceIdentity,
): PeakAssetRecord {
  const durationSec = Math.max(0, source.durationSec)
  const chunkCount = Math.max(1, Math.ceil(durationSec / MAX_CHUNK_DURATION_SEC))
  const levels: PeakLevelRecord[] = PEAK_LEVELS_PER_SECOND.map((peaksPerSecond) => ({
    peaksPerSecond,
    chunkDurationSec: MAX_CHUNK_DURATION_SEC,
    chunkCount,
  }))
  const record: PeakAssetRecord = {
    formatVersion: peakAssetFormatVersion,
    assetKey,
    durationSec,
    sampleRate: source.sampleRate,
    channelCount: source.channelCount,
    sourceIdentity,
    levels,
  }
  return record
}

export async function extractPeakAsset(
  source: AudioPcmSourceDescriptor,
  assetKey: string,
  options: {
    signal?: AbortSignal
    onChunk: (chunk: ExtractedPeakChunk) => Promise<void>
  },
  sourceIdentity?: WaveformSourceIdentity,
) {
  const record = createPeakAssetRecord(source, assetKey, sourceIdentity)
  const highLevel = record.levels[0]
  for (let chunkIndex = 0; chunkIndex < highLevel.chunkCount; chunkIndex++) {
    options.signal?.throwIfAborted()
    const highMeta = getPeakChunkRecord(assetKey, highLevel, record, chunkIndex)
    const highData = await extractChunkPeaks(source, highMeta, options.signal)
    options.signal?.throwIfAborted()
    const chunks = record.levels.map((level, levelIndex) => levelIndex === 0
      ? { meta: highMeta, data: highData }
      : resampleChunkPeaks(highData, assetKey, level, record, chunkIndex))
    await options.onChunk({ chunks })
  }
  return record
}
