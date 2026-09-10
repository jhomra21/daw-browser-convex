import { expect, test } from 'bun:test'
import { normalizeDefaultSampleCatalogItem, readAudioSourceMetadata } from './useProjectSamples'

test('local sample inventory preserves authoritative mono channel metadata', () => {
  expect(readAudioSourceMetadata({
    id: 'asset:mono',
    durationSec: 408,
    sampleRate: 48_000,
    channelCount: 1,
  })).toEqual({
    durationSec: 408,
    sampleRate: 48_000,
    channelCount: 1,
  })
})

test('local sample inventory omits incomplete source metadata', () => {
  expect(readAudioSourceMetadata({
    id: 'asset:incomplete',
    durationSec: 408,
    sampleRate: 48_000,
  })).toBeUndefined()
})

test('default sample catalog items use normalized media URLs for metadata and playback', () => {
  expect(normalizeDefaultSampleCatalogItem({
    key: 'default/Kick.wav',
    assetKey: 'asset:default:default/Kick.wav',
    sourceKind: 'url',
    url: '/api/default-sample?key=default%2FKick.wav',
    name: 'Kick.wav',
  }, (value) => `https://api.example.test${value}`)).toMatchObject({
    url: 'https://api.example.test/api/default-sample?key=default%2FKick.wav',
  })
})

test('default sample catalog items reject unavailable media URLs', () => {
  expect(() => normalizeDefaultSampleCatalogItem({
    key: 'default/Kick.wav',
    assetKey: 'asset:default:default/Kick.wav',
    sourceKind: 'url',
    url: '/api/default-sample?key=default%2FKick.wav',
    name: 'Kick.wav',
  }, () => null)).toThrow('Invalid default sample URL')
})
