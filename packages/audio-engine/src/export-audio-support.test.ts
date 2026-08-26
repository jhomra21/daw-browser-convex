import { describe, expect, test } from 'bun:test'
import { Quality } from 'mediabunny'
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
      quality: new Quality({ bitrate: 320000 }),
    })
  })

  test('provides a Quality bitrate for Opus and no bitrate for FLAC', () => {
    expect(getExportAudioEncodingConfig('ogg-opus').quality).toEqual(new Quality({ bitrate: 128000 }))
    expect(getExportAudioEncodingConfig('flac')).toEqual({
      sampleRate: 44100,
      numberOfChannels: 2,
      quality: undefined,
    })
  })

  test('leaves PCM quality undefined', () => {
    expect(getExportAudioEncodingConfig('wav').quality).toBeUndefined()
  })
})
