import { describe, expect, test } from 'bun:test'
import { getExportAudioBitrate, getExportAudioFormatMetadata, isLossyExportAudioFormat } from './export-audio-formats'

describe('export audio format metadata', () => {
  test('defines the intended lossy bitrate presets and defaults', () => {
    expect(getExportAudioFormatMetadata('mp3').bitratePresets).toEqual([128000, 192000, 256000, 320000])
    expect(getExportAudioBitrate('mp3')).toBe(192000)
    expect(isLossyExportAudioFormat('mp3')).toBe(true)
    expect(getExportAudioFormatMetadata('ogg-opus').bitratePresets).toEqual([64000, 96000, 128000, 160000, 192000])
    expect(getExportAudioBitrate('ogg-opus')).toBe(128000)
    expect(isLossyExportAudioFormat('ogg-opus')).toBe(true)
  })

  test('keeps lossless formats free of user-facing bitrate metadata', () => {
    expect(getExportAudioFormatMetadata('wav').bitratePresets).toBeUndefined()
    expect(getExportAudioBitrate('wav')).toBeUndefined()
    expect(isLossyExportAudioFormat('wav')).toBe(false)
    expect(getExportAudioFormatMetadata('flac').bitratePresets).toBeUndefined()
    expect(getExportAudioBitrate('flac')).toBeUndefined()
  })
})
