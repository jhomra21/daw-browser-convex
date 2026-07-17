import { describe, expect, test } from 'bun:test'
import { automationEnvelopeFromRow, automationEnvelopeValueRange, automationTargetKey, automationTargetKeysAfterReEnable, automationTargetKeysForManualOverride, automationTargetMatchesEffectInstance, filterAutomationEnvelopesForScheduling, type AutomationEnvelope } from './automation'
import { instrumentAutomationKey } from './sampler-automation'
import { synthAutomationKey } from './synth-automation'
import { automationRatioToValue, automationValueToRatio, createEqBandParameterId, evaluatedAutomationValuesByTargetKey, getAutomationParameterDescriptor, getAutomationParameterOptions, getAutomationParameterOptionsForTarget, normalizeAutomationPoints, valueAtAutomationTime, type AutomationEffectInstance } from './automation-parameters'

describe('automation helpers', () => {
  test('builds stable target keys', () => {
    expect(automationTargetKey({ kind: 'master' }, 'volume')).toBe('automation:v2:["master",null,null,"volume"]')
    expect(automationTargetKey({ kind: 'track', trackId: 'track-1' }, 'volume')).toBe('automation:v2:["track","track-1",null,"volume"]')
    expect(automationTargetKey(
      { kind: 'track', trackId: 'track:1', effectInstanceId: 'compressor:a:b' },
      'compressor.thresholdDb',
    )).toBe('automation:v2:["track","track:1","compressor:a:b","compressor.thresholdDb"]')
  })

  test('derives canonical cloud rows without losing processor identity', () => {
    const first = automationEnvelopeFromRow({
      _id: 'first',
      projectId: 'project',
      targetKind: 'track',
      trackId: 'track',
      effectInstanceId: 'delay-one',
      targetKey: 'stale',
      parameterId: 'delay.feedback',
      enabled: true,
      points: [],
      updatedAt: 1,
    })
    const second = automationEnvelopeFromRow({
      _id: 'second',
      projectId: 'project',
      targetKind: 'track',
      trackId: 'track',
      effectInstanceId: 'delay-two',
      parameterId: 'delay.feedback',
      enabled: true,
      points: [],
      updatedAt: 1,
    })
    expect(first?.targetKey).not.toBe(second?.targetKey)
    expect(first?.target.effectInstanceId).toBe('delay-one')
  })

  test('matches effect cleanup from structured identity without parsing target keys', () => {
    expect(automationTargetMatchesEffectInstance(
      { kind: 'track', trackId: 'track:one', effectInstanceId: 'delay:one:colon' },
      'delay:one:colon',
    )).toBe(true)
    expect(automationTargetMatchesEffectInstance(
      { kind: 'track', trackId: 'track:one', effectInstanceId: 'delay:two' },
      'delay:one:colon',
    )).toBe(false)
    expect(automationTargetMatchesEffectInstance('track:track:one:delay:one:colon', 'delay:one:colon')).toBe(false)
  })

  test('normalizes point ordering, duplicate times, and values', () => {
    const descriptor = getAutomationParameterDescriptor('volume')
    expect(descriptor).toBeDefined()
    if (!descriptor) return

    expect(normalizeAutomationPoints([
      { id: 'late', timeSec: 2, value: 2, interpolation: 'linear' },
      { id: 'early', timeSec: -1, value: -1, interpolation: 'linear' },
      { id: 'replace', timeSec: 2, value: 0.5, interpolation: 'hold' },
    ], descriptor)).toEqual([
      { id: 'early', timeSec: 0, value: 0, interpolation: 'linear' },
      { id: 'replace', timeSec: 2, value: 0.5, interpolation: 'hold' },
    ])
  })

  test('interpolates linear and hold values', () => {
    expect(valueAtAutomationTime([
      { id: 'a', timeSec: 0, value: 0, interpolation: 'linear' },
      { id: 'b', timeSec: 10, value: 10, interpolation: 'hold' },
      { id: 'c', timeSec: 20, value: 20, interpolation: 'linear' },
    ], 5, 1)).toBe(5)
    expect(valueAtAutomationTime([
      { id: 'a', timeSec: 0, value: 0, interpolation: 'hold' },
      { id: 'b', timeSec: 10, value: 10, interpolation: 'linear' },
    ], 5, 1)).toBe(0)
  })

  test('evaluates enabled envelopes without mutating or sorting points', () => {
    const envelopes: AutomationEnvelope[] = [{
      id: 'env-1',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-1' },
      targetKey: automationTargetKey({ kind: 'track', trackId: 'track-1' }, 'volume'),
      parameterId: 'volume',
      enabled: true,
      points: [
        { id: 'a', timeSec: 0, value: 0, interpolation: 'linear' },
        { id: 'b', timeSec: 10, value: 1, interpolation: 'hold' },
      ],
      updatedAt: 1,
    }, {
      id: 'env-2',
      projectId: 'project-1',
      target: { kind: 'track', trackId: 'track-2' },
      targetKey: automationTargetKey({ kind: 'track', trackId: 'track-2' }, 'volume'),
      parameterId: 'volume',
      enabled: true,
      points: [{ id: 'a', timeSec: 0, value: 0.5, interpolation: 'linear' }],
      updatedAt: 1,
    }]
    const values = evaluatedAutomationValuesByTargetKey(envelopes, 5)
    expect(values.get(envelopes[0].targetKey)).toBe(0.5)
    expect(values.get(envelopes[1].targetKey)).toBe(0.5)
    expect(evaluatedAutomationValuesByTargetKey(envelopes, 2).get(envelopes[0].targetKey)).toBe(0.2)
    expect(evaluatedAutomationValuesByTargetKey(envelopes, 8).get(envelopes[0].targetKey)).toBe(0.8)
    expect(envelopes[0].points.map((point) => point.id)).toEqual(['a', 'b'])
    const overridden = evaluatedAutomationValuesByTargetKey(envelopes, 5, new Set([envelopes[0].targetKey]))
    expect(overridden.size).toBe(1)
    expect(overridden.has(envelopes[0].targetKey)).toBe(false)
  })

  test('isolates effect instances by stable target key', () => {
    const firstTarget = { kind: 'track' as const, trackId: 'track-1', effectInstanceId: 'delay:first' }
    const secondTarget = { kind: 'track' as const, trackId: 'track-1', effectInstanceId: 'delay:second' }
    const firstKey = automationTargetKey(firstTarget, 'delay.feedback')
    const secondKey = automationTargetKey(secondTarget, 'delay.feedback')
    const values = evaluatedAutomationValuesByTargetKey([
      {
        id: 'env-1',
        projectId: 'project-1',
        target: firstTarget,
        targetKey: firstKey,
        parameterId: 'delay.feedback',
        enabled: true,
        points: [{ id: 'a', timeSec: 0, value: 0.1, interpolation: 'linear' }],
        updatedAt: 1,
      },
      {
        id: 'env-2',
        projectId: 'project-1',
        target: secondTarget,
        targetKey: secondKey,
        parameterId: 'delay.feedback',
        enabled: true,
        points: [{ id: 'a', timeSec: 0, value: 0.8, interpolation: 'linear' }],
        updatedAt: 1,
      },
    ], 0)
    expect(values.get(firstKey)).toBe(0.1)
    expect(values.get(secondKey)).toBe(0.8)
  })

  test('maps linear automation values to ratios and back', () => {
    const descriptor = getAutomationParameterDescriptor('volume')
    expect(descriptor).toBeDefined()
    if (!descriptor) return

    expect(automationValueToRatio(descriptor, descriptor.min)).toBe(0)
    expect(automationValueToRatio(descriptor, descriptor.max)).toBe(1)
    expect(automationRatioToValue(descriptor, 0.5)).toBe(0.75)
  })

  test('maps log automation values to ratios and back', () => {
    const descriptor = getAutomationParameterDescriptor('delay.lowCutHz')
    expect(descriptor).toBeDefined()
    if (!descriptor) return

    const value = Math.sqrt(descriptor.min * descriptor.max)
    expect(automationValueToRatio(descriptor, value)).toBeCloseTo(0.5, 6)
    expect(automationRatioToValue(descriptor, 0.5)).toBeCloseTo(value, 6)
  })

  test('lists EQ automation options with real default band ids', () => {
    const options = getAutomationParameterOptions()
    expect(options.some((option) => option.id === createEqBandParameterId('b1', 'frequencyHz'))).toBe(true)
    expect(options.some((option) => option.id === createEqBandParameterId('low', 'frequencyHz'))).toBe(false)
  })

  test('builds instance-specific picker options that survive effect reorder', () => {
    const effects: AutomationEffectInstance[] = [
      { id: 'delay:first:colon', kind: 'delay' },
      { id: 'delay-second', kind: 'delay' },
      { id: 'compressor-only', kind: 'compressor' },
    ]
    const options = getAutomationParameterOptionsForTarget(effects)
    const firstDelay = options.find((option) => (
      option.effectInstanceId === 'delay:first:colon' && option.parameterId === 'delay.feedback'
    ))
    const secondDelay = options.find((option) => (
      option.effectInstanceId === 'delay-second' && option.parameterId === 'delay.feedback'
    ))

    expect(options.filter((option) => option.parameterId === 'volume')).toHaveLength(1)
    expect(firstDelay?.device).toBe('Delay 1')
    expect(secondDelay?.device).toBe('Delay 2')
    expect(options.some((option) => option.effectInstanceId === 'compressor-only')).toBe(false)

    const reordered = getAutomationParameterOptionsForTarget([...effects].reverse())
    expect(reordered.some((option) => (
      option.effectInstanceId === firstDelay?.effectInstanceId
      && option.parameterId === firstDelay?.parameterId
    ))).toBe(true)
    expect(automationTargetKey(
      { kind: 'track', trackId: 'track:colon', effectInstanceId: firstDelay?.effectInstanceId },
      firstDelay?.parameterId ?? '',
    )).toBe('automation:v2:["track","track:colon","delay:first:colon","delay.feedback"]')
  })

  test('publishes instance-specific sampler and granular picker options for track targets', () => {
    const options = getAutomationParameterOptionsForTarget([
      { id: 'sampler:one', kind: 'sampler' },
      { id: 'granular:one', kind: 'granular' },
    ], 'track-1')
    expect(options.some((option) => option.parameterId === 'instrument:track-1:sampler:one:filter.frequency')).toBe(true)
    expect(options.some((option) => option.parameterId === 'instrument:track-1:granular:one:grainSize')).toBe(true)
    expect(options.find((option) => option.parameterId === 'instrument:track-1:granular:one:grainSize')?.effectInstanceId).toBeUndefined()
  })

  test('exposes only effect parameters with supported automation bindings and UI controls', () => {
    const options = getAutomationParameterOptions()
    for (const parameterId of [
      'saturator.driveDb',
      'saturator.outputDb',
      'saturator.dryWet',
      'saturator.colorFrequencyHz',
      'delay.timeMs',
      'delay.feedback',
      'delay.dryWet',
      'delay.lowCutHz',
      'delay.highCutHz',
      'reverb.wet',
      'reverb.preDelayMs',
      'reverb.stereoWidth',
    ]) {
      expect(options.some((option) => option.id === parameterId)).toBe(true)
      expect(getAutomationParameterDescriptor(parameterId)?.targetKinds).toEqual(['track', 'master'])
    }
    expect(getAutomationParameterDescriptor('compressor.thresholdDb')).toBeUndefined()
    expect(getAutomationParameterDescriptor('reverb.decaySec')).toBeUndefined()
  })

  test('resolves strict sampler automation descriptors without changing legacy keys', () => {
    const parameterId = instrumentAutomationKey('track-1', 'instrument:sampler:one', 'amp.attack')
    expect(getAutomationParameterDescriptor(parameterId)).toMatchObject({
      owner: 'sampler',
      min: 0,
      max: 60,
      unit: 'seconds',
      targetKinds: ['track'],
    })
    expect(getAutomationParameterDescriptor('instrument:track-1:instrument:sampler:one:amp.unknown')).toBeUndefined()
    expect(getAutomationParameterDescriptor('volume')?.owner).toBe('mixer')
  })

  test('preserves granular automation units in generic descriptors', () => {
    expect(getAutomationParameterDescriptor('instrument:track-1:instrument:granular:one:grainSize')).toMatchObject({ owner: 'granular', unit: 'milliseconds' })
    expect(getAutomationParameterDescriptor('instrument:track-1:instrument:granular:one:pitch')).toMatchObject({ owner: 'granular', unit: 'semitones' })
    expect(getAutomationParameterDescriptor('instrument:track-1:instrument:granular:one:position')).toMatchObject({ owner: 'granular', unit: 'percent' })
  })

  test('discovers synth instances through collision-free parameter identities', () => {
    const parameterId = synthAutomationKey('track-1', 'instrument:synth:one', 'filter.frequency')
    expect(getAutomationParameterDescriptor(parameterId)).toMatchObject({
      owner: 'synth',
      min: 20,
      max: 20_000,
      unit: 'hz',
      targetKinds: ['track'],
    })
    const options = getAutomationParameterOptionsForTarget(
      [{ id: 'instrument:synth:one', kind: 'synth' }],
      'track-1',
    )
    expect(options.some((option) => option.parameterId === parameterId)).toBe(true)
  })

  test('computes envelope value ranges with optional bounds', () => {
    const envelope: AutomationEnvelope = {
      id: 'automation-1',
      projectId: 'project-1',
      target: { kind: 'master' },
      targetKey: 'master:volume',
      parameterId: 'volume',
      enabled: true,
      points: [
        { id: 'a', timeSec: 0, value: -1, interpolation: 'linear' },
        { id: 'b', timeSec: 1, value: 2, interpolation: 'linear' },
      ],
      updatedAt: 1,
    }
    expect(automationEnvelopeValueRange(envelope, { min: 0, max: 1 })).toEqual({ min: 0, max: 1 })
  })
})

describe('manual automation override helpers', () => {
  const volumeEnvelope: AutomationEnvelope = {
    id: 'env-1',
    projectId: 'project-1',
    target: { kind: 'track', trackId: 'track-1' },
    targetKey: 'track:track-1:volume',
    parameterId: 'volume',
    enabled: true,
    points: [],
    updatedAt: 1,
  }
  const eqEnvelope: AutomationEnvelope = {
    ...volumeEnvelope,
    id: 'env-2',
    targetKey: 'track:track-1:eq.b1.gainDb',
    parameterId: 'eq.b1.gainDb',
  }

  test('adds and removes overridden target keys without mutating the source set', () => {
    const current = new Set(['track:track-1:volume'])
    const withOverride = automationTargetKeysForManualOverride(current, 'track:track-1:eq.b1.gainDb')

    expect([...current]).toEqual(['track:track-1:volume'])
    expect(withOverride.has('track:track-1:volume')).toBe(true)
    expect(withOverride.has('track:track-1:eq.b1.gainDb')).toBe(true)

    const reEnabled = automationTargetKeysAfterReEnable(withOverride, ['track:track-1:volume'])
    expect(reEnabled.has('track:track-1:volume')).toBe(false)
    expect(reEnabled.has('track:track-1:eq.b1.gainDb')).toBe(true)
  })

  test('filters overridden envelopes from scheduling without mutating envelopes', () => {
    const envelopes = [volumeEnvelope, eqEnvelope]
    const filtered = filterAutomationEnvelopesForScheduling(envelopes, new Set(['track:track-1:volume']))

    expect(filtered).toEqual([eqEnvelope])
    expect(envelopes).toEqual([volumeEnvelope, eqEnvelope])
    expect(filterAutomationEnvelopesForScheduling(envelopes, new Set())).toBe(envelopes)
  })
})
