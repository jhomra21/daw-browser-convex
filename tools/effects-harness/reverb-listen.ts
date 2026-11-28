// Writes the Reverb listening files for the owner: three dry sources, each through the old engine at its defaults and through the
// new engine at its defaults, with Chorus 0.3 ms at 0.4 Hz, and with Chorus off. The old engine is the base commit's worklet
// (git show 61600d21:public/audio-worklets/daw-reverb-processor-v1.js); the new one is the production wasm.
// Usage: bun --conditions=browser tools/effects-harness/reverb-listen.ts [out dir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { fx } from './effects'
import { renderWasm } from './render-wasm'
import { impulse, linearToDb, noise } from './signals'

const rate = 48000
const frames = 6 * rate
const peakDb = -1
const blockFrames = 128
const outDir = process.argv[2] ?? `${process.env.HOME}/.daw-packaged-session/reverb-listen`
const oldWorklet = '61600d21:public/audio-worklets/daw-reverb-processor-v1.js'

const oldDefaults = {
  enabled: true, wet: 0.25, decaySec: 2.2, preDelayMs: 20, reflections: 0, reflectionSpin: true, reflectionModAmountMs: 17.5, reflectionModRateHz: 0.3,
  'reflectionShape': 0.5, diffuse: 1, size: 0.65, diffusion: 0.75, density: 0.8, lowCutHz: 20, highCutHz: 20000, diffusionLowCutHz: 20, diffusionHighCutHz: 20000, stereoWidth: 1,
}

type Worklet = {
  port: { onmessage: ((event: { data: unknown }) => void) | null }
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}

const renderOld = async (input: Float32Array) => {
  const source = await Bun.$`git show ${oldWorklet}`.text()
  const registered: (new () => Worklet)[] = []

  class StubProcessor {
    port = { onmessage: null, postMessage: () => {}, close: () => {} }
  }

  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(StubProcessor, (_name: string, processor: new () => Worklet) => registered.push(processor), rate)
  const worklet = new registered[0]()
  worklet.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: oldDefaults } })

  const parameters = {
    'reverb.wet': Float32Array.of(oldDefaults.wet), 'reverb.preDelayMs': Float32Array.of(oldDefaults.preDelayMs), 'reverb.lowCutHz': Float32Array.of(oldDefaults.lowCutHz),
    'reverb.highCutHz': Float32Array.of(oldDefaults.highCutHz), 'reverb.stereoWidth': Float32Array.of(oldDefaults.stereoWidth),
  }

  const output = [new Float32Array(input.length), new Float32Array(input.length)]

  for (let offset = 0; offset < input.length; offset += blockFrames) {
    const block = input.subarray(offset, offset + blockFrames)
    const left = new Float32Array(blockFrames)
    const right = new Float32Array(blockFrames)
    left.set(block)
    right.set(block)
    const rendered = [new Float32Array(blockFrames), new Float32Array(blockFrames)]
    worklet.process([[left, right]], [rendered], parameters)
    output[0].set(rendered[0].subarray(0, block.length), offset)
    output[1].set(rendered[1].subarray(0, block.length), offset)
  }

  return output
}

const renderNew = async (input: Float32Array, state: Parameters<typeof fx.reverb>[0]) => (await renderWasm(fx.reverb(state), rate, { input: [input] })).output

const drum = () => {
  const burst = noise(Math.round(0.03 * rate), 1, 7).map((value, n) => value * Math.exp(-n / (0.006 * rate)))

  return Float32Array.from({ length: frames }, (_, n) => burst[n] ?? 0)
}

const sine = () => {
  const attack = 0.05 * rate
  const hold = 2 * rate
  const release = 1.5 * rate

  return Float32Array.from({ length: frames }, (_, n) => {
    const envelope = n < attack ? 0.5 - 0.5 * Math.cos(Math.PI * n / attack) : n < hold ? 1 : n < hold + release ? 0.5 + 0.5 * Math.cos(Math.PI * (n - hold) / release) : 0

    return 0.5 * envelope * Math.sin(2 * Math.PI * 440 * n / rate)
  })
}

const wav16 = (channels: readonly Float32Array[], gain: number) => {
  const dataBytes = frames * 4
  const view = new DataView(new ArrayBuffer(44 + dataBytes))
  const text = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 4, true)
  view.setUint16(32, 4, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let n = 0; n < frames; n += 1) {
    channels.forEach((channel, index) => view.setInt16(44 + (n * 2 + index) * 2, Math.round(Math.max(-1, Math.min(1, channel[n] * gain)) * 32767), true))
  }

  return new Uint8Array(view.buffer)
}

const peakOf = (channels: readonly Float32Array[]) => Math.max(...channels.map((channel) => channel.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)))

const rmsDb = (channels: readonly Float32Array[], gain: number) => linearToDb(gain * Math.sqrt(channels.reduce((sum, channel) => sum + channel.reduce((s, v) => s + v * v, 0), 0) / (2 * frames)))

const sources: [string, string, Float32Array][] = [
  ['drum', 'a 30 ms decaying noise burst (time constant 6 ms, seeded noise)', drum()],
  ['sine', 'a 440 Hz sine, 50 ms raised-cosine attack, held to 2 s, 1.5 s raised-cosine release', sine()],
  ['impulse', 'one full-scale sample at 0 s', impulse(frames)],
]

const versions: [string, string, (input: Float32Array) => Promise<Float32Array[]>][] = [
  ['a-old-defaults', 'the old engine at its defaults (Wet 25 %, Decay 2.2 s, Size 0.65, Diffuse 1, Density 0.8, Diffusion 0.75, Reflect 0, Width 1)', renderOld],
  ['b-new-defaults', 'the new engine at its defaults (Wet 25 %, High, Chorus 0.6 ms at 0.6 Hz, Reflect 0.25, Diffuse 0.7)', (input) => renderNew(input, {})],
  ['c-new-chorus-0.3ms-0.4hz', 'the new defaults with Chorus 0.3 ms at 0.4 Hz', (input) => renderNew(input, { chorusAmountMs: 0.3, chorusRateHz: 0.4 })],
  ['d-new-chorus-off', 'the new defaults with Chorus off', (input) => renderNew(input, { chorus: false })],
]

mkdirSync(outDir, { recursive: true })

const lines = [
  '# Reverb listening files', '',
  'Every file is 6 s, 48 kHz, stereo, 16-bit, Wet 25 % (the plain dry/wet mix of each engine). Each file is scaled so its peak is exactly -1 dBFS,',
  'so the files of one source sit at the same peak level. The scale applied and the resulting RMS are listed so the real level difference stays readable.', '',
  'Rendered by tools/effects-harness/reverb-listen.ts: the old engine is the base commit worklet (61600d21), the new engine the production wasm.', '',
]

for (const [sourceName, description, input] of sources) {
  lines.push(`## ${sourceName}: ${description}`, '', '| file | settings | scale applied | RMS |', '|---|---|---|---|')

  for (const [versionName, settings, render] of versions) {
    const output = await render(input)
    const gain = 10 ** (peakDb / 20) / peakOf(output)
    const file = `${sourceName}-${versionName}.wav`
    writeFileSync(`${outDir}/${file}`, wav16(output, gain))
    lines.push(`| ${file} | ${settings} | ${linearToDb(gain).toFixed(1)} dB | ${rmsDb(output, gain).toFixed(1)} dBFS |`)
  }

  lines.push('')
}

writeFileSync(`${outDir}/README.md`, lines.join('\n'))

console.log(`wrote ${sources.length * versions.length} files and README.md to ${outDir}`)
