import { describe, expect, test } from 'bun:test'
import 'fake-indexeddb/auto'
import { automationTargetKey, createAutomationTarget, parseJsonValue, synthAutomationKey, type AutomationEnvelope, type AutomationTarget } from '@daw-browser/shared'
import { loadLocalAutomationEnvelopes, normalizeLocalAutomationEnvelopes, setLocalAutomationEnvelope } from './local-automation'

const envelope = (input: Partial<AutomationEnvelope> & Pick<AutomationEnvelope, 'id' | 'target' | 'targetKey' | 'parameterId' | 'updatedAt'>): AutomationEnvelope => ({
  projectId: 'project-1',
  enabled: true,
  points: [],
  ...input,
})

describe('normalizeLocalAutomationEnvelopes', () => {
  test('deduplicates structured logical identities by updatedAt then stable id', () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:one', effectInstanceId: 'delay:one' }
    const targetKey = automationTargetKey(target, 'delay.feedback')
    const rows = normalizeLocalAutomationEnvelopes([
      envelope({ id: 'z', target, targetKey, parameterId: 'delay.feedback', updatedAt: 2 }),
      envelope({ id: 'b', target, targetKey, parameterId: 'delay.feedback', updatedAt: 3 }),
      envelope({ id: 'a', target, targetKey, parameterId: 'delay.feedback', updatedAt: 3 }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('a')
  })

  test('normalizes mixer rows to the canonical target key', () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:one' }
    const rows = normalizeLocalAutomationEnvelopes([
      envelope({ id: 'old', target, targetKey: 'opaque:a', parameterId: 'volume', updatedAt: 1 }),
      envelope({ id: 'new', target, targetKey: 'opaque:b', parameterId: 'volume', updatedAt: 2 }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('new')
    expect(rows[0]?.targetKey).toBe(automationTargetKey(target, 'volume'))
  })

  test('persists JSON-safe mixer targets and preserves effect identities', async () => {
    const legacyTarget = { kind: 'track' as const, trackId: 'track:legacy', effectInstanceId: undefined }
    const legacyEnvelope = envelope({
      id: 'legacy-mixer-envelope',
      target: legacyTarget,
      targetKey: automationTargetKey(legacyTarget, 'volume'),
      parameterId: 'volume',
      updatedAt: 1,
    })
    expect(parseJsonValue(legacyEnvelope)).toBeUndefined()

    const mixerTarget = createAutomationTarget({ kind: 'track', trackId: 'track:canonical' })
    const effectTarget = createAutomationTarget({ kind: 'track', trackId: 'track:canonical' }, 'delay:one')
    expect(parseJsonValue(envelope({
      id: 'canonical-mixer-envelope',
      target: mixerTarget,
      targetKey: automationTargetKey(mixerTarget, 'volume'),
      parameterId: 'volume',
      updatedAt: 1,
    }))).toBeDefined()
    expect(Object.hasOwn(mixerTarget, 'effectInstanceId')).toBe(false)
    expect(effectTarget.effectInstanceId).toBe('delay:one')
    await expect(setLocalAutomationEnvelope('project:canonical', envelope({
      id: 'canonical-mixer-envelope',
      target: mixerTarget,
      targetKey: 'legacy:mixer',
      parameterId: 'volume',
      updatedAt: 1,
    }))).resolves.toMatchObject({ target: mixerTarget })
    await setLocalAutomationEnvelope('project:canonical', envelope({
      id: 'canonical-effect-envelope',
      target: effectTarget,
      targetKey: 'legacy:effect',
      parameterId: 'delay.feedback',
      updatedAt: 2,
    }))
    await expect(loadLocalAutomationEnvelopes('project:canonical')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'canonical-effect-envelope',
          target: effectTarget,
        }),
      ]),
    )
  })

  test('drops malformed and unsupported effect rows', () => {
    const rows = normalizeLocalAutomationEnvelopes([
      { schemaVersion: 3, targetKey: 'future:key', payload: { untouched: true } },
      envelope({
        id: 'known',
        target: { kind: 'master' },
        targetKey: 'legacy:master:volume',
        parameterId: 'volume',
        updatedAt: 1,
      }),
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]?.targetKey).toBe(automationTargetKey({ kind: 'master' }, 'volume'))
  })

  test('recognizes and normalizes synth instrument envelopes without an effect instance target', () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:one' }
    const parameterId = synthAutomationKey('track:one', 'instrument:synth:one', 'amp.release')
    const rows = normalizeLocalAutomationEnvelopes([
      envelope({
        id: 'synth-envelope',
        target,
        targetKey: 'legacy:synth',
        parameterId,
        updatedAt: 1,
        points: [{ id: 'point', timeSec: 0, value: 0.3, interpolation: 'hold' }],
      }),
    ])

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'synth-envelope',
        parameterId,
        targetKey: automationTargetKey(target, parameterId),
      }),
    ])
  })

  test('saves and loads synth instrument envelopes without an effect instance target', async () => {
    const target: AutomationTarget = { kind: 'track', trackId: 'track:local-synth' }
    const parameterId = synthAutomationKey('track:local-synth', 'instrument:synth:local', 'filter.frequency')
    await setLocalAutomationEnvelope('project:local-synth', envelope({
      id: 'saved-synth-envelope',
      target,
      targetKey: 'legacy:synth',
      parameterId,
      updatedAt: 1,
    }))

    await expect(loadLocalAutomationEnvelopes('project:local-synth')).resolves.toEqual([
      expect.objectContaining({
        id: 'saved-synth-envelope',
        targetKey: automationTargetKey(target, parameterId),
      }),
    ])
  })
})
