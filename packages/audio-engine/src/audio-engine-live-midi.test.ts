import { describe, expect, test } from 'bun:test'
import { AudioEngine } from './audio-engine'
import { createDefaultArpeggiatorParams } from '@daw-browser/shared'

describe('AudioEngine arpeggiator', () => {
  test('reports the arpeggiator equality skip and applied update', () => {
    const engine = new AudioEngine()
    let current = createDefaultArpeggiatorParams()
    Reflect.set(engine, 'instruments', {
      getTrackArpeggiator: () => current,
      setTrackArpeggiator: (_trackId: string, params: typeof current) => {
        current = params
      },
    })
    const params = { ...current, enabled: !current.enabled }

    expect(engine.setTrackArpeggiator('track-1', current)).toBe('skipped')
    expect(engine.setTrackArpeggiator('track-1', params)).toBe('applied')
    expect(current).toEqual(params)
  })
})

describe('AudioEngine tempo', () => {
  test('a failed track tempo write still sends the tempo to the master delays, then reports the failure', () => {
    const engine = new AudioEngine()
    const masterBpms: number[] = []
    Reflect.set(engine, 'mixer', { setBpm: () => { throw new Error('Audio parameter write failed.') } })
    Reflect.set(engine, 'masterFx', { setBpm: (bpm: number) => { masterBpms.push(bpm) } })
    expect(() => engine.setBpm(60)).toThrow('Audio parameter write failed.')
    expect(masterBpms).toEqual([60])
  })

  test('when track and master tempo writes both fail, the first failure is the one reported', () => {
    const engine = new AudioEngine()
    const trackFailure = new Error('track failed first')
    const masterBpms: number[] = []
    Reflect.set(engine, 'mixer', { setBpm: () => { throw trackFailure } })
    Reflect.set(engine, 'masterFx', { setBpm: (bpm: number) => { masterBpms.push(bpm); throw new Error('master failed second') } })
    let reported: unknown

    try {
      engine.setBpm(60)
    } catch (error) {
      reported = error
    }

    expect(reported).toBe(trackFailure)
    expect(masterBpms).toEqual([60])
  })
})
