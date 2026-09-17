import {
  createWaveformSourceFromBuffer,
  ensurePeakAsset,
  loadCachedPeakAsset,
  loadPeakChunkData,
} from './asset-store'
import { isWaveformChunkData, getPeakChunkRecord } from './peak-db'
import { peakAssetMatchesSourceIdentity } from './source-identity'
import type {
  PeakAssetRecord,
  PeakLevelRecord,
  WaveformByteIntervals,
  WaveformFloatIntervals,
  WaveformSamples,
  WaveformSourceData,
  WaveformSourceRequest,
} from './types'

const validFrameRange = (start: number, end: number) => (
  Number.isSafeInteger(start) && start >= 0
  && Number.isSafeInteger(end) && end >= start
)

const levelFor = (record: PeakAssetRecord, framesPerInterval: number) => (
  record.levels.find((level) => level.framesPerInterval === framesPerInterval)
)

const emptyIntervals = (record: PeakAssetRecord, level: PeakLevelRecord, start: number, end: number) => {
  const firstInterval = Math.floor(start / level.framesPerInterval)
  const lastInterval = Math.ceil(Math.max(start + 1, end) / level.framesPerInterval)
  const intervalCount = Math.max(1, lastInterval - firstInterval)
  return {
    firstInterval,
    intervalCount,
    firstFrame: firstInterval * level.framesPerInterval,
    intervalEndFrame: Math.min(record.frameCount, lastInterval * level.framesPerInterval),
  }
}

async function readPersistedIntervals(
  record: PeakAssetRecord,
  level: PeakLevelRecord,
  startFrame: number,
  endFrame: number,
  signal?: AbortSignal,
): Promise<WaveformByteIntervals> {
  const bounds = emptyIntervals(record, level, startFrame, endFrame)
  const channels = Array.from(
    { length: record.channelCount },
    () => new Uint8Array(bounds.intervalCount * 2),
  )
  channels.forEach((channel) => channel.fill(128))
  const firstChunk = Math.floor(bounds.firstInterval / level.intervalsPerChunk)
  const lastChunk = Math.floor((bounds.firstInterval + bounds.intervalCount - 1) / level.intervalsPerChunk)
  for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex += 1) {
    signal?.throwIfAborted()
    const meta = getPeakChunkRecord(
      record.assetKey,
      record.generationId,
      level,
      record.channelCount,
      chunkIndex,
    )
    const data = await loadPeakChunkData(meta.chunkKey)
    if (!data || !isWaveformChunkData(data, record.channelCount, meta.intervalCount)) {
      throw new Error('Waveform interval storage is incomplete or malformed.')
    }
    const overlapStart = Math.max(bounds.firstInterval, meta.intervalStart)
    const overlapEnd = Math.min(bounds.firstInterval + bounds.intervalCount, meta.intervalStart + meta.intervalCount)
    if (overlapEnd <= overlapStart) continue
    const sourceOffset = overlapStart - meta.intervalStart
    const targetOffset = overlapStart - bounds.firstInterval
    for (let channel = 0; channel < channels.length; channel += 1) {
      const source = data[channel]
      const target = channels[channel]
      if (source && target) {
        target.set(
          source.subarray(sourceOffset * 2, (sourceOffset + overlapEnd - overlapStart) * 2),
          targetOffset * 2,
        )
      }
    }
  }
  return {
    kind: 'intervals',
    encoding: 'signed-u8',
    channels,
    firstFrame: bounds.firstFrame,
    sampleRate: record.sampleRate,
    sourceFrameCount: record.frameCount,
    framesPerInterval: level.framesPerInterval,
    intervalCount: bounds.intervalCount,
  }
}

async function readPcm(
  request: WaveformSourceRequest,
): Promise<WaveformFloatIntervals | WaveformSamples | null> {
  const source = request.source
  if (!source) return null
  const startFrame = Math.max(0, Math.min(source.frameCount, request.sourceStartFrame))
  const endFrame = Math.max(startFrame, Math.min(source.frameCount, request.sourceEndFrame))
  if (endFrame <= startFrame) return null
  if (request.framesPerInterval === 1) {
    const channels = Array.from({ length: source.channelCount }, () => new Float32Array(endFrame - startFrame))
    let expectedFrame = startFrame
    for await (const page of source.readPages({ startFrame, endFrame, signal: request.signal })) {
      request.signal?.throwIfAborted()
      if (page.startFrame < expectedFrame
        || page.frameCount <= 0
        || page.startFrame + page.frameCount > endFrame
        || page.sampleRate !== source.sampleRate
        || page.channelCount !== source.channelCount
        || page.planes.length !== source.channelCount
        || page.planes.some((plane) => plane.length !== page.frameCount)) {
        throw new Error('Waveform source pages are unordered or malformed.')
      }
      const offset = page.startFrame - startFrame
      for (let channel = 0; channel < channels.length; channel += 1) {
        channels[channel]?.set(page.planes[channel] ?? new Float32Array(0), offset)
      }
      expectedFrame = page.startFrame + page.frameCount
    }
    return {
      kind: 'samples',
      channels,
      firstFrame: startFrame,
      sampleRate: source.sampleRate,
      sourceFrameCount: source.frameCount,
    }
  }
  const firstFrame = Math.floor(startFrame / request.framesPerInterval) * request.framesPerInterval
  const readEndFrame = Math.min(
    source.frameCount,
    Math.ceil(endFrame / request.framesPerInterval) * request.framesPerInterval,
  )
  const intervalCount = Math.max(1, Math.ceil((readEndFrame - firstFrame) / request.framesPerInterval))
  const mins = Array.from({ length: source.channelCount }, () => new Float32Array(intervalCount).fill(0))
  const maxs = Array.from({ length: source.channelCount }, () => new Float32Array(intervalCount).fill(0))
  const touched = new Uint8Array(intervalCount)
  const populated = new Uint8Array(intervalCount)
  let expectedFrame = firstFrame
  const markSilence = (silenceStart: number, silenceEnd: number) => {
    if (silenceEnd <= silenceStart) return
    const firstIndex = Math.max(
      0,
      Math.floor((silenceStart - firstFrame) / request.framesPerInterval),
    )
    const lastIndex = Math.min(
      intervalCount,
      Math.ceil((silenceEnd - firstFrame) / request.framesPerInterval),
    )
    for (let index = firstIndex; index < lastIndex; index += 1) {
      const wasTouched = touched[index] === 1
      touched[index] = 1
      for (let channel = 0; channel < source.channelCount; channel += 1) {
        if (!wasTouched) {
          mins[channel]![index] = 0
          maxs[channel]![index] = 0
          continue
        }
        mins[channel]![index] = Math.min(mins[channel]![index] ?? 0, 0)
        maxs[channel]![index] = Math.max(maxs[channel]![index] ?? 0, 0)
      }
    }
  }
  for await (const page of source.readPages({ startFrame: firstFrame, endFrame: readEndFrame, signal: request.signal })) {
    request.signal?.throwIfAborted()
    if (page.startFrame < expectedFrame
      || page.frameCount <= 0
      || page.startFrame + page.frameCount > readEndFrame
      || page.sampleRate !== source.sampleRate
      || page.channelCount !== source.channelCount
      || page.planes.length !== source.channelCount
      || page.planes.some((plane) => plane.length !== page.frameCount)) {
      throw new Error('Waveform source pages are unordered or malformed.')
    }
    markSilence(expectedFrame, page.startFrame)
    for (let frame = 0; frame < page.frameCount; frame += 1) {
      const index = Math.floor((page.startFrame + frame - firstFrame) / request.framesPerInterval)
      const wasTouched = touched[index] === 1
      const isFirstFrame = populated[index] !== 1
      touched[index] = 1
      populated[index] = 1
      for (let channel = 0; channel < source.channelCount; channel += 1) {
        const value = page.planes[channel]?.[frame] ?? 0
        if (isFirstFrame) {
          mins[channel]![index] = value
          maxs[channel]![index] = value
          if (wasTouched) {
            mins[channel]![index] = Math.min(mins[channel]![index] ?? 0, 0)
            maxs[channel]![index] = Math.max(maxs[channel]![index] ?? 0, 0)
          }
        } else {
          mins[channel]![index] = Math.min(mins[channel]![index] ?? 0, value)
          maxs[channel]![index] = Math.max(maxs[channel]![index] ?? 0, value)
        }
      }
    }
    expectedFrame = page.startFrame + page.frameCount
  }
  markSilence(expectedFrame, readEndFrame)
  const channels = mins.map((minimums, channel) => {
    const values = new Float32Array(intervalCount * 2)
    for (let index = 0; index < intervalCount; index += 1) {
      values[index * 2] = touched[index] ? minimums[index] ?? 0 : 0
      values[index * 2 + 1] = touched[index] ? maxs[channel]?.[index] ?? 0 : 0
    }
    return values
  })
  return {
    kind: 'intervals',
    encoding: 'float32',
    channels,
    firstFrame,
    sampleRate: source.sampleRate,
    sourceFrameCount: source.frameCount,
    framesPerInterval: request.framesPerInterval,
    intervalCount,
  }
}

export async function loadWaveformSourceData(
  request: WaveformSourceRequest,
): Promise<WaveformSourceData | null> {
  if (!validFrameRange(request.sourceStartFrame, request.sourceEndFrame)
    || request.sourceEndFrame <= request.sourceStartFrame
    || !Number.isSafeInteger(request.framesPerInterval)
    || request.framesPerInterval <= 0) return null
  const normalizedRequest = request.source || !request.buffer
    ? request
    : { ...request, source: createWaveformSourceFromBuffer(request.buffer) }
  const record = normalizedRequest.framesPerInterval > 1 && normalizedRequest.source?.persistable === true
    ? await ensurePeakAsset(normalizedRequest)
    : await loadCachedPeakAsset(normalizedRequest.assetKey)
  if (record && peakAssetMatchesSourceIdentity(record, normalizedRequest.sourceIdentity)) {
    const level = levelFor(record, normalizedRequest.framesPerInterval)
    if (level && level.framesPerInterval === normalizedRequest.framesPerInterval) {
      try {
        return await readPersistedIntervals(
          record,
          level,
          normalizedRequest.sourceStartFrame,
          normalizedRequest.sourceEndFrame,
          normalizedRequest.signal,
        )
      } catch (error) {
        if (!normalizedRequest.source || normalizedRequest.source.persistable !== true) throw error
        const regenerated = await ensurePeakAsset({ ...normalizedRequest, forceRegenerate: true })
        const regeneratedLevel = regenerated
          ? levelFor(regenerated, normalizedRequest.framesPerInterval)
          : undefined
        if (!regenerated || !regeneratedLevel) throw error
        return await readPersistedIntervals(
          regenerated,
          regeneratedLevel,
          normalizedRequest.sourceStartFrame,
          normalizedRequest.sourceEndFrame,
          normalizedRequest.signal,
        )
      }
    }
  }
  return await readPcm(normalizedRequest)
}
