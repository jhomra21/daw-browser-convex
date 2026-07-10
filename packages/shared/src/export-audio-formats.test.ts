import { describe, expect, test } from 'bun:test'
import { getExportAudioBitrate, getExportAudioFormatMetadata } from './export-audio-formats'

describe('export audio format metadata', () => {
  test('defines the intended lossy bitrate presets and defaults', () => {
    expect(getExportAudioFormatMetadata('mp3').bitratePresets).toEqual([128000, 192000, 256000, 320000])
    expect(getExportAudioBitrate('mp3')).toBe(192000)
    expect(getExportAudioFormatMetadata('ogg-opus').bitratePresets).toEqual([64000, 96000, 128000, 160000, 192000])
    expect(getExportAudioBitrate('ogg-opus')).toBe(128000)
  })

  test('keeps lossless formats free of user-facing bitrate metadata', () => {
    expect(getExportAudioFormatMetadata('wav').bitratePresets).toBeUndefined()
    expect(getExportAudioBitrate('wav')).toBeUndefined()
    expect(getExportAudioFormatMetadata('flac').bitratePresets).toBeUndefined()
    expect(getExportAudioBitrate('flac')).toBeUndefined()
  })
})
