import { describe, expect, test } from 'bun:test'
import { createDefaultSynthParams } from '@daw-browser/shared'
import {
  createSynthEnvelopePlan,
  evaluateSynthParamsAtNote,
  estimateSynthEnvelopeLevel,
  getSynthCutoffLimit,
  getSynthFilterCutoff,
  midiPitchFrequency,
  scheduleSynthEnvelope,
  transposeFrequency,
} from './synth-voice'

describe('synth envelope planning', () => {
  test('plans ADSR and releases from interrupted attack and decay levels', () => {
    const envelope = { attackSec: 0.1, decaySec: 0.2, sustain: 0.4, releaseSec: 0.3 }
    const attack = createSynthEnvelopePlan(1, 0.05, envelope)
    const decay = createSynthEnvelopePlan(1, 0.2, envelope)
    const sustain = createSynthEnvelopePlan(1, 1, envelope)

    expect(attack.levelAtNoteOff).toBeCloseTo(0.5)
    expect(decay.levelAtNoteOff).toBeCloseTo(0.7)
    expect(sustain.levelAtNoteOff).toBeCloseTo(0.4)
    expect(estimateSynthEnvelopeLevel(attack, attack.releaseEndTime)).toBe(0)
  })

  test('interpolates attack from a retargeted start level', () => {
    const plan = createSynthEnvelopePlan(1, 1, {
      attackSec: 0.2, decaySec: 0.1, sustain: 0.5, releaseSec: 0.3,
    }, 0.8, 0.2)

    expect(estimateSynthEnvelopeLevel(plan, 1)).toBe(0.2)
    expect(estimateSynthEnvelopeLevel(plan, 1.1)).toBeCloseTo(0.5)
  })

  test('cancels attack scheduling at note-off and releases from the attack level', () => {
    const plan = createSynthEnvelopePlan(1, 0.05, {
      attackSec: 0.1, decaySec: 0.2, sustain: 0.4, releaseSec: 0.3,
    })
    const events: Array<{ kind: 'set' | 'ramp'; time: number; value: number }> = []
    scheduleSynthEnvelope({
      setValueAtTime: (value, time) => events.push({ kind: 'set', value, time }),
      linearRampToValueAtTime: (value, time) => events.push({ kind: 'ramp', value, time }),
    }, plan)

    expect(events.filter((event) => event.time > plan.noteOffTime && event.time < plan.releaseEndTime)).toEqual([])
    expect(events.find((event) => event.time === plan.attackEndTime)).toBeUndefined()
    expect(events.find((event) => event.time === plan.noteOffTime)?.value).toBeCloseTo(plan.levelAtNoteOff)
  })

  test('cancels decay scheduling at note-off and releases from the decay level', () => {
    const plan = createSynthEnvelopePlan(1, 0.2, {
      attackSec: 0.1, decaySec: 0.2, sustain: 0.4, releaseSec: 0.3,
    })
    const events: Array<{ kind: 'set' | 'ramp'; time: number; value: number }> = []
    scheduleSynthEnvelope({
      setValueAtTime: (value, time) => events.push({ kind: 'set', value, time }),
      linearRampToValueAtTime: (value, time) => events.push({ kind: 'ramp', value, time }),
    }, plan)

    expect(events.filter((event) => event.time > plan.noteOffTime && event.time < plan.releaseEndTime)).toEqual([])
    expect(events.find((event) => event.time === plan.decayEndTime)).toBeUndefined()
    expect(events.find((event) => event.time === plan.noteOffTime)?.value).toBeCloseTo(plan.levelAtNoteOff)
  })

  test('clamps cutoff at each supported sample rate', () => {
    for (const sampleRate of [44_100, 48_000, 96_000, 192_000]) {
      expect(getSynthFilterCutoff(100_000, 127, 1, sampleRate)).toBe(getSynthCutoffLimit(sampleRate))
    }
  })

  test('calculates MIDI pitch and oscillator transposition', () => {
    expect(midiPitchFrequency(69)).toBe(440)
    expect(transposeFrequency(440, 1, 0, 0)).toBe(880)
    expect(transposeFrequency(440, 0, 0, 100)).toBeCloseTo(466.164)
    expect(createDefaultSynthParams().oscillators).toHaveLength(2)
  })

  test('evaluates ADSR and filter envelope automation at note-on only', () => {
    const params = createDefaultSynthParams()
    const evaluated = evaluateSynthParamsAtNote(params, [
      {
        id: 'amp-attack',
        projectId: 'project-1',
        target: { kind: 'track', trackId: 'track-1' },
        targetKey: 'attack',
        parameterId: 'synth-instrument:track-1:instrument:synth:1:amp.attack',
        enabled: true,
        points: [
          { id: 'a', timeSec: 0, value: 0.1, interpolation: 'linear' },
          { id: 'b', timeSec: 1, value: 0.3, interpolation: 'linear' },
        ],
        updatedAt: 1,
      },
      {
        id: 'filter-release',
        projectId: 'project-1',
        target: { kind: 'track', trackId: 'track-1' },
        targetKey: 'filter-release',
        parameterId: 'synth-instrument:track-1:instrument:synth:1:filter.release',
        enabled: true,
        points: [{ id: 'a', timeSec: 0, value: 0.5, interpolation: 'linear' }],
        updatedAt: 1,
      },
    ].reduce((envelopes, envelope) => {
      const parameterId = envelope.parameterId.endsWith('amp.attack')
        ? 'amp.attack'
        : 'filter.release'
      envelopes.set(parameterId, envelope)
      return envelopes
    }, new Map()), 0.5)

    expect(evaluated.ampEnvelope.attackSec).toBeCloseTo(0.2)
    expect(evaluated.filter.envelope.releaseSec).toBe(0.5)
    expect(evaluated.ampEnvelope.releaseSec).toBe(params.ampEnvelope.releaseSec)
  })
})
