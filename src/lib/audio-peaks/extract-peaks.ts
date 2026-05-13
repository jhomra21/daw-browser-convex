import type { PeakAssetRecord, PeakChunkRecord, PeakLevelRecord } from '~/lib/audio-peaks/types'
import { resamplePeakPairs } from '~/lib/audio-peaks/resample-peak-pairs'

export const PEAK_LEVELS_PER_SECOND = [400, 100, 25] as const
export const HIGH_RES_PEAKS_PER_SECOND = PEAK_LEVELS_PER_SECOND[0]
export const MAX_CHUNK_DURATION_SEC = 2
export const SILENCE_BYTE = 128

function clampSample(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function quantizeSample(value: number) {
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
    chunkKey: `${assetKey}:${peaksPerSecond}:${safeStart}`,
    startSec: safeStart,
    endSec: Number(chunkEndSec.toFixed(6)),
    peakCount,
  }
}

function getPeakCount(chunkStartSec: number, chunkEndSec: number, peaksPerSecond: number) {
  return Math.max(1, Math.ceil((chunkEndSec - chunkStartSec) * peaksPerSecond))
}

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
  const data = new Uint8Array(peakCount * 2)
  data.fill(SILENCE_BYTE)
  if (frameCount === 0) {
    return {
      meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
      data,
    }
  }

  const ratio = frameCount / peakCount
  const channels = Math.max(1, buffer.numberOfChannels)
  const channelData: Float32Array[] = []
  for (let channel = 0; channel < channels; channel++) {
    channelData.push(buffer.getChannelData(channel))
  }

  for (let index = 0; index < peakCount; index++) {
    const binStart = startFrame + Math.floor(index * ratio)
    const binEnd = Math.max(binStart + 1, Math.min(endFrame, startFrame + Math.ceil((index + 1) * ratio)))
    let min = 1
    let max = -1
    for (let frame = binStart; frame < binEnd; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const value = channelData[channel][frame]
        if (value < min) min = value
        if (value > max) max = value
      }
    }
    data[index * 2] = quantizeSample(min)
    data[index * 2 + 1] = quantizeSample(max)
  }

  return {
    meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
    data,
  }
}

function resampleChunkPeaks(
  source: Uint8Array,
  assetKey: string,
  chunkStartSec: number,
  chunkEndSec: number,
  peaksPerSecond: number,
) {
  const peakCount = getPeakCount(chunkStartSec, chunkEndSec, peaksPerSecond)
  return {
    meta: createChunkRecord(assetKey, peaksPerSecond, chunkStartSec, chunkEndSec, peakCount),
    data: resamplePeakPairs(source, peakCount),
  }
}

export function extractPeakAsset(buffer: AudioBuffer, assetKey: string) {
  const durationSec = Math.max(0, buffer.duration)
  const levelChunks = new Map<number, Array<{ meta: PeakChunkRecord; data: Uint8Array }>>()
  const highResChunks: Array<{ meta: PeakChunkRecord; data: Uint8Array }> = []
  const highResPps = HIGH_RES_PEAKS_PER_SECOND

  for (let chunkStartSec = 0; chunkStartSec < durationSec || (durationSec === 0 && chunkStartSec === 0); chunkStartSec += MAX_CHUNK_DURATION_SEC) {
    const chunkEndSec = durationSec === 0
      ? MAX_CHUNK_DURATION_SEC
      : Math.min(durationSec, chunkStartSec + MAX_CHUNK_DURATION_SEC)
    highResChunks.push(extractChunkPeaks(buffer, assetKey, chunkStartSec, chunkEndSec, highResPps))
    if (durationSec === 0) break
  }
  levelChunks.set(highResPps, highResChunks)

  for (const peaksPerSecond of PEAK_LEVELS_PER_SECOND.slice(1)) {
    levelChunks.set(
      peaksPerSecond,
      highResChunks.map((chunk) => resampleChunkPeaks(chunk.data, assetKey, chunk.meta.startSec, chunk.meta.endSec, peaksPerSecond)),
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
    assetKey,
    durationSec,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
    levels,
  }

  return {
    record,
    chunks: levels.flatMap((level) => levelChunks.get(level.peaksPerSecond) ?? []),
  }
}
