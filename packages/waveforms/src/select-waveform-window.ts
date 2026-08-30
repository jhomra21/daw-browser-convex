import { ensurePeakAsset, loadPeakChunkData } from './asset-store'
import { SILENCE_BYTE } from './extract-peaks'
import { resamplePeakPairs } from './resample-peak-pairs'
import type {
  PeakAssetRecord,
  PeakChunkRecord,
  PeakLevelRecord,
  WaveformPeakChannelSlice,
  WaveformSliceRequest,
} from './types'

type WaveformWindow = {
  startSec: number
  endSec: number
  peakCount: number
}

function getRequestedPeaksPerSecond(request: WaveformSliceRequest, startSec: number, endSec: number) {
  const durationSec = Math.max(0.001, endSec - startSec)
  return Math.max(1, request.bins / durationSec)
}

function selectPeakLevel(record: PeakAssetRecord, request: WaveformSliceRequest, startSec: number, endSec: number) {
  const levels = record.levels.slice().sort((a, b) => a.peaksPerSecond - b.peaksPerSecond)
  if (levels.length === 0) return null
  const requestedPeaksPerSecond = getRequestedPeaksPerSecond(request, startSec, endSec)
  for (const level of levels) {
    if (level.peaksPerSecond >= requestedPeaksPerSecond) return level
  }
  return levels[levels.length - 1]
}

function getWaveformWindow(level: PeakLevelRecord, record: PeakAssetRecord, request: WaveformSliceRequest): WaveformWindow {
  const startSec = Math.max(0, request.sourceStartSec)
  const endSec = Math.max(startSec, Math.min(record.durationSec, request.sourceEndSec))
  return {
    startSec,
    endSec,
    peakCount: Math.max(1, Math.ceil(Math.max(0, endSec - startSec) * level.peaksPerSecond)),
  }
}

function getWindowStartOffset(chunk: PeakChunkRecord, windowStartSec: number, peaksPerSecond: number) {
  return Math.max(0, Math.floor((windowStartSec - chunk.startSec) * peaksPerSecond))
}

function getWindowEndOffset(chunk: PeakChunkRecord, windowEndSec: number, peaksPerSecond: number) {
  return Math.min(chunk.peakCount, Math.ceil((windowEndSec - chunk.startSec) * peaksPerSecond))
}

const channelByteOffset = (channel: number, peakCount: number) => channel * peakCount * 2

async function loadWindowSourceData(
  level: PeakLevelRecord,
  record: PeakAssetRecord,
  window: WaveformWindow,
): Promise<Uint8Array | null> {
  const source = new Uint8Array(window.peakCount * record.channelCount * 2)
  source.fill(SILENCE_BYTE)
  if (window.endSec <= window.startSec) return source

  for (const chunk of level.chunks) {
    if (chunk.endSec <= window.startSec || chunk.startSec >= window.endSec) continue
    const data = await loadPeakChunkData(chunk.chunkKey)
    if (!data) continue
    if (data.length !== chunk.peakCount * record.channelCount * 2) return null

    const overlapStartSec = Math.max(window.startSec, chunk.startSec)
    const overlapEndSec = Math.min(window.endSec, chunk.endSec)
    const sourceStartOffset = getWindowStartOffset(chunk, overlapStartSec, level.peaksPerSecond)
    const sourceEndOffset = getWindowEndOffset(chunk, overlapEndSec, level.peaksPerSecond)
    const copyBins = Math.max(0, sourceEndOffset - sourceStartOffset)
    if (copyBins <= 0) continue
    const targetStartOffset = Math.max(0, Math.floor((overlapStartSec - window.startSec) * level.peaksPerSecond))
    const availableBins = Math.min(copyBins, window.peakCount - targetStartOffset)
    if (availableBins <= 0) continue

    for (let channel = 0; channel < record.channelCount; channel += 1) {
      const chunkChannelStart = channelByteOffset(channel, chunk.peakCount)
      const sourceStart = chunkChannelStart + sourceStartOffset * 2
      const sourceEnd = sourceStart + availableBins * 2
      const targetStart = channelByteOffset(channel, window.peakCount) + targetStartOffset * 2
      source.set(data.subarray(sourceStart, sourceEnd), targetStart)
    }
  }

  return source
}

function resampleWindowChannels(
  source: Uint8Array,
  sourceBins: number,
  channelCount: number,
  targetBins: number,
): WaveformPeakChannelSlice {
  const columns = Math.max(1, Math.floor(targetBins))
  const channels = Array.from({ length: channelCount }, (_, channel) => {
    const start = channelByteOffset(channel, sourceBins)
    return resamplePeakPairs(source.subarray(start, start + sourceBins * 2), columns)
  })
  return { channels, columns }
}

function collapsePeakChannels(slice: WaveformPeakChannelSlice) {
  const output = new Uint8Array(slice.columns * 2)
  for (let column = 0; column < slice.columns; column += 1) {
    let min = 255
    let max = 0
    for (const channel of slice.channels) {
      const channelMin = channel[column * 2] ?? SILENCE_BYTE
      const channelMax = channel[column * 2 + 1] ?? SILENCE_BYTE
      if (channelMin < min) min = channelMin
      if (channelMax > max) max = channelMax
    }
    output[column * 2] = min
    output[column * 2 + 1] = max
  }
  return output
}

export async function getWaveformChannelSlice(request: WaveformSliceRequest): Promise<WaveformPeakChannelSlice | null> {
  const record = await ensurePeakAsset(request)
  if (!record) return null
  const startSec = Math.max(0, request.sourceStartSec)
  const endSec = Math.max(startSec, Math.min(record.durationSec, request.sourceEndSec))
  const level = selectPeakLevel(record, request, startSec, endSec)
  if (!level) return null
  const window = getWaveformWindow(level, record, request)
  const source = await loadWindowSourceData(level, record, window)
  return source ? resampleWindowChannels(source, window.peakCount, record.channelCount, request.bins) : null
}

export async function getWaveformSlice(request: WaveformSliceRequest): Promise<Uint8Array | null> {
  const slice = await getWaveformChannelSlice(request)
  return slice ? collapsePeakChannels(slice) : null
}
