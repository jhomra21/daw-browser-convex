import { afterEach, describe, expect, test } from 'bun:test'
import { automationTargetKey, createDefaultDelayParams, createDefaultDrumRackParams, createDefaultSaturatorParams, type AutomationEnvelope } from '@daw-browser/shared'
import { createSourceAutomationScope, createStemRenderPlan, downmixStereoBufferToMono, encodeAudioBuffer, getAudioBufferPeak, isAutomationEnvelopeInSourceScope, normalizeAudioBufferInPlace, renderMixdown, resolveExportMixerGraph, type ExportFx } from './export-mixdown'
import type { ResolvedMixerChannel, ResolvedMixerGraph } from './mixer/types'
import type { AudioEffectRuntimeInstance } from './effects/runtime-instance'
import { resolveLiveMixerGraph } from './live-mixer-runtime'
import type { Clip, Track } from '@daw-browser/timeline-core/types'
import type { WavEncodingSettings } from './export-fidelity'

const originalOfflineAudioContext = globalThis.OfflineAudioContext

afterEach(() => {
  Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, value: originalOfflineAudioContext })
})

const channel = (
  id: string,
  options: {
    outputTargetId?: string
    sends?: { targetId: string; amount: number }[]
    role?: 'track' | 'group' | 'return'
  } = {},
): ResolvedMixerChannel => ({
  channel: {
    id,
    name: id,
    role: options.role ?? 'track',
    volume: 1,
    muted: false,
    soloed: false,
    sends: options.sends ?? [],
    outputTargetId: options.outputTargetId,
  },
  gain: 1,
  outputGain: 1,
  outputTargetId: options.outputTargetId,
  sends: options.sends ?? [],
  inputLayout: 'stereo',
  outputLayout: 'stereo',
})

const master: ResolvedMixerGraph['master'] = { volume: 1, instances: [], inputLayout: 'stereo', outputLayout: 'stereo' }

describe('createSourceAutomationScope', () => {
  test('includes sends reachable through output ancestors', () => {
    const graph: ResolvedMixerGraph = {
      channels: [
        channel('source', { outputTargetId: 'group' }),
        channel('group', {
          sends: [{ targetId: 'return', amount: 1 }],
        }),
        channel('return'),
        channel('unrelated'),
      ],
      master,
    }

    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: false,
    })

    expect(scope.includeMasterFx).toBe(false)
    expect(scope.trackIds).toEqual(new Set(['source', 'group', 'return']))
  })

  test('follows send targets through their output paths and sends', () => {
    const graph: ResolvedMixerGraph = {
      channels: [
        channel('source', {
          sends: [{ targetId: 'return-a', amount: 1 }],
        }),
        channel('return-a', {
          outputTargetId: 'group',
          sends: [{ targetId: 'return-b', amount: 1 }],
        }),
        channel('group'),
        channel('return-b'),
      ],
      master,
    }

    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: true,
    })

    expect(scope.trackIds).toEqual(new Set(['source', 'return-a', 'group', 'return-b']))
  })
})

describe('explicit stem render plans', () => {
  const graph: ResolvedMixerGraph = {
    channels: [
      channel('source', {
        outputTargetId: 'group-a',
        sends: [{ targetId: 'return-a', amount: 1 }],
      }),
      channel('detector'),
      channel('other', { outputTargetId: 'group-a' }),
      channel('group-a', {
        outputTargetId: 'group-b',
        sends: [{ targetId: 'return-b', amount: 1 }],
        role: 'group',
      }),
      channel('group-b', { role: 'group' }),
      channel('return-a', {
        outputTargetId: 'group-b',
        sends: [{ targetId: 'return-b', amount: 1 }],
        role: 'return',
      }),
      channel('return-b', { role: 'return' }),
      channel('unrelated'),
    ],
    master,
  }

  test('distinguishes dry, post-FX, reachable, and full-master source semantics', () => {
    const dry = createStemRenderPlan(graph, { id: 'source', name: 'Source', mode: 'dry-source', targetTrackId: 'source' })
    expect(dry.sourceTrackIds).toEqual(new Set(['source']))
    expect(dry.graph.channels.find((entry) => entry.channel.id === 'source')?.fx).toBeUndefined()
    expect(dry.graph.channels.find((entry) => entry.channel.id === 'source')?.sends).toEqual([])
    expect(dry.graph.channels.find((entry) => entry.channel.id === 'source')?.outputTargetId).toBeUndefined()

    const postFx = createStemRenderPlan(graph, { id: 'source', name: 'Source', mode: 'post-track-fx', targetTrackId: 'source' })
    expect(postFx.graph.channels.find((entry) => entry.channel.id === 'source')?.outputTargetId).toBeUndefined()
    expect(postFx.graph.channels.find((entry) => entry.channel.id === 'source')?.sends).toEqual([])

    const reachable = createStemRenderPlan(graph, { id: 'source', name: 'Source', mode: 'reachable-routing', targetTrackId: 'source' })
    expect(reachable.sourceTrackIds).toEqual(new Set(['source']))
    expect(reachable.graph.master.volume).toBe(1)

    const full = createStemRenderPlan(graph, { id: 'source', name: 'Source', mode: 'full-master-contribution', targetTrackId: 'source' })
    expect(full.graph.master).toBe(graph.master)
  })

  test('collects channel-output upstream sources once across nested outputs and sends', () => {
    const plan = createStemRenderPlan(graph, {
      id: 'group-b',
      name: 'Group B',
      mode: 'channel-output',
      targetTrackId: 'group-b',
    })
    expect(plan.sourceTrackIds).toEqual(new Set(['source', 'other', 'group-a', 'group-b', 'return-a']))
    expect(plan.sourceTrackIds.has('unrelated')).toBe(false)
    expect(plan.graph.channels.find((entry) => entry.channel.id === 'group-b')?.outputTargetId).toBeUndefined()
  })

  test('adds sidechain sources as detector-only and never as audible sources', () => {
    const plan = createStemRenderPlan(
      graph,
      { id: 'source', name: 'Source', mode: 'reachable-routing', targetTrackId: 'source' },
      [{ sourceTrackId: 'detector', targetTrackId: 'group-a', effectInstanceId: 'compressor' }],
    )
    expect(plan.sourceTrackIds).toEqual(new Set(['source']))
    expect(plan.detectorOnlyTrackIds).toEqual(new Set(['detector']))
    expect(plan.graph.channels.find((entry) => entry.channel.id === 'detector')?.outputGain).toBe(0)
    expect(plan.graph.channels.find((entry) => entry.channel.id === 'detector')?.sends).toEqual([])
  })

  test('preserves mute and solo exclusion while removing the dry-source fader', () => {
    const mutedSource = channel('muted')
    mutedSource.channel.muted = true
    mutedSource.gain = 0
    mutedSource.outputGain = 0
    const excludedBySolo = channel('excluded')
    excludedBySolo.outputGain = 0
    const dryGraph: ResolvedMixerGraph = { channels: [mutedSource, excludedBySolo], master }

    const muted = createStemRenderPlan(dryGraph, { id: 'muted', name: 'Muted', mode: 'dry-source', targetTrackId: 'muted' })
    const excluded = createStemRenderPlan(dryGraph, { id: 'excluded', name: 'Excluded', mode: 'dry-source', targetTrackId: 'excluded' })
    expect(muted.graph.channels[0]?.gain).toBe(0)
    expect(excluded.graph.channels[1]?.gain).toBe(0)
  })

  test('marks full-master stems non-recombinable with shared nonlinear processing', () => {
    const nonlinearGraph: ResolvedMixerGraph = {
      ...graph,
      master: { ...master, instances: [{ id: 'master-saturator', kind: 'saturator', params: { ...createDefaultSaturatorParams(), enabled: true } }] },
    }
    const plan = createStemRenderPlan(nonlinearGraph, {
      id: 'source',
      name: 'Source',
      mode: 'full-master-contribution',
      targetTrackId: 'source',
    })
    expect(plan.metadata.recombinesToMaster).toBe(false)
  })
})

describe('runtime-only cue routing', () => {
  test('is explicitly rejected by offline export', async () => {
    await expect(renderMixdown({
      tracks: [],
      bpm: 120,
      range: { mode: 'custom', startSec: 0, endSec: 1 },
      cueTrackIds: ['track-1'],
    })).rejects.toThrow('Cue routing is live-only and cannot be exported.')
  })
})

describe('offline default synth scheduling', () => {
  test('renders fresh instrument tracks with default synth params and skips explicit non-synth instruments', async () => {
    type Event = { kind: 'set' | 'ramp' | 'cancel'; value?: number; time: number }
    type Param = {
      value: number
      events: Event[]
      setValueAtTime: (value: number, time: number) => void
      linearRampToValueAtTime: (value: number, time: number) => void
      exponentialRampToValueAtTime: (value: number, time: number) => void
      setTargetAtTime: (value: number, time: number, timeConstant: number) => void
      cancelScheduledValues: (time: number) => void
      cancelAndHoldAtTime: (time: number) => void
    }
    const param = (): Param => {
      const events: Event[] = []
      return {
        value: 0,
        events,
        setValueAtTime: (value, time) => { events.push({ kind: 'set', value, time }) },
        linearRampToValueAtTime: (value, time) => { events.push({ kind: 'ramp', value, time }) },
        exponentialRampToValueAtTime: (value, time) => { events.push({ kind: 'ramp', value, time }) },
        setTargetAtTime: (value, time) => { events.push({ kind: 'ramp', value, time }) },
        cancelScheduledValues: (time) => { events.push({ kind: 'cancel', time }) },
        cancelAndHoldAtTime: (time) => { events.push({ kind: 'cancel', time }) },
      }
    }
    class FakeOfflineAudioContext {
      readonly destination = { channelCount: 2, connect: () => {}, disconnect: () => {} }
      readonly oscillators: Array<{ starts: number[]; stops: number[]; frequency: Param; detune: Param }> = []
      readonly sampleRate: number

      constructor(_channels: number, length: number, sampleRate: number) {
        this.sampleRate = sampleRate
        this.length = length
      }

      readonly length: number

      createGain() {
        return { gain: param(), connect: () => {}, disconnect: () => {} }
      }

      createStereoPanner() {
        return { pan: param(), connect: () => {}, disconnect: () => {} }
      }

      createBiquadFilter() {
        return { type: 'lowpass' as BiquadFilterType, frequency: param(), detune: param(), Q: param(), connect: () => {}, disconnect: () => {} }
      }

      createOscillator() {
        const oscillator = {
          type: 'sine' as OscillatorType,
          frequency: param(),
          detune: param(),
          starts: [] as number[],
          stops: [] as number[],
          connect: () => {},
          disconnect: () => {},
          start: (when: number) => { oscillator.starts.push(when) },
          stop: (when: number) => { oscillator.stops.push(when) },
          onended: undefined as (() => void) | undefined,
        }
        this.oscillators.push(oscillator)
        return oscillator
      }

      createBuffer(channels: number, length: number, sampleRate: number) {
        const data = Array.from({ length: channels }, () => new Float32Array(length))
        return {
          numberOfChannels: channels,
          length,
          sampleRate,
          duration: length / sampleRate,
          getChannelData: (channel: number) => {
            const channelData = data[channel]
            if (!channelData) throw new Error('Missing channel')
            return channelData
          },
        }
      }

      async startRendering() {
        return this.createBuffer(2, this.length, this.sampleRate)
      }

      close() {}
    }
    const contexts: FakeOfflineAudioContext[] = []
    class RecordingOfflineAudioContext extends FakeOfflineAudioContext {
      constructor(channels: number, length: number, sampleRate: number) {
        super(channels, length, sampleRate)
        contexts.push(this)
      }
    }
    Object.defineProperty(globalThis, 'OfflineAudioContext', { configurable: true, value: RecordingOfflineAudioContext })
    const midi = {
      wave: 'sine' as const,
      notes: [{ pitch: 60, beat: 0, length: 0.5, velocity: 0.8 }],
    }
    const track = (kind: 'audio' | 'instrument'): Track<AudioBuffer> => ({
      id: 'track-1',
      name: 'Track 1',
      volume: 1,
      kind,
      clips: [{
        id: 'clip-1',
        name: 'Clip 1',
        color: '#fff',
        startSec: 0,
        duration: 1,
        midi,
      }],
    })

    await renderMixdown({
      tracks: [track('instrument')],
      bpm: 60,
      range: { mode: 'custom', startSec: 0, endSec: 1 },
    })
    await renderMixdown({
      tracks: [track('instrument')],
      bpm: 60,
      range: { mode: 'custom', startSec: 0, endSec: 1 },
      fx: {
        masterFxInstances: [],
        trackFx: {
          'track-1': {
            instances: [],
            instrument: { kind: 'drum-rack', instanceId: 'instrument:drum-rack:1', params: createDefaultDrumRackParams() },
          },
        },
      },
    })

    expect(contexts[0]?.oscillators).toHaveLength(3)
    expect(contexts[0]?.oscillators.every((oscillator) => oscillator.starts.includes(0))).toBe(true)
    expect(contexts[1]?.oscillators).toHaveLength(0)
  })
})

describe('isAutomationEnvelopeInSourceScope', () => {
  const envelope = (target: AutomationEnvelope['target'], parameterId: string): AutomationEnvelope => ({
    id: `${parameterId}-automation`,
    projectId: 'project-1',
    target,
    targetKey: automationTargetKey(target, parameterId),
    parameterId,
    enabled: true,
    points: [{ id: 'point-1', timeSec: 0, value: 0.5, interpolation: 'linear' }],
    updatedAt: 1,
  })

  test('keeps master volume automation for source-isolated stems without master FX', () => {
    const graph: ResolvedMixerGraph = {
      channels: [channel('source'), channel('unrelated')],
      master,
    }
    const scope = createSourceAutomationScope(graph, {
      sourceTrackIds: new Set(['source']),
      includeMasterFx: false,
    })

    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'master' }, 'volume'))).toBe(true)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'master' }, 'reverb:mix'))).toBe(false)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'track', trackId: 'source' }, 'volume'))).toBe(true)
    expect(isAutomationEnvelopeInSourceScope(scope, envelope({ kind: 'track', trackId: 'unrelated' }, 'volume'))).toBe(false)
  })
})

describe('normalizeAudioBufferInPlace', () => {
  const createBuffer = (channels: number[][]) => {
    const data = channels.map((channelData) => new Float32Array(channelData))
    return {
      numberOfChannels: data.length,
      getChannelData(channel: number) {
        const channelData = data[channel]
        if (!channelData) throw new Error('Missing channel')
        return channelData
      },
    }
  }

  test('normalizes all channels once to full scale', () => {
    const buffer = createBuffer([[0.25, -0.5], [0.1, 0.4]])
    expect(normalizeAudioBufferInPlace(buffer)).toBe(2)
    expect(getAudioBufferPeak(buffer)).toBe(1)
    expect(Array.from(buffer.getChannelData(1))).toEqual([0.20000000298023224, 0.800000011920929])
  })

  test('attenuates clipped audio and ignores silence and non-finite samples', () => {
    const silence = createBuffer([[0, 0]])
    expect(normalizeAudioBufferInPlace(silence)).toBe(1)
    const clipped = createBuffer([[1.2, -0.5]])
    expect(normalizeAudioBufferInPlace(clipped)).toBeCloseTo(1 / 1.2)
    expect(getAudioBufferPeak(clipped)).toBe(1)
    const nonFinite = createBuffer([[Number.NaN, Number.POSITIVE_INFINITY]])
    expect(normalizeAudioBufferInPlace(nonFinite)).toBe(1)
    expect(Number.isNaN(nonFinite.getChannelData(0)[0])).toBe(true)
  })
})

describe('final master channel conversion', () => {
  const createBuffer = (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData(channel: number) {
        const channelData = data[channel]
        if (!channelData) throw new Error('Missing channel')
        return channelData
      },
    }
  }

  test('preserves duplicated mono samples and render metadata', () => {
    const stereo = createBuffer(2, 4, 48_000)
    stereo.getChannelData(0).set([0.25, -0.5, 0.75, 1])
    stereo.getChannelData(1).set([0.25, -0.5, 0.75, 1])
    const mono = downmixStereoBufferToMono(stereo, createBuffer)

    expect(Array.from(mono.getChannelData(0))).toEqual([0.25, -0.5, 0.75, 1])
    expect(mono.numberOfChannels).toBe(1)
    expect(mono.length).toBe(stereo.length)
    expect(mono.sampleRate).toBe(stereo.sampleRate)
    expect(mono.duration).toBe(stereo.duration)
  })

  test('downmixes opposite-polarity stereo samples to zero', () => {
    const stereo = createBuffer(2, 3, 44_100)
    stereo.getChannelData(0).set([1, -0.5, 0.25])
    stereo.getChannelData(1).set([-1, 0.5, -0.25])
    const mono = downmixStereoBufferToMono(stereo, createBuffer)
    expect(Array.from(mono.getChannelData(0))).toEqual([0, 0, 0])
  })
})

describe('live and offline channel layout parity', () => {
  const audioBuffer = (numberOfChannels: number) => Object.assign(Object.create(null), {
    numberOfChannels,
    duration: 1,
  })
  const clip = (id: string, numberOfChannels: number): Clip<AudioBuffer> => ({
    id,
    name: id,
    startSec: 2,
    duration: 1,
    color: '#fff',
    buffer: audioBuffer(numberOfChannels),
  })
  const track = (id: string, clips: Clip<AudioBuffer>[]): Track<AudioBuffer> => ({
    id,
    name: id,
    volume: 1,
    clips,
  })

  test('resolves identical mixed source counts and active FX', () => {
    const tracks = [
      track('mono', [clip('mono-a', 1), clip('mono-b', 1)]),
      track('mixed', [clip('mixed-a', 1), clip('mixed-b', 2)]),
    ]
    const trackFx: NonNullable<ExportFx['trackFx']> = {
      mono: {
        instances: [
          { id: 'delay', kind: 'delay', params: { ...createDefaultDelayParams(), enabled: true, pingPong: true } },
        ],
      },
    }
    const masterFxInstances: AudioEffectRuntimeInstance[] = [{ id: 'master-delay', kind: 'delay', params: { ...createDefaultDelayParams(), enabled: true, pingPong: true } }]
    const offline = resolveExportMixerGraph({ tracks, fx: { trackFx, masterFxInstances } })
    const live = resolveLiveMixerGraph(tracks, trackFx, { masterFxInstances })

    expect(live.channels.map((entry) => ({
      id: entry.channel.id,
      source: entry.sourceLayout,
      input: entry.inputLayout,
      output: entry.outputLayout,
    }))).toEqual(offline.channels.map((entry) => ({
      id: entry.channel.id,
      source: entry.sourceLayout,
      input: entry.inputLayout,
      output: entry.outputLayout,
    })))
    expect(live.master.inputLayout).toBe(offline.master.inputLayout)
    expect(live.master.outputLayout).toBe(offline.master.outputLayout)
  })
})

describe('MediaBunny WAV encoding', () => {
  class TestAudioBuffer {
    readonly numberOfChannels: number
    readonly length: number
    readonly sampleRate: number
    readonly duration: number
    readonly channels: Float32Array<ArrayBuffer>[]

    constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
      this.numberOfChannels = options.numberOfChannels
      this.length = options.length
      this.sampleRate = options.sampleRate
      this.duration = options.length / options.sampleRate
      this.channels = Array.from(
        { length: options.numberOfChannels },
        () => new Float32Array(new ArrayBuffer(options.length * Float32Array.BYTES_PER_ELEMENT)),
      )
    }

    getChannelData(channel: number) {
      const data = this.channels[channel]
      if (!data) throw new Error('Missing channel')
      return data
    }

    copyFromChannel(destination: Float32Array, channel: number, startInChannel = 0) {
      destination.set(this.getChannelData(channel).subarray(startInChannel, startInChannel + destination.length))
    }

    copyToChannel(source: Float32Array, channel: number, startInChannel = 0) {
      this.getChannelData(channel).set(source, startInChannel)
    }
  }

  const readWavFormat = async (codec: 'pcm-s16' | 'pcm-s24' | 'pcm-f32') => {
    Object.defineProperty(globalThis, 'AudioBuffer', { configurable: true, value: TestAudioBuffer })
    const audio = new TestAudioBuffer({ numberOfChannels: 1, length: 32, sampleRate: 48_000 })
    audio.getChannelData(0).set([0.1, -0.1, 0.25, -0.25])
    const wav: WavEncodingSettings = codec === 'pcm-f32'
      ? { codec, dither: 'none' }
      : codec === 'pcm-s24'
        ? { codec, dither: 'tpdf' }
        : { codec, dither: 'tpdf' }
    const result = await encodeAudioBuffer(audio, {
      format: 'wav',
      wav,
      ditherSeed: 42,
    })
    if (!result.blob) throw new Error('WAV buffer target produced no Blob.')
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const view = new DataView(bytes.buffer)
    return {
      audioFormat: view.getUint16(20, true),
      bitsPerSample: view.getUint16(34, true),
      bytes,
    }
  }

  test('writes actual 16-bit, 24-bit, and 32-bit float WAV fmt fields', async () => {
    expect(await readWavFormat('pcm-s16')).toMatchObject({ audioFormat: 1, bitsPerSample: 16 })
    expect(await readWavFormat('pcm-s24')).toMatchObject({ audioFormat: 1, bitsPerSample: 24 })
    expect(await readWavFormat('pcm-f32')).toMatchObject({ audioFormat: 3, bitsPerSample: 32 })
  })
})
