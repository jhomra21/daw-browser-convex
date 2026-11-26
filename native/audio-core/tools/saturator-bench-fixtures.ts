// Writes the graph fixtures daw-modulation-bench times at 48 kHz for the Saturator: one source -> master graph without a processor, then
// each curve with Hi-Quality on and off and with Color on. Usage: bun native/audio-core/tools/saturator-bench-fixtures.ts <out dir> [curves]
// A comma separated [curves] list restricts the rows, which lets a commit before the nine curves write the rows it knows.
import { mkdirSync, writeFileSync } from 'node:fs'
import { graphEnvelope } from '../../../public/audio-worklets/daw-portable-graph-envelope-v3.js'
import { fx } from '../../../tools/effects-harness/effects'
import type { EffectSpec } from '../../../tools/effects-harness/effects'
import { noise } from '../../../tools/effects-harness/signals'
import { graphSnapshot } from '../../../tools/effects-harness/render-wasm'
import { encodePortableGraphParityFixture } from '../tests/graph-parity-fixtures'

const outDir = process.argv[2]

if (!outDir) throw new Error('Usage: saturator-bench-fixtures.ts <out dir> [curves]')

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

const curves = (process.argv[3] ?? 'soft,medium,hard,clip,analog,sine,bass,fold,warp').split(',')

for (const curve of curves) {
  write(`${curve}-hiq`, fx.saturator({ driveDb: 12, curve, hiQuality: true }))
  write(`${curve}-1x`, fx.saturator({ driveDb: 12, curve, hiQuality: false }))
  write(`${curve}-color`, fx.saturator({ driveDb: 12, curve, hiQuality: true, color: true, colorHighDb: 6, colorLowDb: -3 }))
  write(`${curve}-postclip`, fx.saturator({ driveDb: 12, curve, hiQuality: true, postClip: 'hard' }))
}
