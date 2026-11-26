// Writes the graph fixtures daw-modulation-bench times at 48 kHz: one source -> master graph without a processor, and each modulation
// effect at its default and at a heavy setting. Usage: bun native/audio-core/tools/modulation-bench-fixtures.ts <out dir>
/* oxlint-disable anti-slop/no-shape-in-symbol-names -- shape is a contract field name */
import { mkdirSync, writeFileSync } from 'node:fs'
import { graphEnvelope } from '../../../public/audio-worklets/daw-portable-graph-envelope-v3.js'
import { fx } from '../../../tools/effects-harness/effects'
import type { EffectSpec } from '../../../tools/effects-harness/effects'
import { noise } from '../../../tools/effects-harness/signals'
import { graphSnapshot } from '../../../tools/effects-harness/render-wasm'
import { encodePortableGraphParityFixture } from '../tests/graph-parity-fixtures'

const outDir = process.argv[2]

if (!outDir) throw new Error('Usage: modulation-bench-fixtures.ts <out dir>')

mkdirSync(outDir, { recursive: true })

const rate = 48000

const write = (name: string, spec: EffectSpec | null) => {
  const block = 4096
  const frames = 64 * block
  const input = new Float32Array(2 * frames)

  input.set(noise(frames, 0.25, 3))
  input.set(noise(frames, 0.25, 4), frames)
  writeFileSync(`${outDir}/${name}.fixture`, encodePortableGraphParityFixture({
    name, capability: 'chains', processorKind: spec?.kind ?? 'utility', sampleRateHz: rate, maxFramesPerBlock: block, blockPartitions: Array.from({ length: 64 }, () => block), inputBusCount: 1, channelCount: 2,
    graph: graphEnvelope(graphSnapshot(spec, rate, [], false, 1)), frames, input, portableEligible: true, assertOutput: () => true,
  }))
}

write('none', null)

const rows: [string, EffectSpec][] = [
  ['chorus-default', fx.chorus()],
  ['chorus-heavy', fx.chorus({ mode: 'vintage', waveform: 'wander', safeBass: true })],
  ['flanger-default', fx.flanger()],
  ['flanger-heavy', fx.flanger({ mode: 'throughZero', feedback: 0.9, waveform: 'wander', safeBass: true })],
  ['phaser-default', fx.phaser()],
  ['phaser-heavy', fx.phaser({ stages: 12, feedback: 0.8, spreadOctaves: 1, blend: 0.5, safeBass: true })],
  ['tremolo-default', fx.tremolo()],
  ['tremolo-heavy', fx.tremolo({ shape: 0.9, waveform: 'sampleHold' })],
  ['autopan-default', fx.autopan()],
  ['autopan-heavy', fx.autopan({ shape: 0.9, waveform: 'sampleHold' })],
  ['ensemble-default', fx.ensemble()],
  ['ensemble-heavy', fx.ensemble({ fastDepthMs: 0.5, waveform: 'wander', safeBass: true })],
]

for (const [name, spec] of rows) write(name, spec)
