import { describe, expect, test } from 'bun:test'

import { getMediaRecorderAuxiliaryCaptureOptions } from './track-recording-session'

describe('MediaRecorder auxiliary capture', () => {
  test('does not represent the compressed saved take as processed worklet PCM', () => {
    expect(getMediaRecorderAuxiliaryCaptureOptions()).toEqual({
      layout: 'mono',
      inputChannel: 0,
      gain: 1,
      polarity: 1,
      monitor: 'off',
      armed: false,
      savedAudioSource: 'media-recorder-unprocessed',
    })
  })
})
