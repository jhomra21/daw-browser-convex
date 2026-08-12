import { describe, expect, test } from 'bun:test'
import {
  createLiveMidiArpeggiator,
  type LiveMidiArpeggiatorRelease,
  type LiveMidiArpeggiatorScheduler,
} from './live-midi-arpeggiator'

const params = (overrides: Partial<{
  enabled: boolean
  pattern: 'up' | 'down' | 'updown' | 'random'
  rate: '1/4' | '1/8' | '1/16' | '1/32'
  octaves: number
  gate: number
  hold: boolean
}> = {}) => ({
  enabled: true,
  pattern: 'up' as const,
  rate: '1/4' as const,
  octaves: 1,
  gate: 0.5,
  hold: true,
  ...overrides,
})

const createHarness = (initialParams = params()) => {
  let now = 0
  let nextTimerId = 1
  const timers = new Map<number, { callback: () => void; at: number }>()
  const started: Array<{ pitch: number; velocity: number }> = []
  const startTimes: Array<number | undefined> = []
  const stopped: Array<{ id: number; force: LiveMidiArpeggiatorRelease | undefined }> = []
  const scheduler: LiveMidiArpeggiatorScheduler = {
    schedule: (callback, delayMs) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, { callback, at: now + delayMs })
      return id
    },
    clear: (timer) => {
      timers.delete(timer)
    },
  }
  let config = { trackId: 'track-1', params: initialParams, bpm: 60 }
  let nextHandle = 1
  const arp = createLiveMidiArpeggiator<number>({
    getConfig: () => config,
    scheduler,
    start: ({ pitch, velocity, when }) => {
      started.push({ pitch, velocity })
      startTimes.push(when)
      return nextHandle++
    },
    stop: (id, force) => stopped.push({ id, force }),
  })
  const advance = (ms: number) => {
    now += ms
    let next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
    while (next && next[1].at <= now) {
      timers.delete(next[0])
      next[1].callback()
      next = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
    }
  }
  return {
    arp,
    started,
    startTimes,
    stopped,
    setParams: (nextParams: typeof initialParams) => { config = { ...config, params: nextParams } },
    setBpm: (bpm: number) => { config = { ...config, bpm } },
    setTrack: (trackId: string) => { config = { ...config, trackId } },
    advance,
  }
}

describe('live MIDI arpeggiator', () => {
  test('sequences held notes with rate, octave, pattern, and gate timing', () => {
    const harness = createHarness(params({ octaves: 2, rate: '1/8', gate: 0.5 }))
    const first = harness.arp.noteOn(60, 0.7)
    harness.arp.noteOn(64, 0.9)
    expect(first).toBe(1)
    harness.advance(0)
    expect(harness.started).toEqual([{ pitch: 60, velocity: 0.9 }])
    harness.advance(500)
    expect(harness.started.at(-1)).toEqual({ pitch: 64, velocity: 0.9 })
    harness.advance(250)
    expect(harness.stopped.length).toBe(2)
    harness.advance(500)
    expect(harness.started.at(-1)).toEqual({ pitch: 72, velocity: 0.9 })
  })

  test('holds until the final source release and panic releases emitted notes', () => {
    const harness = createHarness()
    const first = harness.arp.noteOn(60, 1)
    const second = harness.arp.noteOn(64, 1)
    harness.advance(0)
    harness.arp.noteOff(first ?? 0)
    expect(harness.stopped).toEqual([])
    harness.arp.noteOff(second ?? 0)
    expect(harness.stopped.length).toBe(0)
    const third = harness.arp.noteOn(67, 1)
    harness.advance(0)
    harness.arp.panic()
    expect(third).toBeDefined()
    expect(harness.stopped.at(-1)?.force?.force).toBe(true)
  })

  test('hold latches the last chord, then replacement notes replace it', () => {
    const harness = createHarness(params({ hold: true, rate: '1/8' }))
    const source = harness.arp.noteOn(60, 1)
    harness.advance(0)
    harness.arp.noteOff(source ?? 0)
    const startedBeforeReplacement = harness.started.length
    harness.advance(500)
    expect(harness.started.length).toBeGreaterThan(startedBeforeReplacement)
    const replacement = harness.arp.noteOn(67, 1)
    harness.advance(0)
    expect(harness.started.at(-1)?.pitch).toBe(67)
    harness.arp.noteOff(replacement ?? 0)
    harness.arp.panic()
    expect(harness.stopped.at(-1)?.force?.force).toBe(true)
  })

  test('hold disabled releases the final chord immediately', () => {
    const harness = createHarness(params({ enabled: false, hold: false }))
    const source = harness.arp.noteOn(60, 1)
    harness.advance(0)
    harness.arp.noteOff(source ?? 0)
    expect(harness.stopped.length).toBe(1)
  })

  test('forced final release overrides hold and force-stops emitted notes', () => {
    const harness = createHarness(params({ hold: true }))
    const source = harness.arp.noteOn(60, 1)
    harness.advance(0)
    harness.arp.noteOff(source ?? 0, true)
    expect(harness.stopped.at(-1)?.force?.force).toBe(true)
    const started = harness.started.length
    harness.advance(2_000)
    expect(harness.started.length).toBe(started)
  })

  test('disabled state is direct pass-through', () => {
    const harness = createHarness(params({ enabled: false }))
    const source = harness.arp.noteOn(60, 0.8)
    expect(harness.started).toEqual([{ pitch: 60, velocity: 0.8 }])
    harness.arp.noteOff(source ?? 0)
    expect(harness.stopped).toEqual([{ id: 1, force: { force: false, reason: 'manual', when: undefined } }])
  })

  test('same-target disabled parameter changes retain direct pass-through sources', () => {
    const harness = createHarness(params({ enabled: false }))
    const source = harness.arp.noteOn(60, 0.8, 12.5)
    harness.setParams(params({ enabled: false, gate: 0.25, rate: '1/8' }))
    harness.arp.configure()
    expect(harness.started).toEqual([{ pitch: 60, velocity: 0.8 }])
    expect(harness.stopped).toEqual([])
    harness.arp.noteOff(source ?? 0)
    expect(harness.stopped).toHaveLength(1)
  })

  test('BPM changes retain held sources and reschedule the next step', () => {
    const harness = createHarness(params({ rate: '1/4' }))
    harness.arp.noteOn(60, 0.8)
    harness.advance(0)
    expect(harness.started).toEqual([{ pitch: 60, velocity: 0.8 }])
    harness.setBpm(120)
    harness.arp.configure()
    harness.advance(250)
    expect(harness.started).toHaveLength(2)
    expect(harness.stopped).toHaveLength(1)
  })

  test('panic and reset force-release disabled pass-through handles', () => {
    const harness = createHarness(params({ enabled: false }))
    harness.arp.noteOn(60, 0.8)
    harness.arp.noteOn(64, 0.9)
    harness.arp.panic()
    expect(harness.stopped).toEqual([
      { id: 1, force: { force: true, reason: 'manual' } },
      { id: 2, force: { force: true, reason: 'manual' } },
    ])
    harness.arp.noteOn(67, 1)
    harness.arp.reset()
    expect(harness.stopped.at(-1)).toEqual({ id: 3, force: { force: true, reason: 'manual' } })
  })

  test('parameter changes reset the sequence without retaining old voices', () => {
    const harness = createHarness()
    harness.arp.noteOn(60, 1)
    harness.advance(0)
    harness.setParams(params({ pattern: 'down', rate: '1/16' }))
    harness.arp.configure()
    expect(harness.stopped.length).toBe(1)
    harness.advance(0)
    expect(harness.started.at(-1)?.pitch).toBe(60)
  })

  test('covers directional, random, octave, and rate sequencing', () => {
    for (const pattern of ['up', 'down', 'updown', 'random'] as const) {
      const harness = createHarness(params({ pattern, octaves: 2, rate: '1/16', gate: 1 }))
      harness.arp.noteOn(64, 1)
      harness.arp.noteOn(60, 1)
      harness.advance(0)
      harness.advance(250)
      expect(harness.started.length).toBeGreaterThanOrEqual(2)
      expect(harness.started.every((note) => note.pitch >= 60 && note.pitch <= 76)).toBe(true)
    }
  })

  test('duplicate pitches retain independent source ownership', () => {
    const harness = createHarness(params({ enabled: false, hold: false }))
    const first = harness.arp.noteOn(60, 0.5)
    const second = harness.arp.noteOn(60, 0.8)
    harness.arp.noteOff(first ?? 0)
    expect(harness.stopped.length).toBe(1)
    harness.arp.noteOff(second ?? 0)
    expect(harness.stopped.length).toBe(2)
  })

  test('track changes stop old ownership without leaking into the new track', () => {
    const harness = createHarness(params({ enabled: false }))
    const source = harness.arp.noteOn(60, 1)
    harness.setTrack('track-2')
    harness.arp.configure()
    expect(harness.stopped.length).toBe(1)
    expect(harness.arp.noteOff(source ?? 0)).toBeUndefined()
  })

  test('enabled and disabled transitions safely retrigger held source notes', () => {
    const harness = createHarness(params({ enabled: true }))
    const source = harness.arp.noteOn(60, 1)
    harness.advance(0)
    harness.setParams(params({ enabled: false }))
    harness.arp.configure()
    expect(harness.stopped.length).toBe(1)
    expect(harness.started.at(-1)?.pitch).toBe(60)
    harness.arp.noteOff(source ?? 0)
    expect(harness.stopped.length).toBe(2)
  })

  test('direct pass-through preserves source scheduling metadata', () => {
    const harness = createHarness(params({ enabled: false }))
    const source = harness.arp.noteOn(60, 1, 12.5)
    expect(source).toBe(1)
    expect(harness.startTimes).toEqual([12.5])
    harness.arp.noteOff(source ?? 0, false, 13.25)
    expect(harness.stopped).toEqual([
      { id: 1, force: { force: false, reason: 'manual', when: 13.25 } },
    ])
  })
})
