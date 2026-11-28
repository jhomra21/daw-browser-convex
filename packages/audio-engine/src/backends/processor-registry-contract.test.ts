import { expect, test } from 'bun:test'
import { AUDIO_EFFECT_KINDS } from '@daw-browser/shared'
import { processorIds, processorRegistry } from '../../../audio-core-contract/src/generated/processor-contract-metadata'
import { portableWasmCapabilityMatrix } from './portable-wasm-capabilities'

test('the native processor registry names every effect kind except the observer-only spectrum', () => {
  expect(new Set(processorRegistry.map((processor) => processor.name)))
    .toEqual(new Set(AUDIO_EFFECT_KINDS.filter((kind) => kind !== 'spectrum')))
})

test('the wire ids and the portable capability list are the registry ids and names', () => {
  const idsByName: Record<string, number> = processorIds

  expect(Object.entries(idsByName)).toEqual(processorRegistry.map((processor): [string, number] => [processor.name, processor.id]))
  expect(portableWasmCapabilityMatrix.processorKinds).toEqual(processorRegistry.map((processor) => processor.name))
})

test('wire ids stay what shipped', () => {
  expect(processorIds).toEqual({
    utility: 1, saturator: 2, eq: 3, chorus: 4, flanger: 5, phaser: 6, tremolo: 7, autopan: 8, ensemble: 9,
    gate: 10, compressor: 11, limiter: 12, delay: 13, reverb: 14, spectral: 15, autofilter: 16, lofi: 17,
  })
})
