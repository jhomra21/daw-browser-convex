// Writes the graph fixtures daw-reverb-bench times for the Delay: one source -> master graph without a processor and one
// with a Delay, per case at 48 and 96 kHz. Usage: bun native/audio-core/tools/delay-bench-fixtures.ts <out dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { graphEnvelope } from '../../../public/audio-worklets/daw-portable-graph-envelope-v3.js'
import { fx } from '../../../tools/effects-harness/effects'
import type { EffectSpec } from '../../../tools/effects-harness/effects'
import { noise } from '../../../tools/effects-harness/signals'
import { graphSnapshot } from '../../../tools/effects-harness/render-wasm'
import { encodePortableGraphParityFixture } from '../tests/graph-parity-fixtures'

const outDir = process.argv[2]

if (!outDir) throw new Error('Usage: delay-bench-fixtures.ts <out dir>')

mkdirSync(outDir, { recursive: true })

const write = (name: string, spec: EffectSpec | null, rate: number) => {
  const block = 4096
  const frames = 64 * block
  const left = noise(frames, 0.25, 3)
  const right = noise(frames, 0.25, 4)
  const input = new Float32Array(2 * frames)

  input.set(left)
  input.set(right, frames)
  const snapshot = graphSnapshot(spec, rate, [], false, 1)

  writeFileSync(`${outDir}/${name}-${rate}.fixture`, encodePortableGraphParityFixture({
    name, capability: 'chains', processorKind: 'delay', sampleRateHz: rate, maxFramesPerBlock: block, blockPartitions: Array.from({ length: 64 }, () => block), inputBusCount: 1, channelCount: 2,
    graph: graphEnvelope(snapshot), frames, input, portableEligible: true, assertOutput: () => true,
  }))
}

for (const rate of [48000, 96000]) {
  write('none', null, rate)
  write('delay-plain', fx.delay({ timeLeftMs: 250, feedback: 0.4, dryWet: 0.5 }), rate)
  write('delay-filter', fx.delay({ timeLeftMs: 250, feedback: 0.4, dryWet: 0.5, filterEnabled: true }), rate)
  write('delay-pingpong', fx.delay({ timeLeftMs: 250, feedback: 0.4, dryWet: 0.5, pingPong: true }), rate)
}
