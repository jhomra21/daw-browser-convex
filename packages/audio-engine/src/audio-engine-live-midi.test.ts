import { describe, expect, test } from 'bun:test'
import { AudioEngine } from './audio-engine'

type ScheduledCleanup = {
  callback: () => void
  timer: ReturnType<typeof setTimeout>
}

const installGranularRuntime = (engine: AudioEngine, stopped: string[], scheduled: Array<{ trackId: string; when: number; durationSec: number; liveId: string }>) => {
  const instrumentRuntime = {
    getTrackInstrumentKind: (): 'granular' => 'granular',
    startLiveGranularNote: (trackId: string, when: number, durationSec: number, liveId: string) => {
      scheduled.push({ trackId, when, durationSec, liveId })
      return () => stopped.push(liveId)
    },
    stopAll: () => {},
    clear: () => {},
  }
  Reflect.set(engine, 'instrumentRuntime', instrumentRuntime)
  Reflect.set(engine, 'audioCtx', Object.assign(new EventTarget(), { currentTime: 10 }))
}

describe('AudioEngine granular live MIDI ownership', () => {
  test('keeps bounded live notes owned through ordinary note-off, then clears expiry and close cleanup', () => {
    const cleanups: ScheduledCleanup[] = []
    const cleared: ReturnType<typeof setTimeout>[] = []
    const engine = new AudioEngine(
      { latencyHint: 'interactive' },
      {
        schedule: (callback) => {
          const timer = setTimeout(() => {}, 60_000)
          cleanups.push({ callback, timer })
          return timer
        },
        clear: (timer) => {
          cleared.push(timer)
          clearTimeout(timer)
        },
      },
    )
    const stopped: string[] = []
    const scheduled: Array<{ trackId: string; when: number; durationSec: number; liveId: string }> = []
    installGranularRuntime(engine, stopped, scheduled)

    const first = engine.startLiveMidiNote({ trackId: 'track-1', pitch: 60, velocity: 1, when: 11 })
    const second = engine.startLiveMidiNote({ trackId: 'track-1', pitch: 62, velocity: 1, when: 11 })
    if (!first || !second) throw new Error('Expected live granular handles.')
    expect(scheduled).toEqual([
      { trackId: 'track-1', when: 11, durationSec: 0.5, liveId: 'live-granular:1' },
      { trackId: 'track-1', when: 11, durationSec: 0.5, liveId: 'live-granular:2' },
    ])

    engine.releaseLiveMidiNote(first, 11)
    expect(stopped).toEqual([])
    engine.panicLiveMidi()
    expect(stopped).toEqual(['live-granular:1', 'live-granular:2'])

    const expired = engine.startLiveMidiNote({ trackId: 'track-1', pitch: 64, velocity: 1, when: 11 })
    if (!expired) throw new Error('Expected a live granular handle.')
    const expiredCleanup = cleanups[2]
    if (!expiredCleanup) throw new Error('Expected granular expiry cleanup.')
    expiredCleanup.callback()
    engine.panicLiveMidi()
    expect(stopped).toEqual(['live-granular:1', 'live-granular:2', 'live-granular:3'])

    const closing = engine.startLiveMidiNote({ trackId: 'track-1', pitch: 65, velocity: 1, when: 11 })
    if (!closing) throw new Error('Expected a live granular handle.')
    const closingCleanup = cleanups[3]
    if (!closingCleanup) throw new Error('Expected granular close cleanup.')
    engine.close()
    expect(stopped).toEqual(['live-granular:1', 'live-granular:2', 'live-granular:3', 'live-granular:4'])
    expect(cleared).toContain(closingCleanup.timer)
  })

  test('removes sampler and drum one-shot ownership when their sources end', () => {
    const samplerEngine = new AudioEngine()
    const samplerStops: number[] = []
    let samplerEnded: (() => void) | undefined
    Reflect.set(samplerEngine, 'instrumentRuntime', {
      getTrackInstrumentKind: (): 'sampler' => 'sampler',
      startLiveSamplerNote: (_trackId: string, _pitch: number, _velocity: number, _durationSec: number | undefined, onEnded: () => void) => {
        samplerEnded = onEnded
        return () => samplerStops.push(1)
      },
    })
    Reflect.set(samplerEngine, 'audioCtx', Object.assign(new EventTarget(), { currentTime: 0 }))
    const sampler = samplerEngine.startLiveMidiNote({ trackId: 'sampler', pitch: 60, velocity: 1, when: 0 })
    if (!sampler || !samplerEnded) throw new Error('Expected a sampler source-ended callback.')
    samplerEnded()
    samplerEngine.panicLiveMidi()
    expect(samplerStops).toEqual([])

    const drumEngine = new AudioEngine()
    const drumStops: number[] = []
    let drumEnded: (() => void) | undefined
    Reflect.set(drumEngine, 'instrumentRuntime', {
      getTrackInstrumentKind: (): 'drum-rack' => 'drum-rack',
      startLiveDrumRackNote: (_trackId: string, _pitch: number, _velocity: number, onEnded: () => void) => {
        drumEnded = onEnded
        return () => drumStops.push(1)
      },
    })
    Reflect.set(drumEngine, 'audioCtx', Object.assign(new EventTarget(), { currentTime: 0 }))
    const drum = drumEngine.startLiveMidiNote({ trackId: 'drum', pitch: 36, velocity: 1, when: 0 })
    if (!drum || !drumEnded) throw new Error('Expected a drum source-ended callback.')
    drumEnded()
    drumEngine.panicLiveMidi()
    expect(drumStops).toEqual([])
  })

  test('binds synth live releases to the generation that created the handle', () => {
    const engine = new AudioEngine()
    const releases: Array<{ voiceId: number; generation: number | undefined }> = []
    let generation = 1
    Reflect.set(engine, 'instrumentRuntime', {
      getTrackInstrumentKind: (): 'synth' => 'synth',
      triggerSynthNote: () => 1,
      getSynthLiveVoiceGeneration: () => generation,
      releaseSynthPreviewNote: (
        _trackId: string,
        voiceId: number,
        _when: number,
        _force: boolean,
        releasedGeneration: number | undefined,
      ) => releases.push({ voiceId, generation: releasedGeneration }),
    })
    Reflect.set(engine, 'audioCtx', Object.assign(new EventTarget(), { currentTime: 0 }))
    const stale = engine.startLiveMidiNote({ trackId: 'synth', pitch: 60, velocity: 1, when: 0 })
    if (!stale) throw new Error('Expected a live synth handle.')
    generation = 2
    engine.releaseLiveMidiNote(stale, 0)
    expect(releases).toEqual([{ voiceId: 1, generation: 1 }])
  })
})
