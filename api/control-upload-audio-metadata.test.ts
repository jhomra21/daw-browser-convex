import { expect, test } from 'bun:test'
import { Input, InputTrack } from 'mediabunny'
import { AudioUploadValidationError, inspectControlUploadAudioMetadata } from './control-upload-audio-metadata'

const wavFile = (sampleRate = 44_100, channelCount = 2) => {
  const frames = 441
  const data = new Uint8Array(frames * channelCount * 2)
  const bytes = new Uint8Array(44 + data.byteLength)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, 0x52494646)
  header.setUint32(4, bytes.byteLength - 8, true)
  header.setUint32(8, 0x57415645)
  header.setUint32(12, 0x666d7420)
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, channelCount, true)
  header.setUint32(24, sampleRate, true)
  header.setUint32(28, sampleRate * channelCount * 2, true)
  header.setUint16(32, channelCount * 2, true)
  header.setUint16(34, 16, true)
  header.setUint32(36, 0x64617461)
  header.setUint32(40, data.byteLength, true)
  bytes.set(data, 44)
  return new File([bytes], 'fixture.wav', { type: 'audio/wav' })
}

const mp3File = () => {
  const frame = new Uint8Array(72).fill(0x55)
  frame.set([0xff, 0xe3, 0x18, 0xc4], 0)
  frame.set([0, 0, 0, 3, 72, 0, 0, 0, 0, 76, 65, 77, 69, 51, 46, 57, 57, 46, 53], 4)
  const bytes = new Uint8Array(frame.byteLength * 5)
  for (let index = 0; index < 5; index += 1) bytes.set(frame, index * frame.byteLength)
  return new File([bytes], 'fixture.mp3', { type: 'audio/mpeg' })
}

test('inspects deterministic WAV bytes and returns trusted metadata', async () => {
  await expect(inspectControlUploadAudioMetadata({
    file: wavFile(),
    declaredMimeType: 'audio/wav',
  })).resolves.toMatchObject({
    durationSec: 0.01,
    sampleRate: 44_100,
    channelCount: 2,
    detectedFormat: 'WAVE',
  })
})

test('inspects a deterministic compressed MP3 fixture when Mediabunny supports it', async () => {
  await expect(inspectControlUploadAudioMetadata({
    file: mp3File(),
    declaredMimeType: 'audio/mpeg',
  })).resolves.toMatchObject({
    durationSec: 0.36,
    sampleRate: 8_000,
    channelCount: 1,
    detectedFormat: 'MP3',
  })
})

test('does not traverse packets to obtain upload duration', async () => {
  const originalComputeDuration = InputTrack.prototype.computeDuration
  InputTrack.prototype.computeDuration = async () => {
    throw new Error('packet traversal is forbidden')
  }
  try {
    await expect(inspectControlUploadAudioMetadata({
      file: wavFile(),
      declaredMimeType: 'audio/wav',
    })).resolves.toMatchObject({ durationSec: 0.01 })
  } finally {
    InputTrack.prototype.computeDuration = originalComputeDuration
  }
})

test('falls back to metadata-only packet duration when container metadata is absent', async () => {
  const originalGetDurationFromMetadata = InputTrack.prototype.getDurationFromMetadata
  const originalComputeDuration = InputTrack.prototype.computeDuration
  let options: Parameters<InputTrack['computeDuration']>[0]
  InputTrack.prototype.getDurationFromMetadata = async () => null
  InputTrack.prototype.computeDuration = async (nextOptions) => {
    options = nextOptions
    return 1.55
  }
  try {
    await expect(inspectControlUploadAudioMetadata({
      file: wavFile(),
      declaredMimeType: 'audio/wav',
    })).resolves.toMatchObject({ durationSec: 1.55 })
    expect(options).toEqual({ metadataOnly: true, skipLiveWait: true })
  } finally {
    InputTrack.prototype.getDurationFromMetadata = originalGetDurationFromMetadata
    InputTrack.prototype.computeDuration = originalComputeDuration
  }
})

test('rejects spoofed MIME, malformed bytes, and media without audio', async () => {
  const valid = wavFile()
  await expect(inspectControlUploadAudioMetadata({
    file: new File([await valid.arrayBuffer()], 'fixture.mp3', { type: 'audio/mpeg' }),
    declaredMimeType: 'audio/mpeg',
  })).rejects.toThrow('declared audio MIME type')
  await expect(inspectControlUploadAudioMetadata({
    file: new File([new Uint8Array([1, 2, 3])], 'fixture.wav', { type: 'audio/wav' }),
    declaredMimeType: 'audio/wav',
  })).rejects.toThrow()
  await expect(inspectControlUploadAudioMetadata({
    file: wavFile(44_100, 0),
    declaredMimeType: 'audio/wav',
  })).rejects.toThrow()
})

test('propagates an unexpected Mediabunny parser failure', async () => {
  const originalGetFormat = Input.prototype.getFormat
  Input.prototype.getFormat = async () => {
    throw new Error('unexpected parser failure')
  }
  try {
    await expect(inspectControlUploadAudioMetadata({
      file: wavFile(),
      declaredMimeType: 'audio/wav',
    })).rejects.toThrow('unexpected parser failure')
    await expect(inspectControlUploadAudioMetadata({
      file: wavFile(),
      declaredMimeType: 'audio/wav',
    })).rejects.not.toBeInstanceOf(AudioUploadValidationError)
  } finally {
    Input.prototype.getFormat = originalGetFormat
  }
})

test('rejects unsupported decoded metadata', async () => {
  await expect(inspectControlUploadAudioMetadata({
    file: wavFile(500_000, 2),
    declaredMimeType: 'audio/wav',
  })).rejects.toThrow('sample rate')
  await expect(inspectControlUploadAudioMetadata({
    file: wavFile(44_100, 65),
    declaredMimeType: 'audio/wav',
  })).rejects.toThrow('channel count')
})
