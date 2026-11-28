// Writes the graph fixtures daw-spectral-bench times at 48 kHz: one source -> master graph without a processor, and the Spectral
// modes at the FFT sizes the cost depends on, in 1024-frame blocks (a fixture holds at most 64 blocks): at overlap 4 a 4096 hop is one block, so the worst block is one analysis frame.
// Usage: bun native/audio-core/tools/spectral-bench-fixtures.ts <out dir>
import { mkdirSync, writeFileSync } from 'node:fs'
import { graphEnvelope } from '../../../public/audio-worklets/daw-portable-graph-envelope-v3.js'
import { fx } from '../../../tools/effects-harness/effects'
import type { EffectSpec } from '../../../tools/effects-harness/effects'
import { noise } from '../../../tools/effects-harness/signals'
import { graphSnapshot } from '../../../tools/effects-harness/render-wasm'
import { encodePortableGraphParityFixture } from '../tests/graph-parity-fixtures'

const outDir = process.argv[2]

if (!outDir) throw new Error('Usage: spectral-bench-fixtures.ts <out dir>')

mkdirSync(outDir, { recursive: true })

const rate = 48000
const block = 1024
const frames = 64 * block

const write = (name: string, spec: EffectSpec | null) => {
  const input = new Float32Array(2 * frames)

  input.set(noise(frames, 0.25, 3))
  input.set(noise(frames, 0.25, 4), frames)
  writeFileSync(`${outDir}/${name}.fixture`, encodePortableGraphParityFixture({
    name, capability: 'chains', processorKind: spec?.kind ?? 'utility', sampleRateHz: rate, maxFramesPerBlock: block, blockPartitions: Array.from({ length: 64 }, () => block), inputBusCount: 1, channelCount: 2,
    graph: graphEnvelope(graphSnapshot(spec, rate, [], false, 1)), frames, input, portableEligible: true, assertOutput: () => true,
  }))
}

write('none', null)

for (const fftSize of [512, 1024, 2048, 4096] as const) {
  // Freeze released is the plain analysis and synthesis pass: both FFTs, both window loops and the overlap-add.
  write(`passthrough-${fftSize}-overlap4`, fx.spectral({ fftSize, overlap: 4, mode: 'freeze', freeze: 0 }))
}

write('passthrough-4096-overlap2', fx.spectral({ fftSize: 4096, overlap: 2, mode: 'freeze', freeze: 0 }))

for (const [name, mode] of [['gate', 'gate'], ['morph', 'morph'], ['shift-blur', 'shift-blur'], ['hpss', 'hpss'], ['noise-reduce', 'noise-reduce']] as const) {
  write(`${name}-2048-overlap4`, fx.spectral({ fftSize: 2048, overlap: 4, mode, binShift: 3, blur: 0.5, noiseReduction: 0.5, profileLearn: 0.1 }))
  write(`${name}-4096-overlap4`, fx.spectral({ fftSize: 4096, overlap: 4, mode, binShift: 3, blur: 0.5, noiseReduction: 0.5, profileLearn: 0.1 }))
}
