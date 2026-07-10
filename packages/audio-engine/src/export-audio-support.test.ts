import { describe, expect, test } from 'bun:test'
import { getExportAudioEncodingConfig } from './export-audio-support'

describe('getExportAudioEncodingConfig', () => {
  test('uses exact render settings and configured lossy bitrate', () => {
    expect(getExportAudioEncodingConfig('mp3', {
      sampleRate: 96000,
      numberOfChannels: 1,
      bitrateByFormat: { mp3: 320000 },
    })).toEqual({
      sampleRate: 96000,
      numberOfChannels: 1,
      bitrate: 320000,
    })
  })

  test('provides valid defaults for Opus and FLAC', () => {
    expect(getExportAudioEncodingConfig('ogg-opus').bitrate).toBe(128000)
    expect(getExportAudioEncodingConfig('flac')).toEqual({
      sampleRate: 44100,
      numberOfChannels: 2,
      bitrate: 1411200,
    })
  })

  test('leaves PCM bitrate undefined', () => {
    expect(getExportAudioEncodingConfig('wav').bitrate).toBeUndefined()
  })
})
