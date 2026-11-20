import { expect, test } from 'bun:test'
import { OWNED_PROCESSOR_KINDS } from './owned-processor-descriptors'
import {
  AUDIO_EFFECT_KINDS,
  audioEffectKindsWithOperation,
  isAudioEffectKind,
  isDspAudioEffectKind,
  isModulationGroupKind,
  isSidechainCapableKind,
  isStereoWideningKind,
} from './audio-effect-registry'

test('the registry keeps the persisted and UI device order', () => {
  expect([...AUDIO_EFFECT_KINDS]).toEqual([
    'utility', 'eq', 'autofilter', 'gate', 'compressor', 'saturator', 'limiter', 'lofi', 'chorus',
    'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'delay', 'reverb', 'spectral', 'spectrum',
  ])
})

test('traits reproduce the kind lists that used to be written out by hand', () => {
  expect(AUDIO_EFFECT_KINDS.filter(isModulationGroupKind)).toEqual(['chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble'])
  expect(AUDIO_EFFECT_KINDS.filter(isSidechainCapableKind)).toEqual(['gate', 'compressor', 'spectral'])
  expect(AUDIO_EFFECT_KINDS.filter(isStereoWideningKind)).toEqual(['chorus', 'flanger', 'phaser', 'autopan', 'ensemble'])
  expect(OWNED_PROCESSOR_KINDS).toEqual([
    'utility', 'autofilter', 'gate', 'limiter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'spectral',
  ])
  expect(AUDIO_EFFECT_KINDS.filter((kind) => !isDspAudioEffectKind(kind))).toEqual(['spectrum'])
  expect(audioEffectKindsWithOperation('processor')).toEqual(['utility', 'gate', 'limiter', 'spectral'])
  expect(audioEffectKindsWithOperation('modulation')).toEqual([
    'autofilter', 'lofi', 'chorus', 'flanger', 'phaser', 'tremolo', 'autopan', 'ensemble', 'spectrum',
  ])
  expect(audioEffectKindsWithOperation('dedicated')).toEqual(['eq', 'compressor', 'saturator', 'delay', 'reverb'])
})

test('kind names are accepted only as exact strings', () => {
  expect(isAudioEffectKind('reverb')).toBe(true)
  expect(isAudioEffectKind('Reverb')).toBe(false)
  expect(isAudioEffectKind('toString')).toBe(false)
  expect(isAudioEffectKind('instrument')).toBe(false)
  expect(isAudioEffectKind(undefined)).toBe(false)
})
