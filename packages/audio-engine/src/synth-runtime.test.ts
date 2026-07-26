import { describe, expect, test } from 'bun:test'
import { createDefaultSynthParams, type AutomationEnvelope } from '@daw-browser/shared'
import { scheduleAutomationEnvelope } from './automation'
import { createSourceRegistry } from './source-registry'
import { createSynthRuntime } from './synth-runtime'
import { createSynthEnvelopePlan, estimateSynthEnvelopeLevel } from './synth-voice'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type ParamEvent = {
  kind: 'set' | 'ramp' | 'hold' | 'cancel'
  value?: number
  time: number
}

type TestOscillator = {
  onended?: () => void
  connections: unknown[]
  disconnects: number
  frequency: TestParam
  detune: TestParam
  connect: (destination: unknown) => void
  disconnect: () => void
  starts: number[]
  stops: number[]
  start: (when: number) => void
  stop: (when: number) => void
  type: OscillatorType
}

type TestBufferSource = {
  onended?: () => void
  buffer: AudioBuffer | null
  connections: unknown[]
  disconnects: number
  loop: boolean
  connect: (destination: unknown) => void
  disconnect: () => void
  starts: number[]
  stops: number[]
  start: (when: number) => void
  stop: (when: number) => void
}

type TestGain = {
  connections: unknown[]
  disconnects: number
  gain: TestParam
  connect: (destination: unknown) => void
  disconnect: () => void
}

type TestPan = {
  connections: unknown[]
  disconnects: number
  pan: TestParam
  connect: (destination: unknown) => void
  disconnect: () => void
}

type TestParam = {
  value: number
  events: ParamEvent[]
  setValueAtTime: (value: number, time: number) => void
  exponentialRampToValueAtTime: (value: number, time: number) => void
  linearRampToValueAtTime: (value: number, time: number) => void
  setTargetAtTime: (value: number, time: number, timeConstant: number) => void
  cancelScheduledValues: (time: number) => void
  cancelAndHoldAtTime: (time: number) => void
}

const createTestAudio = () => {
  const oscillators: TestOscillator[] = []
  const bufferSources: TestBufferSource[] = []
  const param = (): TestParam => {
    const events: ParamEvent[] = []
    return {
      value: 0,
      events,
      setValueAtTime: (value, time) => events.push({ kind: 'set', value, time }),
      exponentialRampToValueAtTime: (value, time) => events.push({ kind: 'ramp', value, time }),
      linearRampToValueAtTime: (value, time) => events.push({ kind: 'ramp', value, time }),
      setTargetAtTime: (value, time) => events.push({ kind: 'ramp', value, time }),
      cancelScheduledValues: (time) => events.push({ kind: 'cancel', time }),
      cancelAndHoldAtTime: (time) => events.push({ kind: 'hold', time }),
    }
  }
  const gains: TestGain[] = []
  const filters: Array<{ disconnects: number; type: BiquadFilterType; frequency: TestParam; detune: TestParam; Q: TestParam }> = []
  const pans: TestPan[] = []
  const ctx = Object.assign(Object.create(null), {
    currentTime: 0,
    sampleRate: 48_000,
    createOscillator: () => {
      const oscillator: TestOscillator = {
        connections: [],
        disconnects: 0,
        frequency: param(),
        detune: param(),
        connect: (destination) => { oscillator.connections.push(destination) },
        disconnect: () => { oscillator.disconnects += 1 },
        starts: [],
        stops: [],
        start: (when) => { oscillator.starts.push(when) },
        stop: (when) => { oscillator.stops.push(when) },
        type: 'sine',
      }
      oscillators.push(oscillator)
      return oscillator
    },
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      return {
        getChannelData: (channel: number) => data[channel] ?? new Float32Array(),
      }
    },
    createBufferSource: () => {
      const source: TestBufferSource = {
        buffer: null,
        connections: [],
        disconnects: 0,
        loop: false,
        connect: (destination) => { source.connections.push(destination) },
        disconnect: () => { source.disconnects += 1 },
        starts: [],
        stops: [],
        start: (when) => { source.starts.push(when) },
        stop: (when) => { source.stops.push(when) },
      }
      bufferSources.push(source)
      return source
    },
    createGain: () => {
      const events: ParamEvent[] = []
      const gain = {
        connections: [] as unknown[],
        disconnects: 0,
        gain: {
          value: 1,
          events,
          setValueAtTime: (value: number, time: number) => {
            events.push({ kind: 'set', value, time })
          },
          exponentialRampToValueAtTime: (value: number, time: number) => {
            events.push({ kind: 'ramp', value, time })
          },
          linearRampToValueAtTime: (value: number, time: number) => {
            events.push({ kind: 'ramp', value, time })
          },
          setTargetAtTime: (value: number, time: number) => {
            events.push({ kind: 'ramp', value, time })
          },
          cancelScheduledValues: (time: number) => {
            events.push({ kind: 'cancel', time })
          },
          cancelAndHoldAtTime: (time: number) => {
            events.push({ kind: 'hold', time })
          },
        },
        connect: (destination: unknown) => { gain.connections.push(destination) },
        disconnect: () => { gain.disconnects += 1 },
      }
      gains.push(gain)
      return gain
    },
    createBiquadFilter: () => {
      const filter = {
        disconnects: 0,
      type: 'lowpass' as BiquadFilterType,
      frequency: param(),
      detune: param(),
      Q: param(),
      connect: () => {},
        disconnect: () => { filter.disconnects += 1 },
      }
      filters.push(filter)
      return filter
    },
    createStereoPanner: () => {
      const events: ParamEvent[] = []
      const pan = {
        connections: [] as unknown[],
        disconnects: 0,
      pan: Object.assign(Object.create(null), {
        value: 0,
        events,
        setValueAtTime: (value: number, time: number) => events.push({ kind: 'set', value, time }),
        exponentialRampToValueAtTime: (value: number, time: number) => events.push({ kind: 'ramp', value, time }),
        linearRampToValueAtTime: (value: number, time: number) => events.push({ kind: 'ramp', value, time }),
        setTargetAtTime: (value: number, time: number) => events.push({ kind: 'ramp', value, time }),
        cancelScheduledValues: (time: number) => events.push({ kind: 'cancel', time }),
        cancelAndHoldAtTime: (time: number) => events.push({ kind: 'hold', time }),
      }),
        connect: (destination: unknown) => { pan.connections.push(destination) },
        disconnect: () => { pan.disconnects += 1 },
      }
      pans.push(pan)
      return pan
    },
  })
  return { ctx, oscillators, bufferSources, gains, filters, pans }
}

const createTrack = (id: string): Track<AudioBuffer> => ({
  id,
  name: id,
  volume: 1,
  clips: [],
})

const createMidiClip = (id: string): Clip<AudioBuffer> => ({
  id,
  name: id,
  color: '#ffffff',
  startSec: 0,
  duration: 1,
  midi: {
    wave: 'sawtooth',
    notes: [{ pitch: 60, beat: 0, length: 1, velocity: 0.75 }],
  },
})

const createRuntime = (automationEnvelopes: AutomationEnvelope[] = []) => {
  const audio = createTestAudio()
  const sources = createSourceRegistry()
  const runtime = createSynthRuntime({
    ensureAudio: () => {},
    getAudioContext: () => audio.ctx,
    getBpm: () => 60,
    timelineToCtxTime: (time) => time,
    ensureTrackInput: () => audio.ctx.createGain(),
    sources,
    getAutomationEnvelopes: () => automationEnvelopes,
  })
  runtime.setTrackSynth('track-1', createDefaultSynthParams(), 'instrument:synth:1')
  return { ...audio, runtime, sources }
}

describe('synth runtime characterization', () => {
  test('preserves the requested one-shot preview duration', () => {
    const { oscillators, runtime } = createRuntime()

    runtime.previewNote('track-1', 60, 0.9, 0.35)

    expect(oscillators).toHaveLength(3)
    expect(oscillators.every((oscillator) => oscillator.stops.includes(0.47))).toBe(true)
  })

  test('initializes a new track output with the default synth gain', () => {
    const { gains } = createRuntime()

    expect(gains[1]?.gain.events).toContainEqual({ kind: 'set', value: 0.8, time: 0 })
  })

  test('keeps timeline notes separate from a held live note when retrigger is disabled', () => {
    const { oscillators, runtime } = createRuntime()
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', { ...params, retrigger: false })
    const live = runtime.startPreviewNote('track-1', 60)
    if (live === undefined) throw new Error('Expected live synth note.')

    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('timeline-clip'), 0, 0)
    runtime.releasePreviewNote('track-1', live, 0)

    expect(oscillators).toHaveLength(6)
  })

  test('removes ended oscillators and their gain node from active state', () => {
    const { runtime, sources, oscillators, bufferSources } = createRuntime()
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)

    expect(sources.snapshot()).toHaveLength(3)
    for (const oscillator of oscillators) oscillator.onended?.()
    for (const source of bufferSources) source.onended?.()

    expect(sources.snapshot()).toHaveLength(0)
    runtime.stopAll()
  })

  test('schedules legacy MIDI through configured synth waves without repairing the source clip', () => {
    const { oscillators, runtime } = createRuntime()
    const clip = createMidiClip('legacy-wave')
    if (!clip.midi) throw new Error('Expected MIDI clip.')
    clip.midi = { ...clip.midi, wave: 'custom-legacy', gain: 7 }

    expect(runtime.scheduleMidiClip(createTrack('track-1'), clip, 0, 0)).toBe(true)

    expect(clip.midi).toMatchObject({ wave: 'custom-legacy', gain: 7 })
    expect(oscillators.map((oscillator) => oscillator.type)).toEqual(['sawtooth', 'sawtooth', 'sine'])
  })

  test('skips invalid persisted MIDI notes without modifying their source clip', () => {
    const { oscillators, runtime } = createRuntime()
    const clip = createMidiClip('invalid-legacy')
    if (!clip.midi) throw new Error('Expected MIDI clip.')
    clip.midi = {
      wave: 'custom-legacy',
      gain: 7,
      notes: [{ beat: -2, length: -1, pitch: 200, velocity: 2 }],
    }
    const source = structuredClone(clip.midi)

    expect(runtime.scheduleMidiClip(createTrack('track-1'), clip, 0, 0)).toBe(true)

    expect(oscillators).toHaveLength(0)
    expect(clip.midi).toEqual(source)
  })

  test('keeps per-voice pan neutral while applying pan on the persistent track output', () => {
    const { pans, runtime } = createRuntime()
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', { ...params, pan: 0.6 })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)

    expect(pans[0]?.pan.events.some((event) => event.kind === 'ramp' && event.value === 0.6)).toBe(true)
    expect(pans[1]?.pan.events.some((event) => event.kind === 'set' && event.value === 0)).toBe(true)
    expect(pans[1]?.pan.events.some((event) => event.value === 0.6)).toBe(false)
  })

  test('routes amp LFO through a unit-gain modulation stage after the ADSR envelope', () => {
    const { ctx, gains, oscillators, bufferSources, pans, runtime } = createRuntime()
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...params,
      lfo: { ...params.lfo, enabled: true, amp: 1 },
    })
    runtime.triggerNote({ trackId: 'track-1', pitch: 60, velocity: 0.5, clipGain: 0.5, when: 0, durationSec: 1 })

    const voicePan = pans[1]
    const amplitudeModulation = gains.find((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 1 && event.time === 0)
      && gain.connections.includes(voicePan)
    ))
    const amplitude = gains.find((gain) => gain.connections.includes(amplitudeModulation))
    const ampDepth = gains.find((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 1 && event.time === 0)
      && gain.connections.includes(amplitudeModulation?.gain)
    ))

    expect(amplitudeModulation).toBeDefined()
    expect(amplitude?.connections).toContain(amplitudeModulation)
    expect(amplitude?.gain.events.some((event) => event.kind === 'ramp' && event.value === 0.25)).toBe(true)
    expect(ampDepth?.connections).toContain(amplitudeModulation?.gain)
    expect(ampDepth?.connections).not.toContain(amplitude?.gain)

    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', { ...params, lfo: { ...params.lfo, enabled: false, amp: 1 } })
    expect(ampDepth?.gain.events).toContainEqual({ kind: 'ramp', value: 0, time: 0.1 })
    expect(amplitudeModulation?.gain.events).toContainEqual({ kind: 'set', value: 1, time: 0 })

    for (const oscillator of oscillators) oscillator.onended?.()
    for (const source of bufferSources) source.onended?.()
    expect(amplitudeModulation?.disconnects).toBe(1)
  })

  test('keeps zero-level oscillator and LFO graph nodes available for active updates', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], level: 0 },
        { ...initial.oscillators[1], level: 0 },
      ],
    })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], level: 0.5 },
        { ...initial.oscillators[1], level: 0 },
      ],
      lfo: { ...initial.lfo, enabled: true, frequencyHz: 7, pitchCents: 100 },
    })

    expect(oscillators).toHaveLength(3)
    expect(oscillators[2]?.frequency.events.some((event) => event.kind === 'ramp' && event.value === 7)).toBe(true)
  })

  test('gates oscillators independently without recreating held voices', () => {
    const { ctx, filters, gains, oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    const disabledFirstOscillator = {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], enabled: false },
        initial.oscillators[1],
      ],
    }
    runtime.setTrackSynth('track-1', disabledFirstOscillator)
    runtime.startPreviewNote('track-1', 60)

    const voiceFilter = filters.at(-1)
    const oscillatorGates = gains.filter((gain) => gain.connections.includes(voiceFilter))
    const firstGate = oscillatorGates.find((gate) => (
      gate.gain.events.some((event) => event.kind === 'set' && event.value === 0 && event.time === 0)
    ))
    const secondGate = oscillatorGates.find((gate) => (
      gate.gain.events.some((event) => event.kind === 'set' && event.value === 1 && event.time === 0)
    ))

    expect(oscillators).toHaveLength(3)
    expect(oscillatorGates).toHaveLength(3)
    expect(firstGate).toBeDefined()
    expect(secondGate).toBeDefined()

    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...disabledFirstOscillator,
      oscillators: [
        { ...disabledFirstOscillator.oscillators[0], enabled: true },
        disabledFirstOscillator.oscillators[1],
      ],
    })

    expect(oscillators).toHaveLength(3)
    expect(firstGate?.gain.events).toContainEqual({ kind: 'cancel', time: 0.1 })
    expect(firstGate?.gain.events).toContainEqual({ kind: 'ramp', value: 1, time: 0.1 })
    expect(secondGate?.gain.events).toEqual([{ kind: 'set', value: 1, time: 0 }])
  })

  test('gates and smoothly enables held noise without recreating its source', () => {
    const { ctx, bufferSources, gains, filters, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', { ...initial, noise: { enabled: false, level: 0.25 } })
    runtime.startPreviewNote('track-1', 60)

    const voiceFilter = filters.at(-1)
    const noiseGate = gains.find((gain) => (
      gain.connections.includes(voiceFilter)
      && gain.gain.events.some((event) => event.kind === 'set' && event.value === 0)
    ))
    const noiseLevel = gains.find((gain) => (
      gain.connections.includes(noiseGate)
      && gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.25)
    ))

    expect(bufferSources).toHaveLength(1)
    expect(noiseGate).toBeDefined()
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', { ...initial, noise: { enabled: true, level: 0.6 } })

    expect(bufferSources).toHaveLength(1)
    expect(noiseGate?.gain.events).toContainEqual({ kind: 'ramp', value: 1, time: 0.1 })
    expect(noiseLevel?.gain.events).toContainEqual({ kind: 'ramp', value: 0.6, time: 0.1 })
  })

  test('resolves noise level automation while disabled noise remains gated', () => {
    const { gains, runtime } = createRuntime()
    runtime.triggerNote({ trackId: 'track-1', pitch: 60, when: 0, durationSec: 1 })
    const bindings = runtime.resolveAutomationBindings(
      'track-1',
      'synth-instrument:track-1:instrument:synth:1:noise.level',
    )

    expect(bindings).toHaveLength(1)
    bindings[0]?.param.setValueAtTime(0.7, 0)
    expect(gains.some((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 0)
      && gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.7)
    ))).toBe(false)
    expect(gains.some((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.7))).toBe(true)
  })

  test('cancels a future voice before its start without scheduling an audible steal fade', () => {
    const { filters, oscillators, runtime } = createRuntime()
    const clip = { ...createMidiClip('clip-1'), startSec: 1 }
    const initialFilterCount = filters.length
    runtime.scheduleMidiClip(createTrack('track-1'), clip, 0, 0)

    runtime.stopClip('clip-1')

    expect(oscillators).toHaveLength(3)
    expect(oscillators.every((oscillator) => (
      oscillator.starts[0] === 1
      && oscillator.stops.includes(0)
      && !oscillator.stops.includes(1.006)
    ))).toBe(true)
    expect(filters.slice(initialFilterCount).every((filter) => filter.disconnects === 1)).toBe(true)
  })

  test('disconnects every voice node after its oscillators end', () => {
    const { runtime, oscillators, bufferSources, gains, filters, pans } = createRuntime()
    const initialGainCount = gains.length
    const initialFilterCount = filters.length
    const initialPanCount = pans.length
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...params,
      lfo: {
        ...params.lfo,
        enabled: true,
        pitchCents: 10,
        filterOctaves: 0.5,
        amp: 0.25,
        pan: 0.25,
      },
    })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)

    for (const oscillator of oscillators) oscillator.onended?.()
    for (const source of bufferSources) source.onended?.()

    expect(oscillators.every((oscillator) => oscillator.disconnects === 1)).toBe(true)
    expect(bufferSources.every((source) => source.disconnects === 1)).toBe(true)
    expect(gains.slice(initialGainCount).every((gain) => gain.disconnects === 1)).toBe(true)
    expect(filters.slice(initialFilterCount).every((filter) => filter.disconnects === 1)).toBe(true)
    expect(pans.slice(initialPanCount).every((pan) => pan.disconnects === 1)).toBe(true)
  })

  test('stopping one clip preserves notes from other clips', () => {
    const { runtime, sources } = createRuntime()
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-2'), 0, 0)

    runtime.stopClip('clip-1')

    expect(sources.snapshot()).toHaveLength(3)
    runtime.stopAll()
    expect(sources.snapshot()).toHaveLength(0)
  })

  test('retargets active amp and filter envelopes from their scheduled curve', () => {
    const { ctx, gains, filters, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: { ...initial.ampEnvelope, attackSec: 0.5 },
      filter: { ...initial.filter, envelopeAmountOctaves: 1, envelope: { ...initial.filter.envelope, attackSec: 0.5 } },
    })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: {
        attackSec: 0.2,
        decaySec: 0.3,
        sustain: 0.5,
        releaseSec: 0.4,
      },
      filter: {
        ...initial.filter,
        envelopeAmountOctaves: 2,
        envelope: {
          attackSec: 0.2,
          decaySec: 0.4,
          sustain: 0.4,
          releaseSec: 0.5,
        },
      },
    })

    const voiceGain = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.0001 && event.time === 0))
    const initialAmpPlan = createSynthEnvelopePlan(0, 1, { ...initial.ampEnvelope, attackSec: 0.5 }, 0.75, 0.0001)
    const initialFilterPlan = createSynthEnvelopePlan(0, 1, { ...initial.filter.envelope, attackSec: 0.5 }, 1_200)
    expect(voiceGain?.gain.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(initialAmpPlan, 0.1),
      time: 0.1,
    })
    expect(voiceGain?.gain.events.some((event) => (
      event.kind === 'ramp' && event.value === 0.75 && Math.abs(event.time - 0.3) < 1e-8
    ))).toBe(true)
    expect(voiceGain?.gain.events.some((event) => (
      event.kind === 'ramp' && event.value === 0.375 && Math.abs(event.time - 0.6) < 1e-8
    ))).toBe(true)
    expect(voiceGain?.gain.events).toContainEqual({ kind: 'ramp', value: 0, time: 1.4 })
    expect(filters[0]?.detune.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(initialFilterPlan, 0.1),
      time: 0.1,
    })
    expect(filters[0]?.detune.events.some((event) => (
      event.kind === 'ramp' && event.value === 2_400 && Math.abs(event.time - 0.3) < 1e-8
    ))).toBe(true)
    expect(filters[0]?.detune.events.some((event) => (
      event.kind === 'ramp' && event.value === 960 && Math.abs(event.time - 0.7) < 1e-8
    ))).toBe(true)
    expect(filters[0]?.detune.events).toContainEqual({ kind: 'ramp', value: 0, time: 1.5 })
    expect([...voiceGain?.gain.events ?? [], ...filters[0]?.detune.events ?? []].every((event) => (
      Number.isFinite(event.time) && (event.value === undefined || Number.isFinite(event.value))
    ))).toBe(true)
  })

  test('reschedules LFO depth automation when enabling an LFO during playback', () => {
    const lfoDepth: AutomationEnvelope = {
      id: 'lfo-depth',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: 'lfo-depth',
      parameterId: 'synth-instrument:track-1:instrument:synth:1:lfo.ampDepth',
      enabled: true,
      points: [
        { id: 'a', timeSec: 0, value: 0.2, interpolation: 'linear' },
        { id: 'b', timeSec: 0.5, value: 0.8, interpolation: 'linear' },
      ],
      updatedAt: 1,
    }
    const { ctx, gains, runtime } = createRuntime([lfoDepth])
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0, undefined, {
      scheduleVoiceAutomation: false,
    })
    ctx.currentTime = 0.1
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      lfo: { ...initial.lfo, enabled: true, amp: 0.5 },
    })

    const ampDepth = gains.find((gain) => gain.gain.events.some((event) => (
      event.kind === 'set' && Math.abs((event.value ?? 0) - 0.32) < 1e-8 && event.time === 0.1
    )))
    expect(ampDepth?.gain.events.some((event) => (
      event.kind === 'ramp' && Math.abs((event.value ?? 0) - 0.8) < 1e-8 && event.time === 0.5
    ))).toBe(true)
  })

  test('updates a held zero-level oscillator without changing its discrete pitch settings', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], level: 0 },
        { ...initial.oscillators[1], wave: 'sine', octave: 0, semitone: 0, detuneCents: 0, level: 1 },
      ],
    })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    const source = oscillators[0]
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], level: 0 },
        { ...initial.oscillators[1], wave: 'square', octave: 1, semitone: 2, detuneCents: 25, level: 0.5 },
      ],
    })

    expect(oscillators).toHaveLength(3)
    expect(source?.type).toBe('sawtooth')
    expect(source?.frequency.events.some((event) => event.kind === 'ramp')).toBe(false)
  })

  test('uses updated discrete oscillator settings for the next scheduled voice', () => {
    const { oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      oscillators: [
        { ...initial.oscillators[0], wave: 'square', octave: 1, semitone: 2 },
        initial.oscillators[1],
      ],
      lfo: { ...initial.lfo, wave: 'triangle' },
    })

    runtime.triggerNote({ trackId: 'track-1', pitch: 60, when: 0, durationSec: 1 })

    expect(oscillators[0]?.type).toBe('square')
    expect(oscillators[0]?.frequency.events).toContainEqual({
      kind: 'set',
      value: 587.3295358348151,
      time: 0,
    })
    expect(oscillators[2]?.type).toBe('triangle')
  })

  test('updates active voice filter and LFO parameters', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      lfo: { ...initial.lfo, enabled: true },
    })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      filter: { ...initial.filter, frequencyHz: 2_000, q: 8 },
      lfo: {
        ...initial.lfo,
        enabled: true,
        frequencyHz: 7,
        pitchCents: 100,
        filterOctaves: 0.5,
        amp: 0.25,
        pan: 0.75,
      },
    })

    expect(oscillators.at(-1)?.frequency.events.some((event) => event.kind === 'ramp' && event.value === 7)).toBe(true)
  })

  test('updates held-note filter enablement, mode, and next key tracking together', () => {
    const { ctx, filters, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      filter: {
        ...initial.filter,
        mode: 'highpass',
        frequencyHz: 1_000,
        keyTracking: 1,
      },
    })

    expect(filters[0]?.type).toBe('highpass')
    expect(filters[0]?.frequency.events.some((event) => event.kind === 'ramp' && event.value === 1_000)).toBe(true)
    runtime.setTrackSynth('track-1', { ...initial, filter: { ...initial.filter, enabled: false } })
    expect(filters[0]?.type).toBe('allpass')
    expect(filters[0]?.Q.events.some((event) => event.kind === 'ramp' && event.value === 0.0001)).toBe(true)
  })

  test('gates disabled LFO automation and cancels modulation through synth updates', () => {
    const lfoRate: AutomationEnvelope = {
      id: 'lfo-rate',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: 'lfo-rate',
      parameterId: 'synth-instrument:track-1:instrument:synth:1:lfo.rate',
      enabled: true,
      points: [{ id: 'point', timeSec: 0, value: 12, interpolation: 'linear' }],
      updatedAt: 1,
    }
    const offline = createRuntime([lfoRate])
    offline.runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0, undefined, {
      scheduleVoiceAutomation: true,
    })
    expect(offline.oscillators[2]?.frequency.events).not.toContainEqual({ kind: 'set', value: 12, time: 0 })

    const { ctx, gains, oscillators, runtime } = createRuntime([lfoRate])
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', { ...initial, lfo: { ...initial.lfo, enabled: true, amp: 0.5 } })
    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)
    expect(runtime.resolveAutomationBindings('track-1', lfoRate.parameterId)).toHaveLength(1)

    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', { ...initial, lfo: { ...initial.lfo, enabled: false, amp: 0.5 } })

    expect(runtime.resolveAutomationBindings('track-1', lfoRate.parameterId)).toEqual([])
    expect(oscillators[2]?.frequency.events).toContainEqual({ kind: 'cancel', time: 0.1 })
    expect(gains.some((gain) => gain.gain.events.some((event) => (
      event.kind === 'ramp' && event.value === 0 && event.time === 0.1
    )))).toBe(true)
  })

  test('ignores disabled note-rate automation envelopes', () => {
    const disabledRelease: AutomationEnvelope = {
      id: 'release',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: 'release',
      parameterId: 'synth-instrument:track-1:instrument:synth:1:amp.release',
      enabled: false,
      points: [{ id: 'point', timeSec: 0, value: 5, interpolation: 'linear' }],
      updatedAt: 1,
    }
    const { oscillators, runtime } = createRuntime([disabledRelease])

    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0)

    expect(oscillators.every((oscillator) => oscillator.stops.includes(1.12))).toBe(true)
  })

  test('applies persisted MIDI gain to synth voice amplitude', () => {
    const { gains, runtime } = createRuntime()
    const clip = createMidiClip('clip-1')
    if (!clip.midi) throw new Error('Expected MIDI clip')
    clip.midi.gain = 0.5

    runtime.scheduleMidiClip(createTrack('track-1'), clip, 0, 0)

    expect(gains.some((gain) => gain.gain.events.some((event) => event.kind === 'ramp' && event.value === 0.375))).toBe(true)
  })

  test('keeps amp LFO depth normalized across velocity, clip gain, and held-note updates', () => {
    const { ctx, gains, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      lfo: { ...initial.lfo, enabled: true, amp: 0.8 },
    })
    runtime.triggerNote({ trackId: 'track-1', pitch: 60, velocity: 0.5, clipGain: 0.5, when: 0, durationSec: 1 })

    const ampDepth = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.8))
    expect(ampDepth).toBeDefined()

    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      lfo: { ...initial.lfo, enabled: true, amp: 0.6 },
    })

    expect(gains.some((gain) => gain.gain.events.some((event) => (
      event.kind === 'ramp' && event.value === 0.6 && event.time === 0.1
    )))).toBe(true)
  })

  test('resolves synth output gain on the persistent track output', () => {
    const { gains, runtime } = createRuntime()
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), pan: 0.2 })
    const bindings = runtime.resolveAutomationBindings(
      'track-1',
      'synth-instrument:track-1:instrument:synth:1:output.gain',
    )

    expect(bindings).toHaveLength(1)
    bindings[0]?.param.setValueAtTime(0.2, 0)
    expect(gains.some((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.2))).toBe(true)
  })

  test('preserves the synth instance identity across parameter-only updates', () => {
    const { runtime } = createRuntime()

    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), gain: 0.6 })

    expect(runtime.resolveAutomationBindings(
      'track-1',
      'synth-instrument:track-1:instrument:synth:1:output.gain',
    )).toHaveLength(1)
  })

  test('resolves held-voice a-rate automation with per-voice transforms', () => {
    const { filters, runtime } = createRuntime()
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...params,
      filter: { ...params.filter, keyTracking: 1 },
      lfo: { ...params.lfo, enabled: true },
    })
    runtime.triggerNote({ trackId: 'track-1', pitch: 72, velocity: 0.5, clipGain: 0.5, when: 0, durationSec: 1 })

    const filterBindings = runtime.resolveAutomationBindings(
      'track-1',
      'synth-instrument:track-1:instrument:synth:1:filter.frequency',
    )
    const ampBindings = runtime.resolveAutomationBindings(
      'track-1',
      'synth-instrument:track-1:instrument:synth:1:lfo.ampDepth',
    )

    expect(filterBindings).toHaveLength(1)
    expect(filterBindings[0]?.valueToAudioValue(1_000)).toBe(2_000)
    expect(ampBindings[0]?.valueToAudioValue(0.8)).toBe(0.8)
    expect(filters[0]?.frequency.events).toContainEqual({ kind: 'set', value: 20000, time: 0 })

    const parameterId = 'synth-instrument:track-1:instrument:synth:1:filter.frequency'
    runtime.triggerNote({
      trackId: 'track-1',
      pitch: 72,
      when: 0,
      durationSec: 1,
      timelineStartSec: 0,
      automationEnvelopes: new Map([['filter.frequency', {
        id: 'filter-frequency',
        projectId: 'project-1',
        target: { kind: 'track', trackId: 'track-1' },
        targetKey: parameterId,
        parameterId,
        enabled: true,
        points: [{ id: 'point', timeSec: 0, value: 1_000, interpolation: 'linear' }],
        updatedAt: 1,
      }]]),
    })
    expect(filters[1]?.frequency.events).toContainEqual({ kind: 'set', value: 2_000, time: 0 })
  })

  test('reschedules held-voice automation bindings when an envelope changes or is removed', () => {
    const { gains, runtime } = createRuntime()
    runtime.triggerNote({ trackId: 'track-1', pitch: 60, when: 0, durationSec: 1 })
    const parameterId = 'synth-instrument:track-1:instrument:synth:1:osc1.level'
    const bindings = runtime.resolveAutomationBindings('track-1', parameterId)
    const envelope: AutomationEnvelope = {
      id: 'osc1-level',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: parameterId,
      parameterId,
      enabled: true,
      points: [{ id: 'point', timeSec: 0, value: 0.2, interpolation: 'linear' }],
      updatedAt: 1,
    }

    scheduleAutomationEnvelope(bindings, envelope, {
      playheadSec: 0,
      startLimitSec: 0,
      endLimitSec: 1,
    }, (time) => time, 0.7)
    for (const binding of runtime.resolveAutomationBindings('track-1', parameterId)) binding.param.cancelScheduledValues(0.1)

    expect(bindings).toHaveLength(1)
    expect(bindings[0]?.param).toBe(runtime.resolveAutomationBindings('track-1', parameterId)[0]?.param)
    expect(gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.2))
      ?.gain.events.filter((event) => event.kind === 'cancel')).toHaveLength(2)
  })

  test('does not cancel a voice automation binding for an unrelated parameter update', () => {
    const { gains, runtime } = createRuntime()
    runtime.triggerNote({
      trackId: 'track-1',
      pitch: 60,
      when: 0,
      durationSec: 1,
      timelineStartSec: 0,
      automationEnvelopes: new Map([['osc1.level', {
        id: 'osc1-level',
        projectId: 'project-1',
        target: { kind: 'track', trackId: 'track-1' },
        targetKey: 'test-target-key',
        parameterId: 'synth-instrument:track-1:instrument:synth:1:osc1.level',
        enabled: true,
        points: [{ id: 'point-1', timeSec: 0, value: 0.2, interpolation: 'linear' }],
        updatedAt: 1,
      }]]),
    })
    const automatedGain = gains.find((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.2)
    ))
    const cancellations = automatedGain?.gain.events.filter((event) => event.kind === 'cancel').length

    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), gain: 0.6 })

    expect(automatedGain?.gain.events.filter((event) => event.kind === 'cancel')).toHaveLength(cancellations ?? 0)
  })
  test('delegates live a-rate scheduling while retaining voice-local offline scheduling', () => {
    const filterFrequency: AutomationEnvelope = {
      id: 'filter-frequency',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: 'filter-frequency',
      parameterId: 'synth-instrument:track-1:instrument:synth:1:filter.frequency',
      enabled: true,
      points: [{ id: 'point', timeSec: 0, value: 1_000, interpolation: 'linear' }],
      updatedAt: 1,
    }
    const ampDepth: AutomationEnvelope = {
      id: 'amp-depth',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: 'amp-depth',
      parameterId: 'synth-instrument:track-1:instrument:synth:1:lfo.ampDepth',
      enabled: true,
      points: [{ id: 'point', timeSec: 0, value: 0.8, interpolation: 'linear' }],
      updatedAt: 1,
    }
    const params = createDefaultSynthParams()
    const { filters, gains, runtime } = createRuntime([filterFrequency, ampDepth])
    runtime.setTrackSynth('track-1', { ...params, lfo: { ...params.lfo, enabled: true } })

    runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0, undefined, {
      scheduleVoiceAutomation: false,
    })

    expect(runtime.resolveAutomationBindings('track-1', filterFrequency.parameterId)).toHaveLength(1)
    expect(filters[0]?.frequency.events).not.toContainEqual({ kind: 'set', value: 1_000, time: 0 })

    const offline = createRuntime([filterFrequency, ampDepth])
    offline.runtime.setTrackSynth('track-1', { ...params, lfo: { ...params.lfo, enabled: true } })
    offline.runtime.scheduleMidiClip(createTrack('track-1'), createMidiClip('clip-1'), 0, 0, undefined, {
      scheduleVoiceAutomation: true,
    })
    expect(offline.filters[0]?.frequency.events).toContainEqual({ kind: 'set', value: 1_000, time: 0 })
    expect(offline.gains.some((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 0)
      && gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.8)
    ))).toBe(true)
    expect(gains.some((gain) => (
      gain.gain.events.some((event) => event.kind === 'set' && event.value === 0)
      && gain.gain.events.some((event) => event.kind === 'set' && event.value === 0.8)
    ))).toBe(false)
  })
  test('removes every required victim from allocation before replacing voices after a polyphony reduction', () => {
    const { oscillators, runtime } = createRuntime()
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 3 })
    runtime.triggerNote({ trackId: 'track-1', pitch: 60, when: 0, durationSec: 1 })
    runtime.triggerNote({ trackId: 'track-1', pitch: 62, when: 0, durationSec: 1 })
    runtime.triggerNote({ trackId: 'track-1', pitch: 64, when: 0, durationSec: 1 })
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 1 })
    runtime.triggerNote({ trackId: 'track-1', pitch: 65, when: 0, durationSec: 1 })

    expect(oscillators.slice(0, 9).every((oscillator) => oscillator.stops.includes(0.006))).toBe(true)
  })

  test('orders unsorted live MIDI notes by start time before polyphony allocation', () => {
    const { oscillators, runtime } = createRuntime()
    const params = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', { ...params, polyphony: 1 })
    const clip = createMidiClip('clip-1')
    if (!clip.midi) throw new Error('Expected MIDI clip')
    clip.duration = 4
    clip.midi.notes = [
      { pitch: 64, beat: 1, length: 2, velocity: 0.75 },
      { pitch: 60, beat: 0, length: 2, velocity: 0.75 },
      { pitch: 62, beat: 0.5, length: 2, velocity: 0.75 },
    ]

    runtime.scheduleMidiClip(createTrack('track-1'), clip, 0, 0)

    expect([oscillators[0]?.starts[0], oscillators[3]?.starts[0], oscillators[6]?.starts[0]]).toEqual([0, 0.5, 1])
  })

  test('allocates out-of-order cross-clip voices chronologically at polyphony one', () => {
    const { oscillators, runtime } = createRuntime()
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 1 })
    const laterClip = { ...createMidiClip('clip-later'), startSec: 2, duration: 4 }
    const earlierClip = { ...createMidiClip('clip-earlier'), startSec: 1, duration: 4 }

    runtime.scheduleMidiClip(createTrack('track-1'), laterClip, 0, 0)
    runtime.scheduleMidiClip(createTrack('track-1'), earlierClip, 0, 0)

    expect(oscillators.slice(0, 3).every((oscillator) => oscillator.stops.includes(4.006))).toBe(false)
    expect(oscillators.slice(3, 6).every((oscillator) => oscillator.stops.includes(2.006))).toBe(true)
  })

  test('reallocates future scheduled voices after a polyphony decrease and keeps them stoppable', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 3 })
    for (const [pitch, when] of [[60, 1], [62, 2], [64, 3]]) {
      runtime.triggerNote({ trackId: 'track-1', pitch, when, durationSec: 4, clipId: 'clip-1' })
    }

    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 1 })

    expect(oscillators.slice(0, 3).every((oscillator) => oscillator.stops.includes(2.006))).toBe(true)
    expect(oscillators.slice(3, 6).every((oscillator) => oscillator.stops.includes(3.006))).toBe(true)
    ctx.currentTime = 0
    runtime.stopClip('clip-1')
    expect(oscillators.every((oscillator) => oscillator.stops.includes(0))).toBe(true)
  })

  test('keeps dense completed allocations bounded while stopClip and stopAll cancel their scheduled handles', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    runtime.setTrackSynth('track-1', { ...createDefaultSynthParams(), polyphony: 1 })
    for (let index = 0; index < 32; index += 1) {
      runtime.triggerNote({
        trackId: 'track-1',
        pitch: 60 + index,
        when: index,
        durationSec: 0.1,
        clipId: index < 16 ? 'clip-a' : 'clip-b',
      })
    }

    expect(oscillators).toHaveLength(96)
    expect(oscillators.some((oscillator) => oscillator.stops.includes(31.006))).toBe(false)

    ctx.currentTime = 0
    runtime.stopClip('clip-a')
    expect(oscillators.slice(0, 3).every((oscillator) => oscillator.stops.includes(0.006))).toBe(true)
    expect(oscillators.slice(3, 48).every((oscillator) => oscillator.stops.includes(0))).toBe(true)
    expect(oscillators.slice(48).every((oscillator) => oscillator.stops.includes(0))).toBe(false)

    runtime.stopAll()
    expect(oscillators.slice(48).every((oscillator) => oscillator.stops.includes(0))).toBe(true)
  })

  test('releases preview notes with the configured amp release from attack and sustain', () => {
    const { ctx, gains, oscillators, runtime } = createRuntime()
    runtime.startPreviewNote('track-1', 60)
    ctx.currentTime = 0.002
    runtime.releasePreviewNote('track-1', 1)

    const attackRelease = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'ramp' && event.time === 0.122))
    expect(attackRelease?.gain.events).toContainEqual({ kind: 'ramp', value: 0, time: 0.122 })
    expect(oscillators.every((oscillator) => oscillator.stops.includes(0.122))).toBe(true)

    runtime.startPreviewNote('track-1', 62)
    ctx.currentTime = 0.2
    runtime.releasePreviewNote('track-1', 2)
    runtime.releasePreviewNote('track-1', 2)

    expect(oscillators.slice(3).every((oscillator) => oscillator.stops.filter((time) => time === 0.32).length === 1)).toBe(true)
  })

  test('does not release a recreated synth voice through a stale live generation', () => {
    const { ctx, oscillators, runtime } = createRuntime()
    const staleGeneration = runtime.getLiveVoiceGeneration('track-1')
    if (staleGeneration === undefined) throw new Error('Expected a synth generation.')
    runtime.startPreviewNote('track-1', 60)
    runtime.clearTrackSynth('track-1')
    runtime.setTrackSynth('track-1', createDefaultSynthParams())
    const currentGeneration = runtime.getLiveVoiceGeneration('track-1')
    expect(currentGeneration).not.toBe(staleGeneration)
    runtime.startPreviewNote('track-1', 62)
    ctx.currentTime = 0.01
    const newVoiceStops = oscillators.slice(3).map((oscillator) => [...oscillator.stops])
    runtime.releasePreviewNote('track-1', 1, undefined, false, staleGeneration)
    expect(oscillators.slice(3).map((oscillator) => oscillator.stops)).toEqual(newVoiceStops)
  })

  test('does not clear a recreated live voice when a disposed voice ends late', () => {
    const { bufferSources, ctx, oscillators, runtime } = createRuntime()
    runtime.startPreviewNote('track-1', 60)
    const staleOscillatorCount = oscillators.length
    const staleBufferSourceCount = bufferSources.length
    const staleEnded = [...oscillators, ...bufferSources].map((source) => source.onended)
    runtime.clearTrackSynth('track-1')
    runtime.setTrackSynth('track-1', createDefaultSynthParams())
    runtime.startPreviewNote('track-1', 62)
    for (const ended of staleEnded) ended?.()

    ctx.currentTime = 0.01
    runtime.releasePreviewNote('track-1', 1)

    expect([
      ...oscillators.slice(staleOscillatorCount),
      ...bufferSources.slice(staleBufferSourceCount),
    ].every((source) => source.stops.includes(0.13))).toBe(true)
  })

  test('releases a held preview filter envelope at note-off instead of its original long duration', () => {
    const { ctx, filters, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    runtime.setTrackSynth('track-1', {
      ...initial,
      filter: {
        ...initial.filter,
        envelopeAmountOctaves: 1,
        envelope: { attackSec: 0.01, decaySec: 0.01, sustain: 0.5, releaseSec: 0.2 },
      },
    })
    runtime.startPreviewNote('track-1', 60)
    ctx.currentTime = 0.1
    runtime.releasePreviewNote('track-1', 1)

    expect(filters[0]?.detune.events).toContainEqual({ kind: 'set', value: 600, time: 0.1 })
    expect(filters[0]?.detune.events.some((event) => (
      event.kind === 'ramp' && event.value === 0 && Math.abs(event.time - 0.3) < 1e-8
    ))).toBe(true)
  })

  test('releases a retargeted envelope from its retargeted curve', () => {
    const { ctx, filters, gains, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    const nextAmp = { attackSec: 0.2, decaySec: 0.3, sustain: 0.5, releaseSec: 0.4 }
    const nextFilter = { attackSec: 0.2, decaySec: 0.3, sustain: 0.25, releaseSec: 0.5 }
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: { ...initial.ampEnvelope, attackSec: 0.5 },
      filter: { ...initial.filter, envelopeAmountOctaves: 1, envelope: { ...initial.filter.envelope, attackSec: 0.5 } },
    })
    runtime.startPreviewNote('track-1', 60, 0.75)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: nextAmp,
      filter: { ...initial.filter, envelopeAmountOctaves: 2, envelope: nextFilter },
    })
    ctx.currentTime = 0.15
    runtime.releasePreviewNote('track-1', 1)

    const initialAmpPlan = createSynthEnvelopePlan(0, 86_400, { ...initial.ampEnvelope, attackSec: 0.5 }, 0.75, 0.0001)
    const retargetedAmpPlan = createSynthEnvelopePlan(0.1, 86_399.9, nextAmp, 0.75, estimateSynthEnvelopeLevel(initialAmpPlan, 0.1))
    const initialFilterPlan = createSynthEnvelopePlan(0, 86_400, { ...initial.filter.envelope, attackSec: 0.5 }, 1_200)
    const retargetedFilterPlan = createSynthEnvelopePlan(0.1, 86_399.9, nextFilter, 2_400, estimateSynthEnvelopeLevel(initialFilterPlan, 0.1))
    const voiceGain = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.time === 0.15))

    expect(voiceGain?.gain.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(retargetedAmpPlan, 0.15),
      time: 0.15,
    })
    expect(filters[0]?.detune.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(retargetedFilterPlan, 0.15),
      time: 0.15,
    })
  })

  test('preserves exact amp and negative filter levels across repeated retargets', () => {
    const { ctx, filters, gains, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    const firstAmp = { attackSec: 0.4, decaySec: 0.2, sustain: 0.6, releaseSec: 0.3 }
    const firstFilter = { attackSec: 0.4, decaySec: 0.2, sustain: 0.5, releaseSec: 0.3 }
    const secondAmp = { attackSec: 0.3, decaySec: 0.2, sustain: 0.4, releaseSec: 0.2 }
    const secondFilter = { attackSec: 0.3, decaySec: 0.2, sustain: 0.4, releaseSec: 0.2 }
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: { ...initial.ampEnvelope, attackSec: 0.5 },
      filter: { ...initial.filter, envelopeAmountOctaves: 1, envelope: { ...initial.filter.envelope, attackSec: 0.5 } },
    })
    runtime.startPreviewNote('track-1', 60, 0.75)
    ctx.currentTime = 0.1
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: firstAmp,
      filter: { ...initial.filter, envelopeAmountOctaves: 2, envelope: firstFilter },
    })
    ctx.currentTime = 0.2
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: secondAmp,
      filter: { ...initial.filter, envelopeAmountOctaves: -1, envelope: secondFilter },
    })

    const initialAmpPlan = createSynthEnvelopePlan(0, 86_400, { ...initial.ampEnvelope, attackSec: 0.5 }, 0.75, 0.0001)
    const firstAmpPlan = createSynthEnvelopePlan(0.1, 86_399.9, firstAmp, 0.75, estimateSynthEnvelopeLevel(initialAmpPlan, 0.1))
    const initialFilterPlan = createSynthEnvelopePlan(0, 86_400, { ...initial.filter.envelope, attackSec: 0.5 }, 1_200)
    const firstFilterPlan = createSynthEnvelopePlan(0.1, 86_399.9, firstFilter, 2_400, estimateSynthEnvelopeLevel(initialFilterPlan, 0.1))
    const voiceGain = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.time === 0.2))
    const allEvents = [...voiceGain?.gain.events ?? [], ...filters[0]?.detune.events ?? []]

    expect(voiceGain?.gain.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(firstAmpPlan, 0.2),
      time: 0.2,
    })
    expect(filters[0]?.detune.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(firstFilterPlan, 0.2),
      time: 0.2,
    })
    expect(filters[0]?.detune.events).toContainEqual({ kind: 'ramp', value: -1_200, time: 0.5 })
    expect(allEvents.every((event) => Number.isFinite(event.time) && (event.value === undefined || Number.isFinite(event.value)))).toBe(true)
  })

  test('retargets during natural release without reviving the envelope', () => {
    const { ctx, filters, gains, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    const initialAmp = { attackSec: 0.1, decaySec: 0.1, sustain: 0.5, releaseSec: 0.4 }
    const initialFilter = { attackSec: 0.1, decaySec: 0.1, sustain: 0.5, releaseSec: 0.4 }
    runtime.setTrackSynth('track-1', {
      ...initial,
      ampEnvelope: initialAmp,
      filter: { ...initial.filter, envelopeAmountOctaves: 1, envelope: initialFilter },
    })
    runtime.setTrackSynth('clip-track', {
      ...initial,
      ampEnvelope: initialAmp,
      filter: { ...initial.filter, envelopeAmountOctaves: 1, envelope: initialFilter },
    })
    runtime.scheduleMidiClip(createTrack('clip-track'), createMidiClip('clip-1'), 0, 0)
    ctx.currentTime = 1.1
    runtime.setTrackSynth('clip-track', {
      ...initial,
      ampEnvelope: { ...initialAmp, attackSec: 0.3, releaseSec: 0.2 },
      filter: { ...initial.filter, envelopeAmountOctaves: 0, envelope: { ...initialFilter, attackSec: 0.3, releaseSec: 0.2 } },
    })

    const initialAmpPlan = createSynthEnvelopePlan(0, 1, initialAmp, 0.75, 0.0001)
    const initialFilterPlan = createSynthEnvelopePlan(0, 1, initialFilter, 1_200)
    const voiceGain = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.time === 1.1))

    expect(voiceGain?.gain.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(initialAmpPlan, 1.1),
      time: 1.1,
    })
    expect(filters[0]?.detune.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(initialFilterPlan, 1.1),
      time: 1.1,
    })
    expect(voiceGain?.gain.events).not.toContainEqual({ kind: 'ramp', value: 0.75, time: 1.4 })
    expect(filters[0]?.detune.events).toContainEqual({ kind: 'ramp', value: 0, time: 1.3 })
  })

  test('stops an early release from its latest scheduled level', () => {
    const { ctx, gains, oscillators, runtime } = createRuntime()
    const initial = createDefaultSynthParams()
    const envelope = { attackSec: 0.1, decaySec: 0.1, sustain: 0.5, releaseSec: 0.4 }
    runtime.setTrackSynth('track-1', { ...initial, ampEnvelope: envelope })
    runtime.startPreviewNote('track-1', 60, 0.75)
    ctx.currentTime = 0.1
    runtime.releasePreviewNote('track-1', 1)
    ctx.currentTime = 0.15
    runtime.stopAll()

    const initialPlan = createSynthEnvelopePlan(0, 86_400, envelope, 0.75, 0.0001)
    const levelAtRelease = estimateSynthEnvelopeLevel(initialPlan, 0.1)
    const releasePlan = {
      startTime: 0.1,
      attackEndTime: 0.1,
      decayEndTime: 0.1,
      noteOffTime: 0.1,
      releaseEndTime: 0.5,
      startLevel: levelAtRelease,
      peak: levelAtRelease,
      sustain: levelAtRelease,
      levelAtNoteOff: levelAtRelease,
    }
    const voiceGain = gains.find((gain) => gain.gain.events.some((event) => event.kind === 'set' && event.time === 0.15))

    expect(voiceGain?.gain.events).toContainEqual({
      kind: 'set',
      value: estimateSynthEnvelopeLevel(releasePlan, 0.15),
      time: 0.15,
    })
    expect(oscillators.every((oscillator) => oscillator.stops.includes(0.156))).toBe(true)
  })
})