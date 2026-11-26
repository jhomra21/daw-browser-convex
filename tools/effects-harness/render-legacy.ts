// Renders an effect through the shipped browser AudioWorklet (public/audio-worklets/daw-*-processor-v1.js) under a stubbed
// AudioWorkletProcessor. EQ is a Web Audio node chain in the browser; bun has no OfflineAudioContext,
// so it reports as not measured.
import type { EffectKind, EffectSpec } from './effects'
import { getPath, withPaths } from './state-path'
import type { Planar, RenderOptions } from './types'

const blockFrames = 128
const worklets = new URL('../../public/audio-worklets/', import.meta.url).pathname

const files: Partial<Record<EffectKind, string>> = {
  utility: 'daw-utility-processor-v1.js', autofilter: 'daw-autofilter-processor-v1.js', lofi: 'daw-lofi-processor-v1.js',
  limiter: 'daw-limiter-processor-v1.js', gate: 'daw-gate-processor-v1.js', compressor: 'daw-compressor-processor-v1.js',
  reverb: 'daw-reverb-processor-v1.js', delay: 'daw-delay-processor-v1.js', saturator: 'daw-saturator-processor-v1.js', spectral: 'daw-spectral-processor-v1.js',
  chorus: 'daw-modulation-processor-v1.js', flanger: 'daw-modulation-processor-v1.js', phaser: 'daw-modulation-processor-v1.js',
  tremolo: 'daw-modulation-processor-v1.js', autopan: 'daw-modulation-processor-v1.js', ensemble: 'daw-modulation-processor-v1.js',
}

/** Worklet AudioParam names that differ from the contract state key. */
const parameterAliases = new Map([['limiter.ceiling', 'ceilingDbtp'], ['limiter.release', 'releaseMs'], ['delay.timeMs', 'timeLeftMs']])

type Descriptor = { name: string; defaultValue?: number }

type Port = { onmessage: ((event: { data: unknown }) => void) | null; postMessage: () => void; close: () => void }

type WorkletOptions = { processorOptions: { processorKind: EffectKind } | { fftSize: number; overlap: number } }

type Worklet = { port: Port; process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean }

type WorkletConstructor = { new (options: WorkletOptions): Worklet; parameterDescriptors?: Descriptor[] }

export const legacySupported = (kind: EffectKind) => files[kind] !== undefined

export const unsupportedReason = 'Web Audio node chain; bun has no OfflineAudioContext'

const instantiate = async (spec: EffectSpec, rate: number) => {
  const file = files[spec.kind]

  if (file === undefined) throw new Error(`${spec.kind} has no legacy worklet`)
  const source = await Bun.file(worklets + file).text()
  const registered: WorkletConstructor[] = []

  class StubProcessor {
    port: Port = { onmessage: null, postMessage: () => {}, close: () => {} }
  }

  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    StubProcessor, (_name: string, processor: WorkletConstructor) => registered.push(processor), rate)
  const Constructor = registered[0]

  if (Constructor === undefined) throw new Error(`${file} did not register a processor`)

  const options: WorkletOptions = spec.kind === 'spectral'
    ? { processorOptions: { fftSize: spec.state.fftSize, overlap: spec.state.overlap } }
    : { processorOptions: { processorKind: spec.kind } }

  return { worklet: new Constructor(options), descriptors: Constructor.parameterDescriptors ?? [] }
}

const parametersFor = (kind: EffectKind, state: EffectSpec['state'], descriptors: readonly Descriptor[]) =>
  Object.fromEntries(descriptors.map(({ name, defaultValue }) => {
    const [prefix, ...rest] = name.split('.')
    const key = parameterAliases.get(name) ?? rest.join('.')
    const value = prefix === kind ? getPath(state, key) : undefined

    return [name, Float32Array.of(value ?? defaultValue ?? 0)]
  }))

export const renderLegacy = async (spec: EffectSpec, rate: number, options: RenderOptions): Promise<Planar | null> => {
  if (!legacySupported(spec.kind)) return null
  const { worklet, descriptors } = await instantiate(spec, rate)
  const frames = options.input[0].length
  const steps = options.steps ?? []
  const enabledSteps = options.enabledSteps ?? []
  let state = spec.state
  let revision = 0

  const configure = () => {
    revision += 1
    worklet.port.onmessage?.({
      data: spec.kind === 'compressor'
        ? { type: 'params', params: state }
        : { type: 'configure', version: 1, revision, state },
    })
  }

  if (spec.kind === 'delay' && options.tempoBpm !== undefined) worklet.port.onmessage?.({ data: { type: 'tempo', version: 1, bpm: options.tempoBpm } })
  configure()
  const output: Planar = [new Float32Array(frames), new Float32Array(frames)]

  for (let offset = 0; offset < frames; offset += blockFrames) {
    const count = Math.min(blockFrames, frames - offset)

    for (const step of steps) {
      if (step.frame % blockFrames !== 0) throw new Error('Legacy worklet steps must sit on a 128-frame block boundary')

      if (step.frame === offset) {
        state = withPaths(state, step.set)
        configure()
      }
    }

    for (const step of enabledSteps) {
      if (step.frame % blockFrames !== 0) throw new Error('Legacy worklet steps must sit on a 128-frame block boundary')

      if (step.frame === offset) {
        state = { ...state, enabled: step.enabled }
        configure()
      }
    }

    const left = new Float32Array(blockFrames)
    const right = new Float32Array(blockFrames)
    left.set(options.input[0].subarray(offset, offset + count))
    right.set((options.input[1] ?? options.input[0]).subarray(offset, offset + count))
    const blockOutput = [new Float32Array(blockFrames), new Float32Array(blockFrames)]
    const buses = [[left, right]]

    if (options.key) {
      const keyLeft = new Float32Array(blockFrames)
      const keyRight = new Float32Array(blockFrames)
      keyLeft.set(options.key[0].subarray(offset, offset + count))
      keyRight.set((options.key[1] ?? options.key[0]).subarray(offset, offset + count))
      buses.push([keyLeft, keyRight])
    }

    worklet.process(buses, [blockOutput], parametersFor(spec.kind, state, descriptors))
    output[0].set(blockOutput[0].subarray(0, count), offset)
    output[1].set(blockOutput[1].subarray(0, count), offset)
  }

  return output
}
