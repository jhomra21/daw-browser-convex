// Writes the processor descriptors the TypeScript compiler emits for the shapes the
// native contracts drive, so the C++ rig builds its stages from what the product
// sends (state bytes, latency, tail, bypass flag, declared parameter targets)
// instead of a hand-made approximation of it.
//
//   bun native/audio-core/scripts/generate-compiled-processors.ts          write
//   bun native/audio-core/scripts/generate-compiled-processors.ts --check  fail if stale
//
// One record per line: name instanceId kindId stateVersion latencyFrames tailFrames
// bypassed targets(comma separated) state(hex). Every record is the first processor
// of a one-channel graph run through createPortableGraphSnapshot at 48 kHz.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createDefaultAutoFilterParams,
  createDefaultAutoPanParams,
  createDefaultChorusParams,
  createDefaultCompressorParams,
  createDefaultDelayParams,
  createDefaultEnsembleParams,
  createDefaultEqParams,
  createDefaultFlangerParams,
  createDefaultGateParams,
  createDefaultLimiterParams,
  createDefaultLoFiParams,
  createDefaultPhaserParams,
  createDefaultReverbParams,
  createDefaultSaturatorParams,
  createDefaultSpectralParams,
  createDefaultTremoloParams,
  createDefaultUtilityParams,
} from '@daw-browser/shared'
import { createPortableGraphSnapshot } from '../../../packages/audio-engine/src/mixer/graph-contract'
import { createMixerChannels } from '../../../packages/audio-engine/src/mixer/channels'
import { resolveMixerGraph } from '../../../packages/audio-engine/src/mixer/resolve-routing'

type Instance = NonNullable<Parameters<typeof resolveMixerGraph>[0]['trackFx']>[string]['instances'][number]

const outputPath = resolve(import.meta.dir, '../tests/fixtures/compiled-processors.txt')

const utility = (overrides: Partial<ReturnType<typeof createDefaultUtilityParams>>): Instance => ({
  id: 'subject', kind: 'utility', params: { version: 1, state: { ...createDefaultUtilityParams(), ...overrides } },
})
const saturator = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'saturator',
  params: {
    ...createDefaultSaturatorParams(), enabled, driveDb: 18, curve: 'hard', color: true,
    colorFrequencyHz: 2500, colorAmount: 0.5, outputDb: -3, dryWet: 0.75,
  },
})
const eq = (enabled: boolean): Instance => {
  const params = createDefaultEqParams()
  const [first, ...rest] = params.bands
  if (!first) throw new Error('The default EQ has no bands.')
  return {
    id: 'subject', kind: 'eq',
    params: { ...params, enabled, bands: [{ ...first, type: 'lowshelf', frequency: 200, gainDb: 12, q: 0.7, enabled: true }, ...rest] },
  }
}
const gate = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'gate',
  params: {
    version: 1,
    state: {
      ...createDefaultGateParams(), enabled, thresholdDb: 0, ratio: 1, attackMs: 0.1, holdMs: 0, releaseMs: 5,
      hysteresisDb: 0, rangeDb: -60, lookaheadMs: 0, link: 1,
    },
  },
})
// A hard compressor with full lookahead and a detector low-pass wide enough to pass
// a steady key.
const compressor = (enabled: boolean, thresholdDb: number): Instance => ({
  id: 'subject', kind: 'compressor',
  params: {
    ...createDefaultCompressorParams(), enabled, thresholdDb, ratio: 100, attackMs: 0.1, releaseMs: 5, autoRelease: false,
    makeupDb: 0, outputDb: 0, dryWet: 1, kneeDb: 0, lookaheadMs: 10,
    sidechain: { enabled: true, filterType: 'lowpass', frequencyHz: 20000, q: 0.707 },
  },
})
const limiter = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'limiter',
  params: { version: 1, state: { ...createDefaultLimiterParams(), enabled, ceilingDbtp: -12, releaseMs: 20, lookaheadMs: 1, link: 1 } },
})

// The other eleven kinds, each set so that it audibly changes a 220 Hz tone (full wet,
// feedback, a bin shift, a coarse quantizer, a 2 kHz high-pass).
const chorus = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'chorus',
  params: { version: 1, state: { ...createDefaultChorusParams(), enabled, delayMs: 5, depthMs: 0, rateHz: 0.01, feedback: 0.5, mix: 1 } },
})
const flanger = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'flanger',
  params: { version: 1, state: { ...createDefaultFlangerParams(), enabled, depthMs: 0, rateHz: 0.01, feedback: 0.5, mix: 1 } },
})
const phaser = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'phaser',
  params: { version: 1, state: { ...createDefaultPhaserParams(), enabled, depthOctaves: 0, rateHz: 0.01, feedback: 0.5, mix: 1 } },
})
const tremolo = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'tremolo',
  params: { version: 1, state: { ...createDefaultTremoloParams(), enabled, rateHz: 0.01, depth: 1, phase: 0.75 } },
})
const autopan = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'autopan',
  params: { version: 1, state: { ...createDefaultAutoPanParams(), enabled, rateHz: 0.01, depth: 1, phase: 0.75 } },
})
const ensemble = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'ensemble',
  params: { version: 1, state: { ...createDefaultEnsembleParams(), enabled, depthMs: 1, rateHz: 0.05, mix: 1 } },
})
const delay = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'delay',
  params: { ...createDefaultDelayParams(), enabled, mode: 'time', timeMs: 5, feedback: 0.5, dryWet: 1 },
})
const reverb = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'reverb',
  params: { ...createDefaultReverbParams(), enabled, wet: 1, decaySec: 0.5, preDelayMs: 0 },
})
const spectral = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'spectral',
  params: { version: 1, state: { ...createDefaultSpectralParams(), enabled, fftSize: 512, mode: 'shift-blur', binShift: 8, mix: 1 } },
})
const autofilter = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'autofilter',
  params: { version: 1, state: { ...createDefaultAutoFilterParams(), enabled, mode: 'highpass', frequencyHz: 2000, mix: 1 } },
})
const lofi = (enabled: boolean): Instance => ({
  id: 'subject', kind: 'lofi',
  params: { version: 1, state: { ...createDefaultLoFiParams(), enabled, bitDepth: 2, quantization: 'truncate', mix: 1 } },
})
const otherKinds: readonly (readonly [string, (enabled: boolean) => Instance])[] = [
  ['chorus', chorus], ['flanger', flanger], ['phaser', phaser], ['tremolo', tremolo], ['autopan', autopan],
  ['ensemble', ensemble], ['delay', delay], ['reverb', reverb], ['spectral', spectral], ['autofilter', autofilter],
  ['lofi', lofi],
]

// [record name, instance id, instance]. The compiler derives a processor's instance
// id from the instance id alone, so variants of one stage share it and stages that
// sit in one graph differ.
const subjects: readonly (readonly [string, string, Instance])[] = [
  ['stage-one', 'stage-one', utility({ gainDb: 6.0206, dcBlock: false })],
  ['stage-one-swap', 'stage-one', utility({ gainDb: 6.0206, dcBlock: false, swap: true })],
  ['stage-one-off', 'stage-one', utility({ gainDb: 6.0206, dcBlock: false, enabled: false })],
  ['stage-one-swap-off', 'stage-one', utility({ gainDb: 6.0206, dcBlock: false, swap: true, enabled: false })],
  ['stage-two', 'stage-two', saturator(true)],
  ['stage-two-off', 'stage-two', saturator(false)],
  ['dc-stage', 'dc-stage', utility({ dcBlock: true })],
  ['balanced', 'balanced', utility({ dcBlock: true, balance: -1 })],
  ['added-stage', 'added-stage', utility({ dcBlock: false })],
  ['added-node-stage', 'added-node-stage', utility({ dcBlock: false })],
  ['added-source-trim', 'added-source-trim', utility({ gainDb: -3, dcBlock: false })],
  ['return-trim', 'return-trim', utility({ gainDb: -6.0206, dcBlock: false })],
  // The matrix gives this one a latency of zero (see matrix_build in audio_core_test.cpp).
  ['key-compressor', 'key-compressor', compressor(true, -12)],
  ['eq', 'eq-subject', eq(true)],
  ['eq-off', 'eq-subject', eq(false)],
  ['gate', 'gate-subject', gate(true)],
  ['gate-off', 'gate-subject', gate(false)],
  ['compressor', 'compressor-subject', compressor(true, -30)],
  ['compressor-off', 'compressor-subject', compressor(false, -30)],
  ['limiter', 'limiter-subject', limiter(true)],
  ['limiter-off', 'limiter-subject', limiter(false)],
  ...otherKinds.flatMap(([kind, build]): (readonly [string, string, Instance])[] => [
    [kind, `${kind}-subject`, build(true)],
    [`${kind}-off`, `${kind}-subject`, build(false)],
  ]),
]

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const record = (name: string, id: string, instance: Instance) => {
  const graph = resolveMixerGraph({
    channels: createMixerChannels([{ id: 'subject-track', kind: 'audio', name: 'Subject', clips: [], volume: 1 }]),
    trackFx: { 'subject-track': { instances: [{ ...instance, id }] } },
  })
  const processor = createPortableGraphSnapshot({ graph, revision: 1, sampleRate: 48_000 }).nodes[0]?.processorOrder[0]
  if (!processor) throw new Error(`The compiler emitted no processor for ${name}.`)
  const tail = processor.tailKind === 'unbounded' ? 0xffff_ffff : processor.tailFrames
  return [
    name, processor.instanceId, processor.kindId, processor.stateVersion, processor.latencyFrames, tail,
    processor.bypassed ? 1 : 0, processor.parameterTargets.map(({ target }) => target).join(','), hex(processor.state),
  ].join(' ')
}

const expected = `${subjects.map(([name, id, instance]) => record(name, id, instance)).join('\n')}\n`

if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== expected) {
    console.error('compiled-processors.txt is stale. Run: bun native/audio-core/scripts/generate-compiled-processors.ts')
    process.exit(1)
  }
} else {
  writeFileSync(outputPath, expected)
}
