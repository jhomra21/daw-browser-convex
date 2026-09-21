import type { AudioPcmSourceDescriptor, DecodedAudioPage } from '@daw-browser/audio-engine/media-pages'
import {
  peakAssetFormatVersion,
  waveformIntervalsPerChunk,
  type PeakAssetRecord,
  type PeakChunkRecord,
  type PeakLevelRecord,
  type WaveformChunkData,
  type WaveformSourceIdentity,
} from './types'
import { peakChunkKey } from './peak-db'
export { getPeakChunkRecord } from './peak-db'

export const SILENCE_BYTE = 128
export const encodePeakByte = (value: number) => {
  const clipped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
  return clipped < 0
    ? Math.max(0, Math.min(127, Math.round(128 + clipped * 128)))
    : Math.min(255, Math.round(128 + clipped * 127))
}
export const decodePeakByte = (value: number) => {
  const clipped = Number.isFinite(value) ? Math.max(0, Math.min(255, Math.round(value))) : SILENCE_BYTE
  return clipped < SILENCE_BYTE
    ? (clipped - SILENCE_BYTE) / SILENCE_BYTE
    : (clipped - SILENCE_BYTE) / (255 - SILENCE_BYTE)
}

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const nonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0
let generationSequence = 0

const createGenerationId = () => {
  generationSequence += 1
  return `${Date.now().toString(36)}-${generationSequence.toString(36)}`
}

export const finestFramesPerInterval = (sampleRate: number) => {
  if (!positiveInteger(sampleRate)) throw new Error('Waveform sample rate is invalid.')
  let span = 1
  const target = sampleRate / 400
  while (span < target) span *= 2
  return span
}

export const createPeakLevels = (frameCount: number, sampleRate: number): PeakLevelRecord[] => {
  if (!nonNegativeInteger(frameCount) || !positiveInteger(sampleRate)) {
    throw new Error('Waveform source metadata is invalid.')
  }
  const levels: PeakLevelRecord[] = []
  let framesPerInterval = finestFramesPerInterval(sampleRate)
  let intervalCount = Math.max(1, Math.ceil(frameCount / framesPerInterval))
  while (true) {
    levels.push({
      framesPerInterval,
      intervalCount,
      intervalsPerChunk: waveformIntervalsPerChunk,
      chunkCount: Math.max(1, Math.ceil(intervalCount / waveformIntervalsPerChunk)),
    })
    if (intervalCount <= 1) break
    framesPerInterval *= 2
    intervalCount = Math.max(1, Math.ceil(frameCount / framesPerInterval))
  }
  return levels
}

export const createWaveformTierFrames = (frameCount: number, sampleRate: number) => (
  createPeakLevels(frameCount, sampleRate).map((level) => level.framesPerInterval)
)

export const createWaveformRequestTierFrames = (frameCount: number, sampleRate: number) => {
  const finest = finestFramesPerInterval(sampleRate)
  const transient: number[] = []
  for (let framesPerInterval = 2; framesPerInterval < finest; framesPerInterval *= 2) {
    transient.push(framesPerInterval)
  }
  return [1, ...transient, ...createWaveformTierFrames(frameCount, sampleRate)]
}

export function createPeakAssetRecord(
  source: Pick<AudioPcmSourceDescriptor, 'durationSec' | 'frameCount' | 'sampleRate' | 'channelCount'>,
  assetKey: string,
  sourceIdentity?: WaveformSourceIdentity,
): PeakAssetRecord {
  if (!nonNegativeInteger(source.frameCount)
    || !positiveInteger(source.sampleRate)
    || !positiveInteger(source.channelCount)
    || !Number.isFinite(source.durationSec)
    || source.durationSec < 0) throw new Error('Waveform source metadata is invalid.')
  return {
    formatVersion: peakAssetFormatVersion,
    assetKey,
    generationId: createGenerationId(),
    frameCount: source.frameCount,
    durationSec: source.durationSec,
    sampleRate: source.sampleRate,
    channelCount: source.channelCount,
    sourceIdentity,
    levels: createPeakLevels(source.frameCount, source.sampleRate),
  }
}

type MutableInterval = { min: number; max: number; touched: boolean }
type LevelState = {
  level: PeakLevelRecord
  nextInterval: number
  chunk: Uint8Array[]
  chunkIndex: number
}

const createState = (level: PeakLevelRecord, channelCount: number): LevelState => ({
  level,
  nextInterval: 0,
  chunk: Array.from(
    { length: channelCount },
    () => new Uint8Array(level.intervalsPerChunk * 2),
  ),
  chunkIndex: 0,
})

const appendChunkValue = (
  state: LevelState,
  values: readonly { min: number; max: number }[],
  onChunk: (chunk: ExtractedPeakChunk) => Promise<void>,
  assetKey: string,
  generationId: string,
) => {
  const chunkOffset = state.nextInterval % state.level.intervalsPerChunk
  for (let channel = 0; channel < state.chunk.length; channel += 1) {
    const value = values[channel] ?? { min: 0, max: 0 }
    const output = state.chunk[channel]
    if (!output) continue
    output[chunkOffset * 2] = encodePeakByte(value.min)
    output[chunkOffset * 2 + 1] = encodePeakByte(value.max)
  }
  state.nextInterval += 1
  const chunkIntervalCount = Math.min(
    state.level.intervalsPerChunk,
    state.level.intervalCount - state.chunkIndex * state.level.intervalsPerChunk,
  )
  if (state.nextInterval % state.level.intervalsPerChunk !== 0
    && state.nextInterval < state.level.intervalCount) return Promise.resolve()
  const meta: PeakChunkRecord = {
    chunkKey: peakChunkKey(assetKey, generationId, state.level.framesPerInterval, state.chunkIndex),
    generationId,
    framesPerInterval: state.level.framesPerInterval,
    chunkIndex: state.chunkIndex,
    intervalStart: state.chunkIndex * state.level.intervalsPerChunk,
    intervalCount: chunkIntervalCount,
    channelCount: state.chunk.length,
  }
  const data = state.chunk.map((channel) => channel.slice(0, chunkIntervalCount * 2))
  state.chunkIndex += 1
  state.chunk = state.chunk.map(() => new Uint8Array(state.level.intervalsPerChunk * 2))
  return onChunk({ meta, data })
}

const includeValue = (interval: MutableInterval, value: number) => {
  if (!interval.touched) {
    interval.min = value
    interval.max = value
    interval.touched = true
    return
  }
  interval.min = Math.min(interval.min, value)
  interval.max = Math.max(interval.max, value)
}

const validatePage = (
  page: DecodedAudioPage,
  source: AudioPcmSourceDescriptor,
  previousEndFrame: number,
) => {
  if (!Number.isSafeInteger(page.startFrame)
    || page.startFrame < previousEndFrame
    || !positiveInteger(page.frameCount)
    || page.startFrame + page.frameCount > source.frameCount
    || page.sampleRate !== source.sampleRate
    || page.channelCount !== source.channelCount
    || page.planes.length !== source.channelCount
    || page.planes.some((plane) => plane.length !== page.frameCount)) {
    throw new Error('Waveform source pages are unordered or malformed.')
  }
}

export type ExtractedPeakChunk = { meta: PeakChunkRecord; data: WaveformChunkData }

export async function extractPeakAsset(
  source: AudioPcmSourceDescriptor,
  assetKey: string,
  options: {
    readonly signal?: AbortSignal
    readonly onChunk: (chunk: ExtractedPeakChunk) => Promise<void>
    readonly onGeneration?: (record: PeakAssetRecord) => void | Promise<void>
  },
  sourceIdentity?: WaveformSourceIdentity,
) {
  const record = createPeakAssetRecord(source, assetKey, sourceIdentity)
  await options.onGeneration?.(record)
  const states = record.levels.map((level) => createState(level, source.channelCount))
  const parentReducers = record.levels.map(() => (
    Array.from(
      { length: source.channelCount },
      () => ({ min: 0, max: 0, touched: false, childCount: 0 }),
    )
  ))

  const emitInterval = async (levelIndex: number, values: readonly { min: number; max: number }[]) => {
    const state = states[levelIndex]
    if (!state) return
    await appendChunkValue(state, values, options.onChunk, assetKey, record.generationId)
    if (levelIndex + 1 >= states.length) return
    const parent = parentReducers[levelIndex + 1]
    if (!parent) return
    let shouldEmit = false
    for (let channel = 0; channel < source.channelCount; channel += 1) {
      const value = values[channel] ?? { min: 0, max: 0 }
      const accumulator = parent[channel]
      if (!accumulator) continue
      includeValue(accumulator, value.min)
      includeValue(accumulator, value.max)
      accumulator.childCount += 1
      if (accumulator.childCount === 2) shouldEmit = true
    }
    if (!shouldEmit) return
    const parentValues = parent.map((channel) => ({
      min: channel.min,
      max: channel.max,
    }))
    for (const channel of parent) {
      channel.min = 0
      channel.max = 0
      channel.touched = false
      channel.childCount = 0
    }
    await emitInterval(levelIndex + 1, parentValues)
  }

  const baseSpan = record.levels[0]?.framesPerInterval ?? finestFramesPerInterval(source.sampleRate)
  const baseInterval = Array.from(
    { length: source.channelCount },
    () => ({ min: 0, max: 0, touched: false }),
  )
  let baseIntervalFrames = 0

  const flushBaseInterval = async () => {
    const values = baseInterval.map((interval) => (
      interval.touched ? { min: interval.min, max: interval.max } : { min: 0, max: 0 }
    ))
    await emitInterval(0, values)
    for (const interval of baseInterval) {
      interval.min = 0
      interval.max = 0
      interval.touched = false
    }
    baseIntervalFrames = 0
  }

  const appendSilence = async (frameCount: number) => {
    let remaining = frameCount
    while (remaining > 0) {
      const take = Math.min(remaining, baseSpan - baseIntervalFrames)
      for (const interval of baseInterval) includeValue(interval, 0)
      baseIntervalFrames += take
      remaining -= take
      if (baseIntervalFrames === baseSpan) await flushBaseInterval()
    }
  }

  const appendPage = async (page: DecodedAudioPage) => {
    for (let frame = 0; frame < page.frameCount; frame += 1) {
      for (let channel = 0; channel < source.channelCount; channel += 1) {
        includeValue(baseInterval[channel] ?? { min: 0, max: 0 }, page.planes[channel]?.[frame] ?? 0)
      }
      baseIntervalFrames += 1
      if (baseIntervalFrames === baseSpan) await flushBaseInterval()
    }
  }

  let previousPageEnd = 0
  for await (const page of source.readPages({ startFrame: 0, endFrame: source.frameCount, signal: options.signal })) {
    options.signal?.throwIfAborted()
    validatePage(page, source, previousPageEnd)
    options.signal?.throwIfAborted()
    await appendSilence(page.startFrame - previousPageEnd)
    await appendPage(page)
    previousPageEnd = page.startFrame + page.frameCount
  }
  await appendSilence(source.frameCount - previousPageEnd)
  if (baseIntervalFrames > 0 || (states[0]?.nextInterval ?? 0) === 0) {
    await flushBaseInterval()
  }
  while ((states[0]?.nextInterval ?? 0) < (record.levels[0]?.intervalCount ?? 1)) {
    await flushBaseInterval()
  }
  for (let levelIndex = 1; levelIndex < states.length; levelIndex += 1) {
    const parent = parentReducers[levelIndex]
    if (!parent?.some((channel) => channel.childCount > 0)) continue
    const values = parent.map((channel) => (
      channel.childCount > 0
        ? { min: channel.min, max: channel.max }
        : { min: 0, max: 0 }
    ))
    for (const channel of parent) {
      channel.min = 0
      channel.max = 0
      channel.touched = false
      channel.childCount = 0
    }
    await emitInterval(levelIndex, values)
  }
  if (states.some((state) => state.nextInterval !== state.level.intervalCount)) {
    throw new Error('Waveform hierarchy interval counts are inconsistent.')
  }
  return record
}
