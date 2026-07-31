import { expect, test } from 'bun:test'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import { createDefaultLoFiParams, createDefaultReverbParams, createDefaultSynthParams, type TrackInstrumentParams } from '@daw-browser/shared'
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
  id: 'track', name: 'track', volume: 0.8, clips: [clip], ...overrides,
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

test('rejects unsupported MIDI source events without producing a partial session', () => {
  const midiClip = { ...clip, id: 'midi', midi: { wave: 'sine' as const, notes: [] } }
  const result = compile([track({ clips: [midiClip] })])
  expect(result).toMatchObject({
    supported: false,
    reasons: ['midi: MIDI clips are not supported.'],
  })
})

test('projects mixer state and routing topology into the native graph', () => {
  const result = compile([
    track({
      id: 'source',
      volume: 0.5,
      outputTargetId: 'group',
      sends: [{ targetId: 'return', amount: 0.25, tap: 'pre-fader' }],
    }),
    track({ id: 'group', channelRole: 'group', clips: [], volume: 0.75, soloed: true }),
    track({ id: 'return', channelRole: 'return', clips: [], volume: 0.8, muted: true }),
  ])

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'source')).toMatchObject({
    mixer: { gain: 0.5, muted: false, soloed: false },
  })
  expect(result.graph.nodes.find((node) => node.id === 'group')).toMatchObject({
    kind: 'group',
    mixer: { gain: 0.75, muted: false, soloed: false },
  })
  expect(result.graph.nodes.find((node) => node.id === 'return')).toMatchObject({
    kind: 'return',
    mixer: { gain: 0, muted: true, soloed: false },
  })
  expect(result.graph.edges).toContainEqual(expect.objectContaining({
    fromNodeId: 'source',
    toNodeId: 'group',
    kind: 'output',
    gain: 1,
  }))
  expect(result.graph.edges).toContainEqual(expect.objectContaining({
    fromNodeId: 'source',
    toNodeId: 'return',
    kind: 'send',
    tap: 'pre-fader',
    gain: 0.25,
  }))
  expect(result.events).toHaveLength(1)
  expect(result.events[0]?.sourceNodeId).toBe('source')
})

test('projects a synth instrument node for native MIDI playback', () => {
  const midiClip = {
    ...clip,
    id: 'midi',
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sawtooth' as const, notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.75 }] },
  }
  const instrument: TrackInstrumentParams = {
    kind: 'synth',
    instanceId: 'instrument:1',
    params: createDefaultSynthParams(),
  }
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [midiClip] })],
    fx: {
      masterFxInstances: [],
      trackFx: { track: { instances: [], instrument } },
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'track')).toMatchObject({
    kind: 'instrument',
    instrument: { kind: 'synth', outputLayout: 'stereo' },
  })
  expect(result.events).toHaveLength(0)
})

test('projects legacy synth state for native MIDI playback', () => {
  const midiClip = {
    ...clip,
    id: 'legacy-midi',
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sawtooth' as const, notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.75 }] },
  }
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [midiClip] })],
    fx: {
      masterFxInstances: [],
      trackFx: { track: { instances: [], synth: createDefaultSynthParams() } },
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'track')).toMatchObject({
    kind: 'instrument',
    instrument: { kind: 'synth', outputLayout: 'stereo' },
  })
})

test('projects native-owned reverb state instead of applying portable fixture gating', () => {
  const result = compileLiveNativeProjection({
    tracks: [track()],
    fx: {
      masterFxInstances: [{
        id: 'native-reverb',
        kind: 'reverb',
        params: createDefaultReverbParams(),
      }],
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === '$master')?.processorOrder).toEqual([
    expect.objectContaining({
      id: 'native-reverb',
      kind: 'reverb',
      kindId: 14,
      stateVersion: 1,
      state: expect.any(Uint8Array),
      latencyFrames: 0,
      tailFrames: expect.any(Number),
    }),
  ])
  const reverb = result.graph.nodes.find((node) => node.id === '$master')?.processorOrder[0]
  expect(reverb?.tailFrames).toBeGreaterThan(0)
  expect(reverb?.state.byteLength).toBe(72)
})

test('rejects active processors outside the native audio-core contract', () => {
  const result = compileLiveNativeProjection({
    tracks: [track()],
    fx: {
      masterFxInstances: [{
        id: 'active-lofi',
        kind: 'lofi',
        params: { version: 1, state: createDefaultLoFiParams() },
      }],
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })

  expect(result).toMatchObject({
    supported: false,
    reasons: ['active-lofi: processor "lofi" is not supported by the native audio core.'],
  })
})

test('retains empty audio tracks for graph topology without emitting source events', () => {
  const result = compileLiveNativeProjection({
    tracks: [
      track({ id: 'empty-audio', kind: 'audio', clips: [], volume: 0.8 }),
      track({ id: 'instrument', kind: 'instrument', clips: [] }),
    ],
    fx: {
      masterFxInstances: [],
      trackFx: {
        instrument: { instances: [], instrument: { kind: 'synth', instanceId: 'instrument:1', params: createDefaultSynthParams() } },
      },
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.map((node) => node.id)).toEqual(['empty-audio', 'instrument', '$master'])
  expect(result.events).toHaveLength(0)
})