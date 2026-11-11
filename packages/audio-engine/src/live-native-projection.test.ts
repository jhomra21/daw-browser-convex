import { expect, test } from 'bun:test'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import {
  createDefaultDrumRackParams,
  createDefaultGranularParams,
  createDefaultReverbParams,
  createDefaultSamplerParams,
  createDefaultSynthParams,
  type DrumRackParams,
  type GranularParams,
  type SamplerParams,
  type SamplerZone,
  type TrackInstrumentParams,
} from '@daw-browser/shared'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'
import { compileLiveNativeProjection } from './live-native-projection'
import { localizeInstrumentFx } from './portable-export-snapshot'
import { sampledInstrumentRegionIdentity } from './sampled-instrument-region'
import { mapNativeSessionAssets, serializeNativeInstrumentStates } from './native-host-wire'
import type { ExportFx } from './export-mixdown'

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

test('r3 multi-track shared-sample projection preserves fixed pre-r2 output and native bytes', () => {
  const shared = new TestAudioBuffer([new Float32Array(4800).fill(0.2), new Float32Array(4800).fill(-0.3)])
  const sample: SamplerZone['sample'] = { assetKey: 'instrument-only', url: '/sample.wav', sourceKind: 'upload',
    source: { durationSec: 0.1, sampleRate: 48000, channelCount: 2 } }
  const zone: SamplerZone = { id: 'zone', sample, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127,
    rootNote: 60, tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 0, roundRobinIndex: 0,
    playbackMode: 'one-shot', startSec: 0, endSec: 0.1, crossfadeSec: 0, chokeGroup: 0 }
  const secondZone = { ...zone, sample: { ...sample, assetKey: 'second', url: '/second.wav' } }
  const pad = { ...createDefaultDrumRackParams().pads[0]!, sample, endSec: 0.1 }
  const fx: ExportFx = {
    masterVolume: 1, masterFxInstances: [], trackFx: {
      s1: { instances: [], instrument: { kind: 'sampler', instanceId: 's1', params: { ...createDefaultSamplerParams(), zones: [zone] } },
        samplerBuffers: new Map([['zone', { buffer: shared, sourceStartFrame: 0 }]]) },
      g1: { instances: [], instrument: { kind: 'granular', instanceId: 'g1', params: { ...createDefaultGranularParams(), zone } },
        granularBuffer: { buffer: shared, sourceStartFrame: 0, assetKey: sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 0, sourceEndFrame: 4800 }) } },
      d1: { instances: [], instrument: { kind: 'drum-rack', instanceId: 'd1', params: { ...createDefaultDrumRackParams(), pads: [pad] } },
        drumRackBuffers: new Map([[pad.id, { buffer: shared, sourceStartFrame: 0 }]]) },
      s2: { instances: [], instrument: { kind: 'sampler', instanceId: 's2', params: { ...createDefaultSamplerParams(), zones: [secondZone] } },
        samplerBuffers: new Map([['zone', { buffer: shared, sourceStartFrame: 0 }]]) },
      synth: { instances: [], instrument: { kind: 'synth', instanceId: 'synth', params: createDefaultSynthParams() } },
    },
  }
  const tracks = [track(), ...['s1', 'g1', 'd1', 's2', 'synth'].map(id => track({ id, kind: 'instrument',
    clips: [{ id: `midi-${id}`, name: 'MIDI', color: '#fff', startSec: 0, duration: 1,
      midi: { wave: 'sawtooth', notes: [{ pitch: 60, beat: 0, length: 0.5, velocity: 0.8 }] } }],
  }))]
  // Golden output is captured from the reviewer's exact pre-r2 compiler, not another implementation in this test.
  for (const mode of [undefined, 'metadata'] satisfies readonly (undefined | 'metadata')[]) {
    const result = compileLiveNativeProjection({ tracks, fx: localizeInstrumentFx(fx), bpm: 120, sampleRateHz: 48000,
      revision: 1, epoch: 1, firstSequence: 1, instrumentRegionMode: mode })
    if (!result.supported) throw new Error(result.reasons.join('\n'))
    const configurations = result.graph.nodes.flatMap(node => node.instrument ? [{ nodeId: node.id, state: node.instrument }] : [])
    const assets = mapNativeSessionAssets(result.assets.map(asset => asset.asset))
    const nativeBytes = serializeNativeInstrumentStates(configurations, assets)
    expect(configurations).toHaveLength(5)
    expect(result.assets).toHaveLength(3)
    expect(nativeBytes.byteLength).toBe(844)
    expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(result)).digest('hex')).toBe(mode === 'metadata'
      ? '712cdba46a8236f23bce490682810aa9f1f9275a1246a70498800c82fb2b1d73'
      : '11a38547ee2acb840c9a364848a5318b66d9f45a12e9672a1d0790c6a55bd169')
    expect(Buffer.from(nativeBytes).toString('base64')).toBe('BQAAAEnReLUH/9gIAgAAAFgAAABQAAAAAAAAAAEAAAABAAAAAACgQAAAyEIAAIA/AADwQgEAAAAAAAAAAECcRjMzMz8AAAAAAACgQAAAFkMAAAAAAAAWQwAAAAAAAKBAAAAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAQAAAAAAAAB/AAAAAQAAAH8AAAA8AAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAAAAAMASAAAAAAAAAAAAAAAAAAAAAAAAAAAAABUSP7UHB5UIBAAAADwAAAAAAAAAAAAAAAEAAAABAAAAAQAAAAEAAABAAAAAAAAAAAAAAAAAAKBCAABAQQAAAD/NzMw9AAAAAAAAAAAAAAA/AAAAACb1O7UHf5EIAwAAAFgAAABQAAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAIA/AADAQAAAAAAAAAAAAECcRjMzMz8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAQAAACQAAAAkAAAAAQAAAH8AAAAkAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAAAAAMASAAAAAAAAAAAAAAAAAAAAAAAAAAAAADDMeLUH/NgIAgAAAFgAAABQAAAAAAAAAAEAAAABAAAAAACgQAAAyEIAAIA/AADwQgEAAAAAAAAAAECcRjMzMz8AAAAAAACgQAAAFkMAAAAAAAAWQwAAAAAAAKBAAAAAAAAAAAAAAAAAAAAAAAEAAAACAAAAAQAAAAAAAAB/AAAAAQAAAH8AAAA8AAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAAAAAMASAAAAAAAAAAAAAAAAAAAAAAAAAAAAALlAKTXXUqN/AQAAAJwAAAAAAAAAAAAAAAEAAABsMUGjAQAAAAIAAAAzMzM/AAAAAAAAAAAAAODAAQAAAAIAAABmZuY+AAAAAAAAAAAAAOBAAAAAAAAAgD4BAAAAAAAAAACAO0YzMzM/AAAAAAAAAAAAAKBAAAAWQwAAAAAAABZDAACgQAAAyELNzEw/AADwQgAAAAAAAAAAAACgQAAAAAAAAAAAAAAAAAAAAADNzEw/AAAAAA==')
    expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(assets)).digest('hex')).toBe('cab941814c37c6af6fffd2a9c187bce1aa4dd245fa62760aac42b8421ed25778')
  }
})

test('projects source metadata without copying ordinary PCM', () => {
  const result = compile([track()])
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toEqual([expect.objectContaining({
    asset: expect.objectContaining({ assetId: 'portable-export:source' }),
    pcm: undefined,
    sourceAssetKey: 'source',
  })])
  expect(result.events).toHaveLength(1)
})

test('keeps long ordinary sources as one metadata asset', () => {
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
  expect(result.assets).toHaveLength(1)
  expect(result.assets[0]?.asset.frameCount).toBe(frameCount)
  expect(result.assets[0]?.pcm).toBeUndefined()
  expect(result.nativePcmChunkDescriptors).toHaveLength(0)
  expect(result.events).toHaveLength(1)
})

test('keeps long mono source assets mono while projecting a stereo mixer bus', () => {
  const frameCount = 12 * 48_000
  const longClip = {
    ...clip,
    duration: frameCount / 48_000,
    buffer: new TestAudioBuffer([new Float32Array(frameCount)]),
  }
  const result = compile([track({ clips: [longClip] })])
  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets).toEqual([expect.objectContaining({
    asset: expect.objectContaining({
      assetId: 'portable-export:source',
      frameCount,
      channelCount: 1,
    }),
    pcm: undefined,
  })])
  expect(result.nativePcmChunkDescriptors).toHaveLength(0)
  expect(result.graph.nodes.find((node) => node.id === 'track')).toMatchObject({
    inputLayout: 'stereo',
    outputLayout: 'stereo',
  })
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
  const midiClip: Clip<AudioBuffer> = {
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

test('localizes bounded sampler regions for native MIDI playback', () => {
  const midiClip = {
    ...clip,
    id: 'sampled-midi',
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sawtooth', notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.75 }] },
  }
  const sample: SamplerZone['sample'] = {
    assetKey: 'source-a',
    url: 'https://samples.example/source.wav',
    sourceKind: 'url',
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
  }
  const params: SamplerParams = {
    ...createDefaultSamplerParams(),
    zones: [{
      id: 'zone-1',
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'forward-loop',
      startSec: 0.5,
      endSec: 1,
      crossfadeSec: 0,
      chokeGroup: 0,
    }],
  }
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [midiClip] })],
    fx: localizeInstrumentFx({
      masterFxInstances: [],
      trackFx: {
        track: {
          instances: [],
          instrument: { kind: 'sampler', instanceId: 'sampler-1', params },
          samplerBuffers: new Map([['zone-1', {
            buffer: new TestAudioBuffer([new Float32Array(24_000)]),
            sourceStartFrame: 24_000,
          }]]),
        },
      },
    })!,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets[0]?.asset).toMatchObject({
    frameCount: 24_000,
    sampleRateHz: 48_000,
    channelCount: 1,
  })
  expect(result.graph.nodes.find((node) => node.id === 'track')?.instrument).toMatchObject({
    kind: 'sampler',
    zones: [{ startFrame: 0, endFrame: 24_000 }],
  })
})

test('exposes localized instrument buffers in opt-in metadata mode without timeline clips', () => {
  const sample: SamplerZone['sample'] = {
    assetKey: 'source-a',
    url: 'https://samples.example/source.wav',
    sourceKind: 'url',
    source: { durationSec: 2, sampleRate: 48_000, channelCount: 1 },
  }
  const params: SamplerParams = {
    ...createDefaultSamplerParams(),
    zones: [{
      id: 'zone-1',
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startSec: 0,
      endSec: 1,
      crossfadeSec: 0,
      chokeGroup: 0,
    }, {
      id: 'zone-2',
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'forward-loop',
      startSec: 0,
      endSec: 1,
      crossfadeSec: 0,
      chokeGroup: 0,
    }, {
      id: 'zone-3',
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'forward-loop',
      startSec: 0.5,
      endSec: 1.5,
      loopStartSec: 0.75,
      loopEndSec: 1.25,
      crossfadeSec: 0,
      chokeGroup: 0,
    }],
  }
  const firstSamples = new Float32Array(48_000).fill(0.5)
  firstSamples[0] = 0.25
  const secondSamples = new Float32Array(48_000).fill(-0.5)
  secondSamples[0] = -0.25
  const firstRegion = new TestAudioBuffer([firstSamples])
  const region = new TestAudioBuffer([secondSamples])
  const fx = localizeInstrumentFx({
    masterFxInstances: [],
    trackFx: {
      track: {
        instances: [],
        instrument: { kind: 'sampler', instanceId: 'sampler-1', params },
        samplerBuffers: new Map([
          ['zone-1', { buffer: firstRegion, sourceStartFrame: 0 }],
          ['zone-2', { buffer: firstRegion, sourceStartFrame: 0 }],
          ['zone-3', { buffer: region, sourceStartFrame: 24_000 }],
        ]),
      },
    },
  })
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [] })],
    fx,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    instrumentRegionMode: 'metadata',
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.assets[0]?.pcm).toBeUndefined()
  expect(result.instrumentRegionSources).toHaveLength(2)
  expect(result.instrumentRegionSources?.map(({ sourceAssetKey }) => sourceAssetKey)).toEqual([
    sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 0, sourceEndFrame: 48_000 }),
    sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 24_000, sourceEndFrame: 72_000 }),
  ])
  expect(result.instrumentRegionSources?.map(({ buffer: source }) => source)).toEqual([
    firstRegion,
    region,
  ])
  expect(result.assets.map(({ asset }) => asset.frameCount)).toEqual([48_000, 48_000])
  expect(result.graph.nodes.find((node) => node.id === 'track')?.instrument).toMatchObject({
    kind: 'sampler',
    zones: [
      { startFrame: 0, endFrame: 48_000 },
      { startFrame: 0, endFrame: 48_000 },
      { startFrame: 0, endFrame: 48_000, loopStartFrame: 12_000, loopEndFrame: 36_000 },
    ],
  })
})

test('exposes localized drum-rack and granular buffers in metadata mode', () => {
  const sample: SamplerZone['sample'] = {
    assetKey: 'shared-source',
    url: 'https://samples.example/source.wav',
    sourceKind: 'url',
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
  }
  const drumParams: DrumRackParams = {
    ...createDefaultDrumRackParams(),
    pads: createDefaultDrumRackParams().pads.map((pad, index) => index < 2
      ? { ...pad, sample, startSec: index * 0.5, endSec: (index + 1) * 0.5 }
      : pad),
  }
  const firstDrumRegion = new TestAudioBuffer([new Float32Array(24_000).fill(0.1)])
  const secondDrumRegion = new TestAudioBuffer([new Float32Array(24_000).fill(0.7)])
  const drumFx = localizeInstrumentFx({
    masterFxInstances: [],
    trackFx: {
      track: {
        instances: [],
        instrument: { kind: 'drum-rack', instanceId: 'drums-1', params: drumParams },
        drumRackBuffers: new Map([
          ['pad-36', { buffer: firstDrumRegion, sourceStartFrame: 0 }],
          ['pad-37', { buffer: secondDrumRegion, sourceStartFrame: 24_000 }],
        ]),
      },
    },
  })
  const drumResult = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [] })],
    fx: drumFx,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    instrumentRegionMode: 'metadata',
  })
  if (!drumResult.supported) throw new Error(drumResult.reasons.join('\n'))
  expect(drumResult.instrumentRegionSources?.map(({ sourceAssetKey }) => sourceAssetKey)).toEqual([
    sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 0, sourceEndFrame: 24_000 }),
    sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 24_000, sourceEndFrame: 48_000 }),
  ])
  expect(drumResult.instrumentRegionSources?.map(({ buffer: source }) => source)).toEqual([
    firstDrumRegion,
    secondDrumRegion,
  ])
  expect(drumResult.graph.nodes.find((node) => node.id === 'track')?.instrument).toMatchObject({
    kind: 'drum-rack',
    zones: [{ startFrame: 0, endFrame: 24_000 }, { startFrame: 0, endFrame: 24_000 }],
  })

  const granularParams: GranularParams = {
    ...createDefaultGranularParams(),
    zone: {
      id: 'granular-zone',
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startSec: 0.25,
      endSec: 0.75,
      crossfadeSec: 0,
      chokeGroup: 0,
    },
  }
  const granularRegion = new TestAudioBuffer([new Float32Array(24_000).fill(0.3)])
  const granularFx = localizeInstrumentFx({
    masterFxInstances: [],
    trackFx: {
      track: {
        instances: [],
        instrument: { kind: 'granular', instanceId: 'granular-1', params: granularParams },
        granularBuffer: {
          assetKey: sample.assetKey,
          buffer: granularRegion,
          sourceStartFrame: 12_000,
        },
      },
    },
  })
  const localizedGranularZone = granularFx?.trackFx?.track?.instrument?.kind === 'granular'
    ? granularFx.trackFx.track.instrument.params.zone
    : undefined
  if (!localizedGranularZone) throw new Error('Expected localized granular zone.')
  const granularResult = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [] })],
    fx: granularFx,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    instrumentRegionMode: 'metadata',
  })
  if (!granularResult.supported) throw new Error(granularResult.reasons.join('\n'))
  expect(granularResult.instrumentRegionSources?.map(({ sourceAssetKey }) => sourceAssetKey)).toEqual([
    sampledInstrumentRegionIdentity(sample, { sourceStartFrame: 12_000, sourceEndFrame: 36_000 }),
  ])
  expect(granularResult.instrumentRegionSources?.[0]?.buffer).toBe(granularRegion)
  expect(granularResult.graph.nodes.find((node) => node.id === 'track')?.instrument).toMatchObject({
    kind: 'granular',
    assetId: granularResult.assets[0]?.asset.assetId,
  })
})

test('projects the available Drum Rack pad when another sample is missing', () => {
  const sample: SamplerZone['sample'] = {
    assetKey: 'available-pad',
    url: 'https://samples.example/available.wav',
    sourceKind: 'url',
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
  }
  const params = createDefaultDrumRackParams()
  const firstPad = params.pads[0]
  const secondPad = params.pads[1]
  if (!firstPad || !secondPad) throw new Error('Expected default drum pads.')
  const drumParams: DrumRackParams = {
    ...params,
    pads: [
      { ...firstPad, sample: { ...sample, assetKey: 'missing-pad' } },
      { ...secondPad, sample },
    ],
  }
  const fx = localizeInstrumentFx({
    masterFxInstances: [],
    trackFx: {
      track: {
        instances: [],
        instrument: { kind: 'drum-rack', instanceId: 'drums-missing-pad', params: drumParams },
        drumRackBuffers: new Map([
          ['pad-37', { buffer: new TestAudioBuffer([new Float32Array(48_000)]), sourceStartFrame: 0 }],
        ]),
        unavailableSampleAssetKeys: ['missing-pad'],
      },
    },
  })
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [] })],
    fx,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'track')?.instrument).toMatchObject({
    kind: 'drum-rack',
    zones: [{ keyLow: secondPad.note, keyHigh: secondPad.note }],
  })
})

test('rejects inconsistent dimensions for a shared instrument-region identity', () => {
  const sample: SamplerZone['sample'] = {
    assetKey: 'same-region',
    url: 'https://samples.example/source.wav',
    sourceKind: 'url',
    source: { durationSec: 1, sampleRate: 48_000, channelCount: 1 },
  }
  const params: SamplerParams = {
    ...createDefaultSamplerParams(),
    zones: ['zone-1', 'zone-2'].map((id): SamplerZone => ({
      id,
      sample,
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startSec: 0,
      endSec: 1,
      crossfadeSec: 0,
      chokeGroup: 0,
    })),
  }
  const result = compileLiveNativeProjection({
    tracks: [track({ kind: 'instrument', clips: [] })],
    fx: {
      masterFxInstances: [],
      trackFx: {
        track: {
          instances: [],
          instrument: { kind: 'sampler', instanceId: 'sampler-1', params },
          samplerBuffers: new Map([
            ['zone-1', { buffer: new TestAudioBuffer([new Float32Array(48_000)]), sourceStartFrame: 0 }],
            ['zone-2', {
              buffer: new TestAudioBuffer([
                new Float32Array(48_000),
                new Float32Array(48_000),
              ]),
              sourceStartFrame: 0,
            }],
          ]),
        },
      },
    },
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
    instrumentRegionMode: 'metadata',
  })

  expect(result).toMatchObject({
    supported: false,
    reasons: ['Instrument region "same-region" resolves inconsistently.'],
  })
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

test('routes eight-second stereo sampler regions through explicit native metadata', () => {
  const midiClip = {
    ...clip,
    sourceAssetKey: undefined,
    buffer: undefined,
    midi: { wave: 'sine' as const, notes: [] },
  }
  const params: SamplerParams = {
    ...createDefaultSamplerParams(),
    zones: [{
      id: 'long-zone',
      sample: {
        assetKey: 'long-sample',
        url: 'local-asset:long-sample',
        sourceKind: 'upload',
        source: { durationSec: 8, sampleRate: 48_000, channelCount: 2 },
      },
      keyLow: 0,
      keyHigh: 127,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: 60,
      tuneCents: 0,
      gain: 1,
      pan: 0,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startSec: 0,
      endSec: 8,
      crossfadeSec: 0,
      chokeGroup: 0,
    }],
  }
  const result = compileLiveNativeProjection({
    instrumentRegionMode: 'metadata',
    tracks: [track({ kind: 'instrument', clips: [midiClip] })],
    fx: localizeInstrumentFx({
      masterFxInstances: [],
      trackFx: {
        track: {
          instances: [],
          instrument: { kind: 'sampler', instanceId: 'sampler:long', params },
          samplerBuffers: new Map([['long-zone', {
            buffer: new TestAudioBuffer([
              new Float32Array(8 * 48_000),
              new Float32Array(8 * 48_000),
            ]),
            sourceStartFrame: 0,
          }]]),
        },
      },
    })!,
    bpm: 120,
    sampleRateHz: 48_000,
    revision: 1,
    epoch: 1,
    firstSequence: 1,
  })
  expect(result.supported).toBe(true)
  if (!result.supported) throw new Error(result.reasons.join(' '))
  expect(result.assets[0]?.asset.frameCount).toBe(8 * 48_000)
  expect(result.assets[0]?.pcm).toBeUndefined()
  expect(result.instrumentRegionSources).toHaveLength(1)
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

test('projects a default synth for instrument tracks without instrument state', () => {
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

  if (!result.supported) throw new Error(result.reasons.join('\n'))
  expect(result.graph.nodes.find((node) => node.id === 'instrument')).toMatchObject({
    kind: 'instrument',
    instrument: { kind: 'synth', outputLayout: 'stereo' },
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
