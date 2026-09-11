import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { createPeakAssetRecord } from './extract-peaks'
import { loadPeakAssetRecord, loadPeakChunk, PEAK_DB_VERSION, storePeakAssetRecord, storePeakChunk } from './peak-db'
import { peakAssetFormatVersion } from './types'

describe('channel-aware peak persistence', () => {
  test('discards the collapsed v2 schema during the v3 upgrade', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('audio-peaks-db')
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('audio-peaks-db', 2)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('asset-meta')
        request.result.createObjectStore('asset-chunks')
      }
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['asset-meta', 'asset-chunks'], 'readwrite')
        tx.objectStore('asset-meta').put({
          assetKey: 'legacy',
          durationSec: 1,
          sampleRate: 48_000,
          channelCount: 1,
          levels: [],
        }, 'legacy')
        tx.objectStore('asset-chunks').put(new Uint8Array([0, 255]), 'legacy:400:0')
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
      request.onerror = () => reject(request.error)
    })
    expect(await loadPeakAssetRecord('legacy')).toBeNull()
    expect(await loadPeakChunk('legacy:400:0')).toBeNull()
  })

  test('uses the recreated schema and round-trips channel planes', async () => {
    expect(PEAK_DB_VERSION).toBe(3)
    const record = createPeakAssetRecord({
      durationSec: 1,
      sampleRate: 48_000,
      channelCount: 2,
    }, 'round-trip', {
      assetKey: 'round-trip',
      identity: 'fixture',
    })
    expect(record.formatVersion).toBe(peakAssetFormatVersion)
    await storePeakAssetRecord(record)
    await storePeakChunk('round-trip:400:fixture:0', [
      Uint8Array.from([0, 255]),
      Uint8Array.from([255, 0]),
    ])
    expect(await loadPeakAssetRecord('round-trip')).toEqual(record)
    expect(await loadPeakChunk('round-trip:400:fixture:0')).toEqual([
      Uint8Array.from([0, 255]),
      Uint8Array.from([255, 0]),
    ])
  })
})
