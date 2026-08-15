import {
  encodeAudioCoreInstrumentState,
  encodeAutoFilterProcessorState,
  encodeAutoPanProcessorState,
  encodeChorusProcessorState,
  encodeCompressorProcessorState,
  encodeDelayProcessorState,
  encodeEnsembleProcessorState,
  encodeEqProcessorState,
  encodeFlangerProcessorState,
  encodeGateProcessorState,
  encodeLimiterProcessorState,
  encodeLoFiProcessorState,
  encodePhaserProcessorState,
  encodeReverbProcessorState,
  encodeSaturatorProcessorState,
  encodeSpectralProcessorState,
  encodeTremoloProcessorState,
  encodeUtilityProcessorState,
  type AmplitudeModulationProcessorState,
  type AudioCoreDrumRackState,
  type AudioCoreInstrumentState,
  type AudioCoreSampleZone,
  type AutoFilterProcessorState,
  type AudioCoreSamplerState,
  type CompressorProcessorState,
  type DelayModulationProcessorState,
  type DelayProcessorState,
  type EnsembleProcessorState,
  type EqProcessorState,
  type GateProcessorState,
  type LimiterProcessorState,
  type LoFiProcessorState,
  type PhaserProcessorState,
  type ReverbProcessorState,
  type SaturatorProcessorState,
  type SpectralProcessorState,
} from '../../../packages/audio-core-contract/src/index'

export type PortableModulationKind = 'chorus' | 'flanger' | 'phaser' | 'tremolo' | 'autopan' | 'ensemble'
export type PortableDynamicsKind = 'gate' | 'compressor' | 'limiter'
export type PortableTimeEffectKind = 'delay' | 'reverb'
export type PortableSpectralKind = 'spectral'

export type PortableLegacyModulationFixture =
  | { kind: 'chorus' | 'flanger'; state: DelayModulationProcessorState }
  | { kind: 'phaser'; state: PhaserProcessorState }
  | { kind: 'tremolo' | 'autopan'; state: AmplitudeModulationProcessorState }
  | { kind: 'ensemble'; state: EnsembleProcessorState }

export type PortableLegacyDynamicsFixture =
  | { kind: 'gate'; state: GateProcessorState }
  | { kind: 'compressor'; state: CompressorProcessorState }
  | { kind: 'limiter'; state: LimiterProcessorState }

export type PortableLegacyDelayFixture = {
  kind: 'delay'
  state: DelayProcessorState
}

export type PortableLegacySpectralFixture = {
  kind: 'spectral'
  state: SpectralProcessorState
  mixValues?: Float32Array
}

export type PortableGraphParityFixture = {
  name: string
  capability: 'chains' | 'fullBlockAutomation' | 'sidechains' | 'synthMidi' | 'mixerAutomation' | 'variableBlocks' | 'sampleRates' | 'nonfinite' | 'sampledInstruments' | 'topology' | 'invalidTopology'
  processorKind?: 'utility' | 'saturator' | 'eq' | 'autofilter' | 'lofi' | PortableModulationKind | PortableDynamicsKind | PortableTimeEffectKind | PortableSpectralKind
  sampleRateHz: number
  maxFramesPerBlock: number
  inputBusCount: number
  channelCount: number
  graph: Uint8Array
  frames: number
  blockPartitions?: readonly number[]
  input: Float32Array
  parameters?: Uint8Array
  events?: Uint8Array
  instrumentEvents?: Uint8Array
  assets?: readonly PortableFixtureAsset[]
  instrumentStates?: readonly PortableFixtureInstrumentState[]
  expectedResult?: 'reject'
  assertReset?: boolean
  expectedLatencyFrames?: number
  expectedTailFrames?: number
  nativeWasmTolerance?: number
  legacyModulation?: PortableLegacyModulationFixture
  legacyReverb?: { state: ReverbProcessorState }
  legacyDynamics?: PortableLegacyDynamicsFixture
  legacyDelay?: PortableLegacyDelayFixture
  legacySpectral?: PortableLegacySpectralFixture
  legacyTolerance?: number
  legacyDifferenceMinimum?: number
  stateRestoreDirtyInput?: Float32Array
  knownGapIds?: readonly string[]
  characterizationPairKey?: string
  characterizationPairDifferenceMinimum?: number
  characterizationPairDifferenceMaximum?: number
  portableEligible?: boolean
  portableUnsupportedReason?:
    | 'legacy-delay-filter-response-mismatch'
  assertOutput: (output: readonly Float32Array[]) => boolean
}

export const REVERB_KNOWN_GAP_IDS = [] as const

type PortableFixtureAsset = {
  identity: number
  generation: number
  operation: 'install' | 'replace'
  sampleRateHz: number
  planes: readonly Float32Array[]
}

type PortableFixtureInstrumentState = {
  nodeId: bigint
  kind: 1 | 2 | 3 | 4
  state: AudioCoreInstrumentState
}

const graphVersion = 3

const copyBytes = (target: Uint8Array, offset: number, source: Uint8Array) => {
  target.set(source, offset)
  return offset + source.byteLength
}

export const encodePortableGraphParityFixture = (fixture: PortableGraphParityFixture) => {
  const parameters = fixture.parameters ?? new Uint8Array()
  const events = fixture.events ?? new Uint8Array()
  const instrumentEvents = fixture.instrumentEvents ?? new Uint8Array()
  const assets = encodeFixtureAssets(fixture.assets ?? [])
  const instrumentStates = encodeFixtureInstrumentStates(fixture.instrumentStates ?? [])
  const blockPartitions = encodeFixtureBlockPartitions(fixture.blockPartitions)
  const bytes = new Uint8Array(80 + fixture.graph.byteLength + fixture.input.byteLength
    + parameters.byteLength + events.byteLength + instrumentEvents.byteLength + assets.byteLength
    + instrumentStates.byteLength + blockPartitions.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x44474631, true)
  view.setUint32(4, 3, true)
  view.setUint32(8, fixture.sampleRateHz, true)
  view.setUint32(12, fixture.maxFramesPerBlock, true)
  view.setUint32(16, fixture.inputBusCount, true)
  view.setUint32(20, fixture.channelCount, true)
  view.setUint32(24, 1, true)
  view.setUint32(28, fixture.graph.byteLength, true)
  view.setUint32(32, fixture.frames, true)
  view.setUint32(36, parameters.byteLength, true)
  view.setUint32(40, events.byteLength, true)
  view.setUint32(44, instrumentEvents.byteLength, true)
  view.setUint32(48, 1, true)
  view.setUint32(52, 1, true)
  view.setBigInt64(56, 0n, true)
  view.setUint32(64, assets.byteLength, true)
  view.setUint32(68, instrumentStates.byteLength, true)
  view.setUint32(72, blockPartitions.byteLength, true)
  view.setUint32(76, 0, true)
  let offset = 80
  offset = copyBytes(bytes, offset, fixture.graph)
  offset = copyBytes(bytes, offset, new Uint8Array(fixture.input.buffer, fixture.input.byteOffset, fixture.input.byteLength))
  offset = copyBytes(bytes, offset, parameters)
  offset = copyBytes(bytes, offset, events)
  offset = copyBytes(bytes, offset, instrumentEvents)
  offset = copyBytes(bytes, offset, assets)
  offset = copyBytes(bytes, offset, instrumentStates)
  copyBytes(bytes, offset, blockPartitions)
  return bytes
}

const encodeFixtureBlockPartitions = (partitions: readonly number[] | undefined) => {
  if (!partitions) return new Uint8Array()
  const output = new Uint8Array(4 + partitions.length * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, partitions.length, true)
  partitions.forEach((frames, index) => view.setUint32(4 + index * 4, frames, true))
  return output
}

const encodeFixtureAssets = (assets: readonly PortableFixtureAsset[]) => {
  const dataBytes = assets.reduce((total, asset) => total + asset.planes.reduce((planeBytes, plane) => planeBytes + plane.byteLength, 0), 0)
  const output = new Uint8Array(4 + assets.length * 28 + dataBytes)
  const view = new DataView(output.buffer)
  view.setUint32(0, assets.length, true)
  let offset = 4
  for (const asset of assets) {
    const frames = asset.planes[0]?.length ?? 0
    if (frames === 0 || asset.planes.length === 0 || asset.planes.length > 2 || asset.planes.some((plane) => plane.length !== frames)) {
      throw new Error('Fixture assets require one or two equal-length planar PCM channels.')
    }
    view.setUint32(offset, asset.identity, true)
    view.setUint32(offset + 4, asset.generation, true)
    view.setUint32(offset + 8, asset.operation === 'install' ? 1 : 2, true)
    view.setUint32(offset + 12, frames, true)
    view.setUint32(offset + 16, asset.sampleRateHz, true)
    view.setUint32(offset + 20, asset.planes.length, true)
    view.setUint32(offset + 24, frames * asset.planes.length * Float32Array.BYTES_PER_ELEMENT, true)
    offset += 28
    for (const plane of asset.planes) offset = copyBytes(output, offset, new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength))
  }
  return output
}

const fixtureAssetHandle = (identity: number, generation: number) =>
  (BigInt(generation) << 32n) | BigInt(identity)

const encodeFixtureInstrumentStates = (states: readonly PortableFixtureInstrumentState[]) => {
  const encoded = states.map((entry) => ({
    entry,
    binary: encodeAudioCoreInstrumentState(entry.state, (assetId) => {
      const [identity, generation] = assetId.slice('fixture:'.length).split(':').map(Number)
      if (!identity || !generation) throw new Error(`Invalid fixture asset reference ${assetId}.`)
      return fixtureAssetHandle(identity, generation)
    }),
  }))
  const byteLength = encoded.reduce((total, { binary }) => total + 20 + binary.state.byteLength + (binary.zones?.byteLength ?? 0), 4)
  const output = new Uint8Array(byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, states.length, true)
  let offset = 4
  for (const { entry, binary } of encoded) {
    view.setBigUint64(offset, entry.nodeId, true)
    view.setUint32(offset + 8, entry.kind, true)
    view.setUint32(offset + 12, binary.state.byteLength, true)
    view.setUint32(offset + 16, binary.zones?.byteLength ?? 0, true)
    offset = copyBytes(output, offset + 20, binary.state)
    if (binary.zones) offset = copyBytes(output, offset, binary.zones)
  }
  return output
}

const utilityState = (gainDb = 0, enabled = true) => encodeUtilityProcessorState({
  enabled,
  gainDb,
  polarity: 'normal',
  inputMode: 'stereo',
  pan: 0,
  balance: 0,
  width: 1,
  matrix: 'stereo',
  swap: false,
  dcBlock: true,
})

const autoFilterState = (overrides: Partial<AutoFilterProcessorState> = {}): AutoFilterProcessorState => ({
  enabled: true,
  mode: 'lowpass',
  quality: '2x',
  frequencyHz: 1_000,
  resonance: 0.25,
  driveDb: 0,
  mix: 1,
  envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
  lfo: { waveform: 'sine', rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0 },
  ...overrides,
})

const loFiState = (overrides: Partial<LoFiProcessorState> = {}): LoFiProcessorState => ({
  enabled: true,
  bitDepth: 8,
  sampleRateRatio: 0.5,
  jitter: 0.35,
  noiseDb: -60,
  quantization: 'round',
  dither: 'triangular',
  mix: 1,
  seed: 123,
  ...overrides,
})

type FixtureProcessor = {
  nodeId: bigint
  instanceId: number
  kindId?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17
  state?: Uint8Array
  parameterTargets?: readonly number[]
  latencyFrames?: number
  tailFrames?: number
  bypassed?: boolean
  inputLayout?: 1 | 2
  outputLayout?: 1 | 2
}

const graph = (
  nodes: readonly {
    id: bigint
    kind: number
    bus: number
    inputLayout?: 1 | 2
    outputLayout?: 1 | 2
    latencyFrames?: number
    instrumentKind?: 1 | 2 | 3 | 4
    voiceCapacity?: number
  }[],
  edges: readonly {
    from: bigint
    to: bigint
    target?: bigint
    sidechain?: boolean
    tap?: 1 | 2 | 3
    pdcDelayFrames?: number
  }[],
  processors: readonly FixtureProcessor[],
) => {
  const processorBytes = processors.reduce((total, processor) => {
    const state = processor.state ?? utilityState()
    return total + 48 + state.byteLength + (processor.parameterTargets?.length ?? 4) * 4
  }, 0)
  const bytes = 24 + nodes.length * 132 + edges.length * 48 + processorBytes
  const output = new Uint8Array(bytes)
  const view = new DataView(output.buffer)
  view.setUint32(0, graphVersion, true)
  view.setUint32(4, 1, true)
  view.setUint32(8, nodes.length, true)
  view.setUint32(12, edges.length, true)
  view.setUint32(16, processors.length, true)
  let offset = 24
  for (const node of nodes) {
    view.setBigUint64(offset, node.id, true)
    view.setUint32(offset + 8, node.kind, true)
    view.setUint32(offset + 12, node.inputLayout ?? 2, true)
    view.setUint32(offset + 16, node.outputLayout ?? 2, true)
    view.setUint32(offset + 20, node.bus, true)
    view.setUint32(offset + 24, node.latencyFrames ?? 0, true)
    if (node.instrumentKind) {
      view.setUint32(offset + 28, node.instrumentKind, true)
      view.setUint32(offset + 32, 1, true)
      view.setUint32(offset + 36, node.voiceCapacity ?? 2, true)
      if (node.instrumentKind === 1) {
        view.setUint32(offset + 40, 1, true)
        view.setUint32(offset + 44, 1, true)
      }
    }
    view.setBigUint64(offset + 108, node.id + 100n, true)
    view.setFloat32(offset + 116, 1, true)
    view.setFloat32(offset + 120, 0, true)
    offset += 132
  }
  for (const edge of edges) {
    view.setBigUint64(offset, BigInt(offset), true)
    view.setBigUint64(offset + 8, edge.from, true)
    view.setBigUint64(offset + 16, edge.to, true)
    view.setBigUint64(offset + 24, edge.target ?? 0n, true)
    view.setFloat32(offset + 32, 1, true)
    view.setUint32(offset + 36, edge.tap ?? 3, true)
    view.setUint32(offset + 40, edge.sidechain ? 1 : 0, true)
    view.setUint32(offset + 44, edge.pdcDelayFrames ?? 0, true)
    offset += 48
  }
  for (const processor of processors) {
    const state = processor.state ?? utilityState()
    const parameterTargets = processor.parameterTargets ?? [1, 2, 3, 4]
    view.setBigUint64(offset, processor.nodeId, true)
    view.setUint32(offset + 8, processor.kindId ?? 1, true)
    view.setUint32(offset + 12, 1, true)
    view.setUint32(offset + 16, state.byteLength, true)
    view.setUint32(offset + 20, processor.instanceId, true)
    view.setUint32(offset + 24, processor.bypassed ? 1 : 0, true)
    view.setUint32(offset + 28, processor.inputLayout ?? 2, true)
    view.setUint32(offset + 32, processor.outputLayout ?? 2, true)
    view.setUint32(offset + 36, parameterTargets.length, true)
    view.setUint32(offset + 40, processor.latencyFrames ?? 0, true)
    view.setUint32(offset + 44, processor.tailFrames ?? 0, true)
    output.set(state, offset + 48)
    parameterTargets.forEach((target, index) => view.setUint32(offset + 48 + state.byteLength + index * 4, target, true))
    offset += 48 + state.byteLength + parameterTargets.length * 4
  }
  return output
}

const parameterEnvelope = (frames: number) => {
  const output = new Uint8Array(4 + 16 + 4 + frames * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 11n, true)
  view.setUint32(12, frames, true)
  view.setUint32(16, 1, true)
  view.setUint32(20, 2, true)
  for (let frame = 0; frame < frames; frame += 1) view.setFloat32(24 + frame * 4, frame === 0 ? -1 : 1, true)
  return output
}

const parameterEnvelopeForTarget = (target: number, values: readonly number[]) => {
  const output = new Uint8Array(4 + 16 + 4 + values.length * 4)
  const view = new DataView(output.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 11n, true)
  view.setUint32(12, values.length, true)
  view.setUint32(16, 1, true)
  view.setUint32(20, target, true)
  values.forEach((value, frame) => view.setFloat32(24 + frame * 4, value, true))
  return output
}

const processorEventEnvelope = (
  target = 2,
  value = 0,
  frameOffset = 0,
) => {
  const output = new Uint8Array(24)
  const view = new DataView(output.buffer)
  view.setUint32(0, 1, true)
  view.setBigUint64(4, 11n, true)
  view.setUint32(12, target, true)
  view.setUint32(16, frameOffset, true)
  view.setFloat32(20, value, true)
  return output
}

const mixerEventEnvelope = () => {
  const output = new Uint8Array(44)
  const view = new DataView(output.buffer)
  view.setUint32(0, 2, true)
  view.setBigUint64(4, 101n, true)
  view.setUint32(12, 26, true)
  view.setUint32(16, 1, true)
  view.setFloat32(20, 0, true)
  view.setBigUint64(24, 101n, true)
  view.setUint32(32, 26, true)
  view.setUint32(36, 2, true)
  view.setFloat32(40, 1, true)
  return output
}

const midiEnvelope = () => {
  return instrumentEventEnvelope([{
    nodeId: 1n,
    noteId: 1n,
    sequence: 1n,
    frameOffset: 0,
    type: 1,
    note: 60,
    value: 1,
  }])
}

type FixtureInstrumentEvent = {
  nodeId: bigint
  noteId: bigint
  sequence: bigint
  frameOffset: number
  type: 1 | 2
  note: number
  value: number
}

const instrumentEventEnvelope = (events: readonly FixtureInstrumentEvent[]) => {
  const output = new Uint8Array(4 + events.length * 48)
  const view = new DataView(output.buffer)
  view.setUint32(0, events.length, true)
  for (const [index, event] of events.entries()) {
    const offset = 4 + index * 48
    view.setBigUint64(offset, event.nodeId, true)
    view.setBigUint64(offset + 8, event.noteId, true)
    view.setBigUint64(offset + 16, event.sequence, true)
    view.setUint32(offset + 24, 1, true)
    view.setUint32(offset + 28, event.frameOffset, true)
    view.setUint32(offset + 32, event.type, true)
    view.setUint32(offset + 36, 0, true)
    view.setUint32(offset + 40, event.note, true)
    view.setFloat32(offset + 44, event.value, true)
  }
  return output
}

const synthAutomationMidiEnvelope = () => {
  const output = new Uint8Array(100)
  const view = new DataView(output.buffer)
  view.setUint32(0, 2, true)
  view.setBigUint64(4, 1n, true)
  view.setBigUint64(12, 1n, true)
  view.setBigUint64(20, 1n, true)
  view.setUint32(28, 1, true)
  view.setUint32(32, 0, true)
  view.setUint32(36, 1, true)
  view.setUint32(40, 0, true)
  view.setUint32(44, 60, true)
  view.setFloat32(48, 1, true)
  view.setBigUint64(52, 1n, true)
  view.setBigUint64(60, 0n, true)
  view.setBigUint64(68, 2n, true)
  view.setUint32(76, 1, true)
  view.setUint32(80, 1, true)
  view.setUint32(84, 5, true)
  view.setUint32(88, 0, true)
  view.setUint32(92, 1, true)
  view.setFloat32(96, 0.5, true)
  return output
}

const instrumentGraph = (kind: 2 | 3 | 4) => graph(
  [{ id: 1n, kind: 2, bus: 0, instrumentKind: kind }, { id: 2n, kind: 6, bus: 0 }],
  [{ from: 1n, to: 2n }],
  [],
)

const sampleAsset = (generation: number, operation: 'install' | 'replace', data: readonly number[], identity = 1): PortableFixtureAsset => ({
  identity,
  generation,
  operation,
  sampleRateHz: 48_000,
  planes: [new Float32Array(data)],
})

const sampleInstrumentState = (kind: 'sampler' | 'drum-rack', note: number, loop: boolean): AudioCoreInstrumentState => ({
  version: 1,
  kind,
  voiceCapacity: 2,
  outputLayout: 'stereo',
  ampAttackMs: 0,
  ampDecayMs: 0,
  ampSustain: 1,
  ampReleaseMs: 1,
  filterEnabled: false,
  filterMode: 'lowpass',
  filterCutoffHz: 20_000,
  filterResonance: 0.7,
  filterEnvelopeAmount: 0,
  filterAttackMs: 0,
  filterDecayMs: 0,
  filterSustain: 0,
  filterReleaseMs: 0,
  lfoEnabled: false,
  lfoRateHz: 1,
  lfoPitchCents: 0,
  lfoFilterHz: 0,
  lfoAmplitude: 0,
  lfoPan: 0,
  retrigger: true,
  zones: [{
    assetId: 'fixture:1:1',
    keyLow: note,
    keyHigh: note,
    velocityLow: 1,
    velocityHigh: 127,
    rootNote: note,
    tuneCents: 0,
    gain: 1,
    pan: 0,
    roundRobinGroup: 0,
    roundRobinIndex: 0,
    playbackMode: loop ? 'forward-loop' : 'one-shot',
    startFrame: 0,
    endFrame: 4,
    loopStartFrame: loop ? 1 : 0,
    loopEndFrame: loop ? 4 : 0,
    crossfadeFrameCount: 0,
    chokeGroup: kind === 'drum-rack' ? 1 : 0,
  }],
})

type SampleInstrumentState = AudioCoreSamplerState | AudioCoreDrumRackState

const sampleState = (
  kind: SampleInstrumentState['kind'],
  zones: readonly AudioCoreSampleZone[],
  overrides: Partial<Omit<SampleInstrumentState, 'kind' | 'zones'>> = {},
): SampleInstrumentState => ({
  version: 1,
  kind,
  voiceCapacity: 2,
  outputLayout: 'stereo',
  ampAttackMs: 0,
  ampDecayMs: 0,
  ampSustain: 1,
  ampReleaseMs: 1,
  filterEnabled: false,
  filterMode: 'lowpass',
  filterCutoffHz: 20_000,
  filterResonance: 0.7,
  filterEnvelopeAmount: 0,
  filterAttackMs: 0,
  filterDecayMs: 0,
  filterSustain: 0,
  filterReleaseMs: 0,
  lfoEnabled: false,
  lfoRateHz: 1,
  lfoPitchCents: 0,
  lfoFilterHz: 0,
  lfoAmplitude: 0,
  lfoPan: 0,
  retrigger: true,
  ...overrides,
  zones,
})

const sampleZone = (assetId: string, note: number, overrides: Partial<AudioCoreSampleZone> = {}): AudioCoreSampleZone => ({
  assetId,
  keyLow: note,
  keyHigh: note,
  velocityLow: 1,
  velocityHigh: 127,
  rootNote: note,
  tuneCents: 0,
  gain: 1,
  pan: 0,
  roundRobinGroup: 0,
  roundRobinIndex: 0,
  playbackMode: 'one-shot' as const,
  startFrame: 0,
  endFrame: 4,
  loopStartFrame: 0,
  loopEndFrame: 0,
  crossfadeFrameCount: 0,
  chokeGroup: 0,
  ...overrides,
})

const finite = (output: readonly Float32Array[]) => output.every((plane) => plane.every(Number.isFinite))
const sampleAt = (output: readonly Float32Array[], frame: number) => output[0]?.[frame] ?? 0
const closeTo = (value: number, expected: number, tolerance = 1e-4) => Math.abs(value - expected) <= tolerance
const reverbOnsetFrame = (output: readonly Float32Array[], threshold = 1e-6) => {
  for (let frame = 0; frame < (output[0]?.length ?? 0); frame += 1) {
    if (output.some((plane) => Math.abs(plane[frame] ?? 0) >= threshold)) return frame
  }
  return null
}
const reverbStereoCorrelation = (output: readonly Float32Array[]): number | null => {
  const left = output[0]
  const right = output[1]
  if (!left || !right) return null
  let leftEnergy = 0
  let rightEnergy = 0
  let crossEnergy = 0
  for (let frame = 0; frame < Math.min(left.length, right.length); frame += 1) {
    leftEnergy += left[frame] * left[frame]
    rightEnergy += right[frame] * right[frame]
    crossEnergy += left[frame] * right[frame]
  }
  const minimumEnergy = 1e-10
  return leftEnergy < minimumEnergy || rightEnergy < minimumEnergy
    ? null
    : crossEnergy / Math.sqrt(leftEnergy * rightEnergy)
}
const reverbDecayFrame = (output: readonly Float32Array[], thresholdDb = -60) => {
  let peak = 0
  for (const plane of output) {
    for (const sample of plane) peak = Math.max(peak, Math.abs(sample))
  }
  const threshold = peak * Math.pow(10, thresholdDb / 20)
  for (let frame = (output[0]?.length ?? 0) - 1; frame >= 0; frame -= 1) {
    if (output.some((plane) => Math.abs(plane[frame] ?? 0) >= threshold)) return frame
  }
  return null
}
const reverbCharacterizationOutput = (
  output: readonly Float32Array[],
  expectedOnsetRange: readonly [number, number],
) => {
  const onset = reverbOnsetFrame(output)
  const decay = reverbDecayFrame(output)
  const correlation = reverbStereoCorrelation(output)
  const earlyEnergy = output.reduce((total, plane) =>
    total + plane.slice(onset ?? 0, (onset ?? 0) + 240).reduce((sum, sample) => sum + sample * sample, 0), 0)
  return finite(output)
    && onset !== null
    && onset >= expectedOnsetRange[0]
    && onset <= expectedOnsetRange[1]
    && decay !== null
    && decay >= onset + 128
    && earlyEnergy > 1e-8
    && output.some((plane) => plane.slice(onset + 1).some((sample) => Math.abs(sample) > 1e-6))
    // Correlation is only meaningful once both channels carry energy. The
    // mono-expansion gap is asserted separately by the spin pair fixture.
    && correlation !== null
}
export const isPlanarImpulseFixtureInput = (input: Float32Array, channelCount = 2) => {
  if (channelCount <= 0 || input.length % channelCount !== 0) return false
  const frames = input.length / channelCount
  for (let channel = 0; channel < channelCount; channel += 1) {
    const offset = channel * frames
    if (!Number.isFinite(input[offset]) || input[offset] === 0) return false
    for (let frame = 1; frame < frames; frame += 1) {
      if (input[offset + frame] !== 0) return false
    }
  }
  return true
}
const sourceMaster = (processorCount = 0) => graph(
  [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 6, bus: 0 }],
  [{ from: 1n, to: 2n }],
  processorCount === 0 ? [] : Array.from({ length: processorCount }, (_, index) => ({ nodeId: 2n, instanceId: 11 + index })),
)

const processorSourceMaster = (processor: FixtureProcessor) => graph(
  [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 6, bus: 0, latencyFrames: processor.latencyFrames }],
  [{ from: 1n, to: 2n }],
  [processor],
)

const saturatorState = (overrides: Partial<SaturatorProcessorState> = {}) => encodeSaturatorProcessorState({
  enabled: true,
  driveDb: 18,
  curve: 'hard',
  color: true,
  colorFrequencyHz: 2_500,
  colorAmount: 0.5,
  outputDb: -3,
  dryWet: 0.75,
  ...overrides,
})

const eqState = (overrides: Partial<EqProcessorState> = {}) => encodeEqProcessorState({
  enabled: true,
  channelMode: 'stereo',
  bands: Array.from({ length: 8 }, (_, index) => ({
    enabled: index < 3,
    type: index === 0 ? 'highpass' : index === 1 ? 'peaking' : 'highshelf',
    frequency: index === 0 ? 120 : index === 1 ? 1_000 : 8_000,
    gainDb: index === 1 ? 6 : index === 2 ? -3 : 0,
    q: index === 0 ? 0.707 : 1,
  })),
  ...overrides,
})

const stereo = (left: readonly number[], right = left) => new Float32Array([...left, ...right])

const sine = (frames: number, frequency: number, sampleRateHz: number, amplitude = 0.5) =>
  Array.from({ length: frames }, (_, frame) => Math.sin(2 * Math.PI * frequency * frame / sampleRateHz) * amplitude)

const sineWithPhase = (
  frames: number,
  frequency: number,
  sampleRateHz: number,
  amplitude: number,
  phase: number,
) => Array.from({ length: frames }, (_, frame) =>
  Math.sin(2 * Math.PI * frequency * frame / sampleRateHz + phase) * amplitude)

const limiterTruePeakCoefficients = (() => {
  const taps = 48
  const cutoff = 0.125
  const center = (taps - 1) / 2
  const coefficients = new Float64Array(taps)
  let sum = 0
  for (let index = 0; index < taps; index += 1) {
    const x = index - center
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const window = 0.42
      - 0.5 * Math.cos(2 * Math.PI * index / (taps - 1))
      + 0.08 * Math.cos(4 * Math.PI * index / (taps - 1))
    coefficients[index] = sinc * window
    sum += coefficients[index]
  }
  for (let index = 0; index < taps; index += 1) coefficients[index] *= 4 / sum
  return coefficients
})()

const limiterTruePeak = (output: readonly Float32Array[]) => {
  const histories = output.map(() => new Float64Array(12))
  let historyWrite = 0
  let peak = 0
  for (let frame = 0; frame < (output[0]?.length ?? 0); frame += 1) {
    histories.forEach((history, channel) => {
      history[historyWrite] = output[channel]?.[frame] ?? 0
      for (let phase = 0; phase < 4; phase += 1) {
        let value = 0
        for (let tap = 0; tap < 12; tap += 1) {
          const historyIndex = (historyWrite + 11 - tap) % 12
          value += history[historyIndex] * limiterTruePeakCoefficients[tap * 4 + phase]
        }
        peak = Math.max(peak, Math.abs(value))
      }
    })
    historyWrite = (historyWrite + 1) % 12
  }
  return peak
}

const maximumSamplePeak = (planes: readonly Float32Array[] | Float32Array) => {
  let peak = 0
  for (const sample of planes) peak = Math.max(peak, Math.abs(sample))
  return peak
}

const sweep = (frames: number, startHz: number, endHz: number, sampleRateHz: number, amplitude = 0.5) => {
  const duration = frames / sampleRateHz
  const slope = (endHz - startHz) / duration
  return Array.from({ length: frames }, (_, frame) => {
    const time = frame / sampleRateHz
    return Math.sin(2 * Math.PI * (startHz * time + 0.5 * slope * time * time)) * amplitude
  })
}

const seededNoise = (frames: number, seed: number, amplitude = 0.5) => {
  let state = seed >>> 0
  return Array.from({ length: frames }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return ((state / 0xffff_ffff) * 2 - 1) * amplitude
  })
}

const changedFromInput = (output: readonly Float32Array[], input: Float32Array, tolerance = 1e-4) =>
  output.some((plane, channel) => plane.some((sample, frame) =>
    Math.abs(sample - (input[channel * plane.length + frame] ?? 0)) > tolerance))

const liveControlPair = (
  fixture: PortableGraphParityFixture,
  target: number,
  value: number,
  minimumDifference = 1e-6,
): readonly PortableGraphParityFixture[] => {
  const key = `${fixture.name}-live-control`
  const maxFramesPerBlock = Math.max(fixture.maxFramesPerBlock, fixture.frames)
  return [
    { ...fixture, maxFramesPerBlock, blockPartitions: undefined, characterizationPairKey: key },
    {
      ...fixture,
      name: `${fixture.name}-live-event`,
      maxFramesPerBlock,
      blockPartitions: undefined,
      events: processorEventEnvelope(target, value, Math.min(1, fixture.frames - 1)),
      legacyModulation: undefined,
      legacyDynamics: undefined,
      legacyDelay: undefined,
      legacyReverb: undefined,
      legacySpectral: undefined,
      legacyTolerance: undefined,
      legacyDifferenceMinimum: undefined,
      characterizationPairKey: key,
      characterizationPairDifferenceMinimum: minimumDifference,
    },
  ]
}

const bypassInput = stereo(sine(16, 1_000, 48_000), sine(16, 2_000, 48_000, 0.25))

const variableBlockFixture = (frames: number): PortableGraphParityFixture => ({
  name: `variable-block-${frames}`,
  capability: 'variableBlocks',
  sampleRateHz: 48_000,
  maxFramesPerBlock: 4,
  inputBusCount: 1,
  channelCount: 2,
  graph: sourceMaster(),
  frames,
  input: new Float32Array(frames * 2).fill(0.25),
  assertOutput: finite,
})

const sampleRateFixture = (sampleRateHz: number): PortableGraphParityFixture => ({
  name: `sample-rate-${sampleRateHz}`,
  capability: 'sampleRates',
  sampleRateHz,
  maxFramesPerBlock: 4,
  inputBusCount: 1,
  channelCount: 2,
  graph: sourceMaster(),
  frames: 4,
  input: new Float32Array(8).fill(0.25),
  assertOutput: finite,
})

type ModulationFixtureDefinition = {
  kind: PortableModulationKind
  kindId: 4 | 5 | 6 | 7 | 8 | 9
  legacy: PortableLegacyModulationFixture
}

const modulationDefinitions: readonly ModulationFixtureDefinition[] = [
  {
    kind: 'chorus',
    kindId: 4,
    legacy: {
      kind: 'chorus',
      state: { enabled: true, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35 },
    },
  },
  {
    kind: 'flanger',
    kindId: 5,
    legacy: {
      kind: 'flanger',
      state: { enabled: true, delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5 },
    },
  },
  {
    kind: 'phaser',
    kindId: 6,
    legacy: {
      kind: 'phaser',
      state: { enabled: true, stages: 6, centerHz: 1_000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5 },
    },
  },
  {
    kind: 'tremolo',
    kindId: 7,
    legacy: {
      kind: 'tremolo',
      state: { enabled: true, waveform: 'sine', rateHz: 4, depth: 0.5, shape: 0.5, phase: 0 },
    },
  },
  {
    kind: 'autopan',
    kindId: 8,
    legacy: {
      kind: 'autopan',
      state: { enabled: true, waveform: 'sine', rateHz: 1, depth: 1, shape: 0.5, phase: 0 },
    },
  },
  {
    kind: 'ensemble',
    kindId: 9,
    legacy: {
      kind: 'ensemble',
      state: { enabled: true, voices: 3, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5 },
    },
  },
]

const encodeModulationState = (fixture: PortableLegacyModulationFixture) => {
  if (fixture.kind === 'chorus') return encodeChorusProcessorState(fixture.state)
  if (fixture.kind === 'flanger') return encodeFlangerProcessorState(fixture.state)
  if (fixture.kind === 'phaser') return encodePhaserProcessorState(fixture.state)
  if (fixture.kind === 'tremolo') return encodeTremoloProcessorState(fixture.state)
  if (fixture.kind === 'autopan') return encodeAutoPanProcessorState(fixture.state)
  return encodeEnsembleProcessorState(fixture.state)
}

const modulationParameterTargets = (kind: PortableModulationKind): readonly number[] => {
  if (kind === 'chorus') return [74, 75, 76, 77, 78, 79]
  if (kind === 'flanger') return [80, 81, 82, 83, 84, 85]
  if (kind === 'phaser') return [86, 87, 88, 89, 90, 91]
  if (kind === 'tremolo') return [92, 93, 94, 95]
  if (kind === 'autopan') return [96, 97, 98, 99]
  return [100, 101, 102, 103, 104]
}

const modulationStateWith = (
  fixture: PortableLegacyModulationFixture,
  overrides: { enabled?: boolean; phase?: number },
): PortableLegacyModulationFixture => {
  if (fixture.kind === 'chorus' || fixture.kind === 'flanger') {
    return { kind: fixture.kind, state: { ...fixture.state, enabled: overrides.enabled ?? fixture.state.enabled } }
  }
  if (fixture.kind === 'phaser') {
    return { kind: fixture.kind, state: { ...fixture.state, enabled: overrides.enabled ?? fixture.state.enabled } }
  }
  if (fixture.kind === 'tremolo' || fixture.kind === 'autopan') {
    return {
      kind: fixture.kind,
      state: {
        ...fixture.state,
        enabled: overrides.enabled ?? fixture.state.enabled,
        phase: overrides.phase ?? fixture.state.phase,
      },
    }
  }
  return { kind: fixture.kind, state: { ...fixture.state, enabled: overrides.enabled ?? fixture.state.enabled } }
}

const modulationFixture = (
  definition: ModulationFixtureDefinition,
  name: string,
  capability: PortableGraphParityFixture['capability'],
  sampleRateHz: number,
  input: Float32Array,
  options: {
    legacy?: PortableLegacyModulationFixture
    maxFramesPerBlock?: number
    blockPartitions?: readonly number[]
    assertReset?: boolean
    bypassed?: boolean
  } = {},
): PortableGraphParityFixture => {
  const legacy = options.legacy ?? definition.legacy
  const frames = input.length / 2
  return {
    name: `${definition.kind}-${name}`,
    capability,
    processorKind: definition.kind,
    sampleRateHz,
    maxFramesPerBlock: options.maxFramesPerBlock ?? frames,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: definition.kindId,
      state: encodeModulationState(legacy),
      parameterTargets: modulationParameterTargets(definition.kind),
      bypassed: options.bypassed,
    }),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    assertReset: options.assertReset,
    nativeWasmTolerance: 1e-5,
    legacyModulation: legacy,
    legacyTolerance: 5e-5,
    assertOutput: (output) => finite(output) && changedFromInput(output, input, 1e-5),
  }
}

const modulationFixtures = modulationDefinitions.flatMap((definition): PortableGraphParityFixture[] => {
  const impulseFrames = 2_048
  const impulseState = modulationStateWith(definition.legacy, {
    phase: definition.kind === 'tremolo' || definition.kind === 'autopan' ? 0.75 : undefined,
  })
  const stepInput = stereo(
    Array.from({ length: 441 }, () => 0.25),
    Array.from({ length: 441 }, () => -0.125),
  )
  const sineInput = stereo(sine(480, 1_000, 48_000), sine(480, 2_000, 48_000, 0.25))
  const sweepInput = stereo(sweep(960, 80, 18_000, 96_000), sweep(960, 160, 12_000, 96_000, 0.25))
  const bypassState = modulationStateWith(definition.legacy, { enabled: false })
  const bypass = modulationFixture(
    definition,
    'bypass',
    'chains',
    48_000,
    stereo(sine(960, 997, 48_000), sine(960, 1_993, 48_000, 0.25)),
    { legacy: bypassState, maxFramesPerBlock: 480, blockPartitions: [17, 463, 480], bypassed: true },
  )
  bypass.assertOutput = (output) => finite(output)
    && output.every((plane, channel) => plane.slice(480).every((sample, frame) =>
      closeTo(sample, bypass.input[channel * plane.length + 480 + frame] ?? 0, 1e-5)))
  const nonfinite = modulationFixture(
    definition,
    'nonfinite',
    'nonfinite',
    48_000,
    stereo(
      [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, 0.5, -0.5, 0.75, -0.75],
      [Number.NEGATIVE_INFINITY, Number.NaN, 0.25, Number.POSITIVE_INFINITY, -0.25, 0.5, -0.5, 0.75],
    ),
  )
  nonfinite.assertOutput = finite
  nonfinite.legacyModulation = undefined
  nonfinite.legacyTolerance = undefined
  return [
    modulationFixture(
      definition,
      'impulse-partitions-reset',
      'chains',
      48_000,
      stereo(
        [1, ...Array.from({ length: impulseFrames - 1 }, () => 0)],
        [-0.5, ...Array.from({ length: impulseFrames - 1 }, () => 0)],
      ),
      {
        legacy: impulseState,
        maxFramesPerBlock: 768,
        blockPartitions: [1, 7, 64, 256, 512, 512, 696],
        assertReset: true,
      },
    ),
    modulationFixture(definition, 'step-44100', 'sampleRates', 44_100, stepInput, {
      maxFramesPerBlock: 224,
      blockPartitions: [3, 5, 17, 64, 128, 224],
    }),
    modulationFixture(definition, 'sine-48000', 'sampleRates', 48_000, sineInput, {
      maxFramesPerBlock: 240,
      blockPartitions: [31, 89, 120, 240],
    }),
    ...liveControlPair(
      modulationFixture(
        definition,
        'live-control-baseline',
        'fullBlockAutomation',
        48_000,
        stereo(sine(2_048, 440, 48_000), sine(2_048, 880, 48_000, 0.25)),
      ),
      modulationParameterTargets(definition.kind)[0] ?? 0,
      definition.kind === 'chorus'
        ? 20
        : definition.kind === 'flanger'
          ? 5
          : definition.kind === 'phaser'
            ? 2_000
            : definition.kind === 'tremolo'
              ? 8
              : definition.kind === 'autopan'
                ? 5
                : 25,
    ),
    modulationFixture(definition, 'sweep-96000', 'sampleRates', 96_000, sweepInput, {
      maxFramesPerBlock: 480,
      blockPartitions: [1, 63, 128, 288, 480],
    }),
    bypass,
    nonfinite,
    {
      name: `${definition.kind}-rejects-undeclared-automation`,
      capability: 'fullBlockAutomation',
      processorKind: definition.kind,
      sampleRateHz: 48_000,
      maxFramesPerBlock: 4,
      inputBusCount: 1,
      channelCount: 2,
      graph: processorSourceMaster({
        nodeId: 2n,
        instanceId: 11,
        kindId: definition.kindId,
        state: encodeModulationState(definition.legacy),
        parameterTargets: [],
      }),
      frames: 4,
      input: new Float32Array(8).fill(0.25),
      events: processorEventEnvelope(),
      expectedResult: 'reject',
      assertOutput: () => false,
    },
  ]
})

type DynamicsFixtureDefinition = {
  kind: PortableDynamicsKind
  kindId: 10 | 11 | 12
  latencyMs: 2 | 5 | 10
  legacy: PortableLegacyDynamicsFixture
  portableEligible: boolean
}

const dynamicsDefinitions: readonly DynamicsFixtureDefinition[] = [
  {
    kind: 'gate',
    kindId: 10,
    latencyMs: 2,
    portableEligible: true,
    legacy: {
      kind: 'gate',
      state: {
        enabled: true,
        mode: 'expander',
        thresholdDb: -24,
        ratio: 3,
        attackMs: 1,
        holdMs: 8,
        releaseMs: 40,
        hysteresisDb: 4,
        rangeDb: -48,
        lookaheadMs: 1,
        detector: 'peak',
        link: 0.75,
        sidechain: { enabled: false, frequencyHz: 80, q: 0.707 },
      },
    },
  },
  {
    kind: 'compressor',
    kindId: 11,
    latencyMs: 10,
    portableEligible: true,
    legacy: {
      kind: 'compressor',
      state: {
        enabled: true,
        thresholdDb: -18,
        ratio: 4,
        attackMs: 3,
        releaseMs: 60,
        autoRelease: false,
        makeupDb: 2,
        outputDb: -1,
        dryWet: 0.8,
        kneeDb: 6,
        lookaheadMs: 4,
        detectorMode: 'peak',
        dynamicsMode: 'compress',
        envelopeCurve: 'log',
        sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 120, q: 0.707 },
      },
    },
  },
  {
    kind: 'limiter',
    kindId: 12,
    latencyMs: 5,
    portableEligible: true,
    legacy: {
      kind: 'limiter',
      state: {
        enabled: true,
        ceilingDbtp: -6,
        releaseMs: 50,
        lookaheadMs: 5,
        link: 1,
        detectorOversampling: 4,
      },
    },
  },
]

const encodeDynamicsState = (fixture: PortableLegacyDynamicsFixture) => {
  if (fixture.kind === 'gate') return encodeGateProcessorState(fixture.state)
  if (fixture.kind === 'compressor') return encodeCompressorProcessorState(fixture.state)
  return encodeLimiterProcessorState(fixture.state)
}

const dynamicsParameterTargets = (kind: PortableDynamicsKind): readonly number[] => {
  if (kind === 'gate') return Array.from({ length: 11 }, (_, index) => 105 + index)
  if (kind === 'compressor') return Array.from({ length: 11 }, (_, index) => 116 + index)
  return [127, 128, 129, 130]
}

const dynamicsStateWithEnabled = (
  fixture: PortableLegacyDynamicsFixture,
  enabled: boolean,
): PortableLegacyDynamicsFixture => {
  if (fixture.kind === 'gate') return { kind: fixture.kind, state: { ...fixture.state, enabled } }
  if (fixture.kind === 'compressor') {
    return {
      kind: fixture.kind,
      state: {
        ...fixture.state,
        enabled,
        ...(enabled ? {} : { makeupDb: 0, outputDb: 0 }),
      },
    }
  }
  return { kind: fixture.kind, state: { ...fixture.state, enabled } }
}

const dynamicsFixture = (
  definition: DynamicsFixtureDefinition,
  name: string,
  capability: PortableGraphParityFixture['capability'],
  sampleRateHz: number,
  input: Float32Array,
  options: {
    legacy?: PortableLegacyDynamicsFixture
    maxFramesPerBlock?: number
    blockPartitions?: readonly number[]
    assertReset?: boolean
    bypassed?: boolean
    inputBusCount?: number
    graph?: Uint8Array
    legacyDifferenceMinimum?: number
  } = {},
): PortableGraphParityFixture => {
  const legacy = options.legacy ?? definition.legacy
  const frames = input.length / ((options.inputBusCount ?? 1) * 2)
  const latencyFrames = Math.ceil(definition.latencyMs * sampleRateHz / 1_000)
  return {
    name: `${definition.kind}-${name}`,
    capability,
    processorKind: definition.kind,
    sampleRateHz,
    maxFramesPerBlock: options.maxFramesPerBlock ?? frames,
    inputBusCount: options.inputBusCount ?? 1,
    channelCount: 2,
    graph: options.graph ?? processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: definition.kindId,
      state: encodeDynamicsState(legacy),
      parameterTargets: dynamicsParameterTargets(definition.kind),
      latencyFrames,
      tailFrames: 0,
      bypassed: options.bypassed,
    }),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    assertReset: options.assertReset,
    expectedLatencyFrames: latencyFrames,
    expectedTailFrames: 0,
    nativeWasmTolerance: 1e-5,
    legacyDynamics: legacy,
    // Dynamics envelopes accumulate thousands of float-vs-double exponential
    // smoothing steps; one-thousandth full scale stays tightly bounded while
    // still catching a one-sample latency or detector-path disagreement.
    legacyTolerance: 1e-3,
    legacyDifferenceMinimum: options.legacyDifferenceMinimum,
    portableEligible: definition.portableEligible,
    assertOutput: (output) => finite(output) && changedFromInput(output, input.subarray(0, frames * 2), 1e-5),
  }
}

const dynamicsFixtures = dynamicsDefinitions.flatMap((definition): PortableGraphParityFixture[] => {
  const impulseFrames = Math.ceil(definition.latencyMs * 48_000 / 1_000) + 1_024
  const impulse = dynamicsFixture(
    definition,
    'impulse-partitions-reset',
    'chains',
    48_000,
    stereo(
      [1, ...Array.from({ length: impulseFrames - 1 }, () => 0)],
      [-0.5, ...Array.from({ length: impulseFrames - 1 }, () => 0)],
    ),
    {
      maxFramesPerBlock: 512,
      blockPartitions: definition.kind === 'compressor'
        ? [1, 7, 64, 256, 512, 512, impulseFrames - 1_352]
        : [1, 7, 64, 256, 512, impulseFrames - 840],
      assertReset: true,
    },
  )
  const latency = impulse.expectedLatencyFrames ?? 0
  impulse.assertOutput = (output) => finite(output)
    && output.every((plane) => plane.slice(0, latency).every((sample) => sample === 0))
    && output.some((plane) => plane.slice(latency).some((sample) => Math.abs(sample) > 1e-6))

  const stepInput = stereo(
    Array.from({ length: 882 }, (_, frame) => frame < 441 ? 0.01 : 0.5),
    Array.from({ length: 882 }, (_, frame) => frame < 441 ? -0.005 : -0.25),
  )
  const sineInput = stereo(sine(1_440, 1_000, 48_000, 0.9), sine(1_440, 2_000, 48_000, 0.45))
  const sweepInput = stereo(sweep(2_880, 80, 18_000, 96_000, 0.9), sweep(2_880, 160, 12_000, 96_000, 0.45))
  const bypassState = dynamicsStateWithEnabled(definition.legacy, false)
  const bypass = dynamicsFixture(
    definition,
    'bypass',
    'chains',
    48_000,
    stereo(sine(1_440, 997, 48_000), sine(1_440, 1_993, 48_000, 0.25)),
    { legacy: bypassState, maxFramesPerBlock: 480, blockPartitions: [17, 463, 480, 480], bypassed: true },
  )
  const bypassLatency = bypass.expectedLatencyFrames ?? 0
  bypass.assertOutput = (output) => finite(output)
    && output.every((plane, channel) => plane.slice(bypassLatency).every((sample, frame) =>
      closeTo(sample, bypass.input[channel * plane.length + frame] ?? 0, 1e-5)))

  const nonfinite = dynamicsFixture(
    definition,
    'nonfinite',
    'nonfinite',
    48_000,
    stereo(
      [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, 0.5, -0.5, 0.75, -0.75],
      [Number.NEGATIVE_INFINITY, Number.NaN, 0.25, Number.POSITIVE_INFINITY, -0.25, 0.5, -0.5, 0.75],
    ),
  )
  nonfinite.assertOutput = finite
  nonfinite.legacyDynamics = undefined
  nonfinite.legacyTolerance = undefined

  const truePeakFixtures = definition.kind !== 'limiter' ? [] : [44_100, 48_000, 96_000].flatMap((sampleRateHz) => {
    const frames = Math.round(sampleRateHz * 0.05)
    const frequency = sampleRateHz * 0.45
    const left = sineWithPhase(frames, frequency, sampleRateHz, 0.8, 1.727875959)
    const linkedInput = stereo(left, sineWithPhase(frames, frequency, sampleRateHz, 0.2, 1.727875959))
    const unlinkedInput = stereo(left, sineWithPhase(frames, frequency, sampleRateHz, 0.2, 1.727875959))
    const blockPartitions = (maximum: number, first: number) => {
      const partitions = [first, 7, 64, 128, 256]
      let remaining = frames - partitions.reduce((total, partition) => total + partition, 0)
      while (remaining > maximum) {
        partitions.push(maximum)
        remaining -= maximum
      }
      if (remaining > 0) partitions.push(remaining)
      return partitions
    }
    const createTruePeakFixture = (
      name: string,
      input: Float32Array,
      link: number,
      blockPartitions: readonly number[],
    ) => {
      const fixture = dynamicsFixture(definition, `${name}-${sampleRateHz}`, 'sampleRates', sampleRateHz, input, {
        legacy: { kind: 'limiter', state: { ...definition.legacy.state, ceilingDbtp: -6, link } },
        maxFramesPerBlock: Math.max(...blockPartitions),
        blockPartitions,
      })
      if (name === 'true-peak-unlinked') {
        fixture.characterizationPairKey = `limiter-true-peak-link-${sampleRateHz}`
        fixture.characterizationPairDifferenceMinimum = 0.01
      }
      fixture.assertOutput = (output) => {
        const inputSamplePeak = maximumSamplePeak(input)
        const inputTruePeak = limiterTruePeak([input.subarray(0, frames), input.subarray(frames)])
        const outputTruePeak = limiterTruePeak(output)
        return finite(output)
          && inputTruePeak > inputSamplePeak + 0.01
          // The shipped browser detector's finite 48-tap window leaves a
          // bounded residual above the nominal ceiling on this adversarial
          // intersample waveform; native must preserve that contract.
          && outputTruePeak <= 10 ** (-6 / 20) + 0.04
      }
      return fixture
    }
    return [
      createTruePeakFixture(
        'true-peak-linked',
        linkedInput,
        1,
        blockPartitions(441, 1),
      ),
      createTruePeakFixture(
        'true-peak-unlinked',
        unlinkedInput,
        0,
        blockPartitions(sampleRateHz === 44_100 ? 441 : sampleRateHz === 48_000 ? 480 : 960, 5),
      ),
    ]
  })

  return [
    impulse,
    dynamicsFixture(definition, 'step-44100', 'sampleRates', 44_100, stepInput, {
      maxFramesPerBlock: 441,
      blockPartitions: [3, 5, 17, 64, 128, 224, 441],
    }),
    dynamicsFixture(definition, 'sine-48000', 'sampleRates', 48_000, sineInput, {
      maxFramesPerBlock: 480,
      blockPartitions: [31, 89, 120, 240, 480, 480],
    }),
    ...liveControlPair(
      dynamicsFixture(definition, 'live-control-baseline', 'fullBlockAutomation', 48_000, sineInput, {
        maxFramesPerBlock: 480,
        blockPartitions: [31, 89, 120, 240, 480, 480],
      }),
      dynamicsParameterTargets(definition.kind)[0] ?? 0,
      definition.kind === 'gate' ? -12 : definition.kind === 'compressor' ? -10 : -3,
    ),
    dynamicsFixture(definition, 'sweep-96000', 'sampleRates', 96_000, sweepInput, {
      maxFramesPerBlock: 960,
      blockPartitions: [1, 63, 128, 288, 480, 960, 960],
    }),
    bypass,
    nonfinite,
    ...truePeakFixtures,
    {
      name: `${definition.kind}-rejects-undeclared-automation`,
      capability: 'fullBlockAutomation',
      processorKind: definition.kind,
      sampleRateHz: 48_000,
      maxFramesPerBlock: 4,
      inputBusCount: 1,
      channelCount: 2,
      graph: processorSourceMaster({
        nodeId: 2n,
        instanceId: 11,
        kindId: definition.kindId,
        state: encodeDynamicsState(definition.legacy),
        parameterTargets: [],
        latencyFrames: Math.ceil(definition.latencyMs * 48_000 / 1_000),
      }),
      frames: 4,
      input: new Float32Array(8).fill(0.25),
      events: processorEventEnvelope(),
      expectedResult: 'reject',
      portableEligible: definition.portableEligible,
      assertOutput: () => false,
    },
  ]
})

const dynamicsSidechainFixtures: readonly PortableGraphParityFixture[] = dynamicsDefinitions
  .filter((definition) => definition.kind !== 'limiter')
  .flatMap((definition) => {
    const frames = 256
    const legacy = definition.kind === 'gate'
      ? {
          kind: 'gate' as const,
          state: {
            ...definition.legacy.state,
            sidechain: { enabled: true, frequencyHz: 80, q: 0.707 },
          },
        }
      : definition.legacy
    const latencyFrames = Math.ceil(definition.latencyMs * 48_000 / 1_000)
    const stereoAudio = stereo(Array.from({ length: frames }, () => 0.25), Array.from({ length: frames }, () => -0.125))
    const stereoSidechain = stereo(
      Array.from({ length: frames }, (_, frame) => frame < frames / 2 ? 0.01 : 1),
      Array.from({ length: frames }, (_, frame) => frame < frames / 2 ? 0.005 : 0.5),
    )
    const fixture = (
      layout: 1 | 2,
      name: string,
      audio: Float32Array,
      sidechain: Float32Array,
    ) => dynamicsFixture(
        definition,
        name,
        'sidechains',
        48_000,
        new Float32Array([...audio, ...sidechain]),
        {
          legacy,
          inputBusCount: 2,
          maxFramesPerBlock: frames,
          graph: graph(
            [
              { id: 1n, kind: 1, bus: 0, inputLayout: layout, outputLayout: layout },
              { id: 2n, kind: 1, bus: 1, inputLayout: layout, outputLayout: layout },
              { id: 3n, kind: 6, bus: 0, inputLayout: layout, outputLayout: layout, latencyFrames },
            ],
            [{ from: 1n, to: 3n }, { from: 2n, to: 3n, target: 11n, sidechain: true }],
            [{
              nodeId: 3n,
              instanceId: 11,
              kindId: definition.kindId,
              state: encodeDynamicsState(legacy),
              parameterTargets: [],
              latencyFrames,
              inputLayout: layout,
              outputLayout: layout,
            }],
          ),
        },
      )
    const monoAudio = stereo(Array.from({ length: frames }, () => 0.25))
    const monoSidechain = stereo(Array.from({ length: frames }, (_, frame) => frame < frames / 2 ? 0.01 : 1))
    return [
      fixture(2, 'external-sidechain-stereo', stereoAudio, stereoSidechain),
      fixture(1, 'external-sidechain-mono', monoAudio, monoSidechain),
    ]
  })

const delayState: DelayProcessorState = {
  enabled: true,
  delayMs: 10,
  feedback: 0.5,
  dryWet: 0.5,
  pingPong: true,
  filterEnabled: true,
  lowCutHz: 120,
  highCutHz: 8_000,
}

const reverbState: ReverbProcessorState = {
  enabled: true,
  wet: 0.5,
  decaySec: 0.2,
  preDelayMs: 20,
  reflections: 0.5,
  reflectionSpin: true,
  reflectionModAmountMs: 5,
  reflectionModRateHz: 0.3,
  reflectionShape: 0.5,
  diffuse: 1,
  size: 0,
  diffusion: 0.75,
  density: 0.8,
  lowCutHz: 20,
  highCutHz: 20_000,
  diffusionLowCutHz: 20,
  diffusionHighCutHz: 20_000,
  stereoWidth: 1,
}

const timeEffectTailFrames = (
  kind: PortableTimeEffectKind,
  state: DelayProcessorState | ReverbProcessorState,
  sampleRateHz: number,
) => {
  if (kind === 'delay' && 'feedback' in state) {
    if (!state.enabled || state.dryWet === 0) return 0
    const repeats = Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(Math.max(state.feedback, 1e-6))))
    return Math.ceil(state.delayMs * sampleRateHz / 1_000 * repeats)
  }
  if (kind === 'reverb' && 'decaySec' in state) {
    return Math.ceil(state.enabled
      ? (state.preDelayMs / 1_000 + state.decaySec) * sampleRateHz
      : 0)
  }
  return 0
}

const timeEffectFixture = (
  kind: PortableTimeEffectKind,
  name: string,
  capability: PortableGraphParityFixture['capability'],
  sampleRateHz: number,
  input: Float32Array,
  options: {
    state?: DelayProcessorState | ReverbProcessorState
    maxFramesPerBlock?: number
    blockPartitions?: readonly number[]
    assertReset?: boolean
    bypassed?: boolean
    parameters?: Uint8Array
  } = {},
): PortableGraphParityFixture => {
  const state = options.state ?? (kind === 'delay' ? delayState : reverbState)
  const frames = input.length / 2
  return {
    name: `${kind}-${name}`,
    capability,
    processorKind: kind,
    sampleRateHz,
    maxFramesPerBlock: options.maxFramesPerBlock ?? frames,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: kind === 'delay' ? 13 : 14,
      state: kind === 'delay'
        ? encodeDelayProcessorState(state)
        : encodeReverbProcessorState(state),
      parameterTargets: kind === 'delay'
        ? [5, 6, 7, 8, 9]
        : [10, 11, 12, 13, 14, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142],
      latencyFrames: 0,
      tailFrames: timeEffectTailFrames(kind, state, sampleRateHz),
      bypassed: options.bypassed,
    }),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    parameters: options.parameters,
    assertReset: options.assertReset,
    expectedLatencyFrames: 0,
    expectedTailFrames: timeEffectTailFrames(kind, state, sampleRateHz),
    nativeWasmTolerance: kind === 'reverb' ? 2e-4 : 5e-5,
    legacyDelay: kind === 'delay' ? { kind, state } : undefined,
    legacyReverb: kind === 'reverb'
      && state.wet === 0.5
      && state.enabled
      && name !== 'nonfinite'
      ? { state }
      : undefined,
    legacyTolerance: kind === 'delay' ? 1e-3 : undefined,
    knownGapIds: kind === 'reverb' ? REVERB_KNOWN_GAP_IDS : undefined,
    portableEligible: true,
    assertOutput: (output) => kind === 'reverb'
      && state.wet === 1
      && isPlanarImpulseFixtureInput(input)
      ? reverbCharacterizationOutput(output, [Math.max(0, Math.round(state.preDelayMs * sampleRateHz / 1000) - 80), Math.round(state.preDelayMs * sampleRateHz / 1000) + 120])
      : finite(output) && changedFromInput(output, input, 1e-5),
  }
}

const reverbSpinPair = (reflectionSpin: boolean): PortableGraphParityFixture => {
  const fixture = timeEffectFixture(
    'reverb',
    reflectionSpin ? 'reflections-zero-spin-on' : 'reflections-zero-spin-off',
    'chains',
    48_000,
    stereo([1, ...Array.from({ length: 4_095 }, () => 0)], Array.from({ length: 4_096 }, () => 0)),
    {
      state: {
        ...reverbState,
        wet: 1,
        reflections: 0,
        reflectionSpin,
        reflectionModAmountMs: 25,
        reflectionModRateHz: 5,
      },
      maxFramesPerBlock: 2_048,
      blockPartitions: [1, 31, 127, 512, 1_024, 1_024, 1_377],
    },
  )
  const graphView = new DataView(fixture.graph.buffer, fixture.graph.byteOffset, fixture.graph.byteLength)
  graphView.setUint32(24 + 12, 1, true)
  graphView.setUint32(24 + 16, 1, true)
  graphView.setUint32(24 + 132 + 12, 1, true)
  graphView.setUint32(24 + 132 + 16, 2, true)
  const processorOffset = 24 + 2 * 132 + 48
  graphView.setUint32(processorOffset + 28, 1, true)
  graphView.setUint32(processorOffset + 32, 2, true)
  fixture.characterizationPairKey = 'reverb.reflections-zero-spin'
  fixture.characterizationPairDifferenceMaximum = 1e-7
  fixture.knownGapIds = []
  fixture.assertOutput = (output) => {
    const onset = reverbOnsetFrame(output)
    const rightEnergy = output[1]?.reduce((sum, sample) => sum + sample * sample, 0) ?? 0
    return finite(output)
      && onset !== null
      && onset >= 1_840
      && onset <= 2_040
      && rightEnergy > 1e-8
  }
  return fixture
}

const reverbCapacityFixture = (processorCount: number): PortableGraphParityFixture => ({
  name: `reverb-time-effect-capacity-${processorCount}`,
  capability: 'chains',
  processorKind: 'reverb',
  sampleRateHz: 48_000,
  maxFramesPerBlock: 4,
  inputBusCount: 1,
  channelCount: 2,
  graph: graph(
    [
      { id: 1n, kind: 1, bus: 0 },
      { id: 2n, kind: 6, bus: 0 },
    ],
    [{ from: 1n, to: 2n }],
    Array.from({ length: processorCount }, (_, index) => ({
      nodeId: 2n,
      instanceId: index + 11,
      kindId: 14,
      state: encodeReverbProcessorState(reverbState),
      parameterTargets: [10, 11, 12, 13, 14, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142],
    })),
  ),
  frames: 4,
  input: new Float32Array(8).fill(0.25),
  expectedResult: processorCount === 33 ? 'reject' : undefined,
  knownGapIds: [],
  portableEligible: true,
  assertOutput: processorCount === 33 ? () => false : finite,
})

const timeEffectFixtures: readonly PortableGraphParityFixture[] = [
  timeEffectFixture(
    'delay',
    'impulse-partitions-reset',
    'chains',
    48_000,
    stereo(
      [1, ...Array.from({ length: 2_047 }, () => 0)],
      [-0.5, ...Array.from({ length: 2_047 }, () => 0)],
    ),
    {
      maxFramesPerBlock: 696,
      blockPartitions: [1, 7, 64, 256, 512, 512, 696],
      assertReset: true,
    },
  ),
  timeEffectFixture(
    'delay',
    'step-44100',
    'sampleRates',
    44_100,
    stereo(
      Array.from({ length: 1_024 }, () => 0.25),
      Array.from({ length: 1_024 }, () => -0.125),
    ),
    { maxFramesPerBlock: 583, blockPartitions: [3, 5, 17, 64, 128, 224, 583] },
  ),
  timeEffectFixture(
    'delay',
    'sine-48000',
    'sampleRates',
    48_000,
    stereo(sine(1_200, 1_000, 48_000), sine(1_200, 2_000, 48_000, 0.25)),
    { maxFramesPerBlock: 480, blockPartitions: [31, 89, 120, 240, 480, 240] },
  ),
  ...liveControlPair(
    timeEffectFixture(
      'delay',
      'live-control-baseline',
      'fullBlockAutomation',
      48_000,
      stereo(sine(1_200, 1_000, 48_000), sine(1_200, 2_000, 48_000, 0.25)),
      { maxFramesPerBlock: 480, blockPartitions: [31, 89, 120, 240, 480, 240] },
    ),
    5,
    80,
  ),
  timeEffectFixture(
    'delay',
    'sweep-96000',
    'sampleRates',
    96_000,
    stereo(sweep(2_048, 80, 18_000, 96_000), sweep(2_048, 160, 12_000, 96_000, 0.25)),
    { maxFramesPerBlock: 960, blockPartitions: [1, 63, 128, 288, 480, 960, 128] },
  ),
  timeEffectFixture(
    'delay',
    'ping-pong-off-feedback-decay',
    'chains',
    48_000,
    stereo(
      [1, ...Array.from({ length: 4_095 }, () => 0)],
      Array.from({ length: 4_096 }, () => 0),
    ),
    {
      state: { ...delayState, pingPong: false, feedback: 0.95, dryWet: 1 },
      maxFramesPerBlock: 512,
      blockPartitions: [1, 7, 31, 127, 346, 512, 512, 512, 512, 512, 512, 512],
    },
  ),
  ...([20, 2_000] as const).map((lowCutHz): PortableGraphParityFixture => timeEffectFixture(
    'delay',
    `cutoff-extreme-${lowCutHz}`,
    'chains',
    48_000,
    stereo(
      [1, ...Array.from({ length: 1_023 }, () => 0)],
      [-0.5, ...Array.from({ length: 1_023 }, () => 0)],
    ),
    {
      state: {
        ...delayState,
        lowCutHz,
        highCutHz: lowCutHz === 20 ? 1_000 : 20_000,
      },
      maxFramesPerBlock: 256,
      blockPartitions: [1, 3, 17, 64, 171, 256, 256, 256],
    },
  )),
  (() => {
    const frames = 256
    const fixture = timeEffectFixture(
      'delay',
      'fractional-time-automation',
      'fullBlockAutomation',
      48_000,
      stereo(sine(frames, 997, 48_000), sine(frames, 1_993, 48_000, 0.25)),
      {
        state: { ...delayState, pingPong: false, feedback: 0.25, dryWet: 1 },
        maxFramesPerBlock: 256,
        parameters: parameterEnvelopeForTarget(5, Array.from(
          { length: frames },
          (_, frame) => 10 + frame * 0.0025,
        )),
      },
    )
    fixture.assertOutput = (output) => finite(output) && changedFromInput(output, fixture.input, 1e-5)
    return fixture
  })(),
  (() => {
    const fixture = timeEffectFixture(
      'delay',
      'bypass',
      'chains',
      48_000,
      stereo(sine(960, 997, 48_000), sine(960, 1_993, 48_000, 0.25)),
      { state: { ...delayState, enabled: false }, maxFramesPerBlock: 480, blockPartitions: [17, 463, 480], bypassed: true },
    )
    fixture.legacyDelay = undefined
    fixture.legacyDifferenceMinimum = undefined
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane, channel) => plane.slice(480).every((sample, frame) =>
        closeTo(sample, fixture.input[channel * plane.length + 480 + frame] ?? 0, 1e-5)))
    return fixture
  })(),
  (() => {
    const fixture = timeEffectFixture(
      'delay',
      'nonfinite',
      'nonfinite',
      48_000,
      stereo(
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, 0.5, -0.5, 0.75, -0.75],
        [Number.NEGATIVE_INFINITY, Number.NaN, 0.25, Number.POSITIVE_INFINITY, -0.25, 0.5, -0.5, 0.75],
      ),
    )
    fixture.legacyDelay = undefined
    fixture.legacyDifferenceMinimum = undefined
    fixture.assertOutput = finite
    return fixture
  })(),
  (() => {
    const fixture = timeEffectFixture(
      'delay',
      'full-block-dry-wet-automation',
      'fullBlockAutomation',
      48_000,
      new Float32Array(8).fill(1),
      { maxFramesPerBlock: 4, parameters: parameterEnvelopeForTarget(7, [0, 1, 1, 1]) },
    )
    fixture.legacyDelay = undefined
    fixture.legacyDifferenceMinimum = undefined
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => closeTo(plane[0] ?? 0, 1) && plane.slice(1).every((sample) => closeTo(sample, 0)))
    return fixture
  })(),
  timeEffectFixture(
    'reverb',
    'impulse-partitions-reset',
    'chains',
    48_000,
    stereo(
      [1, ...Array.from({ length: 4_095 }, () => 0)],
      [-0.5, ...Array.from({ length: 4_095 }, () => 0)],
    ),
    {
      state: { ...reverbState, wet: 1 },
      maxFramesPerBlock: 2_048,
      blockPartitions: [1, 7, 64, 256, 512, 1_024, 2_048, 184],
      assertReset: true,
    },
  ),
  reverbSpinPair(false),
  reverbSpinPair(true),
  (() => {
    const fixture = timeEffectFixture(
      'reverb',
      'size-density-diffusion-extremes',
      'chains',
      48_000,
      stereo(
        [1, ...Array.from({ length: 4_095 }, () => 0)],
        [0, ...Array.from({ length: 4_095 }, () => 0)],
      ),
      {
        state: {
          ...reverbState,
          wet: 1,
          size: 1,
          density: 0,
          diffusion: 0,
        },
        maxFramesPerBlock: 2_048,
        blockPartitions: [1, 7, 64, 256, 512, 1_024, 2_048, 184],
      },
    )
    fixture.assertOutput = (output) => {
      const onset = reverbOnsetFrame(output)
      const decay = reverbDecayFrame(output)
      return finite(output)
        && onset !== null
        && onset >= 880
        && onset <= 1_080
        && decay !== null
        && decay <= onset + 4
    }
    return fixture
  })(),
  reverbCapacityFixture(32),
  reverbCapacityFixture(33),
  timeEffectFixture(
    'reverb',
    'step-44100',
    'sampleRates',
    44_100,
    stereo(
      Array.from({ length: 4_000 }, () => 0.25),
      Array.from({ length: 4_000 }, () => -0.125),
    ),
    { maxFramesPerBlock: 1_764, blockPartitions: [3, 5, 17, 64, 128, 224, 441, 882, 1_764, 472] },
  ),
  timeEffectFixture(
    'reverb',
    'sine-48000',
    'sampleRates',
    48_000,
    stereo(sine(4_000, 1_000, 48_000), sine(4_000, 2_000, 48_000, 0.25)),
    { maxFramesPerBlock: 1_920, blockPartitions: [31, 89, 120, 240, 480, 960, 1_920, 160] },
  ),
  ...liveControlPair(
    timeEffectFixture(
      'reverb',
      'live-control-baseline',
      'fullBlockAutomation',
      48_000,
      stereo([1, ...Array.from({ length: 4_095 }, () => 0)], Array.from({ length: 4_096 }, () => 0)),
      {
        state: { ...reverbState, wet: 1 },
        maxFramesPerBlock: 2_048,
        blockPartitions: [1, 31, 127, 512, 1_024, 1_024, 377],
      },
    ),
    132,
    1,
    1e-7,
  ),
  timeEffectFixture(
    'reverb',
    'sweep-96000',
    'sampleRates',
    96_000,
    stereo(sweep(4_096, 80, 18_000, 96_000), sweep(4_096, 160, 12_000, 96_000, 0.25)),
    { maxFramesPerBlock: 1_920, blockPartitions: [1, 63, 128, 288, 480, 960, 1_920, 256] },
  ),
  (() => {
    const fixture = timeEffectFixture(
      'reverb',
      'bypass',
      'chains',
      48_000,
      stereo(sine(960, 997, 48_000), sine(960, 1_993, 48_000, 0.25)),
      { state: { ...reverbState, enabled: false }, maxFramesPerBlock: 480, blockPartitions: [17, 463, 480], bypassed: true },
    )
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane, channel) => plane.slice(480).every((sample, frame) =>
        closeTo(sample, fixture.input[channel * plane.length + 480 + frame] ?? 0, 1e-5)))
    return fixture
  })(),
  (() => {
    const fixture = timeEffectFixture(
      'reverb',
      'nonfinite',
      'nonfinite',
      48_000,
      stereo(
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, 0.5, -0.5, 0.75, -0.75],
        [Number.NEGATIVE_INFINITY, Number.NaN, 0.25, Number.POSITIVE_INFINITY, -0.25, 0.5, -0.5, 0.75],
      ),
    )
    fixture.assertOutput = finite
    return fixture
  })(),
  (() => {
    const fixture = timeEffectFixture(
      'reverb',
      'full-block-wet-automation',
      'fullBlockAutomation',
      48_000,
      new Float32Array(8).fill(1),
      { maxFramesPerBlock: 4, parameters: parameterEnvelopeForTarget(10, [0, 1, 1, 1]) },
    )
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => closeTo(plane[0] ?? 0, 1) && plane.slice(1).every((sample) => closeTo(sample, 0)))
    return fixture
  })(),
]

const spectralState = (
  overrides: Partial<SpectralProcessorState> = {},
): SpectralProcessorState => ({
  enabled: true,
  fftSize: 512,
  overlap: 4,
  mode: 'freeze',
  freeze: 0,
  gateThresholdDb: -60,
  gateAttackMs: 10,
  gateReleaseMs: 100,
  morph: 0,
  binShift: 0,
  blur: 0,
  harmonicPercussiveBalance: 0,
  noiseReduction: 0,
  profileLearn: 0,
  mix: 1,
  ...overrides,
})

const spectralGraph = (
  state: SpectralProcessorState,
  inputBusCount: 1 | 2,
  bypassed = false,
) => inputBusCount === 1
  ? processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 15,
      state: encodeSpectralProcessorState(state),
      parameterTargets: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
      latencyFrames: state.fftSize,
      tailFrames: 0,
      bypassed,
    })
  : graph(
      [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 1, bus: 1 }, { id: 3n, kind: 6, bus: 0, latencyFrames: state.fftSize }],
      [{ from: 1n, to: 3n }, { from: 2n, to: 3n, target: 11n, sidechain: true }],
      [{
        nodeId: 3n,
        instanceId: 11,
        kindId: 15,
        state: encodeSpectralProcessorState(state),
        parameterTargets: [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
        latencyFrames: state.fftSize,
        tailFrames: 0,
        bypassed,
      }],
    )

const spectralFixture = (
  name: string,
  capability: PortableGraphParityFixture['capability'],
  sampleRateHz: number,
  input: Float32Array,
  state: SpectralProcessorState,
  options: {
    inputBusCount?: 1 | 2
    maxFramesPerBlock?: number
    blockPartitions?: readonly number[]
    parameters?: Uint8Array
    mixValues?: Float32Array
    assertReset?: boolean
    bypassed?: boolean
  } = {},
): PortableGraphParityFixture => {
  const inputBusCount = options.inputBusCount ?? 1
  const frames = input.length / (inputBusCount * 2)
  return {
    name: `spectral-${name}`,
    capability,
    processorKind: 'spectral',
    sampleRateHz,
    maxFramesPerBlock: options.maxFramesPerBlock ?? frames,
    inputBusCount,
    channelCount: 2,
    graph: spectralGraph(state, inputBusCount, options.bypassed),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    parameters: options.parameters,
    assertReset: options.assertReset,
    expectedLatencyFrames: state.fftSize,
    expectedTailFrames: 0,
    // A 512-point FFT accumulates native-libm versus Wasm-libm rounding across
    // nine butterfly stages; this remains below one ten-thousandth full scale.
    nativeWasmTolerance: 1e-4,
    legacySpectral: { kind: 'spectral', state, mixValues: options.mixValues },
    // The shipped worklet computes FFT state in Float64Array while the portable
    // core stores it as float; keep the bound below five ten-thousandths FS.
    legacyTolerance: 5e-4,
    portableEligible: true,
    assertOutput: (output) => finite(output) && changedFromInput(output, input.subarray(0, frames * 2), 1e-5),
  }
}

const spectralFixtures: readonly PortableGraphParityFixture[] = [
  (() => {
    const frames = 2_048
    const impulse = Array.from({ length: frames }, () => 0)
    impulse[256] = 1
    const fixture = spectralFixture(
      'freeze-impulse-partitions-state-restore',
      'chains',
      48_000,
      stereo(impulse, impulse.map((sample) => sample * -0.5)),
      spectralState({ mode: 'freeze', freeze: 1 }),
      {
        maxFramesPerBlock: 696,
        blockPartitions: [1, 7, 64, 256, 512, 512, 696],
        assertReset: true,
      },
    )
    fixture.stateRestoreDirtyInput = new Float32Array(fixture.input.length)
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => plane.slice(0, 512).every((sample) => sample === 0))
      && output.some((plane) => plane.slice(512).some((sample) => Math.abs(sample) > 1e-6))
    return fixture
  })(),
  (() => {
    const frames = 1_024
    const left = Array.from({ length: frames }, () => 0)
    const right = Array.from({ length: frames }, () => 0)
    left[127] = 1
    right[127] = -0.5
    const fixture = spectralFixture(
      'latency-impulse-44100',
      'sampleRates',
      44_100,
      stereo(left, right),
      spectralState({ mode: 'shift-blur', binShift: 1, blur: 0.25 }),
      { maxFramesPerBlock: 256, blockPartitions: [1, 7, 64, 128, 256, 256, 256, 56] },
    )
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => plane.slice(0, 512).every((sample) => sample === 0))
      && output.some((plane) => plane.slice(512).some((sample) => Math.abs(sample) > 1e-6))
    return fixture
  })(),
  spectralFixture(
    'gate-step-44100',
    'sampleRates',
    44_100,
    stereo(
      [...Array.from({ length: 512 }, () => 0.001), ...Array.from({ length: 1_536 }, () => 0.25)],
      [...Array.from({ length: 512 }, () => -0.001), ...Array.from({ length: 1_536 }, () => -0.125)],
    ),
    spectralState({ mode: 'gate', gateThresholdDb: -20, gateAttackMs: 1, gateReleaseMs: 20 }),
    { maxFramesPerBlock: 1_024, blockPartitions: [3, 5, 17, 64, 128, 224, 583, 1_024] },
  ),
  spectralFixture(
    'morph-sine-sidechain-48000',
    'sidechains',
    48_000,
    new Float32Array([
      ...stereo(sine(2_048, 1_000, 48_000), sine(2_048, 2_000, 48_000, 0.25)),
      ...stereo(sine(2_048, 4_000, 48_000), sine(2_048, 8_000, 48_000, 0.25)),
    ]),
    spectralState({ mode: 'morph', morph: 1 }),
    { inputBusCount: 2, maxFramesPerBlock: 960, blockPartitions: [31, 89, 120, 240, 480, 960, 128] },
  ),
  spectralFixture(
    'shift-blur-sweep-96000',
    'sampleRates',
    96_000,
    stereo(sweep(2_048, 80, 18_000, 96_000), sweep(2_048, 160, 12_000, 96_000, 0.25)),
    spectralState({ mode: 'shift-blur', binShift: 2.5, blur: 0.35 }),
    { maxFramesPerBlock: 960, blockPartitions: [1, 63, 128, 288, 480, 960, 128] },
  ),
  (() => {
    const state = spectralState({ fftSize: 4_096, overlap: 2, mode: 'shift-blur', binShift: 1.5, blur: 0.25 })
    const frames = 8_192
    const left = Array.from({ length: frames }, () => 0)
    const right = Array.from({ length: frames }, () => 0)
    left[127] = 1
    right[127] = -0.5
    const fixture = spectralFixture(
      'fft4096-overlap2-exact-latency-96000',
      'sampleRates',
      96_000,
      stereo(left, right),
      state,
      {
        maxFramesPerBlock: 1_024,
        blockPartitions: [1, 63, 128, 512, 1_024, 1_024, 1_024, 1_024, 1_024, 1_024, 1_024, 320],
      },
    )
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => plane.slice(0, state.fftSize).every((sample) => sample === 0))
      && output.some((plane) => plane.slice(state.fftSize).some((sample) => Math.abs(sample) > 1e-6))
    return fixture
  })(),
  spectralFixture(
    'hpss-seeded-noise',
    'chains',
    48_000,
    stereo(seededNoise(2_048, 7), seededNoise(2_048, 11, 0.25)),
    spectralState({ mode: 'hpss', harmonicPercussiveBalance: 0.25 }),
    { maxFramesPerBlock: 768, blockPartitions: [17, 239, 512, 512, 768] },
  ),
  spectralFixture(
    'noise-reduce-seeded-noise-sidechain',
    'sidechains',
    48_000,
    new Float32Array([
      ...stereo(seededNoise(2_048, 13), seededNoise(2_048, 17, 0.25)),
      ...stereo(seededNoise(2_048, 19, 0.1), seededNoise(2_048, 23, 0.1)),
    ]),
    spectralState({ mode: 'noise-reduce', noiseReduction: 0.5, profileLearn: 0.25 }),
    { inputBusCount: 2, maxFramesPerBlock: 1_024, blockPartitions: [1, 127, 384, 512, 1_024] },
  ),
  (() => {
    const state = spectralState({ enabled: false })
    const fixture = spectralFixture(
      'bypass-fixed-latency',
      'chains',
      48_000,
      stereo(sine(1_536, 997, 48_000), sine(1_536, 1_993, 48_000, 0.25)),
      state,
      { maxFramesPerBlock: 768, blockPartitions: [17, 239, 512, 768], bypassed: true },
    )
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane, channel) => plane.slice(state.fftSize).every((sample, frame) =>
        closeTo(sample, fixture.input[channel * plane.length + frame] ?? 0, 1e-5)))
    return fixture
  })(),
  (() => {
    const frames = 1_024
    const mixValues = Float32Array.from({ length: frames }, (_, frame) => frame < frames / 2 ? 0 : 1)
    return spectralFixture(
      'mix-automation-48000',
      'fullBlockAutomation',
      48_000,
      stereo(sine(frames, 997, 48_000), sine(frames, 1_993, 48_000, 0.25)),
      spectralState({ mode: 'shift-blur', binShift: 2.5, blur: 0.35 }),
      {
        maxFramesPerBlock: frames,
        parameters: parameterEnvelopeForTarget(25, [...mixValues]),
        mixValues,
      },
    )
  })(),
  (() => {
    const fixture = spectralFixture(
      'stereo-isolation-48000',
      'chains',
      48_000,
      stereo(sine(1_024, 997, 48_000), Array.from({ length: 1_024 }, () => 0)),
      spectralState({ mode: 'shift-blur', binShift: 1.5, blur: 0.25 }),
      { maxFramesPerBlock: 512, blockPartitions: [1, 31, 127, 512, 353] },
    )
    fixture.assertOutput = (output) => finite(output)
      && output[1]?.every((sample) => sample === 0) === true
      && changedFromInput(output, fixture.input, 1e-5)
    return fixture
  })(),
  (() => {
    const fixture = spectralFixture(
      'nonfinite',
      'nonfinite',
      48_000,
      stereo(
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, ...Array.from({ length: 1_021 }, () => 0.25)],
        [Number.NEGATIVE_INFINITY, Number.NaN, Number.POSITIVE_INFINITY, ...Array.from({ length: 1_021 }, () => -0.125)],
      ),
      spectralState({ mode: 'shift-blur', binShift: 1, blur: 0.25 }),
    )
    fixture.assertOutput = finite
    return fixture
  })(),
]

const loFiFixtures: readonly PortableGraphParityFixture[] = [44_100, 48_000, 96_000].flatMap((sampleRateHz) => {
  const fixture: PortableGraphParityFixture = {
  name: `lofi-deterministic-stereo-${sampleRateHz}`,
  capability: 'sampleRates' as const,
  processorKind: 'lofi' as const,
  sampleRateHz,
  maxFramesPerBlock: 23,
  inputBusCount: 1,
  channelCount: 2,
  graph: processorSourceMaster({
    nodeId: 2n,
    instanceId: 11,
    kindId: 17,
    state: encodeLoFiProcessorState(loFiState()),
    parameterTargets: [41, 42, 43, 44, 131],
  }),
  frames: 64,
  blockPartitions: [1, 7, 3, 17, 2, 11, 23],
  input: stereo(
    sine(64, 440, sampleRateHz, 0.7),
    sineWithPhase(64, 880, sampleRateHz, 0.4, 0.3),
  ),
  nativeWasmTolerance: 2e-5,
  assertOutput: (output: readonly Float32Array[]) => finite(output)
    && output[0] !== undefined
    && output[1] !== undefined
    && output[0].some((sample) => Math.abs(sample) > 1e-4)
    && output[1].some((sample) => Math.abs(sample) > 1e-4),
  }
  return liveControlPair(fixture, 131, 16)
})

const autoFilterFixtures: readonly PortableGraphParityFixture[] = [
  {
    name: 'autofilter-lowpass-impulse-partitions-reset',
    capability: 'chains',
    processorKind: 'autofilter',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 32,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 16,
      state: encodeAutoFilterProcessorState(autoFilterState()),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: 6,
    }),
    frames: 64,
    blockPartitions: [1, 3, 12, 16, 32],
    input: stereo([1, ...Array.from({ length: 63 }, () => 0)], [-0.5, ...Array.from({ length: 63 }, () => 0)]),
    assertReset: true,
    expectedLatencyFrames: 6,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output)
      && output[0]?.slice(0, 6).every((sample) => sample === 0)
      && output[0]?.slice(6).some((sample) => Math.abs(sample) > 1e-6),
  },
  ...(['highpass', 'bandpass', 'notch', 'peak'] as const).map((mode): PortableGraphParityFixture => ({
    name: `autofilter-${mode}-extreme`,
    capability: 'chains',
    processorKind: 'autofilter',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 128,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 16,
      state: encodeAutoFilterProcessorState(autoFilterState({
        mode,
        frequencyHz: 20_000,
        resonance: 1,
        driveDb: 24,
        envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100 },
        lfo: { waveform: 'triangle', rateHz: 3, depthOctaves: 0, phaseOffset: 0, stereoPhase: 0.25 },
      })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: 6,
    }),
    frames: 128,
    input: new Float32Array([
      Number.NaN, Number.POSITIVE_INFINITY, ...Array.from({ length: 126 }, (_, index) => Math.sin(index * 0.31) * 4),
      Number.NEGATIVE_INFINITY, Number.NaN, ...Array.from({ length: 126 }, (_, index) => -Math.sin(index * 0.31) * 4),
    ]),
    expectedLatencyFrames: 6,
    nativeWasmTolerance: 2e-5,
    assertOutput: finite,
  })),
  {
    name: 'autofilter-automation-sample-rate-96000',
    capability: 'sampleRates',
    processorKind: 'autofilter',
    sampleRateHz: 96_000,
    maxFramesPerBlock: 68,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 16,
      state: encodeAutoFilterProcessorState(autoFilterState({ mode: 'bandpass', resonance: 0.5 })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: 6,
    }),
    frames: 68,
    input: stereo(sine(68, 440, 96_000), sine(68, 880, 96_000, 0.25)),
    parameters: parameterEnvelopeForTarget(30, Array.from({ length: 68 }, (_, frame) => 200 + frame * 25)),
    expectedLatencyFrames: 6,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output) && changedFromInput(output, stereo(
      sine(68, 440, 96_000), sine(68, 880, 96_000, 0.25),
    )),
  },
  {
    name: 'autofilter-bypass-fixed-latency',
    capability: 'chains',
    processorKind: 'autofilter',
    sampleRateHz: 44_100,
    maxFramesPerBlock: 16,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 16,
      state: encodeAutoFilterProcessorState(autoFilterState({ enabled: false })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: 6,
      bypassed: true,
    }),
    frames: 16,
    input: bypassInput,
    expectedLatencyFrames: 6,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output)
      && output.every((plane) => plane.slice(0, 6).every((sample) => sample === 0))
      && output.some((plane) => plane.slice(6).some((sample) => Math.abs(sample) > 1e-6)),
  },
]

const topologyNodes = [
  { id: 1n, kind: 1, bus: 0 },
  { id: 2n, kind: 3, bus: 0, latencyFrames: 2 },
  { id: 3n, kind: 3, bus: 0 },
  { id: 4n, kind: 3, bus: 0 },
  { id: 5n, kind: 3, bus: 0 },
  { id: 6n, kind: 6, bus: 0 },
] as const

export const portableGraphParityFixtures: readonly PortableGraphParityFixture[] = [
  {
    name: 'processor-chain',
    capability: 'chains',
    processorKind: 'utility',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: sourceMaster(2),
    frames: 4,
    input: new Float32Array([0.25, 0.5, 0.75, 1, -0.25, -0.5, -0.75, -1]),
    assertOutput: finite,
  },
  {
    name: 'saturator-impulse-partitions-reset',
    capability: 'chains',
    processorKind: 'saturator',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 32,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      parameterTargets: [],
    }),
    frames: 64,
    blockPartitions: [1, 3, 12, 16, 32],
    input: stereo([1, ...Array.from({ length: 63 }, () => 0)], [-0.5, ...Array.from({ length: 63 }, () => 0)]),
    assertReset: true,
    assertOutput: (output) => finite(output)
      && Math.abs(sampleAt(output, 0) - 1) > 0.05
      && output.some((plane) => plane.slice(1).some((sample) => Math.abs(sample) > 1e-6)),
  },
  {
    name: 'saturator-step-44100',
    capability: 'sampleRates',
    processorKind: 'saturator',
    sampleRateHz: 44_100,
    maxFramesPerBlock: 9,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState({ color: false, colorAmount: 0, dryWet: 1 }),
      parameterTargets: [],
    }),
    frames: 32,
    blockPartitions: [3, 5, 8, 7, 9],
    input: stereo(Array.from({ length: 32 }, () => 0.25), Array.from({ length: 32 }, () => -0.125)),
    assertOutput: (output) => finite(output) && changedFromInput(output, stereo(
      Array.from({ length: 32 }, () => 0.25),
      Array.from({ length: 32 }, () => -0.125),
    )),
  },
  {
    name: 'saturator-sine-96000',
    capability: 'sampleRates',
    processorKind: 'saturator',
    sampleRateHz: 96_000,
    maxFramesPerBlock: 48,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState({ curve: 'soft' }),
      parameterTargets: [],
    }),
    frames: 96,
    blockPartitions: [16, 32, 7, 41],
    input: stereo(sine(96, 1_000, 96_000), sine(96, 2_000, 96_000, 0.25)),
    assertOutput: (output) => finite(output) && output.every((plane) => plane.some((sample) => Math.abs(sample) > 0.01)),
  },
  {
    name: 'saturator-bypass',
    capability: 'chains',
    processorKind: 'saturator',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 16,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      parameterTargets: [],
      bypassed: true,
    }),
    frames: 16,
    input: bypassInput,
    assertOutput: (output) => finite(output)
      && output.every((plane, channel) => plane.every((sample, frame) =>
        closeTo(sample, bypassInput[channel * plane.length + frame] ?? 0))),
  },
  {
    name: 'saturator-nonfinite',
    capability: 'nonfinite',
    processorKind: 'saturator',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      parameterTargets: [],
    }),
    frames: 4,
    input: new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, Number.NaN, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    assertOutput: finite,
  },
  ...liveControlPair({
    name: 'saturator-live-control-baseline',
    capability: 'fullBlockAutomation',
    processorKind: 'saturator',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 64,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      parameterTargets: [69, 70, 71, 72, 73],
    }),
    frames: 64,
    blockPartitions: [1, 7, 16, 40],
    input: stereo(sine(64, 440, 48_000), sine(64, 880, 48_000, 0.25)),
    assertOutput: (output) => finite(output) && changedFromInput(output, stereo(
      sine(64, 440, 48_000),
      sine(64, 880, 48_000, 0.25),
    )),
  }, 69, 30),
  {
    name: 'saturator-rejects-undeclared-automation',
    capability: 'fullBlockAutomation',
    processorKind: 'saturator',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      parameterTargets: [],
    }),
    frames: 4,
    input: new Float32Array(8).fill(0.25),
    events: processorEventEnvelope(),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  {
    name: 'eq-impulse-partitions-reset',
    capability: 'chains',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 32,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: [],
    }),
    frames: 64,
    blockPartitions: [1, 3, 12, 16, 32],
    input: stereo([1, ...Array.from({ length: 63 }, () => 0)], [-0.5, ...Array.from({ length: 63 }, () => 0)]),
    assertReset: true,
    assertOutput: (output) => finite(output)
      && Math.abs(sampleAt(output, 0) - 1) > 0.001
      && output.some((plane) => plane.slice(1).some((sample) => Math.abs(sample) > 1e-6)),
  },
  {
    name: 'eq-step-mono-44100',
    capability: 'sampleRates',
    processorKind: 'eq',
    sampleRateHz: 44_100,
    maxFramesPerBlock: 9,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState({ channelMode: 'mono' }),
      parameterTargets: [],
    }),
    frames: 32,
    blockPartitions: [3, 5, 8, 7, 9],
    input: stereo(Array.from({ length: 32 }, () => 0.25), Array.from({ length: 32 }, () => -0.125)),
    assertOutput: (output) => finite(output)
      && output[0]?.every((sample, frame) => closeTo(sample, output[1]?.[frame] ?? 0)) === true,
  },
  {
    name: 'eq-sine-96000',
    capability: 'sampleRates',
    processorKind: 'eq',
    sampleRateHz: 96_000,
    maxFramesPerBlock: 48,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: [],
    }),
    frames: 96,
    blockPartitions: [16, 32, 7, 41],
    input: stereo(sine(96, 1_000, 96_000), sine(96, 8_000, 96_000, 0.25)),
    assertOutput: (output) => finite(output) && output.every((plane) => plane.some((sample) => Math.abs(sample) > 0.01)),
  },
  {
    name: 'eq-bypass',
    capability: 'chains',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 16,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: [],
      bypassed: true,
    }),
    frames: 16,
    input: bypassInput,
    assertOutput: (output) => finite(output)
      && output.every((plane, channel) => plane.every((sample, frame) =>
        closeTo(sample, bypassInput[channel * plane.length + frame] ?? 0))),
  },
  {
    name: 'eq-nonfinite',
    capability: 'nonfinite',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: [],
    }),
    frames: 4,
    input: new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, Number.NaN, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    assertOutput: finite,
  },
  ...liveControlPair({
    name: 'eq-live-control-baseline',
    capability: 'fullBlockAutomation',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 64,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: Array.from({ length: 24 }, (_, index) => 45 + index),
    }),
    frames: 64,
    blockPartitions: [1, 7, 16, 40],
    input: stereo(sine(64, 440, 48_000), sine(64, 880, 48_000, 0.25)),
    assertOutput: (output) => finite(output),
  }, 45, 2_000),
  {
    name: 'eq-rejects-undeclared-automation',
    capability: 'fullBlockAutomation',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: eqState(),
      parameterTargets: [],
    }),
    frames: 4,
    input: new Float32Array(8).fill(0.25),
    events: processorEventEnvelope(),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  ...modulationFixtures,
  ...dynamicsFixtures,
  ...dynamicsSidechainFixtures,
  ...timeEffectFixtures,
  ...spectralFixtures,
  ...loFiFixtures,
  ...autoFilterFixtures,
  {
    name: 'mixer-automation',
    capability: 'mixerAutomation',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: sourceMaster(),
    frames: 4,
    input: new Float32Array(8).fill(1),
    events: mixerEventEnvelope(),
    assertOutput: (output) => finite(output)
      && output.every((plane) => plane[0] === 1 && plane[1] === 0 && plane[2] === 1 && plane[3] === 1),
  },
  {
    name: 'full-block-automation',
    capability: 'fullBlockAutomation',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: sourceMaster(1),
    frames: 4,
    input: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1]),
    parameters: parameterEnvelope(4),
    events: processorEventEnvelope(),
    assertOutput: finite,
  },
  {
    name: 'targeted-sidechain',
    capability: 'sidechains',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 2,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 1, bus: 1 }, { id: 3n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 3n }, { from: 2n, to: 3n, target: 11n, sidechain: true }],
      [{ nodeId: 3n, instanceId: 11 }],
    ),
    frames: 4,
    input: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
    assertOutput: finite,
  },
  {
    name: 'synth-midi',
    capability: 'synthMidi',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 1 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(),
    instrumentEvents: midiEnvelope(),
    assertOutput: (output) => finite(output) && output.some((plane) => plane.some((sample) => Math.abs(sample) > 0)),
  },
  {
    name: 'synth-automation-midi',
    capability: 'synthMidi',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 1 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(),
    instrumentEvents: synthAutomationMidiEnvelope(),
    assertOutput: (output) => finite(output) && output.some((plane) => plane.some((sample) => Math.abs(sample) > 0)),
  },
  {
    name: 'sampler-asset-loop-midi',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(2),
    frames: 4,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', [0.25, 0.5, 0.75, 1])],
    instrumentStates: [{ nodeId: 1n, kind: 2, state: sampleInstrumentState('sampler', 60, true) }],
    instrumentEvents: midiEnvelope(),
    assertOutput: (output) => finite(output) && output.some((plane) => plane.some((sample) => Math.abs(sample) > 0)),
  },
  {
    name: 'sampler-retrigger-stable-note-ownership',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 320,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 2, voiceCapacity: 2 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 320,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', [1, 1, 1, 1])],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [sampleZone('fixture:1:1', 60, {
        playbackMode: 'forward-loop',
        loopStartFrame: 0,
        loopEndFrame: 4,
      })]),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 11n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 12n, sequence: 2n, frameOffset: 1, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 11n, sequence: 3n, frameOffset: 2, type: 2, note: 60, value: 0 },
    ]),
    assertOutput: (output) => finite(output) && closeTo(sampleAt(output, 288), 1),
  },
  {
    name: 'sampler-voice-limit-oldest-steal',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 2, voiceCapacity: 1 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(),
    assets: [
      sampleAsset(1, 'install', [0.25, 0.25, 0.25, 0.25]),
      sampleAsset(1, 'install', [-0.75, -0.75, -0.75, -0.75], 2),
    ],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [
        sampleZone('fixture:1:1', 60, { playbackMode: 'forward-loop', loopStartFrame: 0, loopEndFrame: 4 }),
        sampleZone('fixture:2:1', 61, { playbackMode: 'forward-loop', loopStartFrame: 0, loopEndFrame: 4 }),
      ], { retrigger: false }),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 2n, sequence: 2n, frameOffset: 1, type: 1, note: 61, value: 1 },
    ]),
    assertOutput: (output) => finite(output) && closeTo(sampleAt(output, 0), 0.25) && closeTo(sampleAt(output, 1), -0.75),
  },
  {
    name: 'sampler-round-robin-index-sequence',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 2, voiceCapacity: 2 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(),
    assets: [
      sampleAsset(1, 'install', [0.25, 0.25, 0.25, 0.25]),
      sampleAsset(1, 'install', [0.75, 0.75, 0.75, 0.75], 2),
    ],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [
        sampleZone('fixture:1:1', 60, { roundRobinGroup: 1, roundRobinIndex: 1 }),
        sampleZone('fixture:2:1', 60, { roundRobinGroup: 1, roundRobinIndex: 0 }),
      ], { retrigger: false }),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 2n, sequence: 2n, frameOffset: 1, type: 1, note: 60, value: 1 },
    ]),
    assertOutput: (output) => finite(output) && closeTo(sampleAt(output, 0), 0.75) && closeTo(sampleAt(output, 1), 1),
  },
  {
    name: 'sampler-transposition-loop-boundary',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(2),
    frames: 4,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', [0.1, 0.2, 0.3, 0.4])],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [sampleZone('fixture:1:1', 72, {
        rootNote: 60,
        playbackMode: 'forward-loop',
        loopStartFrame: 1,
        loopEndFrame: 4,
      })]),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 72, value: 1 },
    ]),
    assertOutput: (output) => finite(output)
      && closeTo(sampleAt(output, 0), 0.1)
      && closeTo(sampleAt(output, 1), 0.3)
      && closeTo(sampleAt(output, 2), 0.2),
  },
  {
    name: 'sampler-envelope-release',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 64,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(2),
    frames: 64,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', Array.from({ length: 128 }, () => 1))],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [sampleZone('fixture:1:1', 60, {
        playbackMode: 'forward-loop',
        endFrame: 128,
        loopEndFrame: 128,
      })], { ampReleaseMs: 1 }),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 1n, sequence: 2n, frameOffset: 1, type: 2, note: 60, value: 0 },
    ]),
    assertOutput: (output) => finite(output) && sampleAt(output, 0) > 0.9 && closeTo(sampleAt(output, 48), 0),
  },
  ...(['lowpass', 'highpass', 'bandpass', 'notch'] as const).map((filterMode): PortableGraphParityFixture => ({
    name: `sampler-crossfade-${filterMode}-envelope-lfo`,
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 32,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(2),
    frames: 32,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25])],
    instrumentStates: [{
      nodeId: 1n,
      kind: 2,
      state: sampleState('sampler', [sampleZone('fixture:1:1', 60, {
        playbackMode: 'crossfade-loop',
        endFrame: 8,
        loopStartFrame: 2,
        loopEndFrame: 8,
        crossfadeFrameCount: 2,
      })], {
        filterEnabled: true,
        filterMode,
        filterCutoffHz: 800,
        filterResonance: 0.7,
        filterEnvelopeAmount: 0.5,
        filterAttackMs: 0.5,
        filterDecayMs: 1,
        filterSustain: 0.4,
        filterReleaseMs: 2,
        lfoEnabled: true,
        lfoRateHz: 4,
        lfoPitchCents: 12,
        lfoFilterHz: 120,
        lfoAmplitude: 0.2,
        lfoPan: 0.25,
      }),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 0.8 },
      { nodeId: 1n, noteId: 1n, sequence: 2n, frameOffset: 16, type: 2, note: 60, value: 0 },
    ]),
    assertOutput: finite,
  })),
  {
    name: 'drum-rack-asset-choke-midi',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(3),
    frames: 4,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', [1, 0.75, 0.5, 0.25])],
    instrumentStates: [{ nodeId: 1n, kind: 3, state: sampleInstrumentState('drum-rack', 60, false) }],
    instrumentEvents: midiEnvelope(),
    assertOutput: (output) => finite(output) && output.some((plane) => plane.some((sample) => Math.abs(sample) > 0)),
  },
  {
    name: 'drum-rack-two-hit-six-ms-choke',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 320,
    inputBusCount: 0,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 2, bus: 0, instrumentKind: 3, voiceCapacity: 2 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 320,
    input: new Float32Array(),
    assets: [
      sampleAsset(1, 'install', Array.from({ length: 320 }, () => 1)),
      sampleAsset(1, 'install', Array.from({ length: 320 }, () => -1), 2),
    ],
    instrumentStates: [{
      nodeId: 1n,
      kind: 3,
      state: sampleState('drum-rack', [
        sampleZone('fixture:1:1', 36, { endFrame: 320, chokeGroup: 1 }),
        sampleZone('fixture:2:1', 37, { endFrame: 320, chokeGroup: 1 }),
      ], { ampReleaseMs: 1000, retrigger: false }),
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 1n, sequence: 1n, frameOffset: 0, type: 1, note: 36, value: 1 },
      { nodeId: 1n, noteId: 2n, sequence: 2n, frameOffset: 1, type: 1, note: 37, value: 1 },
    ]),
    assertOutput: (output) => finite(output) && closeTo(sampleAt(output, 288), -1),
  },
  {
    name: 'granular-replaced-asset-seed-freeze-midi',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(4),
    frames: 4,
    input: new Float32Array(),
    assets: [
      sampleAsset(1, 'install', [0, 0, 0, 0]),
      sampleAsset(2, 'replace', [0.25, 0.5, 0.75, 1]),
    ],
    instrumentStates: [{
      nodeId: 1n,
      kind: 4,
      state: {
        version: 1,
        kind: 'granular',
        voiceCapacity: 2,
        outputLayout: 'stereo',
        assetId: 'fixture:1:2',
        seed: 77,
        maxGrains: 2,
        windowShape: 'hann',
        freeze: true,
        grainSizeMs: 5,
        densityHz: 200,
        position: 0.5,
        spray: 0,
        pitchSemitones: 0,
        reverseProbability: 0,
        stereoSpread: 0.5,
      },
    }],
    instrumentEvents: midiEnvelope(),
    nativeWasmTolerance: 1e-5,
    assertOutput: (output) => finite(output) && output.some((plane) => plane.some((sample) => Math.abs(sample) > 0)),
  },
  {
    name: 'granular-stable-note-lifecycle',
    capability: 'sampledInstruments',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 8,
    inputBusCount: 0,
    channelCount: 2,
    graph: instrumentGraph(4),
    frames: 8,
    input: new Float32Array(),
    assets: [sampleAsset(1, 'install', Array.from({ length: 512 }, () => 1))],
    instrumentStates: [{
      nodeId: 1n,
      kind: 4,
      state: {
        version: 1,
        kind: 'granular',
        voiceCapacity: 2,
        outputLayout: 'stereo',
        assetId: 'fixture:1:1',
        seed: 77,
        maxGrains: 2,
        windowShape: 'hann',
        freeze: false,
        grainSizeMs: 5,
        densityHz: 200,
        position: 0.5,
        spray: 0,
        pitchSemitones: 0,
        reverseProbability: 0,
        stereoSpread: 0,
      },
    }],
    instrumentEvents: instrumentEventEnvelope([
      { nodeId: 1n, noteId: 11n, sequence: 1n, frameOffset: 0, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 11n, sequence: 2n, frameOffset: 1, type: 1, note: 60, value: 1 },
      { nodeId: 1n, noteId: 99n, sequence: 3n, frameOffset: 2, type: 2, note: 60, value: 0 },
      { nodeId: 1n, noteId: 11n, sequence: 4n, frameOffset: 3, type: 2, note: 60, value: 0 },
    ]),
    assertOutput: (output) => finite(output) && sampleAt(output, 2) > 0 && closeTo(sampleAt(output, 3), 0),
  },
  variableBlockFixture(1),
  variableBlockFixture(2),
  variableBlockFixture(4),
  sampleRateFixture(44_100),
  sampleRateFixture(48_000),
  sampleRateFixture(96_000),
  {
    name: 'nonfinite-input',
    capability: 'nonfinite',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: sourceMaster(),
    frames: 4,
    input: new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.25, Number.NaN, 0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]),
    assertOutput: finite,
  },
  {
    name: 'groups-returns-master-all-send-taps-sidechain-disabled-latency',
    capability: 'topology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: graph(
      topologyNodes,
      [
        { from: 1n, to: 2n, tap: 3 },
        { from: 1n, to: 3n, tap: 1 },
        { from: 1n, to: 4n, tap: 2 },
        { from: 1n, to: 5n, tap: 3 },
        { from: 1n, to: 2n, target: 11n, sidechain: true },
        { from: 2n, to: 6n, tap: 3 },
        { from: 3n, to: 6n, tap: 3, pdcDelayFrames: 2 },
        { from: 4n, to: 6n, tap: 3, pdcDelayFrames: 2 },
        { from: 5n, to: 6n, tap: 3, pdcDelayFrames: 2 },
      ],
      [{ nodeId: 2n, instanceId: 11, latencyFrames: 2, bypassed: true }],
    ),
    frames: 4,
    input: new Float32Array(8).fill(0.25),
    assertOutput: finite,
  },
  {
    name: 'converging-pdc-delays-shorter-route',
    capability: 'topology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 2,
    channelCount: 2,
    graph: graph(
      [
        { id: 1n, kind: 1, bus: 0, latencyFrames: 2 },
        { id: 2n, kind: 1, bus: 1 },
        { id: 3n, kind: 6, bus: 0 },
      ],
      [{ from: 1n, to: 3n }, { from: 2n, to: 3n, pdcDelayFrames: 2 }],
      [],
    ),
    frames: 4,
    input: new Float32Array([
      1, 1, 1, 1,
      1, 1, 1, 1,
      1, 1, 1, 1,
      1, 1, 1, 1,
    ]),
    assertOutput: (output) => finite(output)
      && output.every((plane) => [1, 1, 2, 2].every((expected, frame) => closeTo(plane[frame] ?? 0, expected))),
  },
  {
    name: 'mono-source-stereo-master',
    capability: 'topology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: graph(
      [
        { id: 1n, kind: 1, bus: 0, inputLayout: 1, outputLayout: 1 },
        { id: 2n, kind: 6, bus: 0 },
      ],
      [{ from: 1n, to: 2n }],
      [],
    ),
    frames: 4,
    input: new Float32Array([0.25, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0.75]),
    assertOutput: (output) => finite(output) && output.every((plane) => plane.every((sample) => closeTo(sample, 0.5))),
  },
  {
    name: 'rejects-routing-cycle',
    capability: 'invalidTopology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n }, { from: 2n, to: 1n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(8),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  {
    name: 'rejects-missing-route-target',
    capability: 'invalidTopology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 3n }],
      [],
    ),
    frames: 4,
    input: new Float32Array(8),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  {
    name: 'rejects-pdc-capacity-overflow',
    capability: 'invalidTopology',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 4,
    inputBusCount: 1,
    channelCount: 2,
    graph: graph(
      [{ id: 1n, kind: 1, bus: 0 }, { id: 2n, kind: 6, bus: 0 }],
      [{ from: 1n, to: 2n, pdcDelayFrames: 5 }],
      [],
    ),
    frames: 4,
    input: new Float32Array(8),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
]
