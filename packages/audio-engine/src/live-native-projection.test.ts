import { expect, test } from 'bun:test'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultReverbParams,
  createDefaultSamplerParams,
  createDefaultSynthParams,
  type TrackInstrumentParams,
} from '@daw-browser/shared'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'
import { compileLiveNativeProjection } from './live-native-projection'

const defaultSamples = () => {
  const samples = new Float32Array(new ArrayBuffer(4 * Float32Array.BYTES_PER_ELEMENT))
  samples.set([0, 0.25, -0.5, 1])
  return samples
}

class TestAudioBuffer implements AudioBuffer {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
  readonly sampleRate: number

  constructor(
    private readonly channels: Float32Array<ArrayBuffer>[] = [
      defaultSamples(),
    ],
    sampleRate = 48_000,
  ) {
    this.length = channels[0]?.length ?? 0
    this.numberOfChannels = channels.length
    this.sampleRate = sampleRate
    this.duration = this.length / sampleRate
  }

  copyFromChannel(destination: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const source = this.channels[channel]
    if (!source) throw new Error(`Missing channel ${channel}.`)
    destination.set(source.subarray(offset, offset + destination.length))
  }
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number, offset = 0) {
    const destination = this.channels[channel]
    if (!destination) throw new Error(`Missing channel ${channel}.`)
    destination.set(source, offset)
  }
  getChannelData(_channel: number): Float32Array<ArrayBuffer> {
    const channel = this.channels[_channel]
    if (!channel) throw new Error(`Missing channel ${_channel}.`)
    return channel
  }
}

const buffer = new TestAudioBuffer()

const clip: Clip<AudioBuffer> = {
  id: 'clip', name: 'clip', color: '#fff', startSec: 0, duration: 1, sourceAssetKey: 'source', buffer,
}

const preparedStretchAsset = (clipId: string): PortablePreparedStretchAsset => {
  const assetId = `portable-stretch:1:${clipId}`
  const planes = [new Float32Array([1, 0.5, 0, -0.5])]
  return {
    clipId,
    sourceAssetKey: 'source',
    sourceDurationSec: buffer.duration,
    projectGeneration: 1,
    projectAssetId: assetId,
    portableAssetId: assetId,
    asset: {
      version: 1,
      assetId,
      frameCount: 4,
      sampleRateHz: 48_000,
      channelCount: 1,
    },
    pcm: { frameCount: 4, planes },
    transferables: planes.map((plane) => plane.buffer),
    timelineStartSec: 0,
    timelineDurationSec: buffer.duration,
    sourceStartSec: 0,
  }
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

test('chunks a 12-second stereo source into payload-safe native assets', () => {
  const frameCount = 12 * 48_000
  const longClip = {
    ...clip,
    duration: frameCount / 48_000,
    buffer: new TestAudioBuffer([
      new Float32Array(frameCount),
      new Float32Array(frameCount),
    ]),
  }
  const result = compile([track({ clips: [longClip] })])
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets.length).toBeGreaterThan(1)
  expect(result.assets.every(({ asset: entry }) => (
    entry.frameCount <= (entry.channelCount === 1 ? 262_138 : 131_069)
  ))).toBe(true)
  expect(result.nativePcmChunkDescriptors).toHaveLength(1)
  expect(result.nativePcmChunkDescriptors[0]?.chunks).toHaveLength(5)
  expect(result.events).toHaveLength(5)
})

test('skips source-exhausted clips without rejecting the native projection', () => {
  const result = compile([track({
    clips: [
      { ...clip, id: 'exhausted', bufferOffsetSec: 1 },
      { ...clip, id: 'playable' },
    ],
  })])

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.events).toHaveLength(1)
  expect(result.events[0]?.sourceNodeId).toBe('track')
  expect(result.events[0]?.sequence).toBe(1)
})

test('preserves external latency and route PDC in the native projection', () => {
  const result = compileLiveNativeProjection({
    tracks: [
      track({ id: 'fast' }),
      track({ id: 'slow' }),
    ],
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    externalLatencyFrames: new Map([['fast', 512]]),
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'fast')).toMatchObject({
    externalLatencyFrames: 512,
    latencyFrames: 0,
  })
  expect(result.graph.edges.find((edge) => edge.fromNodeId === 'fast')).toMatchObject({
    pdcDelayFrames: 0,
  })
  expect(result.graph.edges.find((edge) => edge.fromNodeId === 'slow')).toMatchObject({
    pdcDelayFrames: 512,
  })
})

test('projects prepared Stretch PCM instead of the raw source asset', () => {
  const warpedClip = {
    ...clip,
    audioWarp: { enabled: true, mode: 'stretch' as const, sourceBpm: 120 },
  }
  const prepared = preparedStretchAsset(warpedClip.id)
  const planes = prepared.pcm.planes
  const result = compileLiveNativeProjection({
    tracks: [track({ clips: [warpedClip] })],
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    projectGeneration: 1,
    preparedStretchAssets: [prepared],
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toEqual([expect.objectContaining({
    asset: expect.objectContaining({ assetId: prepared.asset.assetId }),
    pcm: { frameCount: 4, planes },
  })])
  expect(result.assets.some(({ asset }) => asset.assetId === 'portable-export:source')).toBeFalse()
  expect(result.events).toEqual([
    expect.objectContaining({ assetId: prepared.asset.assetId }),
  ])
})

test('keeps disabled Stretch warp on the raw source path', () => {
  const result = compile([track({
    clips: [{
      ...clip,
      audioWarp: { enabled: false, mode: 'stretch', sourceBpm: 120 },
    }],
  })])
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets[0]?.asset.assetId).toBe('portable-export:source')
  expect(result.events[0]?.assetId).toBe('portable-export:source')
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

test('projects empty sampled instruments for native MIDI playback', () => {
  const midiClip = {
    ...clip,
    id: 'empty-sampled-midi',
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sawtooth' as const, notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.75 }] },
  }
  const instruments: readonly TrackInstrumentParams[] = [
    { kind: 'sampler', instanceId: 'sampler:empty', params: createDefaultSamplerParams() },
    { kind: 'drum-rack', instanceId: 'drums:empty', params: createDefaultDrumRackParams() },
    { kind: 'granular', instanceId: 'granular:empty', params: createDefaultGranularParams() },
  ]
  for (const instrument of instruments) {
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
      instrument: { kind: instrument.kind, outputLayout: 'stereo' },
    })
    expect(result.events).toHaveLength(0)
  }
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

test('rejects instrument tracks without native instrument state', () => {
  const midiClip = {
    ...clip,
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sine' as const, notes: [] },
  }
  const result = compileLiveNativeProjection({
    tracks: [track({ id: 'instrument', kind: 'instrument', clips: [midiClip] })],
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

  expect(result).toMatchObject({
    supported: false,
    reasons: ['instrument: native instrument state is unavailable.'],
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

test('allows empty instrument tracks alongside prepared Stretch audio and mixer routing', () => {
  const stretchClip = {
    ...clip,
    id: 'stretch-clip',
    audioWarp: { enabled: true, mode: 'stretch' as const, sourceBpm: 120 },
  }
  const prepared = preparedStretchAsset(stretchClip.id)
  const audioTracks = Array.from({ length: 6 }, (_, index) => track({
    id: `audio-${index + 1}`,
    kind: 'audio',
    clips: index === 0 ? [stretchClip] : [],
    outputTargetId: 'group',
  }))
  const emptyInstrumentTracks = Array.from({ length: 4 }, (_, index) => track({
    id: `instrument-${index + 1}`,
    kind: 'instrument',
    clips: [],
    outputTargetId: 'group',
  }))
  const result = compileLiveNativeProjection({
    tracks: [
      ...audioTracks,
      ...emptyInstrumentTracks,
      track({ id: 'group', kind: 'audio', channelRole: 'group', clips: [] }),
      track({ id: 'return', kind: 'audio', channelRole: 'return', clips: [] }),
    ],
    fx: { masterFxInstances: [], trackFx: {} },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 12,
    epoch: 1,
    firstSequence: 1,
    projectGeneration: 1,
    preparedStretchAssets: [prepared],
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.map((node) => node.id)).toEqual([
    'audio-1', 'audio-2', 'audio-3', 'audio-4', 'audio-5', 'audio-6',
    'instrument-1', 'instrument-2', 'instrument-3', 'instrument-4',
    'group', 'return', '$master',
  ])
  expect(result.graph.nodes.slice(6, 10).map((node) => node.kind)).toEqual([
    'source', 'source', 'source', 'source',
  ])
  expect(result.graph.edges).toContainEqual(expect.objectContaining({
    fromNodeId: 'instrument-1',
    toNodeId: 'group',
    kind: 'output',
  }))
  expect(result.assets).toEqual([expect.objectContaining({
    asset: expect.objectContaining({ assetId: prepared.asset.assetId }),
  })])
  expect(result.events).toEqual([
    expect.objectContaining({
      sourceNodeId: 'audio-1',
      assetId: prepared.asset.assetId,
    }),
  ])
})
