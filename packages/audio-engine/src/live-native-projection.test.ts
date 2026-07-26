import { expect, test } from 'bun:test'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { compileLiveNativeProjection } from './live-native-projection'

class TestAudioBuffer implements AudioBuffer {
  readonly duration = 4 / 48_000
  readonly length = 4
  readonly numberOfChannels = 1
  readonly sampleRate = 48_000
  private readonly samples = new Float32Array([0, 0.25, -0.5, 1])
  copyFromChannel(destination: Float32Array, _channel: number, offset = 0) {
    destination.set(this.samples.subarray(offset, offset + destination.length))
  }
  copyToChannel(source: Float32Array, _channel: number, offset = 0) {
    this.samples.set(source, offset)
  }
  getChannelData(_channel: number) {
    return this.samples
  }
}

const buffer = new TestAudioBuffer()

const clip: Clip<AudioBuffer> = {
  id: 'clip', name: 'clip', color: '#fff', startSec: 0, duration: 1, sourceAssetKey: 'source', buffer,
}

const track = (overrides: Partial<Track<AudioBuffer>> = {}): Track<AudioBuffer> => ({
  id: 'track', name: 'track', volume: 1, clips: [clip], ...overrides,
})

const compile = (tracks: readonly Track<AudioBuffer>[]) => compileLiveNativeProjection({
  tracks, bpm: 120, sampleRateHz: 48_000, revision: 1, epoch: 1, firstSequence: 1,
})

test('projects deterministic copied PCM for supported source-only sessions', () => {
  const result = compile([track()])
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toEqual([expect.objectContaining({
    asset: expect.objectContaining({ assetId: 'portable-export:source' }),
    pcm: expect.objectContaining({ planes: [new Float32Array([0, 0.25, -0.5, 1])] }),
  })])
  expect(result.events).toHaveLength(1)
})

test('rejects routing and MIDI instead of producing a partial session', () => {
  const midiClip = { ...clip, id: 'midi', midi: { wave: 'sine' as const, notes: [] } }
  const result = compile([track({ volume: 0.5, clips: [midiClip] })])
  expect(result).toEqual({
    supported: false,
    reasons: ['track: routing and mix state are not supported.'],
  })
})
