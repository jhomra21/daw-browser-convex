import { describe, expect, test } from 'bun:test'
import { instrumentAutomationKey, parseInstrumentAutomationKey } from './sampler-automation'
import {
  parseSynthAutomationKey,
  SYNTH_AUTOMATION_DESCRIPTORS,
  synthAutomationKey,
} from './synth-automation'

describe('synth automation identity', () => {
  test('uses a dedicated durable namespace that sampler parsing rejects', () => {
    const synthKey = synthAutomationKey('track-1', 'instrument:synth:one', 'filter.frequency')
    const samplerKey = instrumentAutomationKey('track-1', 'instrument:synth:one', 'filter.frequency')

    expect(synthKey).toBe('synth-instrument:track-1:instrument%3Asynth%3Aone:filter.frequency')
    expect(parseSynthAutomationKey(synthKey)).toEqual({
      kind: 'synth-instrument',
      trackId: 'track-1',
      instanceId: 'instrument:synth:one',
      parameterId: 'filter.frequency',
    })
    expect(parseInstrumentAutomationKey(synthKey)).toBeUndefined()
    expect(parseSynthAutomationKey(samplerKey)).toBeUndefined()
  })

  test('roundtrips local track identities and colon-containing instances without collisions', () => {
    const localTrackKey = synthAutomationKey('track:local-uuid', 'instrument:synth:one', 'filter.frequency')
    const remoteTrackKey = synthAutomationKey('track', 'local-uuid:instrument:synth:one', 'filter.frequency')

    expect(localTrackKey).not.toBe(remoteTrackKey)
    expect(parseSynthAutomationKey(localTrackKey)).toEqual({
      kind: 'synth-instrument',
      trackId: 'track:local-uuid',
      instanceId: 'instrument:synth:one',
      parameterId: 'filter.frequency',
    })
    expect(parseSynthAutomationKey(remoteTrackKey)).toEqual({
      kind: 'synth-instrument',
      trackId: 'track',
      instanceId: 'local-uuid:instrument:synth:one',
      parameterId: 'filter.frequency',
    })
  })

  test('parses previously queued simple remote keys', () => {
    expect(parseSynthAutomationKey('synth-instrument:track-1:instrument:synth:one:filter.frequency')).toEqual({
      kind: 'synth-instrument',
      trackId: 'track-1',
      instanceId: 'instrument:synth:one',
      parameterId: 'filter.frequency',
    })
  })

  test('describes only continuous synth parameters with synth-v2 ranges', () => {
    expect(SYNTH_AUTOMATION_DESCRIPTORS['osc1.detune']).toMatchObject({ min: -100, max: 100, unit: 'cents', rate: 'a-rate' })
    expect(SYNTH_AUTOMATION_DESCRIPTORS['filter.envAmount']).toMatchObject({ min: -6, max: 6, unit: 'octaves', rate: 'note' })
    expect(SYNTH_AUTOMATION_DESCRIPTORS['lfo.filterDepth']).toMatchObject({ min: -6, max: 6, unit: 'octaves', rate: 'a-rate' })
    expect(Object.hasOwn(SYNTH_AUTOMATION_DESCRIPTORS, 'osc1.wave')).toBe(false)
    expect(Object.hasOwn(SYNTH_AUTOMATION_DESCRIPTORS, 'polyphony')).toBe(false)
  })
})
