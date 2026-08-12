import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  audioCoreContractVersion,
  audioCoreMaxProcessorParameterTargets,
  decodeAudioCoreProcessorStateEnvelope,
  decodeAudioCoreWireEnvelope,
  encodeAudioCoreProcessorStateEnvelope,
  encodeEqProcessorState,
  encodeChorusProcessorState,
  encodeCompressorProcessorState,
  encodeDelayProcessorState,
  encodeEnsembleProcessorState,
  encodeGateProcessorState,
  encodeLimiterProcessorState,
  encodeLoFiProcessorState,
  encodePhaserProcessorState,
  encodeReverbProcessorState,
  encodeSaturatorProcessorState,
  encodeSpectralProcessorState,
  encodeTremoloProcessorState,
  encodeAudioCoreWireEnvelope,
  encodeAudioCoreInstrumentState,
  type AudioAssetRef,
  type AudioCoreProcessorStateEnvelope,
  isAudioAssetRef,
  isPlanarPcmForAsset,
  isAudioCoreGranularState,
  isAudioCoreSamplerInstrumentState,
  isAudioCoreDrumRackState,
  isAudioCoreSynthState,
  isUtilityProcessorContract,
  synthParameterRegistry,
} from './index'
import {
  portableGraphContractHash,
  portableGraphContractSchemaJson,
  processorContractHash,
  processorContractSchemaJson,
  processorRegistry,
  utilityParameterMetadata,
} from './generated/processor-contract-metadata'

const repositoryRoot = resolve(import.meta.dir, '../../..')

test('generated processor contract artifacts are current and hash-identical', async () => {
  const output = Bun.spawnSync({
    cmd: ['bun', 'packages/audio-core-contract/scripts/generate-contract.ts', '--check'],
    cwd: repositoryRoot,
    stderr: 'pipe',
  })
  expect(output.exitCode).toBe(0)
  const header = await readFile(resolve(repositoryRoot, 'native/audio-core/generated/processor_contract_generated.h'), 'utf8')
  expect(header).toContain(processorContractHash)
  expect(new Bun.CryptoHasher('sha256').update(processorContractSchemaJson).digest('hex')).toBe(processorContractHash)
  expect(new Bun.CryptoHasher('sha256').update(portableGraphContractSchemaJson).digest('hex')).toBe(portableGraphContractHash)
})

test('utility processor contract accepts only the versioned canonical shape', () => {
  const contract = {
    version: 1 as const,
    kind: 'utility',
    state: {
      enabled: true,
      gainDb: 0,
      polarity: 'normal',
      inputMode: 'stereo',
      pan: 0,
      balance: 0,
      width: 1,
      matrix: 'stereo',
      swap: false,
      dcBlock: false,
    },
  }
  expect(isUtilityProcessorContract(contract)).toBe(true)
  expect(isUtilityProcessorContract({ ...contract, kind: 'gate' })).toBe(false)
  expect(isUtilityProcessorContract({ ...contract, unexpected: true })).toBe(false)
})

test('granular instrument contract bounds immutable assets and grain state', () => {
  const state = {
    version: audioCoreContractVersion,
    kind: 'granular',
    voiceCapacity: 4,
    outputLayout: 'stereo',
    assetId: 'asset:7',
    seed: 77,
    maxGrains: 64,
    windowShape: 'hann',
    freeze: true,
    grainSizeMs: 80,
    densityHz: 12,
    position: 0.5,
    spray: 0.1,
    pitchSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0.5,
  }
  expect(isAudioCoreGranularState(state)).toBe(true)
  expect(isAudioCoreGranularState({ ...state, maxGrains: 129 })).toBe(false)
  expect(isAudioCoreGranularState({ ...state, seed: 0 })).toBe(false)
  expect(isAudioCoreGranularState({ ...state, densityHz: Number.NaN })).toBe(false)
})

test('sample instrument codecs resolve asset identities only at the ABI boundary', () => {
  const state = {
    version: 1 as const,
    kind: 'sampler' as const,
    voiceCapacity: 4,
    outputLayout: 'stereo' as const,
    ampAttackMs: 1,
    ampDecayMs: 10,
    ampSustain: 1,
    ampReleaseMs: 20,
    filterEnabled: true,
    filterMode: 'lowpass' as const,
    filterCutoffHz: 20_000,
    filterResonance: 0.707,
    filterEnvelopeAmount: 0,
    filterAttackMs: 1,
    filterDecayMs: 10,
    filterSustain: 0,
    filterReleaseMs: 20,
    lfoEnabled: false,
    lfoRateHz: 5,
    lfoPitchCents: 0,
    lfoFilterHz: 0,
    lfoAmplitude: 0,
    lfoPan: 0,
    retrigger: true,
    zones: [{
      assetId: 'asset:1', keyLow: 36, keyHigh: 60, velocityLow: 1, velocityHigh: 127, rootNote: 48,
      tuneCents: 0, gain: 1, pan: 0, roundRobinGroup: 1, roundRobinIndex: 0, playbackMode: 'forward-loop' as const,
      startFrame: 0, endFrame: 128, loopStartFrame: 8, loopEndFrame: 120, crossfadeFrameCount: 0, chokeGroup: 2,
    }],
  }
  expect(isAudioCoreSamplerInstrumentState(state)).toBe(true)
  expect(isAudioCoreDrumRackState({ ...state, kind: 'drum-rack', zones: [{ ...state.zones[0], keyHigh: 36, roundRobinGroup: 0 }] })).toBe(true)
  expect(isAudioCoreDrumRackState({ ...state, kind: 'drum-rack' })).toBe(false)
  const binary = encodeAudioCoreInstrumentState(state, (assetId) => assetId === 'asset:1' ? 0x100000001n : 0n)
  expect(binary.state.byteLength).toBe(88)
  expect(binary.zones?.byteLength).toBe(80)
  if (!binary.zones) throw new Error('Sampler state did not encode zones.')
  expect(new DataView(binary.zones.buffer).getBigUint64(0, true)).toBe(0x100000001n)
})

test('empty sampled instrument states use silent portable sentinels', () => {
  const base = {
    version: 1 as const,
    voiceCapacity: 4,
    outputLayout: 'stereo' as const,
    ampAttackMs: 1,
    ampDecayMs: 10,
    ampSustain: 1,
    ampReleaseMs: 20,
    filterEnabled: true,
    filterMode: 'lowpass' as const,
    filterCutoffHz: 20_000,
    filterResonance: 0.707,
    filterEnvelopeAmount: 0,
    filterAttackMs: 1,
    filterDecayMs: 10,
    filterSustain: 0,
    filterReleaseMs: 20,
    lfoEnabled: false,
    lfoRateHz: 5,
    lfoPitchCents: 0,
    lfoFilterHz: 0,
    lfoAmplitude: 0,
    lfoPan: 0,
    retrigger: true,
    zones: [],
  }
  const sampler = { ...base, kind: 'sampler' as const }
  const drums = { ...base, kind: 'drum-rack' as const }
  expect(isAudioCoreSamplerInstrumentState(sampler)).toBe(true)
  expect(isAudioCoreDrumRackState(drums)).toBe(true)
  expect(encodeAudioCoreInstrumentState(sampler, () => {
    throw new Error('empty sampler should not resolve an asset')
  }).zones?.byteLength).toBe(0)
  expect(encodeAudioCoreInstrumentState(drums, () => {
    throw new Error('empty drum rack should not resolve an asset')
  }).zones?.byteLength).toBe(0)

  const granular = {
    version: 1 as const,
    kind: 'granular' as const,
    voiceCapacity: 2,
    outputLayout: 'stereo' as const,
    assetId: '',
    seed: 1,
    maxGrains: 2,
    windowShape: 'hann' as const,
    freeze: false,
    grainSizeMs: 5,
    densityHz: 1,
    position: 0,
    spray: 0,
    pitchSemitones: 0,
    reverseProbability: 0,
    stereoSpread: 0,
  }
  expect(isAudioCoreGranularState(granular)).toBe(true)
  const binary = encodeAudioCoreInstrumentState(granular, () => {
    throw new Error('empty granular should not resolve an asset')
  })
  expect(new DataView(binary.state.buffer).getBigUint64(4, true)).toBe(0n)
})

test('synth instrument codec emits the fixed native default profile', () => {
  const binary = encodeAudioCoreInstrumentState({
    version: 1,
    kind: 'synth',
    voiceCapacity: 2,
    outputLayout: 'stereo',
    ampReleaseMs: 60_000,
    parameterTargets: [{ id: 'synth.outputGain', target: 1 }],
  }, () => 0n)
  expect(binary.state.byteLength).toBe(156)
  const view = new DataView(binary.state.buffer)
  expect(view.getUint32(0, true)).toBe(1)
  expect(view.getFloat32(72, true)).toBe(20_000)
  expect(view.getFloat32(116, true)).toBe(60_000)
  expect(view.getFloat32(148, true)).toBe(1)
})

test('utility parameter metadata matches the supported worklet AudioParams', () => {
  expect(utilityParameterMetadata).toEqual([
    { id: 'gainDb', defaultValue: 0, minValue: -60, maxValue: 24 },
    { id: 'pan', defaultValue: 0, minValue: -1, maxValue: 1 },
    { id: 'balance', defaultValue: 0, minValue: -1, maxValue: 1 },
    { id: 'width', defaultValue: 1, minValue: 0, maxValue: 2 },
  ])
})

test('processor registry preserves stable portable processor ids', () => {
  expect(processorRegistry).toEqual([
    expect.objectContaining({ name: 'utility', id: 1, schemaVersion: 1, stateBytes: 40, tombstone: false }),
    expect.objectContaining({ name: 'saturator', id: 2, schemaVersion: 1, stateBytes: 32, tombstone: false }),
    expect.objectContaining({ name: 'eq', id: 3, schemaVersion: 1, stateBytes: 200, tombstone: false }),
    expect.objectContaining({ name: 'chorus', id: 4, stateBytes: 28 }),
    expect.objectContaining({ name: 'flanger', id: 5, stateBytes: 28 }),
    expect.objectContaining({ name: 'phaser', id: 6, stateBytes: 32 }),
    expect.objectContaining({ name: 'tremolo', id: 7, stateBytes: 24 }),
    expect.objectContaining({ name: 'autopan', id: 8, stateBytes: 24 }),
    expect.objectContaining({ name: 'ensemble', id: 9, stateBytes: 28 }),
    expect.objectContaining({ name: 'gate', id: 10, stateBytes: 60 }),
    expect.objectContaining({ name: 'compressor', id: 11, stateBytes: 72 }),
    expect.objectContaining({ name: 'limiter', id: 12, stateBytes: 24 }),
    expect.objectContaining({ name: 'delay', id: 13, stateBytes: 32 }),
    expect.objectContaining({ name: 'reverb', id: 14, stateBytes: 72 }),
    expect.objectContaining({ name: 'spectral', id: 15, stateBytes: 60 }),
    expect.objectContaining({ name: 'autofilter', id: 16, schemaVersion: 1, stateBytes: 60, tombstone: false }),
    expect.objectContaining({ name: 'lofi', id: 17, stateBytes: 36, schemaVersion: 1, tombstone: false }),
  ])
})

test('dynamics codecs preserve portable little-endian state layouts', () => {
  const gate = encodeGateProcessorState({
    enabled: true, mode: 'expander', thresholdDb: -40, ratio: 4, attackMs: 1, holdMs: 20, releaseMs: 120,
    hysteresisDb: 6, rangeDb: -80, lookaheadMs: 0, detector: 'rms', link: 1,
    sidechain: { enabled: true, frequencyHz: 80, q: 0.707 },
  })
  expect(gate.byteLength).toBe(60)
  expect(new DataView(gate.buffer).getUint32(4, true)).toBe(1)
  const compressor = encodeCompressorProcessorState({
    enabled: true, thresholdDb: -24, ratio: 4, attackMs: 10, releaseMs: 120, autoRelease: true,
    makeupDb: 0, outputDb: 0, dryWet: 1, kneeDb: 6, lookaheadMs: 0, detectorMode: 'rms',
    dynamicsMode: 'compress', envelopeCurve: 'log',
    sidechain: { enabled: true, filterType: 'bandpass', frequencyHz: 120, q: 0.707 },
  })
  expect(compressor.byteLength).toBe(72)
  expect(new DataView(compressor.buffer).getUint32(60, true)).toBe(2)
  expect(encodeLimiterProcessorState({ enabled: true, ceilingDbtp: -1, releaseMs: 100, lookaheadMs: 5, link: 1, detectorOversampling: 4 }).byteLength).toBe(24)
})

test('modulation codecs preserve the native little-endian state layouts', () => {
  const chorus = encodeChorusProcessorState({ enabled: true, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35 })
  expect(chorus.byteLength).toBe(28)
  expect(new DataView(chorus.buffer).getFloat32(4, true)).toBeCloseTo(12)
  const phaser = encodePhaserProcessorState({ enabled: true, stages: 6, centerHz: 1000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5 })
  expect(phaser.byteLength).toBe(32)
  expect(new DataView(phaser.buffer).getUint32(4, true)).toBe(6)
  expect(encodeTremoloProcessorState({ enabled: true, waveform: 'triangle', rateHz: 4, depth: 0.5, shape: 0.5, phase: 0 }).byteLength).toBe(24)
  expect(encodeEnsembleProcessorState({ enabled: true, voices: 3, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5 }).byteLength).toBe(28)
})

test('delay and reverb codecs preserve portable state without claiming browser convolution parity', () => {
  const delay = encodeDelayProcessorState({
    enabled: true, delayMs: 250, feedback: 0.25, dryWet: 0.2, pingPong: false,
    filterEnabled: false, lowCutHz: 120, highCutHz: 8000,
  })
  expect(delay.byteLength).toBe(32)
  expect(new DataView(delay.buffer).getFloat32(4, true)).toBe(250)
  const reverb = encodeReverbProcessorState({
    enabled: true, wet: 0.25, decaySec: 2.2, preDelayMs: 20, reflections: 0,
    reflectionSpin: true, reflectionModAmountMs: 17.5, reflectionModRateHz: 0.3,
    reflectionShape: 0.5, diffuse: 1, size: 0.65, diffusion: 0.75, density: 0.8,
    lowCutHz: 20, highCutHz: 20_000, diffusionLowCutHz: 20,
    diffusionHighCutHz: 20_000, stereoWidth: 1,
  })
  expect(reverb.byteLength).toBe(72)
  expect(new DataView(reverb.buffer).getFloat32(8, true)).toBeCloseTo(2.2)
})

test('LoFi codec preserves deterministic state and portable controls', () => {
  const lofi = encodeLoFiProcessorState({
    enabled: true, bitDepth: 12, sampleRateRatio: 0.5, jitter: 0.25, noiseDb: -80,
    quantization: 'truncate', dither: 'triangular', mix: 0.75, seed: 123,
  })
  expect(lofi.byteLength).toBe(36)
  const view = new DataView(lofi.buffer)
  expect(view.getUint32(4, true)).toBe(12)
  expect(view.getUint32(20, true)).toBe(2)
  expect(view.getUint32(24, true)).toBe(2)
  expect(view.getUint32(32, true)).toBe(123)
})

test('spectral codec preserves bounded STFT state and generic automation metadata', () => {
  const spectral = encodeSpectralProcessorState({
    enabled: true, fftSize: 2048, overlap: 4, mode: 'noise-reduce', freeze: 0,
    gateThresholdDb: -60, gateAttackMs: 10, gateReleaseMs: 100, morph: 0,
    binShift: 0, blur: 0, harmonicPercussiveBalance: 0, noiseReduction: 0.5,
    profileLearn: 1, mix: 1,
  })
  expect(spectral.byteLength).toBe(60)
  const view = new DataView(spectral.buffer)
  expect(view.getUint32(4, true)).toBe(2048)
  expect(view.getUint32(12, true)).toBe(5)
  expect(processorRegistry.find((entry) => entry.name === 'spectral')?.parameters).toHaveLength(11)
})

test('processor state envelopes are little-endian, bounded, and kind-neutral', () => {
  const state = encodeSaturatorProcessorState({
    enabled: true, driveDb: 6, curve: 'soft', color: false,
    colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1,
  })
  const wire = encodeAudioCoreProcessorStateEnvelope({
    kindId: 2,
    schemaVersion: 1,
    state,
    instanceId: 9,
    bypassed: false,
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    latencyFrames: 3,
    tailFrames: 4,
    parameterTargets: [],
  })
  expect(decodeAudioCoreProcessorStateEnvelope(wire)).toMatchObject({
    kindId: 2, schemaVersion: 1, state, instanceId: 9, latencyFrames: 3, tailFrames: 4,
  })
  wire[8] = 1
  wire[9] = 1
  expect(() => decodeAudioCoreProcessorStateEnvelope(wire)).toThrow('invalid bounds')
})

test('processor state envelopes allow the explicit generic automation capacity', () => {
  const parameterTargets = Array.from(
    { length: audioCoreMaxProcessorParameterTargets },
    (_, target) => ({ id: `reserved.${target}`, target: target + 1 }),
  )
  const envelope: AudioCoreProcessorStateEnvelope = {
    kindId: 2,
    schemaVersion: 1,
    state: encodeSaturatorProcessorState({
      enabled: true, driveDb: 6, curve: 'soft', color: false,
      colorFrequencyHz: 1200, colorAmount: 0, outputDb: 0, dryWet: 1,
    }),
    instanceId: 9,
    bypassed: false,
    inputLayout: 'stereo',
    outputLayout: 'stereo',
    latencyFrames: 0,
    tailFrames: 0,
    parameterTargets,
  }
  expect(decodeAudioCoreProcessorStateEnvelope(encodeAudioCoreProcessorStateEnvelope(envelope)).parameterTargets).toHaveLength(
    audioCoreMaxProcessorParameterTargets,
  )
  expect(() => encodeAudioCoreProcessorStateEnvelope({
    ...envelope,
    parameterTargets: [...parameterTargets, { id: 'reserved.overflow', target: 17 }],
  })).toThrow('Invalid audio-core processor state envelope.')
})

test('Saturator and eight-band EQ codecs preserve their portable state profiles', () => {
  const saturator = encodeSaturatorProcessorState({
    enabled: true, driveDb: 18, curve: 'hard', color: true,
    colorFrequencyHz: 2500, colorAmount: 0.5, outputDb: -3, dryWet: 0.75,
  })
  expect(saturator.byteLength).toBe(32)
  expect(new DataView(saturator.buffer).getFloat32(4, true)).toBe(18)
  const eq = encodeEqProcessorState({
    enabled: true,
    channelMode: 'stereo',
    bands: Array.from({ length: 8 }, (_, index) => ({
      enabled: index === 0,
      type: index === 0 ? 'lowshelf' : 'peaking',
      frequency: 100 * (index + 1),
      gainDb: index,
      q: 1,
    })),
  })
  expect(eq.byteLength).toBe(200)
  expect(new DataView(eq.buffer).getFloat32(16, true)).toBe(100)
  expect(() => encodeEqProcessorState({ enabled: true, channelMode: 'mono', bands: [] })).toThrow('exactly eight')
})

test('wire envelopes are explicit, versioned, and length-checked', () => {
  const wire = encodeAudioCoreWireEnvelope('contract payload')
  expect(decodeAudioCoreWireEnvelope(wire)).toEqual({
    version: audioCoreContractVersion,
    payload: 'contract payload',
  })
  wire[1] = 0
  expect(() => decodeAudioCoreWireEnvelope(wire)).toThrow('invalid payload length')
})

test('audio asset references are portable identities with exact planar PCM metadata', () => {
  const asset: AudioAssetRef = {
    version: audioCoreContractVersion,
    assetId: 'asset:source-1',
    frameCount: 2,
    sampleRateHz: 48_000,
    channelCount: 2,
  }
  expect(isAudioAssetRef(asset)).toBe(true)
  expect(isAudioAssetRef({ ...asset, url: 'https://example.test/audio.wav' })).toBe(false)
  expect(isPlanarPcmForAsset(asset, {
    frameCount: 2,
    planes: [new Float32Array(2), new Float32Array(2)],
  })).toBe(true)
  expect(isPlanarPcmForAsset(asset, {
    frameCount: 1,
    planes: [new Float32Array(1), new Float32Array(1)],
  })).toBe(false)
})

test('portable synth states use a stable bounded parameter registry', () => {
  const state = {
    version: audioCoreContractVersion,
    kind: 'synth',
    voiceCapacity: 32,
    outputLayout: 'stereo',
    parameterTargets: [
      { id: 'synth.outputGain', target: 1 },
      { id: 'synth.ampReleaseMs', target: 8 },
    ],
  }
  expect(isAudioCoreSynthState(state)).toBe(true)
  expect(isAudioCoreSynthState({ ...state, parameterTargets: [...state.parameterTargets, state.parameterTargets[0]] })).toBe(false)
  expect(isAudioCoreSynthState({ ...state, parameterTargets: [{ id: 'synth.reserved', target: 9 }] })).toBe(false)
  expect(synthParameterRegistry.some((entry) => entry.tombstone)).toBe(true)
})
