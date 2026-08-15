import { expect, test } from 'bun:test'
import path from 'node:path'
import {
  encodePortableGraphParityFixture,
  isPlanarImpulseFixtureInput,
  portableGraphParityFixtures,
  REVERB_KNOWN_GAP_IDS,
  type PortableGraphParityFixture,
  type PortableLegacyDynamicsFixture,
  type PortableLegacyDelayFixture,
  type PortableLegacyModulationFixture,
  type PortableLegacySpectralFixture,
  type PortableDynamicsKind,
  type PortableModulationKind,
} from './graph-parity-fixtures'
import type { ReverbProcessorState } from '../../../packages/audio-core-contract/src/index'
import { portableWasmCapabilityMatrix } from '../../../packages/audio-engine/src/backends/portable-wasm-capabilities'
import { computePortableWasmSourceHash } from '../scripts/portable-wasm-source-hash'

const repositoryRoot = path.resolve(import.meta.dirname, '../../..')
const artifactUrl = new URL('../../build/audio-core-wasm/audio-core/daw-audio-core-wasm.wasm', import.meta.url)
const fixtureArtifactUrl = new URL('../../build/audio-core-wasm/audio-core/daw-audio-core-wasm-harness.wasm', import.meta.url)
const manifestUrl = new URL('../../build/audio-core-wasm/audio-core/daw-audio-core.manifest.json', import.meta.url)
const publicArtifactUrl = new URL('../../../public/audio-core/daw-audio-core.wasm', import.meta.url)
const publicManifestUrl = new URL('../../../public/audio-core/daw-audio-core.manifest.json', import.meta.url)
const nativeFixtureRunnerUrl = new URL('../../build/audio-core-debug/audio-core/daw-audio-core-graph-fixture', import.meta.url)
const legacyModulationWorkletUrl = new URL('../../../public/audio-worklets/daw-modulation-processor-v1.js', import.meta.url)
const legacyReverbWorkletUrl = new URL('../../../public/audio-worklets/daw-reverb-processor-v1.js', import.meta.url)
const legacySpectralWorkletUrl = new URL('../../../public/audio-worklets/daw-spectral-processor-v1.js', import.meta.url)
const legacyDynamicsWorkletUrls = {
  gate: new URL('../../../public/audio-worklets/daw-gate-processor-v1.js', import.meta.url),
  compressor: new URL('../../../public/audio-worklets/daw-compressor-processor-v1.js', import.meta.url),
  limiter: new URL('../../../public/audio-worklets/daw-limiter-processor-v1.js', import.meta.url),
} satisfies Record<PortableDynamicsKind, URL>

type WasmArtifactManifest = {
  artifactKind: string
  abiVersion: number
  buildType: string
  lto: boolean
  fixedMemory: boolean
  memoryBytes: number
  sizeBytes: number
  maximumBytes: number
  sha256: string
  sourceHash: string
  wasmUrl: string
}

const isWasmArtifactManifest = (value: unknown): value is WasmArtifactManifest =>
  typeof value === 'object'
  && value !== null
  && 'artifactKind' in value && typeof value.artifactKind === 'string'
  && 'abiVersion' in value && typeof value.abiVersion === 'number'
  && 'buildType' in value && typeof value.buildType === 'string'
  && 'lto' in value && typeof value.lto === 'boolean'
  && 'fixedMemory' in value && typeof value.fixedMemory === 'boolean'
  && 'memoryBytes' in value && typeof value.memoryBytes === 'number'
  && 'sizeBytes' in value && typeof value.sizeBytes === 'number'
  && 'maximumBytes' in value && typeof value.maximumBytes === 'number'
  && 'sha256' in value && typeof value.sha256 === 'string'
  && 'sourceHash' in value && typeof value.sourceHash === 'string'
  && 'wasmUrl' in value && typeof value.wasmUrl === 'string'

type LegacyModulationPort = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (message: unknown) => void
  close: () => void
}

type LegacyModulationProcessor = {
  port: LegacyModulationPort
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters?: object) => boolean
}

type LegacyModulationProcessorConstructor = new (
  options: { processorOptions: { processorKind: PortableModulationKind } },
) => LegacyModulationProcessor

type LegacyReverbProcessor = {
  port: LegacyModulationPort
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>) => boolean
}

type LegacyReverbProcessorConstructor = new (
  options?: { processorOptions?: unknown },
) => LegacyReverbProcessor

const renderLegacyReverbFixture = async (
  fixture: PortableGraphParityFixture,
  reverb: { state: ReverbProcessorState },
  reset = false,
) => {
  const source = await Bun.file(legacyReverbWorkletUrl).text()
  const registered = new Map<string, LegacyReverbProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: LegacyModulationPort = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: LegacyReverbProcessorConstructor) => registered.set(name, processor),
    fixture.sampleRateHz,
  )
  const Processor = registered.get('daw-reverb-processor')
  if (!Processor) throw new Error('Reverb worklet did not register.')
  const processor = new Processor()
  processor.port.onmessage?.({ data: { type: 'configure', version: 1, revision: 1, state: reverb.state } })
  if (reset) processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
  const output = [
    new Float32Array(fixture.frames),
    new Float32Array(fixture.frames),
  ]
  const mono = new DataView(
    fixture.graph.buffer,
    fixture.graph.byteOffset,
    fixture.graph.byteLength,
  ).getUint32(24 + 12, true) === 1
  const input = mono
    ? [fixture.input.subarray(0, fixture.frames)]
    : [
        fixture.input.subarray(0, fixture.frames),
        fixture.input.subarray(fixture.frames, fixture.frames * 2),
      ]
  const blockPartitions = fixture.blockPartitions ?? [fixture.frames]
  const parameterBlock = (target: number, fallback: number, offset: number, frames: number) => {
    const values = delayParameterValues(fixture, target)
    if (!values) return new Float32Array(frames).fill(fallback)
    return values.length === 1
      ? new Float32Array(values)
      : Float32Array.from(values.slice(offset, offset + frames))
  }
  let offset = 0
  for (const blockFrames of blockPartitions) {
    const blockInput = mono
      ? [input[0].subarray(offset, offset + blockFrames)]
      : [
          input[0].subarray(offset, offset + blockFrames),
          input[1].subarray(offset, offset + blockFrames),
        ]
    const blockOutput = [
      output[0].subarray(offset, offset + blockFrames),
      output[1].subarray(offset, offset + blockFrames),
    ]
    processor.process([blockInput], [blockOutput], {
      // The graph fixture ABI defaults an unbound wet target to 0.5.
      'reverb.wet': parameterBlock(10, 0.5, offset, blockFrames),
      'reverb.preDelayMs': parameterBlock(11, reverb.state.preDelayMs, offset, blockFrames),
      'reverb.lowCutHz': parameterBlock(12, reverb.state.lowCutHz, offset, blockFrames),
      'reverb.highCutHz': parameterBlock(13, reverb.state.highCutHz, offset, blockFrames),
      'reverb.stereoWidth': parameterBlock(14, reverb.state.stereoWidth, offset, blockFrames),
    })
    offset += blockFrames
  }
  return output
}

const renderLegacyModulationFixture = async (
  fixture: PortableGraphParityFixture,
  modulation: PortableLegacyModulationFixture,
  reset = false,
) => {
  const source = await Bun.file(legacyModulationWorkletUrl).text()
  const registered = new Map<string, LegacyModulationProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: LegacyModulationPort = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: LegacyModulationProcessorConstructor) => registered.set(name, processor),
    fixture.sampleRateHz,
  )
  const Constructor = registered.get('daw-modulation-processor')
  if (!Constructor) throw new Error('The legacy modulation processor did not register.')
  const processor = new Constructor({ processorOptions: { processorKind: modulation.kind } })
  processor.port.onmessage?.({
    data: {
      type: 'configure',
      version: 1,
      revision: 1,
      processorKind: modulation.kind,
      state: modulation.state,
    },
  })
  const output = Array.from({ length: fixture.channelCount }, () => new Float32Array(fixture.frames))
  const partitions = fixture.blockPartitions ?? [fixture.frames]
  if (reset) {
    let dirtyOffset = 0
    for (const frames of partitions) {
      const input = Array.from({ length: fixture.channelCount }, (_, channel) =>
        fixture.input.subarray(channel * fixture.frames + dirtyOffset, channel * fixture.frames + dirtyOffset + frames))
      processor.process([input], [output.map(() => new Float32Array(frames))], {})
      dirtyOffset += frames
    }
    processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
  }
  let frameOffset = 0
  for (const frames of partitions) {
    const input = Array.from({ length: fixture.channelCount }, (_, channel) =>
      fixture.input.subarray(channel * fixture.frames + frameOffset, channel * fixture.frames + frameOffset + frames))
    const blockOutput = output.map((plane) => plane.subarray(frameOffset, frameOffset + frames))
    processor.process([input], [blockOutput], {})
    frameOffset += frames
  }
  return output
}

const maximumDifference = (
  left: readonly Float32Array[],
  right: readonly Float32Array[],
) => left.reduce((maximum, plane, channel) => plane.reduce((channelMaximum, sample, frame) =>
  Math.max(channelMaximum, Math.abs(sample - (right[channel]?.[frame] ?? 0))), maximum), 0)

type LegacyDynamicsProcessor = {
  port: LegacyModulationPort
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>) => boolean
}

type LegacyDynamicsProcessorConstructor = new () => LegacyDynamicsProcessor

const legacyDynamicsParameters = (dynamics: PortableLegacyDynamicsFixture) => {
  if (dynamics.kind === 'gate') {
    const state = dynamics.state
    return {
      'gate.thresholdDb': Float32Array.of(state.thresholdDb),
      'gate.ratio': Float32Array.of(state.ratio),
      'gate.attackMs': Float32Array.of(state.attackMs),
      'gate.holdMs': Float32Array.of(state.holdMs),
      'gate.releaseMs': Float32Array.of(state.releaseMs),
      'gate.hysteresisDb': Float32Array.of(state.hysteresisDb),
      'gate.rangeDb': Float32Array.of(state.rangeDb),
      'gate.lookaheadMs': Float32Array.of(state.lookaheadMs),
      'gate.link': Float32Array.of(state.link),
    }
  }
  if (dynamics.kind === 'limiter') {
    const state = dynamics.state
    return {
      'limiter.ceiling': Float32Array.of(state.ceilingDbtp),
      'limiter.release': Float32Array.of(state.releaseMs),
      'limiter.lookaheadMs': Float32Array.of(state.lookaheadMs),
      'limiter.link': Float32Array.of(state.link),
      'limiter.detectorOversampling': Float32Array.of(state.detectorOversampling),
    }
  }
  return {}
}

const renderLegacyDynamicsFixture = async (
  fixture: PortableGraphParityFixture,
  dynamics: PortableLegacyDynamicsFixture,
  reset = false,
) => {
  const source = await Bun.file(legacyDynamicsWorkletUrls[dynamics.kind]).text()
  const registered = new Map<string, LegacyDynamicsProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: LegacyModulationPort = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: LegacyDynamicsProcessorConstructor) => registered.set(name, processor),
    fixture.sampleRateHz,
  )
  const processorName = dynamics.kind === 'gate'
    ? 'daw-gate-processor'
    : dynamics.kind === 'compressor'
      ? 'daw-compressor-processor'
      : 'daw-limiter-processor'
  const Constructor = registered.get(processorName)
  if (!Constructor) throw new Error(`The legacy ${dynamics.kind} processor did not register.`)
  const processor = new Constructor()
  processor.port.onmessage?.({
    data: dynamics.kind === 'compressor'
      ? { type: 'params', params: dynamics.state }
      : { type: 'configure', version: 1, revision: 1, state: dynamics.state },
  })
  const output = Array.from({ length: fixture.channelCount }, () => new Float32Array(fixture.frames))
  const partitions = fixture.blockPartitions ?? [fixture.frames]
  const render = (target: readonly Float32Array[]) => {
    let frameOffset = 0
    for (const frames of partitions) {
      const inputs = Array.from({ length: fixture.inputBusCount }, (_, bus) =>
        Array.from({ length: fixture.channelCount }, (_, channel) => {
          const plane = bus * fixture.channelCount + channel
          return fixture.input.subarray(
            plane * fixture.frames + frameOffset,
            plane * fixture.frames + frameOffset + frames,
          )
        }))
      const blockOutput = target.map((plane) => plane.subarray(frameOffset, frameOffset + frames))
      processor.process(inputs, [blockOutput], legacyDynamicsParameters(dynamics))
      frameOffset += frames
    }
  }
  if (reset && dynamics.kind !== 'compressor') {
    render(output.map(() => new Float32Array(fixture.frames)))
    processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
  }
  render(output)
  return output
}

type LegacySpectralProcessor = {
  port: LegacyModulationPort
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) => boolean
}

type LegacySpectralProcessorConstructor = new (
  options: { processorOptions: { fftSize: number; overlap: number } },
) => LegacySpectralProcessor

const legacySpectralParameters = (spectral: PortableLegacySpectralFixture) => {
  const state = spectral.state
  return {
    'spectral.freeze': Float32Array.of(state.freeze),
    'spectral.gateThresholdDb': Float32Array.of(state.gateThresholdDb),
    'spectral.gateAttackMs': Float32Array.of(state.gateAttackMs),
    'spectral.gateReleaseMs': Float32Array.of(state.gateReleaseMs),
    'spectral.morph': Float32Array.of(state.morph),
    'spectral.binShift': Float32Array.of(state.binShift),
    'spectral.blur': Float32Array.of(state.blur),
    'spectral.harmonicPercussiveBalance': Float32Array.of(state.harmonicPercussiveBalance),
    'spectral.noiseReduction': Float32Array.of(state.noiseReduction),
    'spectral.profileLearn': Float32Array.of(state.profileLearn),
    'spectral.mix': spectral.mixValues ?? Float32Array.of(state.mix),
  }
}

const renderLegacySpectralFixture = async (
  fixture: PortableGraphParityFixture,
  spectral: PortableLegacySpectralFixture,
  attemptStateRestore = false,
) => {
  const source = await Bun.file(legacySpectralWorkletUrl).text()
  const registered = new Map<string, LegacySpectralProcessorConstructor>()
  class FakeAudioWorkletProcessor {
    port: LegacyModulationPort = {
      onmessage: null,
      postMessage: () => {},
      close: () => {},
    }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
    FakeAudioWorkletProcessor,
    (name: string, processor: LegacySpectralProcessorConstructor) => registered.set(name, processor),
    fixture.sampleRateHz,
  )
  const Constructor = registered.get('daw-spectral-processor')
  if (!Constructor) throw new Error('The legacy spectral processor did not register.')
  const processor = new Constructor({
    processorOptions: { fftSize: spectral.state.fftSize, overlap: spectral.state.overlap },
  })
  processor.port.onmessage?.({
    data: {
      type: 'configure',
      version: 1,
      state: spectral.state,
    },
  })
  const output = Array.from({ length: fixture.channelCount }, () => new Float32Array(fixture.frames))
  const partitions = fixture.blockPartitions ?? [fixture.frames]
  const render = (sourceInput: Float32Array, target: readonly Float32Array[]) => {
    let frameOffset = 0
    for (const frames of partitions) {
      const inputs = Array.from({ length: fixture.inputBusCount }, (_, bus) =>
        Array.from({ length: fixture.channelCount }, (_, channel) => {
          const plane = bus * fixture.channelCount + channel
          return sourceInput.subarray(
            plane * fixture.frames + frameOffset,
            plane * fixture.frames + frameOffset + frames,
          )
        }))
      const blockOutput = target.map((plane) => plane.subarray(frameOffset, frameOffset + frames))
      processor.process(inputs, [blockOutput], legacySpectralParameters(spectral))
      frameOffset += frames
    }
  }
  if (attemptStateRestore) {
    const dirtyInput = fixture.stateRestoreDirtyInput
    if (!dirtyInput) throw new Error(`${fixture.name} does not define state-restore dirty input.`)
    render(dirtyInput, output.map(() => new Float32Array(fixture.frames)))
    processor.port.onmessage?.({ data: { type: 'reset', version: 1 } })
  }
  render(fixture.input, output)
  return output
}

type BiquadState = {
  x1: number
  x2: number
  y1: number
  y2: number
}

type BiquadCoefficients = {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

const legacyBiquadCoefficients = (
  type: 'lowpass' | 'highpass',
  frequencyHz: number,
  sampleRateHz: number,
): BiquadCoefficients => {
  const omega = 2 * Math.PI * Math.min(frequencyHz, sampleRateHz * 0.5) / sampleRateHz
  const cosine = Math.cos(omega)
  const alpha = Math.sin(omega) / (2 * 0.707)
  const a0 = 1 + alpha
  const highpass = type === 'highpass'
  return {
    b0: (highpass ? (1 + cosine) / 2 : (1 - cosine) / 2) / a0,
    b1: (highpass ? -(1 + cosine) : 1 - cosine) / a0,
    b2: (highpass ? (1 + cosine) / 2 : (1 - cosine) / 2) / a0,
    a1: -2 * cosine / a0,
    a2: (1 - alpha) / a0,
  }
}

const renderLegacyBiquad = (
  input: number,
  coefficients: BiquadCoefficients,
  state: BiquadState,
) => {
  const output = coefficients.b0 * input
    + coefficients.b1 * state.x1
    + coefficients.b2 * state.x2
    - coefficients.a1 * state.y1
    - coefficients.a2 * state.y2
  state.x2 = state.x1
  state.x1 = input
  state.y2 = state.y1
  state.y1 = output
  return output
}

const delayParameterValues = (
  fixture: PortableGraphParityFixture,
  target: number,
) => {
  const parameters = fixture.parameters
  if (!parameters) return undefined
  const view = new DataView(parameters.buffer, parameters.byteOffset, parameters.byteLength)
  const envelopeCount = view.getUint32(0, true)
  let offset = 4
  for (let envelope = 0; envelope < envelopeCount; envelope += 1) {
    const frameCount = view.getUint32(offset + 8, true)
    const parameterTarget = view.getUint32(offset + 16, true)
    if (parameterTarget === target) {
      return Array.from({ length: frameCount }, (_, frame) => view.getFloat32(offset + 20 + frame * 4, true))
    }
    offset += 20 + frameCount * 4
  }
  return undefined
}

/**
 * Test-only reference for the shipped Web Audio DelayNode -> highpass Biquad ->
 * lowpass Biquad graph.
 */
const renderLegacyDelayFixture = (
  fixture: PortableGraphParityFixture,
  delay: PortableLegacyDelayFixture,
) => {
  const state = delay.state
  const delayValues = delayParameterValues(fixture, 5)
  const feedbackValues = delayParameterValues(fixture, 6)
  const dryWetValues = delayParameterValues(fixture, 7)
  const lowCutValues = delayParameterValues(fixture, 8)
  const highCutValues = delayParameterValues(fixture, 9)
  const maximumDelayMs = Math.max(state.delayMs, ...(delayValues ?? []))
  const bufferLength = Math.ceil(Math.min(3_000, maximumDelayMs) * fixture.sampleRateHz / 1_000) + 2
  const buffers = Array.from({ length: fixture.channelCount }, () => new Float64Array(bufferLength))
  const highpassStates = Array.from({ length: fixture.channelCount }, (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
  const lowpassStates = Array.from({ length: fixture.channelCount }, (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
  const output = Array.from({ length: fixture.channelCount }, () => new Float32Array(fixture.frames))
  let write = 0
  for (let frame = 0; frame < fixture.frames; frame += 1) {
    const delayFrames = Math.max(1, Math.min(3_000, delayValues?.[frame] ?? state.delayMs) * fixture.sampleRateHz / 1_000)
    const delayBase = Math.floor(write - delayFrames)
    const delayFraction = write - delayFrames - delayBase
    const readIndex = (index: number) => (index % bufferLength + bufferLength) % bufferLength
    const lowCut = state.filterEnabled ? Math.max(20, Math.min(2_000, lowCutValues?.[frame] ?? state.lowCutHz)) : 20
    const highCut = state.filterEnabled ? Math.max(1_000, Math.min(20_000, highCutValues?.[frame] ?? state.highCutHz)) : 20_000
    const highpass = legacyBiquadCoefficients('highpass', lowCut, fixture.sampleRateHz)
    const lowpass = legacyBiquadCoefficients('lowpass', highCut, fixture.sampleRateHz)
    const wet = buffers.map((buffer, channel) => {
      const raw = (buffer[readIndex(delayBase)] ?? 0)
        + ((buffer[readIndex(delayBase + 1)] ?? 0) - (buffer[readIndex(delayBase)] ?? 0)) * delayFraction
      return renderLegacyBiquad(
        renderLegacyBiquad(raw, highpass, highpassStates[channel]),
        lowpass,
        lowpassStates[channel],
      )
    })
    for (let channel = 0; channel < fixture.channelCount; channel += 1) {
      const dry = fixture.input[channel * fixture.frames + frame] ?? 0
      const feedbackChannel = state.pingPong ? (channel + 1) % fixture.channelCount : channel
      const feedback = wet[feedbackChannel] ?? 0
      const buffer = buffers[channel]
      if (buffer) buffer[write] = dry + feedback * Math.max(0, Math.min(0.95, feedbackValues?.[frame] ?? state.feedback))
      const plane = output[channel]
      const dryWet = Math.max(0, Math.min(1, dryWetValues?.[frame] ?? state.dryWet))
      if (plane) plane[frame] = dry * (1 - dryWet) + (wet[channel] ?? 0) * dryWet
    }
    write = (write + 1) % bufferLength
  }
  return output
}

test('the production Wasm artifact omits native and fixture-only exports', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = Object.keys(instance.instance.exports)
  for (const absent of [
    'RegisterNativeGraphHook',
    'daw_audio_core_register_native_graph_hook',
    'daw_audio_core_wasm_harness_abi_version',
    'daw_audio_core_wasm_fixture_protocol_version',
    'daw_audio_core_graph_fixture_protocol_version',
    'daw_audio_core_run_utility_fixture',
    'daw_audio_core_run_graph_fixture',
  ]) {
    expect(exports).not.toContain(absent)
  }
})

test('the fixed-memory Wasm artifact matches the Utility fixture vector', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const unknownManifest = await Bun.file(manifestUrl).json()
  if (!isWasmArtifactManifest(unknownManifest)) throw new Error('The Wasm artifact manifest is invalid.')
  const manifest = unknownManifest
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('')
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports

  expect(manifest).toMatchObject({
    artifactKind: 'production',
    abiVersion: 3,
    buildType: 'Release',
    lto: true,
    fixedMemory: true,
    memoryBytes: 268_435_456,
    sizeBytes: bytes.byteLength,
    sha256: hash,
    sourceHash: await computePortableWasmSourceHash(repositoryRoot),
    wasmUrl: '/audio-core/daw-audio-core.wasm',
  })
  expect(bytes.byteLength).toBeLessThanOrEqual(manifest.maximumBytes)
  expect(new Uint8Array(await Bun.file(publicArtifactUrl).arrayBuffer())).toEqual(new Uint8Array(bytes))
  expect(await Bun.file(publicManifestUrl).json()).toEqual(manifest)
  expect(exports.memory).toBeInstanceOf(WebAssembly.Memory)
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_get_abi_version !== 'function'
    || typeof exports.daw_audio_core_wasm_utility_initialize !== 'function'
    || typeof exports.daw_audio_core_wasm_utility_process !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_initialize !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_initialize_planar !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_prepare !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_publish !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process_planar !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_schedule_sample_source !== 'function') {
    throw new Error('The Wasm artifact does not expose the stable portable C ABI.')
  }

  expect(exports.memory.buffer.byteLength).toBe(manifest.memoryBytes)
  expect(() => exports.memory.grow(1)).toThrow()
  expect(exports.daw_audio_core_get_abi_version()).toBe(manifest.abiVersion)
  expect(exports.daw_audio_core_wasm_utility_initialize(48_000, 1)).toBe(0)

  const headroomExports = (await WebAssembly.instantiate(bytes)).instance.exports
  if (typeof headroomExports.daw_audio_core_wasm_graph_initialize_planar !== 'function'
    || typeof headroomExports.malloc !== 'function'
    || typeof headroomExports.free !== 'function') {
    throw new Error('The Wasm artifact does not expose the headroom regression ABI.')
  }
  expect(headroomExports.daw_audio_core_wasm_graph_initialize_planar(48_000, 128, 2, 2, 64)).toBe(0)
  const postInitializeAsset = headroomExports.malloc(16_000_000)
  if (typeof postInitializeAsset !== 'number' || postInitializeAsset === 0) {
    throw new Error('The fixed-memory Wasm artifact could not allocate ordinary PCM asset headroom after graph initialization.')
  }
  headroomExports.free(postInitializeAsset)

  const inputBytes = Float32Array.BYTES_PER_ELEMENT * 4
  const stateBytes = 40
  const allocation = exports.malloc(inputBytes + stateBytes)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('The Wasm artifact could not allocate its fixture buffers.')
  try {
    const memory = new DataView(exports.memory.buffer)
    const leftInput = allocation
    const rightInput = leftInput + Float32Array.BYTES_PER_ELEMENT
    const leftOutput = rightInput + Float32Array.BYTES_PER_ELEMENT
    const rightOutput = leftOutput + Float32Array.BYTES_PER_ELEMENT
    const state = rightOutput + Float32Array.BYTES_PER_ELEMENT
    memory.setFloat32(leftInput, 0.25, true)
    memory.setFloat32(rightInput, -0.5, true)
    memory.setUint32(state, 1, true)
    memory.setFloat32(state + 4, 0, true)
    memory.setUint32(state + 8, 1, true)
    memory.setUint32(state + 12, 0, true)
    memory.setFloat32(state + 16, 0, true)
    memory.setFloat32(state + 20, 0, true)
    memory.setFloat32(state + 24, 1, true)
    memory.setUint32(state + 28, 0, true)
    memory.setUint32(state + 32, 0, true)
    memory.setUint32(state + 36, 1, true)

    expect(exports.daw_audio_core_wasm_utility_process(1, leftInput, rightInput, leftOutput, rightOutput, state)).toBe(0)
    expect(memory.getFloat32(leftOutput, true)).toBeCloseTo(-0.25, 6)
    expect(memory.getFloat32(rightOutput, true)).toBeCloseTo(0.5, 6)
  } finally {
    exports.free(allocation)
  }
})

test('the Wasm recording capture bridge keeps bounded block output and diagnostics', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_wasm_recording_capture_initialize !== 'function'
    || typeof exports.daw_audio_core_wasm_recording_capture_process !== 'function'
    || typeof exports.daw_audio_core_wasm_recording_capture_dequeue !== 'function'
    || typeof exports.daw_audio_core_wasm_recording_capture_finalize !== 'function'
    || typeof exports.daw_audio_core_wasm_recording_capture_get_diagnostics !== 'function') {
    throw new Error('The recording capture Wasm bridge exports are unavailable.')
  }
  const allocation = exports.malloc(56 + 8 + 3 * Float32Array.BYTES_PER_ELEMENT + 48 + 64)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('Could not allocate recording capture fixture.')
  try {
    const config = allocation
    const pointers = config + 56
    const input = pointers + 8
    const block = input + 3 * Float32Array.BYTES_PER_ELEMENT
    const diagnostics = block + 48
    const view = new DataView(exports.memory.buffer)
    view.setUint32(config, 3, true)
    view.setUint32(config + 4, 3, true)
    view.setBigUint64(config + 8, 11n, true)
    view.setUint32(config + 16, 1, true)
    view.setUint32(config + 20, 0, true)
    view.setFloat32(config + 28, 2, true)
    view.setInt32(config + 32, -1, true)
    view.setBigInt64(config + 40, 1n, true)
    view.setBigInt64(config + 48, 3n, true)
    view.setUint32(pointers, input, true)
    view.setFloat32(input, 0.25, true)
    view.setFloat32(input + 4, 0.5, true)
    view.setFloat32(input + 8, 0.75, true)
    expect(exports.daw_audio_core_wasm_recording_capture_initialize(config)).toBe(0)
    expect(exports.daw_audio_core_wasm_recording_capture_process(pointers, 1, 3, 0n)).toBe(0)
    expect(exports.daw_audio_core_wasm_recording_capture_finalize(3n)).toBe(0)
    expect(exports.daw_audio_core_wasm_recording_capture_dequeue(pointers, block)).toBe(0)
    expect(view.getUint32(block + 24, true)).toBe(2)
    expect(view.getFloat32(input, true)).toBeCloseTo(-1, 6)
    expect(view.getFloat32(input + 4, true)).toBeCloseTo(-1.5, 6)
    expect(exports.daw_audio_core_wasm_recording_capture_get_diagnostics(diagnostics)).toBe(0)
    expect(view.getBigUint64(diagnostics + 16, true)).toBe(2n)
    expect(view.getUint32(diagnostics + 56, true)).toBe(0)
  } finally {
    exports.free(allocation)
  }
})

test('the Wasm graph bridge matches the portable processor envelope contract', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_initialize !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_prepare !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_publish !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process !== 'function') throw new Error('The graph bridge exports are unavailable.')
  expect(exports.daw_audio_core_wasm_graph_initialize(48_000, 4, 1)).toBe(0)
  const graph = new Uint8Array(24 + 2 * 28 + 48 + 48 + 40)
  const view = new DataView(graph.buffer)
  view.setUint32(0, 1, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, 2, true)
  view.setUint32(12, 1, true)
  view.setUint32(16, 1, true)
  view.setBigUint64(24, 1n, true)
  view.setUint32(32, 1, true)
  view.setUint32(36, 2, true)
  view.setUint32(40, 2, true)
  view.setBigUint64(52, 2n, true)
  view.setUint32(60, 6, true)
  view.setUint32(64, 2, true)
  view.setUint32(68, 2, true)
  const edge = 80
  view.setBigUint64(edge, 3n, true)
  view.setBigUint64(edge + 8, 1n, true)
  view.setBigUint64(edge + 16, 2n, true)
  view.setFloat32(edge + 32, 1, true)
  view.setUint32(edge + 36, 3, true)
  const processor = edge + 48
  view.setBigUint64(processor, 2n, true)
  view.setUint32(processor + 8, 1, true)
  view.setUint32(processor + 12, 1, true)
  view.setUint32(processor + 16, 40, true)
  view.setUint32(processor + 20, 7, true)
  view.setUint32(processor + 28, 2, true)
  view.setUint32(processor + 32, 2, true)
  view.setUint32(processor + 36, 0, true)
  view.setUint32(processor + 48, 1, true)
  view.setFloat32(processor + 52, 0, true)
  view.setUint32(processor + 56, 0, true)
  view.setUint32(processor + 60, 0, true)
  view.setFloat32(processor + 64, 0, true)
  view.setFloat32(processor + 68, 0, true)
  view.setFloat32(processor + 72, 1, true)
  const allocation = exports.malloc(graph.byteLength + Float32Array.BYTES_PER_ELEMENT * 8)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('The Wasm graph bridge could not allocate fixture buffers.')
  try {
    new Uint8Array(exports.memory.buffer, allocation, graph.byteLength).set(graph)
    expect(exports.daw_audio_core_wasm_graph_prepare(allocation, graph.byteLength - 1)).toBe(1)
    expect(exports.daw_audio_core_wasm_graph_prepare(allocation, graph.byteLength)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_publish(1)).toBe(0)
    const leftInput = allocation + graph.byteLength
    const rightInput = leftInput + 4
    const leftOutput = rightInput + 4
    const rightOutput = leftOutput + 4
    const memory = new DataView(exports.memory.buffer)
    memory.setFloat32(leftInput, 0.25, true)
    memory.setFloat32(rightInput, -0.5, true)
    expect(exports.daw_audio_core_wasm_graph_process(1, leftInput, rightInput, leftOutput, rightOutput, 1, 0, 0, 0, 0)).toBe(0)
    expect(memory.getFloat32(leftOutput, true)).toBeCloseTo(0.25, 6)
    expect(memory.getFloat32(rightOutput, true)).toBeCloseTo(-0.5, 6)
  } finally {
    exports.free(allocation)
  }
})

test('the planar graph bridge validates bounded buses and forwards epoch-scoped synth events', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_initialize_planar !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_prepare !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_publish !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_set_transport !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process_planar !== 'function') throw new Error('The planar graph bridge exports are unavailable.')
  expect(exports.daw_audio_core_wasm_graph_initialize_planar(48_000, 4, 2, 2, 1)).toBe(0)

  const graph = new Uint8Array(24 + 2 * 108 + 48)
  const graphView = new DataView(graph.buffer)
  graphView.setUint32(0, 2, true)
  graphView.setUint32(4, 1, true)
  graphView.setUint32(8, 2, true)
  graphView.setUint32(12, 1, true)
  const writeNode = (offset: number, id: bigint, kind: number, bus: number, instrument: boolean) => {
    graphView.setBigUint64(offset, id, true)
    graphView.setUint32(offset + 8, kind, true)
    graphView.setUint32(offset + 12, 2, true)
    graphView.setUint32(offset + 16, 2, true)
    graphView.setUint32(offset + 20, bus, true)
    graphView.setUint32(offset + 28, instrument ? 1 : 0, true)
    graphView.setUint32(offset + 32, instrument ? 1 : 0, true)
    graphView.setUint32(offset + 36, instrument ? 2 : 0, true)
    graphView.setUint32(offset + 40, instrument ? 1 : 0, true)
    graphView.setUint32(offset + 44, 1, true)
  }
  writeNode(24, 1n, 2, 0, true)
  writeNode(132, 2n, 6, 0, false)
  const edge = 240
  graphView.setBigUint64(edge, 3n, true)
  graphView.setBigUint64(edge + 8, 1n, true)
  graphView.setBigUint64(edge + 16, 2n, true)
  graphView.setFloat32(edge + 32, 1, true)
  graphView.setUint32(edge + 36, 3, true)

  const allocation = exports.malloc(graph.byteLength + 8 * 4 + 4 * Float32Array.BYTES_PER_ELEMENT + 4 + 48)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('The planar graph bridge could not allocate fixture buffers.')
  try {
    new Uint8Array(exports.memory.buffer, allocation, graph.byteLength).set(graph)
    expect(exports.daw_audio_core_wasm_graph_prepare(allocation, graph.byteLength)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_publish(1)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_set_transport(1, 1, 0n)).toBe(0)
    const pointers = allocation + graph.byteLength
    const planes = pointers + 8 * 4
    const view = new DataView(exports.memory.buffer)
    for (let index = 0; index < 4; index += 1) view.setUint32(pointers + index * 4, planes + index * 4, true)
    view.setUint32(pointers + 4 * 4, planes + 2 * 4, true)
    view.setUint32(pointers + 5 * 4, planes + 3 * 4, true)
    const events = planes + 4 * 4
    view.setUint32(events, 1, true)
    view.setBigUint64(events + 4, 1n, true)
    view.setBigUint64(events + 12, 1n, true)
    view.setBigUint64(events + 20, 1n, true)
    view.setUint32(events + 28, 1, true)
    view.setUint32(events + 32, 0, true)
    view.setUint32(events + 36, 1, true)
    view.setUint32(events + 40, 0, true)
    view.setUint32(events + 44, 60, true)
    view.setFloat32(events + 48, 1, true)
    expect(exports.daw_audio_core_wasm_graph_process_planar(1, 2, 2, pointers, pointers + 4 * 4, 1, 0, 0, 0, 0, events, 52)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_process_planar(1, 3, 2, pointers, pointers + 4 * 4, 1, 0, 0, 0, 0, 0, 0)).toBe(3)
    view.setUint32(events + 28, 0, true)
    expect(exports.daw_audio_core_wasm_graph_process_planar(1, 2, 2, pointers, pointers + 4 * 4, 1, 0, 0, 0, 0, events, 52)).toBe(1)
  } finally {
    exports.free(allocation)
  }
})

test('the production Wasm graph bridge renders curved fades and silence after a same-epoch pause', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_initialize_planar !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_prepare !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_publish !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_register_pcm_asset !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_schedule_sample_source !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_set_transport !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process_planar !== 'function') {
    throw new Error('The sample-source graph bridge exports are unavailable.')
  }
  expect(exports.daw_audio_core_wasm_graph_initialize_planar(48_000, 4, 1, 2, 1)).toBe(0)

  const graph = new Uint8Array(24 + 2 * 108 + 48)
  const graphView = new DataView(graph.buffer)
  graphView.setUint32(0, 2, true)
  graphView.setUint32(4, 1, true)
  graphView.setUint32(8, 2, true)
  graphView.setUint32(12, 1, true)
  graphView.setBigUint64(24, 1n, true)
  graphView.setUint32(32, 1, true)
  graphView.setUint32(36, 2, true)
  graphView.setUint32(40, 2, true)
  graphView.setBigUint64(132, 2n, true)
  graphView.setUint32(140, 6, true)
  graphView.setUint32(144, 2, true)
  graphView.setUint32(148, 2, true)
  graphView.setBigUint64(240, 3n, true)
  graphView.setBigUint64(248, 1n, true)
  graphView.setBigUint64(256, 2n, true)
  graphView.setFloat32(272, 1, true)
  graphView.setUint32(276, 3, true)

  const assetFrames = 8
  const processFrames = 4
  const allocation = exports.malloc(
    graph.byteLength
    + assetFrames * 2 * Float32Array.BYTES_PER_ELEMENT
    + 3 * BigUint64Array.BYTES_PER_ELEMENT
    + processFrames * 2 * Float32Array.BYTES_PER_ELEMENT,
  )
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('Could not allocate pause regression buffers.')
  try {
    const graphOffset = allocation
    const leftAssetOffset = graphOffset + graph.byteLength
    const rightAssetOffset = leftAssetOffset + assetFrames * Float32Array.BYTES_PER_ELEMENT
    const assetPointersOffset = rightAssetOffset + assetFrames * Float32Array.BYTES_PER_ELEMENT
    const assetHandleOffset = assetPointersOffset + BigUint64Array.BYTES_PER_ELEMENT
    const outputPointersOffset = assetHandleOffset + BigUint64Array.BYTES_PER_ELEMENT
    const leftOutputOffset = outputPointersOffset + BigUint64Array.BYTES_PER_ELEMENT
    const rightOutputOffset = leftOutputOffset + processFrames * Float32Array.BYTES_PER_ELEMENT
    const view = new DataView(exports.memory.buffer)
    new Uint8Array(exports.memory.buffer, graphOffset, graph.byteLength).set(graph)
    new Float32Array(exports.memory.buffer, leftAssetOffset, assetFrames).fill(0.25)
    new Float32Array(exports.memory.buffer, rightAssetOffset, assetFrames).fill(-0.125)
    view.setUint32(assetPointersOffset, leftAssetOffset, true)
    view.setUint32(assetPointersOffset + Uint32Array.BYTES_PER_ELEMENT, rightAssetOffset, true)
    view.setUint32(outputPointersOffset, leftOutputOffset, true)
    view.setUint32(outputPointersOffset + Uint32Array.BYTES_PER_ELEMENT, rightOutputOffset, true)

    expect(exports.daw_audio_core_wasm_graph_prepare(graphOffset, graph.byteLength)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_publish(1)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_register_pcm_asset(
      assetFrames, 48_000, 2, assetPointersOffset, assetHandleOffset,
    )).toBe(0)
    const asset = view.getBigUint64(assetHandleOffset, true)
    expect(exports.daw_audio_core_wasm_graph_set_transport(1, 0, 0n)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_schedule_sample_source(
      1, 1n, 1n, asset, 0n, 100n, 0n, BigInt(assetFrames), 1,
      0n, 4n, 100n, 100n, 0,
      1, 0.25, 0, 0.5,
    )).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_set_transport(1, 1, 0n)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_process_planar(
      processFrames, 0, 2, 0, outputPointersOffset, 1, 0, 0, 0, 0, 0, 0,
    )).toBe(0)
    const expectedFade = [0, 0.5980762, 0.8541020, 0.9686270]
    expect(Array.from(new Float32Array(exports.memory.buffer, leftOutputOffset, processFrames))).toEqual(
      expectedFade.map((gain) => expect.closeTo(gain * 0.25, 5)),
    )
    expect(Array.from(new Float32Array(exports.memory.buffer, rightOutputOffset, processFrames))).toEqual(
      expectedFade.map((gain) => expect.closeTo(gain * -0.125, 5)),
    )

    expect(exports.daw_audio_core_wasm_graph_set_transport(1, 0, 2n)).toBe(0)
    new Float32Array(exports.memory.buffer, leftOutputOffset, processFrames).fill(1)
    new Float32Array(exports.memory.buffer, rightOutputOffset, processFrames).fill(-1)
    expect(exports.daw_audio_core_wasm_graph_process_planar(
      processFrames, 0, 2, 0, outputPointersOffset, 1, 0, 0, 0, 0, 0, 0,
    )).toBe(0)
    expect(Array.from(new Float32Array(exports.memory.buffer, leftOutputOffset, processFrames))).toEqual(
      Array.from(new Float32Array(processFrames)),
    )
    expect(Array.from(new Float32Array(exports.memory.buffer, rightOutputOffset, processFrames))).toEqual(
      Array.from(new Float32Array(processFrames)),
    )
  } finally {
    exports.free(allocation)
  }
})

test('the Wasm graph bridge renders asset-backed sampler voices', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_register_pcm_asset !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_configure_sampler !== 'function'
    || typeof exports.daw_audio_core_wasm_graph_process_planar !== 'function') {
    throw new Error('The sampler graph bridge exports are unavailable.')
  }
  expect(exports.daw_audio_core_wasm_graph_initialize_planar(48_000, 4, 1, 2, 1)).toBe(0)
  const graph = new Uint8Array(24 + 2 * 108 + 48)
  const graphView = new DataView(graph.buffer)
  graphView.setUint32(0, 2, true)
  graphView.setUint32(4, 1, true)
  graphView.setUint32(8, 2, true)
  graphView.setUint32(12, 1, true)
  graphView.setBigUint64(24, 1n, true)
  graphView.setUint32(32, 2, true)
  graphView.setUint32(36, 2, true)
  graphView.setUint32(40, 2, true)
  graphView.setUint32(52, 2, true)
  graphView.setUint32(56, 1, true)
  graphView.setUint32(60, 2, true)
  graphView.setUint32(64, 0, true)
  graphView.setBigUint64(132, 2n, true)
  graphView.setUint32(140, 6, true)
  graphView.setUint32(144, 2, true)
  graphView.setUint32(148, 2, true)
  graphView.setBigUint64(240, 3n, true)
  graphView.setBigUint64(248, 1n, true)
  graphView.setBigUint64(256, 2n, true)
  graphView.setFloat32(272, 1, true)
  graphView.setUint32(276, 3, true)
  const allocation = exports.malloc(graph.byteLength + 4 * 4 + 4 + 8 + 88 + 80 + 8 * 4 + 52)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('Could not allocate sampler bridge fixture.')
  try {
    const graphOffset = allocation
    const sampleOffset = graphOffset + graph.byteLength
    const planesOffset = sampleOffset + 4 * 4
    const assetOffset = planesOffset + 4
    const stateOffset = assetOffset + 8
    const zoneOffset = stateOffset + 88
    const pointersOffset = zoneOffset + 80
    const eventsOffset = pointersOffset + 8 * 4
    new Uint8Array(exports.memory.buffer, graphOffset, graph.byteLength).set(graph)
    const view = new DataView(exports.memory.buffer)
    for (let index = 0; index < 4; index += 1) view.setFloat32(sampleOffset + index * 4, 0.25 * (index + 1), true)
    view.setUint32(planesOffset, sampleOffset, true)
    expect(exports.daw_audio_core_wasm_graph_prepare(graphOffset, graph.byteLength)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_publish(1)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_register_pcm_asset(4, 44_100, 1, planesOffset, assetOffset)).toBe(0)
    const asset = view.getBigUint64(assetOffset, true)
    view.setUint32(stateOffset, 1, true)
    view.setUint32(stateOffset + 4, 1, true)
    view.setFloat32(stateOffset + 8, 0, true)
    view.setFloat32(stateOffset + 12, 0, true)
    view.setFloat32(stateOffset + 16, 1, true)
    view.setFloat32(stateOffset + 20, 1, true)
    view.setUint32(stateOffset + 24, 0, true)
    view.setUint32(stateOffset + 28, 0, true)
    view.setFloat32(stateOffset + 32, 20_000, true)
    view.setFloat32(stateOffset + 36, 0.7, true)
    view.setUint32(stateOffset + 40, 1, true)
    view.setFloat32(stateOffset + 64, 0.01, true)
    view.setBigUint64(zoneOffset, asset, true)
    view.setUint32(zoneOffset + 8, 36, true)
    view.setUint32(zoneOffset + 12, 36, true)
    view.setUint32(zoneOffset + 16, 1, true)
    view.setUint32(zoneOffset + 20, 127, true)
    view.setUint32(zoneOffset + 24, 36, true)
    view.setFloat32(zoneOffset + 32, 1, true)
    view.setFloat32(zoneOffset + 36, 0, true)
    view.setUint32(zoneOffset + 52, 0, true)
    view.setUint32(zoneOffset + 56, 4, true)
    expect(exports.daw_audio_core_wasm_graph_configure_sampler(1n, stateOffset, zoneOffset)).toBe(0)
    expect(exports.daw_audio_core_wasm_graph_set_transport(1, 1, 0n)).toBe(0)
    view.setUint32(pointersOffset, pointersOffset + 8, true)
    view.setUint32(pointersOffset + 4, pointersOffset + 12, true)
    view.setUint32(eventsOffset, 1, true)
    view.setBigUint64(eventsOffset + 4, 1n, true)
    view.setBigUint64(eventsOffset + 12, 1n, true)
    view.setBigUint64(eventsOffset + 20, 1n, true)
    view.setUint32(eventsOffset + 28, 1, true)
    view.setUint32(eventsOffset + 36, 1, true)
    view.setUint32(eventsOffset + 44, 36, true)
    view.setFloat32(eventsOffset + 48, 1, true)
    expect(exports.daw_audio_core_wasm_graph_process_planar(1, 0, 2, 0, pointersOffset, 1, 0, 0, 0, 0, eventsOffset, 52)).toBe(0)
    expect(Math.abs(view.getFloat32(pointersOffset + 8, true))).toBeGreaterThan(0)
  } finally {
    exports.free(allocation)
  }
})

test('the Wasm graph bridge exports the fixed granular configuration ABI', async () => {
  const bytes = await Bun.file(artifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  expect(typeof exports.daw_audio_core_wasm_graph_configure_synth).toBe('function')
  expect(typeof exports.daw_audio_core_wasm_graph_configure_granular).toBe('function')
})

test('the shared graph fixtures execute through the bounded Wasm runner', async () => {
  const bytes = await Bun.file(fixtureArtifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_graph_fixture_protocol_version !== 'function'
    || typeof exports.daw_audio_core_run_graph_fixture !== 'function') {
    throw new Error('The shared graph fixture runner exports are unavailable.')
  }
  expect(exports.daw_audio_core_graph_fixture_protocol_version()).toBe(3)

  const characterizationPairs = new Map<string, readonly Float32Array[]>()
  for (const fixture of portableGraphParityFixtures) {
    const fixtureBytes = encodePortableGraphParityFixture(fixture)
    const pointerBytes = fixture.channelCount * Uint32Array.BYTES_PER_ELEMENT
    const outputBytes = fixture.channelCount * fixture.frames * Float32Array.BYTES_PER_ELEMENT
    const allocation = exports.malloc(fixtureBytes.byteLength + pointerBytes + outputBytes)
    if (typeof allocation !== 'number' || allocation === 0) throw new Error(`Could not allocate ${fixture.name}.`)
    try {
      const fixtureOffset = allocation
      const pointersOffset = fixtureOffset + fixtureBytes.byteLength
      const outputOffset = pointersOffset + pointerBytes
      new Uint8Array(exports.memory.buffer, fixtureOffset, fixtureBytes.byteLength).set(fixtureBytes)
      const memory = new DataView(exports.memory.buffer)
      for (let channel = 0; channel < fixture.channelCount; channel += 1) {
        memory.setUint32(pointersOffset + channel * Uint32Array.BYTES_PER_ELEMENT,
          outputOffset + channel * fixture.frames * Float32Array.BYTES_PER_ELEMENT, true)
      }
      const result = exports.daw_audio_core_run_graph_fixture(fixtureOffset, fixtureBytes.byteLength, pointersOffset)
      if (fixture.expectedResult === 'reject') {
        expect(result).not.toBe(0)
        const native = Bun.spawnSync({
          cmd: [nativeFixtureRunnerUrl.pathname],
          stdin: fixtureBytes,
          stdout: 'pipe',
        })
        expect(native.exitCode).toBe(3)
        continue
      }
      if (result !== 0) throw new Error(`Graph fixture ${fixture.name} failed with result ${result}.`)
      if (fixture.expectedLatencyFrames !== undefined || fixture.expectedTailFrames !== undefined) {
        const graphView = new DataView(fixture.graph.buffer, fixture.graph.byteOffset, fixture.graph.byteLength)
        const nodeCount = graphView.getUint32(8, true)
        const edgeCount = graphView.getUint32(12, true)
        const processorOffset = 24 + nodeCount * 132 + edgeCount * 48
        const processorNodeId = graphView.getBigUint64(processorOffset, true)
        const processorNodeIndex = Array.from({ length: nodeCount }, (_, index) => index)
          .find((index) => graphView.getBigUint64(24 + index * 132, true) === processorNodeId)
        if (processorNodeIndex === undefined) throw new Error(`${fixture.name} processor node is unavailable.`)
        expect(graphView.getUint32(processorOffset + 40, true)).toBe(fixture.expectedLatencyFrames ?? 0)
        expect(graphView.getUint32(processorOffset + 44, true)).toBe(fixture.expectedTailFrames ?? 0)
        expect(graphView.getUint32(24 + processorNodeIndex * 132 + 24, true)).toBe(fixture.expectedLatencyFrames ?? 0)
      }
      const output = Array.from({ length: fixture.channelCount }, (_, channel) =>
        new Float32Array(exports.memory.buffer,
          outputOffset + channel * fixture.frames * Float32Array.BYTES_PER_ELEMENT, fixture.frames).slice())
      if (!fixture.assertOutput(output)) throw new Error(`Graph fixture ${fixture.name} produced an unexpected output: ${JSON.stringify(output.map((plane) => [...plane]))}`)
      if (fixture.characterizationPairKey) {
        const previous = characterizationPairs.get(fixture.characterizationPairKey)
        if (previous) {
          const difference = maximumDifference(previous, output)
          const minimum = fixture.characterizationPairDifferenceMinimum ?? 0
          if (difference < minimum) {
            throw new Error(`${fixture.name} characterization pair ${fixture.characterizationPairKey} difference ${difference} did not exceed ${minimum}.`)
          }
          const maximum = fixture.characterizationPairDifferenceMaximum
          if (maximum !== undefined && difference > maximum) {
            throw new Error(`${fixture.name} characterization pair ${fixture.characterizationPairKey} difference ${difference} exceeded ${maximum}.`)
          }
        } else {
          characterizationPairs.set(fixture.characterizationPairKey, output)
        }
      }
      if (fixture.assertReset) {
        expect(exports.daw_audio_core_run_graph_fixture(fixtureOffset, fixtureBytes.byteLength, pointersOffset)).toBe(0)
        for (let channel = 0; channel < fixture.channelCount; channel += 1) {
          const resetOutput = new Float32Array(
            exports.memory.buffer,
            outputOffset + channel * fixture.frames * Float32Array.BYTES_PER_ELEMENT,
            fixture.frames,
          )
          expect(resetOutput).toEqual(output[channel] ?? new Float32Array())
        }
      }
      const native = Bun.spawnSync({
        cmd: fixture.assertReset
          ? [nativeFixtureRunnerUrl.pathname, '--repeat']
          : [nativeFixtureRunnerUrl.pathname],
        stdin: fixtureBytes,
        stdout: 'pipe',
      })
      expect(native.exitCode).toBe(0)
      const nativeOutput = new Float32Array(native.stdout.buffer, native.stdout.byteOffset, native.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT)
      expect(nativeOutput.length).toBe(fixture.channelCount * fixture.frames)
      let maximumNativeWasmDifference = 0
      for (let index = 0; index < nativeOutput.length; index += 1) {
        const wasmSample = output[Math.floor(index / fixture.frames)]?.[index % fixture.frames] ?? 0
        const nativeSample = nativeOutput[index] ?? 0
        if (fixture.nativeWasmTolerance !== undefined || fixture.processorKind === 'saturator' || fixture.processorKind === 'eq') {
          maximumNativeWasmDifference = Math.max(maximumNativeWasmDifference, Math.abs(wasmSample - nativeSample))
        } else {
          expect(wasmSample).toBeCloseTo(nativeSample, 6)
        }
      }
      const nativeWasmTolerance = fixture.nativeWasmTolerance ?? 5e-5
      if (maximumNativeWasmDifference > nativeWasmTolerance) {
        throw new Error(`${fixture.name} native/Wasm difference ${maximumNativeWasmDifference} exceeded ${nativeWasmTolerance}.`)
      }
      if (fixture.legacyModulation) {
        const legacyOutput = await renderLegacyModulationFixture(fixture, fixture.legacyModulation)
        const legacyDifference = maximumDifference(output, legacyOutput)
        const legacyTolerance = fixture.legacyTolerance ?? 5e-4
        if (legacyDifference > legacyTolerance) {
          throw new Error(`${fixture.name} portable/legacy difference ${legacyDifference} exceeded ${legacyTolerance}.`)
        }
        if (fixture.assertReset) {
          expect(await renderLegacyModulationFixture(fixture, fixture.legacyModulation, true)).toEqual(legacyOutput)
        }
      }
      if (fixture.legacyDynamics) {
        const legacyOutput = await renderLegacyDynamicsFixture(fixture, fixture.legacyDynamics)
        const legacyDifference = maximumDifference(output, legacyOutput)
        if (fixture.legacyDifferenceMinimum !== undefined) {
          if (legacyDifference < fixture.legacyDifferenceMinimum) {
            throw new Error(`${fixture.name} portable/legacy difference ${legacyDifference} did not prove the expected mismatch ${fixture.legacyDifferenceMinimum}.`)
          }
        } else {
          const legacyTolerance = fixture.legacyTolerance ?? 5e-4
          if (legacyDifference > legacyTolerance) {
            throw new Error(`${fixture.name} portable/legacy difference ${legacyDifference} exceeded ${legacyTolerance}.`)
          }
        }
        if (fixture.assertReset && fixture.legacyDynamics.kind !== 'compressor') {
          expect(await renderLegacyDynamicsFixture(fixture, fixture.legacyDynamics, true)).toEqual(legacyOutput)
        }
      }
      if (fixture.legacyDelay) {
        const legacyOutput = renderLegacyDelayFixture(fixture, fixture.legacyDelay)
        const legacyDifference = maximumDifference(output, legacyOutput)
        const legacyTolerance = fixture.legacyTolerance ?? 5e-4
        if (legacyDifference > legacyTolerance) {
          throw new Error(`${fixture.name} portable/legacy difference ${legacyDifference} exceeded ${legacyTolerance}.`)
        }
        if (fixture.assertReset) {
          expect(renderLegacyDelayFixture(fixture, fixture.legacyDelay)).toEqual(legacyOutput)
        }
      }
      if (fixture.legacyReverb) {
        const legacyOutput = await renderLegacyReverbFixture(fixture, fixture.legacyReverb)
        const legacyDifference = maximumDifference(output, legacyOutput)
        const legacyTolerance = fixture.legacyTolerance ?? 5e-4
        if (legacyDifference > legacyTolerance) {
          throw new Error(`${fixture.name} portable/browser-worklet difference ${legacyDifference} exceeded ${legacyTolerance}.`)
        }
        if (fixture.assertReset) {
          expect(await renderLegacyReverbFixture(fixture, fixture.legacyReverb, true)).toEqual(legacyOutput)
        }
      }
      if (fixture.legacySpectral) {
        const legacyOutput = await renderLegacySpectralFixture(fixture, fixture.legacySpectral)
        const legacyDifference = maximumDifference(output, legacyOutput)
        const legacyTolerance = fixture.legacyTolerance ?? 5e-4
        if (legacyDifference > legacyTolerance) {
          throw new Error(`${fixture.name} portable/legacy difference ${legacyDifference} exceeded ${legacyTolerance}.`)
        }
        if (fixture.stateRestoreDirtyInput) {
          const stateRestoreOutput = await renderLegacySpectralFixture(fixture, fixture.legacySpectral, true)
          const stateRestoreDifference = maximumDifference(output, stateRestoreOutput)
          if (stateRestoreDifference > legacyTolerance) {
            throw new Error(`${fixture.name} portable/legacy state-restore difference ${stateRestoreDifference} exceeded ${legacyTolerance}.`)
          }
        }
      }
      if (fixture.blockPartitions) {
        const referenceBytes = encodePortableGraphParityFixture({
          ...fixture,
          maxFramesPerBlock: fixture.frames,
          blockPartitions: undefined,
        })
        new Uint8Array(exports.memory.buffer, fixtureOffset, referenceBytes.byteLength).set(referenceBytes)
        expect(exports.daw_audio_core_run_graph_fixture(fixtureOffset, referenceBytes.byteLength, pointersOffset)).toBe(0)
        for (let channel = 0; channel < fixture.channelCount; channel += 1) {
          const referenceOutput = new Float32Array(
            exports.memory.buffer,
            outputOffset + channel * fixture.frames * Float32Array.BYTES_PER_ELEMENT,
            fixture.frames,
          )
          expect(referenceOutput).toEqual(output[channel] ?? new Float32Array())
        }
        const nativeReference = Bun.spawnSync({
          cmd: [nativeFixtureRunnerUrl.pathname],
          stdin: referenceBytes,
          stdout: 'pipe',
        })
        expect(nativeReference.exitCode).toBe(0)
        expect(new Float32Array(
          nativeReference.stdout.buffer,
          nativeReference.stdout.byteOffset,
          nativeReference.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT,
        )).toEqual(nativeOutput)
      }
    } finally {
      exports.free(allocation)
    }
  }
}, 20_000)

test('the shared graph fixture wire preserves portable tap, latency, and PDC declarations', () => {
  const fixture = portableGraphParityFixtures.find((candidate) => candidate.name === 'groups-returns-master-all-send-taps-sidechain-disabled-latency')
  if (!fixture) throw new Error('The topology fixture is unavailable.')
  const graph = fixture.graph
  const view = new DataView(graph.buffer, graph.byteOffset, graph.byteLength)
  const nodeBytes = 132
  const edgeOffset = 24 + 6 * nodeBytes

  expect(view.getUint32(24 + nodeBytes + 24, true)).toBe(2)
  expect(view.getUint32(edgeOffset + 36, true)).toBe(3)
  expect(view.getUint32(edgeOffset + 48 + 36, true)).toBe(1)
  expect(view.getUint32(edgeOffset + 96 + 36, true)).toBe(2)
  expect(view.getUint32(edgeOffset + 144 + 36, true)).toBe(3)
  expect(view.getUint32(edgeOffset + 48 * 6 + 44, true)).toBe(2)
  expect(view.getUint32(edgeOffset + 48 * 7 + 44, true)).toBe(2)
  expect(view.getUint32(edgeOffset + 48 * 8 + 44, true)).toBe(2)
})

test('the shared graph fixture runner rejects excess asset definitions on both targets', async () => {
  const fixture = portableGraphParityFixtures.find((candidate) => candidate.name === 'sampler-asset-loop-midi')
  if (!fixture) throw new Error('The sampler fixture is unavailable.')
  const fixtureBytes = encodePortableGraphParityFixture(fixture)
  const sectionOffset = 80 + fixture.graph.byteLength + fixture.input.byteLength
    + new DataView(fixtureBytes.buffer).getUint32(36, true)
    + new DataView(fixtureBytes.buffer).getUint32(40, true)
    + new DataView(fixtureBytes.buffer).getUint32(44, true)
  new DataView(fixtureBytes.buffer).setUint32(sectionOffset, 5, true)

  const bytes = await Bun.file(fixtureArtifactUrl).arrayBuffer()
  const instance = await WebAssembly.instantiate(bytes)
  const exports = instance.instance.exports
  if (!(exports.memory instanceof WebAssembly.Memory)
    || typeof exports.malloc !== 'function'
    || typeof exports.free !== 'function'
    || typeof exports.daw_audio_core_run_graph_fixture !== 'function') {
    throw new Error('The shared graph fixture runner exports are unavailable.')
  }
  const allocation = exports.malloc(fixtureBytes.byteLength + fixture.channelCount * Uint32Array.BYTES_PER_ELEMENT
    + fixture.channelCount * fixture.frames * Float32Array.BYTES_PER_ELEMENT)
  if (typeof allocation !== 'number' || allocation === 0) throw new Error('Could not allocate malformed fixture.')
  try {
    const pointersOffset = allocation + fixtureBytes.byteLength
    const outputOffset = pointersOffset + fixture.channelCount * Uint32Array.BYTES_PER_ELEMENT
    new Uint8Array(exports.memory.buffer, allocation, fixtureBytes.byteLength).set(fixtureBytes)
    const memory = new DataView(exports.memory.buffer)
    for (let channel = 0; channel < fixture.channelCount; channel += 1) {
      memory.setUint32(pointersOffset + channel * Uint32Array.BYTES_PER_ELEMENT,
        outputOffset + channel * fixture.frames * Float32Array.BYTES_PER_ELEMENT, true)
    }
    expect(exports.daw_audio_core_run_graph_fixture(allocation, fixtureBytes.byteLength, pointersOffset)).not.toBe(0)
  } finally {
    exports.free(allocation)
  }
  const native = Bun.spawnSync({
    cmd: [nativeFixtureRunnerUrl.pathname],
    stdin: fixtureBytes,
    stdout: 'pipe',
  })
  expect(native.exitCode).toBe(3)
})

test('the backend capability matrix is covered by executable graph fixtures', () => {
  const capabilities = new Set(portableGraphParityFixtures.map((fixture) => fixture.capability))
  const processorKinds = new Set(portableGraphParityFixtures.flatMap((fixture) =>
    fixture.processorKind && fixture.portableEligible !== false ? [fixture.processorKind] : []))
  expect(portableWasmCapabilityMatrix.chains && capabilities.has('chains')).toBe(true)
  expect(portableWasmCapabilityMatrix.fullBlockAutomation && capabilities.has('fullBlockAutomation')).toBe(true)
  expect(portableWasmCapabilityMatrix.processorEvents && capabilities.has('fullBlockAutomation')).toBe(true)
  expect(portableWasmCapabilityMatrix.sidechains && capabilities.has('sidechains')).toBe(true)
  expect(portableWasmCapabilityMatrix.synthMidi && capabilities.has('synthMidi')).toBe(true)
  expect(portableWasmCapabilityMatrix.mixerAutomation && capabilities.has('mixerAutomation')).toBe(true)
  expect(portableWasmCapabilityMatrix.variableBlocks && capabilities.has('variableBlocks')).toBe(true)
  expect(portableWasmCapabilityMatrix.nonfiniteInputSanitization && capabilities.has('nonfinite')).toBe(true)
  expect(portableWasmCapabilityMatrix.processorKinds.every((kind) => processorKinds.has(kind))).toBe(true)
  expect(portableGraphParityFixtures
    .filter((fixture) => fixture.processorKind === 'reverb')
    .every((fixture) => fixture.portableEligible !== false
      && fixture.portableUnsupportedReason === undefined)).toBe(true)
  const reverbFixtures = portableGraphParityFixtures.filter((fixture) => fixture.processorKind === 'reverb')
  expect(reverbFixtures.length).toBeGreaterThan(0)
  expect(reverbFixtures.every((fixture) =>
    fixture.knownGapIds?.every((gap) => REVERB_KNOWN_GAP_IDS.some((knownGap) => knownGap === gap)) ?? false)).toBe(true)
  expect([...portableWasmCapabilityMatrix.sampleRatesHz].sort()).toEqual([...new Set(
    portableGraphParityFixtures.filter((fixture) => fixture.capability === 'sampleRates').map((fixture) => fixture.sampleRateHz),
  )].sort())
  expect(portableWasmCapabilityMatrix.maxInputBuses).toBe(Math.max(...portableGraphParityFixtures.map((fixture) => fixture.inputBusCount)))
  expect(portableWasmCapabilityMatrix.maxChannels).toBe(Math.max(...portableGraphParityFixtures.map((fixture) => fixture.channelCount)))
  expect(portableWasmCapabilityMatrix.maxReverbProcessors).toBe(32)
})

test('the reverb impulse characterization inspects each planar channel', () => {
  const fixture = portableGraphParityFixtures.find((candidate) => candidate.name === 'reverb-impulse-partitions-reset')
  if (!fixture) throw new Error('The reverb impulse fixture is unavailable.')
  expect(isPlanarImpulseFixtureInput(fixture.input, fixture.channelCount)).toBe(true)
  expect(fixture.input.slice(2).every((sample) => sample === 0)).toBe(false)
})

test('the browser reverb worklet stays bounded under sustained input and emits a tail', async () => {
  const base = portableGraphParityFixtures.find((candidate) => candidate.name === 'reverb-sine-48000')
  const state = base?.legacyReverb?.state
  if (!base || !state) throw new Error('The reverb worklet characterization state is unavailable.')
  const frames = 3 * 48_000
  const sustainedFrames = 2 * 48_000
  const input = new Float32Array(frames * 2)
  for (let frame = 0; frame < sustainedFrames; frame += 1) {
    input[frame] = 0.25
    input[frames + frame] = -0.125
  }
  const fixture: PortableGraphParityFixture = {
    ...base,
    name: 'reverb-worklet-sustained-bounded-tail',
    frames,
    input,
    maxFramesPerBlock: 4_096,
    blockPartitions: [...Array.from({ length: 35 }, () => 4_096), 640],
    legacyReverb: { state: { ...state, decaySec: 2.2 } },
  }
  const output = await renderLegacyReverbFixture(fixture, fixture.legacyReverb)
  let peak = 0
  let energy = 0
  let tailPeak = 0
  for (const plane of output) {
    for (let frame = 0; frame < plane.length; frame += 1) {
      const sample = plane[frame] ?? 0
      expect(Number.isFinite(sample)).toBe(true)
      peak = Math.max(peak, Math.abs(sample))
      energy += sample * sample
      if (frame >= sustainedFrames) tailPeak = Math.max(tailPeak, Math.abs(sample))
    }
  }
  const rms = Math.sqrt(energy / (output.length * frames))
  expect(peak).toBeLessThan(2)
  expect(rms).toBeLessThan(0.75)
  expect(tailPeak).toBeGreaterThan(1e-5)
})
