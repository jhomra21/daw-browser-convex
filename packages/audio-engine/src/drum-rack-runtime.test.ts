import { describe, expect, test } from 'bun:test'
import { createDefaultDrumRackParams, createDefaultSynthParams } from '@daw-browser/shared'
import { createDrumRackRuntime, scheduleDrumRackHit } from './drum-rack-runtime'
import { createInstrumentRuntime } from './instrument-runtime'
import type { Clip, Track } from '@daw-browser/timeline-core/types'

type ScheduledStart = {
  when: number
  offset: number
  duration: number
}

type TestParam = {
  value: number
  setValueAtTime: (value: number, time: number) => void
  cancelScheduledValues: (time: number) => void
  linearRampToValueAtTime: (value: number, time: number) => void
  exponentialRampToValueAtTime: (value: number, time: number) => void
}

type TestSource = {
  buffer?: AudioBuffer
  playbackRate: TestParam
  connect: (node: unknown) => void
  start: (when: number, offset: number, duration: number) => void
  stop: (when?: number) => void
  onended?: () => void
  starts: ScheduledStart[]
}

type TestGain = {
  gain: TestParam
  connect: (node: unknown) => void
}

type TestPan = {
  pan: TestParam
  connect: (node: unknown) => void
}

const createMutableParam = (initial = 0): TestParam => {
  const param: TestParam = {
    value: initial,
    setValueAtTime: (value) => {
      param.value = value
    },
    cancelScheduledValues: () => {},
    linearRampToValueAtTime: (value) => {
      param.value = value
    },
    exponentialRampToValueAtTime: (value) => {
      param.value = value
    },
  }
  return param
}

const createTestAudio = () => {
  const sources: TestSource[] = []
  const gains: TestGain[] = []
  const pans: TestPan[] = []
  const ctx = Object.assign(Object.create(null), {
    currentTime: 0,
    createBufferSource: () => {
      const source: TestSource = {
        playbackRate: createMutableParam(1),
        connect: () => {},
        start: (when, offset, duration) => {
          source.starts.push({ when, offset, duration })
        },
        stop: () => {},
        starts: [],
      }
      sources.push(source)
      return source
    },
    createGain: () => {
      const gain: TestGain = {
        gain: createMutableParam(1),
        connect: () => {},
      }
      gains.push(gain)
      return gain
    },
    createStereoPanner: () => {
      const pan: TestPan = {
        pan: createMutableParam(0),
        connect: () => {},
      }
      pans.push(pan)
      return pan
    },
    createOscillator: () => ({
      type: 'sine',
      frequency: createMutableParam(440),
      connect: () => {},
      start: () => {},
      stop: () => {},
    }),
  })
  return { ctx, sources, gains, pans }
}

const createBuffer = (duration: number): AudioBuffer => Object.assign(Object.create(null), { duration })

const createTrack = (): Track<AudioBuffer> => ({
  id: 'track-1',
  name: 'Track 1',
  volume: 1,
  clips: [],
})

describe('Instrument runtime', () => {
  test('keeps Synth and Drum Rack scheduling exclusive per track', () => {
    const audio = createTestAudio()
    const params = createDefaultDrumRackParams()
    const buffers = new Map([[params.pads[0]?.id ?? '', createBuffer(1)]])
    const runtime = createInstrumentRuntime({
      ensureAudio: () => {},
      getAudioContext: () => audio.ctx,
      getBpm: () => 120,
      timelineToCtxTime: (timelineSec) => timelineSec,
      ensureTrackInput: () => audio.ctx.createGain(),
      sources: {
        add: () => {},
        remove: () => {},
        snapshot: () => [],
        clear: () => {},
        stopClip: () => {},
      },
    })

    runtime.setTrackInstrument('track-1', {
      instrument: { kind: 'synth', params: createDefaultSynthParams() },
    })
    runtime.setTrackInstrument('track-1', {
      instrument: { kind: 'drum-rack', params },
      buffers,
    })

    expect(runtime.scheduleMidiClip(createTrack(), createMidiClip(36), 0, 0, 1)).toBe(true)

    runtime.setTrackInstrument('track-1', {
      instrument: { kind: 'synth', params: createDefaultSynthParams() },
    })

    expect(runtime.getTrackInstrumentKind('track-1')).toBe('synth')
    expect(runtime.scheduleMidiClip(createTrack(), createMidiClip(36), 0, 0, 1)).toBe(true)
    expect(audio.sources).toHaveLength(1)
  })
})

const createMidiClip = (pitch: number): Clip<AudioBuffer> => ({
  id: 'clip-1',
  name: 'clip-1',
  color: '#fff',
  startSec: 0,
  duration: 1,
  midi: {
    wave: 'sine',
    notes: [{ pitch, beat: 0, length: 1, velocity: 0.75 }],
  },
})

describe('Drum Rack runtime', () => {
  test('schedules live MIDI notes through note-to-pad routing', () => {
    const audio = createTestAudio()
    const params = createDefaultDrumRackParams()
    const buffers = new Map([[params.pads[2]?.id ?? '', createBuffer(1)]])
    const registryAdds: string[] = []
    const runtime = createDrumRackRuntime({
      ensureAudio: () => {},
      getAudioContext: () => audio.ctx,
      getBpm: () => 120,
      timelineToCtxTime: (timelineSec) => timelineSec + 10,
      ensureTrackInput: () => audio.ctx.createGain(),
      sources: {
        add: (clipId) => registryAdds.push(clipId),
        remove: () => {},
        snapshot: () => [],
        clear: () => {},
        stopClip: () => {},
      },
      getArpeggiator: () => undefined,
    })

    runtime.setTrackDrumRack('track-1', params, buffers)

    expect(runtime.scheduleMidiClip(createTrack(), createMidiClip(38), 0, 10, 1)).toBe(true)
    expect(audio.sources).toHaveLength(1)
    expect(audio.sources[0]?.starts).toEqual([{ when: 10, offset: 0, duration: 1 }])
    expect(audio.gains[1]?.gain.value).toBe(0.75)
    expect(registryAdds).toEqual(['clip-1'])

    expect(runtime.scheduleMidiClip(createTrack(), createMidiClip(39), 0, 10, 1)).toBe(false)
    expect(audio.sources).toHaveLength(1)
  })

  test('previews keyboard notes through mapped pads', () => {
    const audio = createTestAudio()
    const params = createDefaultDrumRackParams()
    const buffers = new Map([[params.pads[0]?.id ?? '', createBuffer(1)]])
    const runtime = createDrumRackRuntime({
      ensureAudio: () => {},
      getAudioContext: () => audio.ctx,
      getBpm: () => 120,
      timelineToCtxTime: (timelineSec) => timelineSec,
      ensureTrackInput: () => audio.ctx.createGain(),
      sources: {
        add: () => {},
        remove: () => {},
        snapshot: () => [],
        clear: () => {},
        stopClip: () => {},
      },
      getArpeggiator: () => undefined,
    })

    runtime.setTrackDrumRack('track-1', params, buffers)

    expect(runtime.previewNote('track-1', 36, 0.5)).toBe(true)
    expect(runtime.previewNote('track-1', 37, 0.5)).toBe(false)
    expect(audio.sources).toHaveLength(1)
  })

  test('live scheduling helper applies pad trim, transpose, gain, pan, and mute', () => {
    const audio = createTestAudio()
    const defaultPad = createDefaultDrumRackParams().pads[0]
    if (!defaultPad) throw new Error('Missing default pad')
    const pad = {
      ...defaultPad,
      gain: 0.5,
      pan: -0.25,
      transpose: 12,
      startSec: 0.25,
      endSec: 0.75,
    }
    const scheduled = scheduleDrumRackHit({
      ctx: audio.ctx,
      destination: audio.ctx.createGain(),
      buffer: createBuffer(2),
      pad,
      when: 5,
      velocity: 0.8,
    })

    expect(scheduled).not.toBeNull()
    expect(audio.sources[0]?.playbackRate.value).toBe(2)
    expect(audio.sources[0]?.starts).toEqual([{ when: 5, offset: 0.25, duration: 0.5 }])
    expect(audio.gains[1]?.gain.value).toBe(0.4)
    expect(audio.pans[0]?.pan.value).toBe(-0.25)

    expect(scheduleDrumRackHit({
      ctx: audio.ctx,
      destination: audio.ctx.createGain(),
      buffer: createBuffer(2),
      pad: { ...pad, mute: true },
      when: 5,
      velocity: 1,
    })).toBeNull()
  })
})
