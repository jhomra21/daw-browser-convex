import { ensurePeakAsset, loadPeakChunkData } from '~/lib/audio-peaks/asset-store'
import { SILENCE_BYTE } from '~/lib/audio-peaks/extract-peaks'
import { resamplePeakPairs } from '~/lib/audio-peaks/resample-peak-pairs'
import type { PeakAssetRecord, PeakChunkRecord, PeakLevelRecord, WaveformSliceRequest } from '~/lib/audio-peaks/types'

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

async function loadWindowSourceData(level: PeakLevelRecord, window: WaveformWindow) {
  const source = new Uint8Array(window.peakCount * 2)
  source.fill(SILENCE_BYTE)
  if (window.endSec <= window.startSec) return source

  for (const chunk of level.chunks) {
    if (chunk.endSec <= window.startSec || chunk.startSec >= window.endSec) continue
    const data = await loadPeakChunkData(chunk.chunkKey)
    if (!data) continue
    const overlapStartSec = Math.max(window.startSec, chunk.startSec)
    const overlapEndSec = Math.min(window.endSec, chunk.endSec)
    const sourceStartOffset = getWindowStartOffset(chunk, overlapStartSec, level.peaksPerSecond)
    const sourceEndOffset = getWindowEndOffset(chunk, overlapEndSec, level.peaksPerSecond)
    const copyBins = Math.max(0, sourceEndOffset - sourceStartOffset)
    if (copyBins <= 0) continue
    const targetStartOffset = Math.max(0, Math.floor((overlapStartSec - window.startSec) * level.peaksPerSecond))
    const availableBins = Math.min(copyBins, window.peakCount - targetStartOffset)
    if (availableBins <= 0) continue
    source.set(
      data.subarray(sourceStartOffset * 2, (sourceStartOffset + availableBins) * 2),
      targetStartOffset * 2,
    )
  }

  return source
}

function resampleWindow(source: Uint8Array, bins: number) {
  return resamplePeakPairs(source, bins)
}

export async function getWaveformSlice(request: WaveformSliceRequest): Promise<Uint8Array | null> {
  const record = await ensurePeakAsset(request)
  if (!record) return null
  const startSec = Math.max(0, request.sourceStartSec)
  const endSec = Math.max(startSec, Math.min(record.durationSec, request.sourceEndSec))
  const level = selectPeakLevel(record, request, startSec, endSec)
  if (!level) return null
  const window = getWaveformWindow(level, record, request)
  const source = await loadWindowSourceData(level, window)
  return resampleWindow(source, request.bins)
}
