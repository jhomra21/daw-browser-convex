import { describe, expect, test } from 'bun:test'
import { AUDIO_EFFECT_KINDS, automationTargetKey, normalizeAudioEffectChange, normalizeMasterAudioEffectChange, type AudioEffectKind, type JsonValue, granularAutomationKey, instrumentAutomationKey, synthAutomationKey, type AutomationEnvelope } from '@daw-browser/shared'
import { installFetch } from '~/test-support/install-fetch'
import { persistHistoryEffectParams, rebaseTrackAutomationEnvelope } from './history-persistence'

describe('history automation rebasing', () => {
  test('rebases instrument keys without changing effect parameters', () => {
    const sampler: AutomationEnvelope = {
      id: 'sampler',
      projectId: 'project',
      target: { kind: 'track', trackId: 'old-track' },
      targetKey: 'old',
      parameterId: instrumentAutomationKey('old-track', 'instrument:sampler:1', 'filter.frequency'),
      enabled: true,
      points: [],
      updatedAt: 1,
    }

    const granular = {
      ...sampler,
      id: 'granular',
      parameterId: granularAutomationKey('old-track', 'instrument:granular:1', 'grainSize'),
    }

    const effect = {
      ...sampler,
      id: 'effect',
      parameterId: 'compressor.thresholdDb',
    }

    const synth = {
      ...sampler,
      id: 'synth',
      parameterId: synthAutomationKey('old-track', 'instrument:synth:1', 'filter.frequency'),
    }

    const rebasedSampler = rebaseTrackAutomationEnvelope(sampler, 'new-track')
    const rebasedGranular = rebaseTrackAutomationEnvelope(granular, 'new-track')
    const rebasedEffect = rebaseTrackAutomationEnvelope(effect, 'new-track')
    const rebasedSynth = rebaseTrackAutomationEnvelope(synth, 'new-track')

    expect(rebasedSampler.parameterId).toBe(instrumentAutomationKey('new-track', 'instrument:sampler:1', 'filter.frequency'))
    expect(rebasedSampler.target).toMatchObject({ trackId: 'new-track' })
    expect(rebasedSampler.targetKey).toBe(automationTargetKey(rebasedSampler.target, rebasedSampler.parameterId))
    expect(rebasedGranular.parameterId).toBe(granularAutomationKey('new-track', 'instrument:granular:1', 'grainSize'))
    expect(rebasedSynth.parameterId).toBe(synthAutomationKey('new-track', 'instrument:synth:1', 'filter.frequency'))
    expect(rebasedEffect.parameterId).toBe('compressor.thresholdDb')
    expect(rebasedEffect.targetKey).toBe(automationTargetKey(rebasedEffect.target, rebasedEffect.parameterId))
  })
})

// The operation each kind persists through in a cloud project, written out per kind so a registry change cannot move it.
const cloudOperationByKind = {
  utility: 'Utility', eq: 'Eq', autofilter: 'Modulation', gate: 'Gate', compressor: 'Compressor', saturator: 'Saturator',
  limiter: 'Limiter', lofi: 'Modulation', chorus: 'Modulation', flanger: 'Modulation', phaser: 'Modulation',
  tremolo: 'Modulation', autopan: 'Modulation', ensemble: 'Modulation', delay: 'Delay', reverb: 'Reverb',
  spectral: 'Spectral', spectrum: 'Modulation',
} as const satisfies Record<AudioEffectKind, string>

const publishedBy = async (publish: () => Promise<void>) => {
  const bodies: JsonValue[] = []

  const restoreFetch = installFetch(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))

    return new Response(JSON.stringify({ status: 'applied', effectId: 'effect-1' }))
  })

  try {
    await publish()
  } finally {
    restoreFetch()
  }

  return bodies
}

describe('cloud effect params history', () => {
  const deps = { projectId: 'cloud-project' }

  for (const kind of AUDIO_EFFECT_KINDS) {
    test(`${kind} persists through ${cloudOperationByKind[kind]} on a track and on the master`, async () => {
      const operation = cloudOperationByKind[kind]
      const track = normalizeAudioEffectChange(kind, {}, {})
      const master = normalizeMasterAudioEffectChange(kind, {}, {})
      const carriesKind = operation === 'Modulation'

      const [trackBody] = await publishedBy(() => persistHistoryEffectParams(
        deps, { type: 'effect-params', projectId: 'cloud-project', data: { ...track, instanceId: 'instance-1' } }, 'track-1', 'undo',
      ))

      const [masterBody] = await publishedBy(() => persistHistoryEffectParams(
        deps, { type: 'effect-params', projectId: 'cloud-project', data: { ...master, instanceId: 'instance-2' } }, 'master', 'redo',
      ))

      const trackPayload = carriesKind
        ? { trackId: 'track-1', effect: kind, params: track.from, instanceId: 'instance-1' }
        : { trackId: 'track-1', params: track.from, instanceId: 'instance-1' }

      const masterPayload = carriesKind
        ? { effect: kind, params: master.to, instanceId: 'instance-2' }
        : { params: master.to, instanceId: 'instance-2' }

      expect<unknown>(trackBody).toEqual({ kind: `effects.set${operation}Params`, payload: trackPayload })
      expect<unknown>(masterBody).toEqual({ kind: `effects.setMaster${operation}Params`, payload: masterPayload })
    })
  }
})
