import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { getPeakChunkRecord, createPeakAssetRecord } from './extract-peaks'
import {
  getPeakChunkRecord as getStoredPeakChunkRecord,
  isWaveformChunkData,
  loadPeakAssetRecord,
  loadPeakChunk,
  storePeakAssetRecord,
  storePeakChunk,
} from './peak-db'

describe('waveform persistence contracts', () => {
  test('stores validated metadata and exact interval-count chunks', async () => {
    const record = createPeakAssetRecord({
      durationSec: 1,
      frameCount: 48_000,
      sampleRate: 48_000,
      channelCount: 2,
    }, 'db-contract')
    await storePeakAssetRecord(record)
    const loaded = await loadPeakAssetRecord(record.assetKey)
    expect(loaded?.formatVersion).toBe(record.formatVersion)
    const meta = getStoredPeakChunkRecord(record.assetKey, record.generationId, record.levels[0]!, record.channelCount, 0)
    const data = [new Uint8Array(meta.intervalCount * 2), new Uint8Array(meta.intervalCount * 2)]
    await storePeakChunk(meta.chunkKey, data)
    expect(isWaveformChunkData(data, 2, meta.intervalCount)).toBe(true)
    expect(isWaveformChunkData([new Uint8Array(2)], 2, meta.intervalCount)).toBe(false)
    expect(await loadPeakChunk(meta.chunkKey)).toEqual(data)
    expect(getPeakChunkRecord(record.assetKey, record.generationId, record.levels[0]!, record.channelCount, 0).chunkKey).toBe(meta.chunkKey)
  })
})
