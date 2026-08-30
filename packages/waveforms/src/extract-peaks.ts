import { resamplePeakPairs } from './resample-peak-pairs'
import {
  peakAssetFormatVersion,
  type PeakAssetRecord,
  type PeakChunkRecord,
  type PeakLevelRecord,
  type WaveformSourceIdentity,
} from './types'

const HIGH_RES_PEAKS_PER_SECOND = 400
const PEAK_LEVELS_PER_SECOND = [HIGH_RES_PEAKS_PER_SECOND, 100, 25]
const MAX_CHUNK_DURATION_SEC = 2
export const SILENCE_BYTE = 128

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value))
}

export function encodePeakByte(value: number) {
  return Math.max(0, Math.min(255, Math.round((clampSample(value) + 1) * 127.5)))
}

export function decodePeakByte(value: number) {
  return value / 127.5 - 1
}

function createChunkRecord(
  assetKey: string,
  peaksPerSecond: number,
  chunkStartSec: number,
  chunkEndSec: number,
  peakCount: number,
): PeakChunkRecord {
  const safeStart = Number(chunkStartSec.toFixed(6))
  return {
    chunkKey: `${assetKey}:v${peakAssetFormatVersion}:${peaksPerSecond}:${safeStart}`,
    startSec: safeStart,
    endSec: Number(chunkEndSec.toFixed(6)),
    peakCount,
  }
}

function getPeakCount(chunkStartSec: number, chunkEndSec: number, peaksPerSecond: number) {
  return Math.max(1, Math.ceil((chunkEndSec - chunkStartSec) * peaksPerSecond))
}

const channelByteOffset = (channel: number, peakCount: number) => channel * peakCount * 2

function extractChunkPeaks(
  buffer: AudioBuffer,
  assetKey: string,
  chunkStartSec: number,
  chunkEndSec: number,
  peaksPerSecond: number,
) {
  const sampleRate = buffer.sampleRate
  const startFrame = Math.max(0, Math.floor(chunkStartSec * sampleRate))
  const endFrame = Math.max(startFrame, Math.min(buffer.length, Math.ceil(chunkEndSec * sampleRate)))
  const frameCount = Math.max(0, endFrame - startFrame)
  const peakCount = getPeakCount(chunkStartSec, chunkEndSec, peaksPerSecond)
  const channels = Math.max(1, buffer.numberOfChannels)
  const data = new Uint8Array(peakCount * channels * 2)
  data.fill(SILENCE_BYTE)
  if (frameCount === 0) {
    return {
      meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
      data,
    }
  }

  const ratio = frameCount / peakCount
  for (let channel = 0; channel < channels; channel += 1) {
    const channelData = buffer.getChannelData(channel)
    const byteOffset = channelByteOffset(channel, peakCount)
    for (let index = 0; index < peakCount; index += 1) {
      const binStart = startFrame + Math.floor(index * ratio)
      const binEnd = Math.max(binStart + 1, Math.min(endFrame, startFrame + Math.ceil((index + 1) * ratio)))
      let min = 1
      let max = -1
      for (let frame = binStart; frame < binEnd; frame += 1) {
        const value = channelData[frame] ?? 0
        if (value < min) min = value
        if (value > max) max = value
      }
      data[byteOffset + index * 2] = encodePeakByte(min)
      data[byteOffset + index * 2 + 1] = encodePeakByte(max)
    }
  }

  return {
    meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
    data,
  }
}

function resampleChunkPeaks(
  source: Uint8Array,
  sourcePeakCount: number,
  channelCount: number,
  assetKey: string,
  chunkStartSec: number,
  chunkEndSec: number,
  peaksPerSecond: number,
) {
  const peakCount = getPeakCount(chunkStartSec, chunkEndSec, peaksPerSecond)
  const data = new Uint8Array(peakCount * channelCount * 2)
  for (let channel = 0; channel < channelCount; channel += 1) {
    const sourceStart = channelByteOffset(channel, sourcePeakCount)
    const sourceEnd = sourceStart + sourcePeakCount * 2
    data.set(
      resamplePeakPairs(source.subarray(sourceStart, sourceEnd), peakCount),
      channelByteOffset(channel, peakCount),
    )
  }
  return {
    meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
    data,
  }
}

export function extractPeakAsset(buffer: AudioBuffer, assetKey: string, sourceIdentity?: WaveformSourceIdentity) {
  const durationSec = Math.max(0, buffer.duration)
  const channelCount = Math.max(1, buffer.numberOfChannels)
  const levelChunks = new Map<number, Array<{ meta: PeakChunkRecord; data: Uint8Array }>>()
  const highResChunks: Array<{ meta: PeakChunkRecord; data: Uint8Array }> = []

  for (
    let chunkStartSec = 0;
    chunkStartSec < durationSec || (durationSec === 0 && chunkStartSec === 0);
    chunkStartSec += MAX_CHUNK_DURATION_SEC
  ) {
    const chunkEndSec = durationSec === 0
      ? MAX_CHUNK_DURATION_SEC
      : Math.min(durationSec, chunkStartSec + MAX_CHUNK_DURATION_SEC)
    highResChunks.push(extractChunkPeaks(
      buffer,
      assetKey,
      chunkStartSec,
      chunkEndSec,
      HIGH_RES_PEAKS_PER_SECOND,
    ))
    if (durationSec === 0) break
  }
  levelChunks.set(HIGH_RES_PEAKS_PER_SECOND, highResChunks)

  for (const peaksPerSecond of PEAK_LEVELS_PER_SECOND.slice(1)) {
    levelChunks.set(
      peaksPerSecond,
      highResChunks.map((chunk) => resampleChunkPeaks(
        chunk.data,
        chunk.meta.peakCount,
        channelCount,
        assetKey,
        chunk.meta.startSec,
        chunk.meta.endSec,
        peaksPerSecond,
      )),
    )
  }

  const levels: PeakLevelRecord[] = PEAK_LEVELS_PER_SECOND.map((peaksPerSecond) => {
    const chunks = levelChunks.get(peaksPerSecond) ?? []
    return {
      peaksPerSecond,
      chunkDurationSec: MAX_CHUNK_DURATION_SEC,
      chunks: chunks.map((chunk) => chunk.meta),
    }
  })

  const record: PeakAssetRecord = {
    formatVersion: peakAssetFormatVersion,
    assetKey,
    durationSec,
    sampleRate: buffer.sampleRate,
    channelCount,
    sourceIdentity,
    levels,
  }

  return {
    record,
    chunks: levels.flatMap((level) => levelChunks.get(level.peaksPerSecond) ?? []),
  }
}