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
import { processorRegistry } from '../../../packages/audio-core-contract/src/generated/processor-contract-metadata'
import { AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES, EQ_HIGH_QUALITY_LATENCY_FRAMES, saturatorLatencyFrames } from '../../../packages/shared/src/effects-params'

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
  // The shipped chain state is told at each of these frames, as the host does on a toggle.
  enabledEdits?: readonly { frame: number; enabled: boolean }[]
}

export type PortableLegacySaturatorFixture = { kind: 'saturator'; state: SaturatorProcessorState }

export type PortableLegacySpectralFixture = {
  kind: 'spectral'
  state: SpectralProcessorState
  mixValues?: Float32Array
  // The worklet is told at each of these frames, as the host does on a toggle.
  enabledEdits?: readonly { frame: number; enabled: boolean }[]
}

// Published as the next revision just before the block that starts at `frame`.
export type PortableGraphEdit = { frame: number; graph: Uint8Array }

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
  graphEdits?: readonly PortableGraphEdit[]
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
  legacySaturator?: PortableLegacySaturatorFixture
  legacySpectral?: PortableLegacySpectralFixture
  legacyTolerance?: number
  // The legacy worklets are constructed wet and ramp to a bypass requested up front;
  // the portable core is dry from its first sample. Frames before this one are not
  // compared against the legacy render.
  legacyStartFrame?: number
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
  const graphEdits = encodeFixtureGraphEdits(fixture.graphEdits)

  const bytes = new Uint8Array(80 + fixture.graph.byteLength + fixture.input.byteLength
    + parameters.byteLength + events.byteLength + instrumentEvents.byteLength + assets.byteLength
    + instrumentStates.byteLength + blockPartitions.byteLength + graphEdits.byteLength)

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
  view.setUint32(76, graphEdits.byteLength, true)
  let offset = 80
  offset = copyBytes(bytes, offset, fixture.graph)
  offset = copyBytes(bytes, offset, new Uint8Array(fixture.input.buffer, fixture.input.byteOffset, fixture.input.byteLength))
  offset = copyBytes(bytes, offset, parameters)
  offset = copyBytes(bytes, offset, events)
  offset = copyBytes(bytes, offset, instrumentEvents)
  offset = copyBytes(bytes, offset, assets)
  offset = copyBytes(bytes, offset, instrumentStates)
  offset = copyBytes(bytes, offset, blockPartitions)
  copyBytes(bytes, offset, graphEdits)

  return bytes
}

const encodeFixtureGraphEdits = (edits: readonly PortableGraphEdit[] | undefined) => {
  if (!edits) return new Uint8Array()
  const output = new Uint8Array(4 + edits.reduce((total, edit) => total + 8 + edit.graph.byteLength, 0))
  const view = new DataView(output.buffer)
  view.setUint32(0, edits.length, true)
  let offset = 4

  for (const [index, edit] of edits.entries()) {
    view.setUint32(offset, edit.frame, true)
    view.setUint32(offset + 4, edit.graph.byteLength, true)
    const graphOffset = offset + 8
    offset = copyBytes(output, graphOffset, edit.graph)
    // The fixture graph is revision 1; each edit is the next revision after it.
    view.setUint32(graphOffset + 4, index + 2, true)
  }

  return output
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
  phaseLeft: false,
  phaseRight: false,
  inputMode: 'stereo',
  balance: 0,
  width: 1,
  matrix: 'stereo',
  channelMode: 'both',
  dcBlock: true,
  mute: false,
  widthMode: 'stereo',
  midSide: 0,
  bassMono: false,
  bassMonoHz: 120,
  bassMonoAudition: false,
})

const autoFilterState = (overrides: Partial<AutoFilterProcessorState> = {}): AutoFilterProcessorState => ({
  enabled: true,
  mode: 'lowpass',
  slope: 12,
  hiQuality: false,
  frequencyHz: 1_000,
  resonance: 0.25,
  driveDb: 0,
  mix: 1,
  outputDb: 0,
  clip: false,
  envelope: { amountOctaves: 0, attackMs: 10, releaseMs: 100, hold: false, link: false },
  lfo: { waveform: 'sine', sync: false, division: 5, rateHz: 1, depthOctaves: 0, phaseOffset: 0, stereoMode: 'phase', stereoPhase: 0 },
  ...overrides,
})

const loFiState = (overrides: Partial<LoFiProcessorState> = {}): LoFiProcessorState => ({
  enabled: true,
  bitDepth: 8,
  sampleRateHz: 24_000,
  jitter: 0.35,
  noiseDb: -60,
  quantization: 'round',
  dither: 'triangular',
  mix: 1,
  seed: 123,
  preFilter: true,
  postFilter: true,
  dcCorrection: false,
  subSampleClock: true,
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
    const parameterTargets = processor.parameterTargets ?? [1, 3, 4, 210]
    view.setBigUint64(offset, processor.nodeId, true)
    view.setUint32(offset + 8, processor.kindId ?? 1, true)
    view.setUint32(offset + 12, processorRegistry.find((entry) => entry.id === (processor.kindId ?? 1))?.schemaVersion ?? 1, true)
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
  view.setUint32(20, 3, true)

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
  target = 3,
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
  hiQuality: true,
  driveDb: 18,
  curve: 'hard',
  color: true,
  colorFrequencyHz: 2_500,
  colorWidth: 0.57,
  colorLowDb: 0,
  colorHighDb: 6,
  bassThresholdDb: -12,
  warpDepth: 0.5,
  warpPeriod: 0.5,
  postClip: 'off',
  outputDb: -3,
  dryWet: 0.75,
  ...overrides,
})

const saturatorLatency = (overrides: Partial<SaturatorProcessorState> = {}) => saturatorLatencyFrames(overrides.hiQuality ?? true, overrides.postClip ?? 'off')

const eqState = (overrides: Partial<EqProcessorState> = {}): EqProcessorState => ({
  enabled: true,
  channelMode: 'stereo',
  adaptiveQ: false,
  highQuality: false,
  scale: 1,
  outputDb: 0,
  bands: Array.from({ length: 16 }, (_, index) => ({
    enabled: index % 8 < 3,
    type: index % 8 === 0 ? 'highpass' : index % 8 === 1 ? 'peaking' : 'highshelf',
    frequency: index % 8 === 0 ? 120 : index % 8 === 1 ? 1_000 : 8_000,
    gainDb: index % 8 === 1 ? 6 : index % 8 === 2 ? -3 : 0,
    q: index % 8 === 0 ? 0.707 : 1,
  })),
  ...overrides,
})

const eqImpulseFixture = (highQuality: boolean): PortableGraphParityFixture => {
  const latency = highQuality ? EQ_HIGH_QUALITY_LATENCY_FRAMES : 0
  const frames = latency + 64
  const state = eqState({ highQuality })

  return {
    name: highQuality ? 'eq-hi-quality-impulse-partitions-reset' : 'eq-impulse-partitions-reset',
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
      state: encodeEqProcessorState(state),
      parameterTargets: [],
      latencyFrames: latency,
    }),
    frames,
    blockPartitions: highQuality ? [1, 3, 12, 16, 32, 3] : [1, 3, 12, 16, 32],
    input: stereo([1, ...Array.from({ length: frames - 1 }, () => 0)], [-0.5, ...Array.from({ length: frames - 1 }, () => 0)]),
    assertReset: true,
    expectedLatencyFrames: latency,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => {
      const left = output[0]

      if (!finite(output) || left === undefined) return false

      if (!highQuality) {
        return Math.abs(sampleAt(output, 0) - 1) > 0.001
          && output.some((plane) => plane.slice(1).some((sample) => Math.abs(sample) > 1e-6))
      }

      const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample * sample, 0)
      const peak = left.reduce((best, sample, index) => Math.abs(sample) > Math.abs(left[best] ?? 0) ? index : best, 0)

      return energy(left) > 1e-12
        && energy(left.slice(0, latency)) <= 0.1 * energy(left)
        && peak >= latency
    },
  }
}

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
      legacySaturator: undefined,
      legacyReverb: undefined,
      legacySpectral: undefined,
      legacyTolerance: undefined,
      legacyDifferenceMinimum: undefined,
      characterizationPairKey: key,
      characterizationPairDifferenceMinimum: minimumDifference,
    },
  ]
}

// A Saturator or EQ that is bypassed when its graph is first built has nothing
// sounding to ramp away from, so it passes its input dry from the first sample.
const rampedBypassFrames = 960

const rampedBypassInput = stereo(
  sine(rampedBypassFrames, 1_000, 48_000),
  sine(rampedBypassFrames, 2_000, 48_000, 0.25),
)

const dryFromTheStart = (plane: Float32Array, channel: number) => plane.every((sample, frame) =>
  closeTo(sample, rampedBypassInput[channel * rampedBypassFrames + frame] ?? 0))

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

const chorusState: DelayModulationProcessorState = {
  enabled: true, mode: 'chorus', waveform: 'sine', safeBass: false, delayMs: 12, depthMs: 4, rateHz: 0.8, feedback: 0, stereoPhase: 0.25, mix: 0.35,
  safeBassHz: 100, width: 1, outputDb: 0,
}

const flangerState: DelayModulationProcessorState = {
  enabled: true, mode: 'flanger', waveform: 'sine', safeBass: false, delayMs: 1.5, depthMs: 1, rateHz: 0.2, feedback: 0.35, stereoPhase: 0.5, mix: 0.5,
  safeBassHz: 100, width: 1, outputDb: 0,
}

const phaserState: PhaserProcessorState = {
  enabled: true, stages: 6, waveform: 'sine', safeBass: false, centerHz: 1_000, depthOctaves: 3, rateHz: 0.3, feedback: 0.3, stereoPhase: 0.5, mix: 0.5,
  spreadOctaves: 0, blend: 0, safeBassHz: 100, outputDb: 0,
}

const tremoloState: AmplitudeModulationProcessorState = {
  enabled: true, waveform: 'sine', sync: false, division: 5, invert: false, rateHz: 4, depth: 0.5, 'shape': 0.5, phase: 0, stereoPhase: 0,
}

const autoPanState: AmplitudeModulationProcessorState = {
  enabled: true, waveform: 'sine', sync: false, division: 5, invert: false, rateHz: 1, depth: 1, 'shape': 0.5, phase: 0, stereoPhase: 0.5,
}

const ensembleState: EnsembleProcessorState = {
  enabled: true, voices: 3, waveform: 'sine', safeBass: false, delayMs: 18, depthMs: 6, rateHz: 0.6, spread: 1, mix: 0.5,
  fastDepthMs: 0, fastRateHz: 6, safeBassHz: 100, width: 1, outputDb: 0,
}

const modulationDefinitions: readonly ModulationFixtureDefinition[] = [
  { kind: 'chorus', kindId: 4, legacy: { kind: 'chorus', state: chorusState } },
  { kind: 'flanger', kindId: 5, legacy: { kind: 'flanger', state: flangerState } },
  { kind: 'phaser', kindId: 6, legacy: { kind: 'phaser', state: phaserState } },
  { kind: 'tremolo', kindId: 7, legacy: { kind: 'tremolo', state: tremoloState } },
  { kind: 'autopan', kindId: 8, legacy: { kind: 'autopan', state: autoPanState } },
  { kind: 'ensemble', kindId: 9, legacy: { kind: 'ensemble', state: ensembleState } },
]

// Several parameter sets per effect, so the worklet is held to the core on every mode, waveform and control extreme the
// effects have, not just their defaults. Each runs about 85 ms of low-pitched sweeps in uneven blocks: the delay reads of the native
// and the Wasm core differ by float contraction, and a high-pitched input would measure that, not the worklet.
type ModulationVariant = { name: string; sampleRateHz?: number; legacy: PortableLegacyModulationFixture; tolerance?: number }

const chorusVariant = (name: string, state: Partial<DelayModulationProcessorState>, sampleRateHz?: number): ModulationVariant =>
  ({ name, sampleRateHz, legacy: { kind: 'chorus', state: { ...chorusState, ...state } } })

const flangerVariant = (name: string, state: Partial<DelayModulationProcessorState>, sampleRateHz?: number): ModulationVariant =>
  ({ name, sampleRateHz, legacy: { kind: 'flanger', state: { ...flangerState, ...state } } })

const phaserVariant = (name: string, state: Partial<PhaserProcessorState>, sampleRateHz?: number, tolerance?: number): ModulationVariant =>
  ({ name, sampleRateHz, tolerance, legacy: { kind: 'phaser', state: { ...phaserState, ...state } } })

const tremoloVariant = (name: string, state: Partial<AmplitudeModulationProcessorState>, sampleRateHz?: number): ModulationVariant =>
  ({ name, sampleRateHz, legacy: { kind: 'tremolo', state: { ...tremoloState, ...state } } })

const autoPanVariant = (name: string, state: Partial<AmplitudeModulationProcessorState>, sampleRateHz?: number): ModulationVariant =>
  ({ name, sampleRateHz, legacy: { kind: 'autopan', state: { ...autoPanState, ...state } } })

const ensembleVariant = (name: string, state: Partial<EnsembleProcessorState>, sampleRateHz?: number): ModulationVariant =>
  ({ name, sampleRateHz, legacy: { kind: 'ensemble', state: { ...ensembleState, ...state } } })

const modulationVariants: readonly ModulationVariant[] = [
  chorusVariant('vibrato', { mode: 'vibrato', depthMs: 3, rateHz: 5, feedback: 0.4 }),
  chorusVariant('vintage', { mode: 'vintage', delayMs: 8, depthMs: 3, rateHz: 3, feedback: 0.4, safeBass: true, safeBassHz: 250, width: 0.5, outputDb: 3 }, 44_100),
  chorusVariant('vintage-96000', { mode: 'vintage', delayMs: 30, depthMs: 10, rateHz: 7, feedback: 0.5, mix: 1 }, 96_000),
  chorusVariant('triangle-negative-stereo', { waveform: 'triangle', feedback: 0.5, stereoPhase: -0.5, rateHz: 6 }),
  chorusVariant('sample-hold', { waveform: 'sampleHold', rateHz: 20, mix: 1 }),
  chorusVariant('wander-depth-over-delay', { waveform: 'wander', rateHz: 9, delayMs: 5, depthMs: 10, mix: 1 }),
  flangerVariant('through-zero', { mode: 'throughZero', delayMs: 1.5, depthMs: 3, feedback: -0.7, rateHz: 6 }),
  flangerVariant('through-zero-44100', { mode: 'throughZero', delayMs: 0.1, depthMs: 5, rateHz: 15, mix: 1 }, 44_100),
  flangerVariant('max-feedback-short', { delayMs: 0.1, depthMs: 0.05, feedback: 0.95, rateHz: 4, mix: 1 }),
  flangerVariant('negative-feedback-saw', { waveform: 'sawUp', feedback: -0.95, delayMs: 3, depthMs: 2, rateHz: 8 }, 96_000),
  flangerVariant('square', { waveform: 'square', rateHz: 11, safeBass: true, width: 2, outputDb: -6 }),
  ensembleVariant('fast-modulation', { fastDepthMs: 3, fastRateHz: 8, rateHz: 3, depthMs: 8 }),
  ensembleVariant('safe-bass-width', { safeBass: true, safeBassHz: 400, width: 0, outputDb: -6, rateHz: 5 }),
  ensembleVariant('triangle-no-spread', { waveform: 'triangle', spread: 0, rateHz: 5, delayMs: 10, depthMs: 12 }, 44_100),
  ensembleVariant('sample-hold-96000', { waveform: 'sampleHold', rateHz: 5, fastDepthMs: 4, fastRateHz: 12, width: 2 }, 96_000),
  phaserVariant('four-stages-negative-feedback', { stages: 4, feedback: -0.95, rateHz: 6 }),
  phaserVariant('twelve-stages-max-feedback', { stages: 12, feedback: 0.95, centerHz: 1_000, depthOctaves: 3, rateHz: 8 }),
  phaserVariant('twelve-stages-negative-feedback-wide-sweep', { stages: 12, feedback: -0.95, centerHz: 1_000, depthOctaves: 5, rateHz: 8 }, 96_000),
  // 12 stages at feedback +0.95 with the sweep reaching both ends of the range: the loop gain 1 / (1 - fb G) is about 5 there, so the
  // native and the Wasm core (same source, different libm and float contraction) drift apart more than anywhere else. Each row states
  // its own tolerance, set above the largest difference measured (native vs Wasm, worklet vs Wasm): 5.4e-6 and 4.7e-6 at 48 kHz, which
  // keeps the 1e-5 bar; 1.27e-5 and 1.04e-5 at 96 kHz, where the loop runs twice as many samples per second, so 2e-5.
  phaserVariant('twelve-stages-max-feedback-wide-sweep', { stages: 12, feedback: 0.95, centerHz: 1_000, depthOctaves: 5, rateHz: 8 }, undefined, 1e-5),
  phaserVariant('twelve-stages-max-feedback-wide-sweep-96000', { stages: 12, feedback: 0.95, centerHz: 1_000, depthOctaves: 5, rateHz: 8 }, 96_000, 2e-5),
  phaserVariant('spread-blend', { stages: 8, spreadOctaves: 2, blend: 0.5, rateHz: 7 }),
  phaserVariant('spread-only-44100', { stages: 6, spreadOctaves: 4, blend: 0, rateHz: 7, feedback: 0.6 }, 44_100),
  phaserVariant('square-safe-bass', { waveform: 'square', rateHz: 15, safeBass: true, safeBassHz: 300, outputDb: -3, mix: 1 }),
  tremoloVariant('triangle-inverted-shape', { waveform: 'triangle', depth: 1, 'shape': 0.2, invert: true, rateHz: 8 }),
  tremoloVariant('synced-saw', { waveform: 'sawDown', sync: true, division: 3, depth: 0.8, stereoPhase: 0.25 }),
  tremoloVariant('square-antiphase', { waveform: 'square', rateHz: 10, depth: 0.8, stereoPhase: 0.5 }, 44_100),
  tremoloVariant('sample-hold', { waveform: 'sampleHold', rateHz: 14, depth: 1, 'shape': 0.8 }),
  tremoloVariant('wander-offset', { waveform: 'wander', rateHz: 9, depth: 1, phase: 0.3, stereoPhase: -0.3 }, 96_000),
  tremoloVariant('sine-shaped', { depth: 1, 'shape': 0.9, rateHz: 6, phase: 0.6 }),
  autoPanVariant('triangle-in-phase', { waveform: 'triangle', stereoPhase: 0, rateHz: 6 }),
  autoPanVariant('square-synced-inverted', { waveform: 'square', sync: true, division: 8, invert: true }),
  autoPanVariant('sample-hold-shaped', { waveform: 'sampleHold', rateHz: 12, 'shape': 0.1, stereoPhase: -0.25 }, 44_100),
  autoPanVariant('wander-half-depth', { waveform: 'wander', rateHz: 9, depth: 0.5, 'shape': 0.9, phase: 0.4 }, 96_000),
  autoPanVariant('saw-quarter-phase', { waveform: 'sawUp', rateHz: 5, stereoPhase: 0.25 }),
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
  if (kind === 'chorus') return [74, 75, 76, 77, 78, 79, 177, 178, 179]

  if (kind === 'flanger') return [80, 81, 82, 83, 84, 85, 180, 181, 182]

  if (kind === 'phaser') return [86, 87, 88, 89, 90, 91, 183, 184, 185, 186]

  if (kind === 'tremolo') return [92, 93, 94, 95, 187]

  if (kind === 'autopan') return [96, 97, 98, 99, 188]

  return [100, 101, 102, 103, 104, 189, 190, 191, 192, 193]
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
    tolerance?: number
  } = {},
): PortableGraphParityFixture => {
  const legacy = options.legacy ?? definition.legacy
  const frames = input.length / 2
  // Through-zero delays its dry path by 5 ms and declares that as the processor's latency.
  const latencyFrames = legacy.kind === 'flanger' && legacy.state.mode === 'throughZero' ? Math.ceil(5 * sampleRateHz / 1_000) : 0

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
      latencyFrames,
    }),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    assertReset: options.assertReset,
    expectedLatencyFrames: latencyFrames,
    nativeWasmTolerance: options.tolerance ?? 1e-5,
    legacyModulation: legacy,
    legacyTolerance: options.tolerance ?? 1e-5,
    assertOutput: (output) => finite(output) && changedFromInput(output, input, 1e-5),
  }
}

const modulationVariantFixtures = modulationVariants.map((variant): PortableGraphParityFixture => {
  const definition = modulationDefinitions.find((candidate) => candidate.kind === variant.legacy.kind)

  if (!definition) throw new Error(`No modulation fixture definition for ${variant.legacy.kind}.`)
  const frames = 4_096
  const rate = variant.sampleRateHz ?? 48_000

  return modulationFixture(
    definition,
    `variant-${variant.name}`,
    'chains',
    rate,
    stereo(sweep(frames, 80, 1_500, rate), sweep(frames, 120, 1_200, rate, 0.4)),
    { legacy: variant.legacy, tolerance: variant.tolerance, maxFramesPerBlock: 480, blockPartitions: [31, 449, ...Array.from({ length: 7 }, () => 480), 256] },
  )
})

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

  bypass.legacyStartFrame = 480
  bypass.assertOutput = (output) => finite(output)
    && output.every((plane, channel) => plane.every((sample, frame) =>
      closeTo(sample, bypass.input[channel * plane.length + frame] ?? 0, 1e-5)))

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
  latencyMs: 1 | 6 | 10
  legacy: PortableLegacyDynamicsFixture
  portableEligible: boolean
}

const dynamicsDefinitions: readonly DynamicsFixtureDefinition[] = [
  {
    kind: 'gate',
    kindId: 10,
    latencyMs: 1,
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
        flip: false,
        sidechain: { enabled: false, filterType: 'highpass', frequencyHz: 80, q: 0.707, gainDb: 0, mix: 1 },
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
        lookaheadMs: 10,
        autoMakeup: false,
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
    latencyMs: 6,
    portableEligible: true,
    legacy: {
      kind: 'limiter',
      state: {
        enabled: true,
        gainDb: 0,
        ceilingDbtp: -6,
        releaseMs: 50,
        autoRelease: false,
        lookaheadMs: 6,
        link: 1,
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
  if (kind === 'gate') return [105, 106, 107, 108, 109, 110, 111, 113, 114, 115, 171, 172]

  if (kind === 'compressor') return [116, 117, 118, 119, 120, 121, 122, 123, 125, 126]

  return [127, 128, 130, 170]
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
        makeupDb: enabled ? undefined : 0,
        outputDb: enabled ? undefined : 0,
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
      definition.kind === 'gate' ? 0 : definition.kind === 'compressor' ? -10 : -3,
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
            sidechain: { ...definition.legacy.state.sidechain, enabled: true },
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
  link: true,
  pingPong: true,
  freeze: false,
  filterEnabled: true,
  smoothing: 'repitch',
  syncLeft: false,
  syncRight: false,
  divisionLeft: '1/8',
  divisionRight: '1/8',
  feelLeft: 'straight',
  feelRight: 'straight',
  timeLeftMs: 10,
  timeRightMs: 10,
  offsetLeftPercent: 0,
  offsetRightPercent: 0,
  feedback: 0.5,
  dryWet: 0.5,
  filterHz: 1_000,
  filterWidth: 5,
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
  'reflectionShape': 0.5,
  diffuse: 1,
  size: 0,
  diffusion: 0.75,
  density: 'sparse',
  lowCutHz: 20,
  highCutHz: 20_000,
  lowShelfHz: 200,
  highShelfHz: 5_000,
  stereoWidth: 100,
  smooth: 'fast',
  freeze: false,
  flat: false,
  cut: false,
  chorus: true,
  chorusAmountMs: 0.3,
  chorusRateHz: 0.4,
  lowShelfOn: true,
  highShelfOn: true,
  lowShelfDb: 0,
  highShelfDb: 0,
  lowCutOn: false,
  highCutOn: false,
}

const timeEffectTailFrames = (
  kind: PortableTimeEffectKind,
  state: DelayProcessorState | ReverbProcessorState,
  sampleRateHz: number,
) => {
  if (kind === 'delay' && 'feedback' in state) {
    if (!state.enabled || state.dryWet === 0) return 0
    const repeats = Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(Math.max(state.feedback, 1e-6))))

    return Math.ceil(Math.max(state.timeLeftMs, state.timeRightMs) * sampleRateHz / 1_000 * repeats)
  }

  if (kind === 'reverb' && 'decaySec' in state) {
    return Math.ceil(state.enabled
      ? (state.preDelayMs / 1_000 + 0.15 + state.decaySec) * sampleRateHz
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
    // Delay toggles, each compiled the way the product does: the plan's bypass flag
    // and the state's own enabled flag together.
    enabledEdits?: readonly { frame: number; enabled: boolean }[]
  } = {},
): PortableGraphParityFixture => {
  const state = options.state ?? (kind === 'delay' ? delayState : reverbState)
  const frames = input.length / 2

  const graphFor = (processorState: DelayProcessorState | ReverbProcessorState, bypassed: boolean | undefined) =>
    processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: kind === 'delay' ? 13 : 14,
      state: kind === 'delay'
        ? encodeDelayProcessorState(processorState)
        : encodeReverbProcessorState(processorState),
      parameterTargets: kind === 'delay'
        ? [5, 6, 7, 8, 9]
        : [10, 11, 12, 13, 14, 132, 133, 134, 135, 136, 137, 138, 139, 141, 142, 173, 174, 175, 176],
      latencyFrames: 0,
      tailFrames: timeEffectTailFrames(kind, state, sampleRateHz),
      bypassed,
    })

  return {
    name: `${kind}-${name}`,
    capability,
    processorKind: kind,
    sampleRateHz,
    maxFramesPerBlock: options.maxFramesPerBlock ?? frames,
    inputBusCount: 1,
    channelCount: 2,
    graph: graphFor(state, options.bypassed),
    graphEdits: options.enabledEdits?.map(({ frame, enabled }) => ({
      frame,
      graph: graphFor({ ...state, enabled }, !enabled),
    })),
    frames,
    blockPartitions: options.blockPartitions,
    input,
    parameters: options.parameters,
    assertReset: options.assertReset,
    expectedLatencyFrames: 0,
    expectedTailFrames: timeEffectTailFrames(kind, state, sampleRateHz),
    nativeWasmTolerance: kind === 'reverb' ? 2e-4 : 5e-5,
    legacyDelay: kind === 'delay' ? { kind, state, enabledEdits: options.enabledEdits } : undefined,
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
      && onset >= 1_480
      && onset <= 1_680
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
      parameterTargets: [10, 11, 12, 13, 14, 132, 133, 134, 135, 136, 137, 138, 139, 141, 142, 173, 174, 175, 176],
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
    // Audio before the disable (an impulse at 20), audio received while disabled (one at
    // 3900), then enabled again at 4096. A disabled delay keeps running on its input and
    // only its output is dry, so the echo of the second impulse (960 frames later, past
    // the 10 ms bypass ramp the legacy chain does not have) is heard on re-enable. At a
    // feedback of 0.3 the echoes of the first have decayed to nothing by then, so what is
    // heard cannot be a tail from before the disable. The legacy render is compared
    // from the end of the ramp.
    const frames = 6_144
    const left = Array.from({ length: frames }, () => 0)
    const right = Array.from({ length: frames }, () => 0)
    left[20] = 1
    right[20] = -0.5
    left[3_900] = 0.8
    right[3_900] = 0.4

    const fixture = timeEffectFixture(
      'delay',
      'toggle-keeps-running',
      'chains',
      48_000,
      stereo(left, right),
      {
        state: { ...delayState, timeLeftMs: 20, timeRightMs: 20, feedback: 0.3, pingPong: false },
        maxFramesPerBlock: 512,
        blockPartitions: Array.from({ length: frames / 512 }, () => 512),
        enabledEdits: [{ frame: 1_024, enabled: false }, { frame: 4_096, enabled: true }],
      },
    )

    fixture.legacyStartFrame = 4_608

    const energy = (plane: Float32Array, start: number, end: number) =>
      plane.slice(start, end).some((sample) => Math.abs(sample) > 0.05)

    fixture.assertOutput = (output) => finite(output)
      && output.every((plane, channel) =>
        // Enabled: the first echo is there.
        energy(plane, 960, 1_000)
        // Disabled, past the ramp: only the dry input is left.
        && plane.slice(1_024 + 480, 4_096).every((sample, frame) =>
          closeTo(sample, fixture.input[channel * frames + 1_024 + 480 + frame] ?? 0, 1e-5))
        // Enabled again: the echo of what was heard while disabled.
        && energy(plane, 4_860, 4_900))

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
      new Float32Array(64).fill(1),
      { maxFramesPerBlock: 32, parameters: parameterEnvelopeForTarget(7, Array.from({ length: 32 }, (_, frame) => (frame < 8 ? 0 : 1))) },
    )

    fixture.legacyDelay = undefined
    fixture.legacyDifferenceMinimum = undefined
    // The delay reads its controls every 8 frames and smooths the wet gain over 10 ms: the first 8 frames are dry, then the wet gain
    // glides up, so the dry level (the delayed signal is still silent) falls steadily instead of dropping at once.
    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => plane.slice(0, 8).every((sample) => closeTo(sample, 1))
        && plane.slice(9).every((sample, frame) => sample <= (plane[8 + frame] ?? 0) + 1e-7)
        && (plane[31] ?? 1) < 0.97 && (plane[31] ?? 0) > 0.5)

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
          diffuse: 0,
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
        // Only the early-reflection cascade remains without late texture: its longest path is 81.7 ms
        // (3,922 frames) after the first echo at this size.
        && decay <= onset + 4_000
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
      && output.every((plane) => closeTo(plane[0] ?? 0, 1) && plane.slice(1).every((sample) => sample > 0.99 && sample <= 1 + 1e-6))

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
    // Toggles of the stage, each compiled the way the product does: the plan's
    // bypass flag and the state's own enabled flag together.
    enabledEdits?: readonly { frame: number; enabled: boolean }[]
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
    graphEdits: options.enabledEdits?.map(({ frame, enabled }) => ({
      frame,
      graph: spectralGraph({ ...state, enabled }, inputBusCount, !enabled),
    })),
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
    legacySpectral: { kind: 'spectral', state, mixValues: options.mixValues, enabledEdits: options.enabledEdits },
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
    // Capture, silence, disable, enable. Disabling a stage is a bypass, so the sound
    // it froze is still there when it is switched back on. The windows around the two
    // toggles differ by design (the portable core ramps its bypass and keeps its
    // overlap-add running underneath; the worklet switches at once and refills its
    // rings), so the legacy render is compared once both are back in the steady frozen state.
    const frames = 3_072
    const impulse = Array.from({ length: frames }, () => 0)
    impulse[256] = 1

    const fixture = spectralFixture(
      'freeze-toggle-keeps-capture',
      'chains',
      48_000,
      stereo(impulse, impulse.map((sample) => sample * -0.5)),
      spectralState({ mode: 'freeze', freeze: 1 }),
      {
        maxFramesPerBlock: 512,
        blockPartitions: [7, 505, 512, 512, 512, 512, 512],
        enabledEdits: [{ frame: 1_024, enabled: false }, { frame: 1_536, enabled: true }],
      },
    )

    fixture.legacyStartFrame = 2_560

    const energy = (plane: Float32Array, start: number, end: number) =>
      plane.slice(start, end).some((sample) => Math.abs(sample) > 1e-3)

    fixture.assertOutput = (output) => finite(output)
      && output.every((plane) => plane.slice(0, 512).every((sample) => sample === 0)
        && energy(plane, 512, 1_024)
        // Disabled: the bypass ramp is over and only the (silent) dry input is left.
        && plane.slice(1_024 + 480, 1_536).every((sample) => Math.abs(sample) < 1e-6)
        // Enabled again: the frozen capture is sounding, not a recapture of silence.
        && energy(plane, 2_560, frames))

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
    parameterTargets: [209, 42, 43, 44, 131],
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

const autoFilterImpulseFixture = (hiQuality: boolean): PortableGraphParityFixture => {
  const latency = hiQuality ? AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES : 0
  const frames = latency + 64

  return {
    name: hiQuality ? 'autofilter-lowpass-hi-quality-impulse-partitions-reset' : 'autofilter-lowpass-impulse-partitions-reset',
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
      state: encodeAutoFilterProcessorState(autoFilterState({ hiQuality })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: latency,
    }),
    frames,
    // Uneven blocks up to the 32-frame maximum; the sizes must add up to the frame count.
    blockPartitions: hiQuality ? [1, 3, 12, 16, 32, 32, 31] : [1, 3, 12, 16, 32],
    input: stereo([1, ...Array.from({ length: frames - 1 }, () => 0)], [-0.5, ...Array.from({ length: frames - 1 }, () => 0)]),
    assertReset: true,
    expectedLatencyFrames: latency,
    nativeWasmTolerance: 2e-5,
    // The Hi-Quality oversampler is linear phase, so it rings slightly before its peak: almost no energy may arrive
    // before the declared latency, and the peak must not.
    assertOutput: (output) => {
      const left = output[0]

      if (!finite(output) || left === undefined) return false
      const energy = (samples: Float32Array) => samples.reduce((sum, sample) => sum + sample * sample, 0)
      const peak = left.reduce((best, sample, index) => Math.abs(sample) > Math.abs(left[best] ?? 0) ? index : best, 0)

      return energy(left) > 1e-12 && energy(left.slice(0, latency)) <= 1e-3 * energy(left) && peak >= latency
    },
  }
}

const saturatorCurves = ['soft', 'medium', 'hard', 'clip', 'analog', 'sine', 'bass', 'fold', 'warp'] as const

const saturatorVariant = (
  name: string,
  sampleRateHz: number,
  overrides: Partial<SaturatorProcessorState>,
): PortableGraphParityFixture => {
  const state: SaturatorProcessorState = {
    enabled: true,
    hiQuality: true,
    driveDb: 18,
    curve: 'hard',
    color: true,
    colorFrequencyHz: 2_500,
    colorWidth: 0.57,
    colorLowDb: 0,
    colorHighDb: 6,
    bassThresholdDb: -12,
    warpDepth: 0.5,
    warpPeriod: 0.5,
    postClip: 'off',
    outputDb: -3,
    dryWet: 0.75,
    ...overrides,
  }

  const frames = 1_200
  const input = stereo(sine(frames, 997, sampleRateHz, 0.8), sweep(frames, 80, 9_000, sampleRateHz, 0.6))

  return {
    name: `saturator-variant-${name}`,
    capability: 'chains',
    processorKind: 'saturator',
    sampleRateHz,
    maxFramesPerBlock: 480,
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: encodeSaturatorProcessorState(state),
      latencyFrames: saturatorLatencyFrames(state.hiQuality, state.postClip),
      parameterTargets: [69, 70, 72, 73, 203, 204, 205, 206, 207, 208],
    }),
    frames,
    blockPartitions: [1, 63, 128, 288, 480, 240],
    input,
    assertReset: true,
    legacySaturator: { kind: 'saturator', state },
    legacyTolerance: 1e-5,
    assertOutput: finite,
  }
}

const saturatorVariantFixtures: readonly PortableGraphParityFixture[] = [
  ...saturatorCurves.map((curve) => saturatorVariant(curve, 48_000, { curve })),
  ...saturatorCurves.map((curve) => saturatorVariant(`${curve}-lofi`, 48_000, { curve, hiQuality: false, color: false })),
  saturatorVariant('hard-44100', 44_100, {}),
  saturatorVariant('soft-96000', 96_000, { curve: 'soft', colorLowDb: -6 }),
  saturatorVariant('soft-postclip-soft', 48_000, { curve: 'soft', postClip: 'soft' }),
  saturatorVariant('soft-postclip-hard', 48_000, { curve: 'soft', postClip: 'hard', driveDb: 30 }),
  saturatorVariant('analog-postclip-hard-lofi', 48_000, { curve: 'analog', postClip: 'hard', hiQuality: false }),
  saturatorVariant('warp-extreme', 48_000, { curve: 'warp', warpDepth: 1, warpPeriod: 0.1, driveDb: 36 }),
  saturatorVariant('bass-threshold-floor', 48_000, { curve: 'bass', bassThresholdDb: -50 }),
  saturatorVariant('dry', 48_000, { dryWet: 0 }),
  saturatorVariant('color-extreme', 48_000, { colorLowDb: 12, colorHighDb: -12, colorFrequencyHz: 100, colorWidth: 1 }),
]

const autoFilterFixtures: readonly PortableGraphParityFixture[] = [
  autoFilterImpulseFixture(false),
  autoFilterImpulseFixture(true),
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
        lfo: { waveform: 'triangle', sync: false, division: 5, rateHz: 3, depthOctaves: 0, phaseOffset: 0, stereoMode: 'phase', stereoPhase: 0.25 },
      })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: 0,
    }),
    frames: 128,
    input: new Float32Array([
      Number.NaN, Number.POSITIVE_INFINITY, ...Array.from({ length: 126 }, (_, index) => Math.sin(index * 0.31) * 4),
      Number.NEGATIVE_INFINITY, Number.NaN, ...Array.from({ length: 126 }, (_, index) => -Math.sin(index * 0.31) * 4),
    ]),
    expectedLatencyFrames: 0,
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
      latencyFrames: 0,
    }),
    frames: 68,
    input: stereo(sine(68, 440, 96_000), sine(68, 880, 96_000, 0.25)),
    parameters: parameterEnvelopeForTarget(30, Array.from({ length: 68 }, (_, frame) => 200 + frame * 25)),
    expectedLatencyFrames: 0,
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
      state: encodeAutoFilterProcessorState(autoFilterState({ enabled: false, hiQuality: true })),
      parameterTargets: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
      latencyFrames: AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES,
      bypassed: true,
    }),
    frames: AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES + 16,
    blockPartitions: [16, 16, 16, 16, 15],
    input: stereo(sine(AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES + 16, 1_000, 44_100), sine(AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES + 16, 2_000, 44_100, 0.25)),
    expectedLatencyFrames: AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output)
      && output.every((plane) => plane.slice(0, AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES).every((sample) => sample === 0))
      && output.some((plane) => plane.slice(AUTO_FILTER_HI_QUALITY_LATENCY_FRAMES).some((sample) => Math.abs(sample) > 1e-6)),
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
      latencyFrames: saturatorLatency(),
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
      state: saturatorState({ color: false, colorHighDb: 0, dryWet: 1 }),
      latencyFrames: saturatorLatency({ color: false, colorHighDb: 0, dryWet: 1 }),
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
      latencyFrames: saturatorLatency({ curve: 'soft' }),
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
    maxFramesPerBlock: 480,
    blockPartitions: [480, 480],
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 2,
      state: saturatorState(),
      latencyFrames: saturatorLatency(),
      parameterTargets: [],
      bypassed: true,
    }),
    frames: rampedBypassFrames,
    input: rampedBypassInput,
    assertOutput: (output) => finite(output) && output.every(dryFromTheStart),
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
      latencyFrames: saturatorLatency(),
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
      latencyFrames: saturatorLatency(),
      parameterTargets: [69, 70, 203, 72, 73],
    }),
    frames: 64,
    blockPartitions: [1, 7, 16, 40],
    input: stereo(sine(64, 440, 48_000), sine(64, 880, 48_000, 0.25)),
    assertOutput: (output) => finite(output) && changedFromInput(output, stereo(
      sine(64, 440, 48_000),
      sine(64, 880, 48_000, 0.25),
    )),
  }, 69, 30),
  ...saturatorVariantFixtures,
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
      latencyFrames: saturatorLatency(),
      parameterTargets: [],
    }),
    frames: 4,
    input: new Float32Array(8).fill(0.25),
    events: processorEventEnvelope(),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  eqImpulseFixture(false),
  eqImpulseFixture(true),
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
      state: encodeEqProcessorState(eqState({ channelMode: 'mono' })),
      parameterTargets: [],
      latencyFrames: 0,
    }),
    frames: 32,
    blockPartitions: [3, 5, 8, 7, 9],
    expectedLatencyFrames: 0,
    nativeWasmTolerance: 2e-5,
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
      state: encodeEqProcessorState(eqState()),
      parameterTargets: [],
      latencyFrames: 0,
    }),
    frames: 96,
    blockPartitions: [16, 32, 7, 41],
    expectedLatencyFrames: 0,
    nativeWasmTolerance: 2e-5,
    input: stereo(sine(96, 1_000, 96_000), sine(96, 8_000, 96_000, 0.25)),
    assertOutput: (output) => finite(output) && output.every((plane) => plane.some((sample) => Math.abs(sample) > 0.01)),
  },
  {
    name: 'eq-bypass',
    capability: 'chains',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 480,
    blockPartitions: [480, 480],
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: encodeEqProcessorState(eqState()),
      parameterTargets: [],
      bypassed: true,
      latencyFrames: 0,
    }),
    frames: rampedBypassFrames,
    input: rampedBypassInput,
    expectedLatencyFrames: 0,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output) && output.every(dryFromTheStart),
  },
  {
    name: 'eq-hi-quality-bypass-delay',
    capability: 'chains',
    processorKind: 'eq',
    sampleRateHz: 48_000,
    maxFramesPerBlock: 480,
    blockPartitions: [480, 480, EQ_HIGH_QUALITY_LATENCY_FRAMES],
    inputBusCount: 1,
    channelCount: 2,
    graph: processorSourceMaster({
      nodeId: 2n,
      instanceId: 11,
      kindId: 3,
      state: encodeEqProcessorState(eqState({ highQuality: true })),
      parameterTargets: [],
      bypassed: true,
      latencyFrames: EQ_HIGH_QUALITY_LATENCY_FRAMES,
    }),
    frames: rampedBypassFrames + EQ_HIGH_QUALITY_LATENCY_FRAMES,
    input: stereo(
      sine(rampedBypassFrames + EQ_HIGH_QUALITY_LATENCY_FRAMES, 1_000, 48_000),
      sine(rampedBypassFrames + EQ_HIGH_QUALITY_LATENCY_FRAMES, 2_000, 48_000, 0.25),
    ),
    expectedLatencyFrames: EQ_HIGH_QUALITY_LATENCY_FRAMES,
    nativeWasmTolerance: 2e-5,
    assertOutput: (output) => finite(output)
      && output.every((plane) => plane.slice(0, EQ_HIGH_QUALITY_LATENCY_FRAMES).every((sample) => sample === 0))
      && output.every((plane, channel) => plane.slice(EQ_HIGH_QUALITY_LATENCY_FRAMES).every((sample, frame) =>
        closeTo(sample, rampedBypassInput[channel * rampedBypassFrames + frame] ?? 0))),
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
      state: encodeEqProcessorState(eqState()),
      parameterTargets: [],
      latencyFrames: 0,
    }),
    frames: 4,
    expectedLatencyFrames: 0,
    nativeWasmTolerance: 2e-5,
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
      state: encodeEqProcessorState(eqState()),
      parameterTargets: Array.from({ length: 24 }, (_, index) => 45 + index),
      latencyFrames: 0,
    }),
    frames: 64,
    blockPartitions: [1, 7, 16, 40],
    expectedLatencyFrames: 0,
    nativeWasmTolerance: 2e-5,
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
      state: encodeEqProcessorState(eqState()),
      parameterTargets: [],
      latencyFrames: 0,
    }),
    frames: 4,
    expectedLatencyFrames: 0,
    input: new Float32Array(8).fill(0.25),
    events: processorEventEnvelope(),
    expectedResult: 'reject',
    assertOutput: () => false,
  },
  ...modulationFixtures,
  ...modulationVariantFixtures,
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
        'windowShape': 'hann',
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
    name: 'granular-voice-stealing-stolen-note-off',
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
        'windowShape': 'hann',
        freeze: true,
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
      ...Array.from({ length: 33 }, (_, index) => ({
        nodeId: 1n,
        noteId: BigInt(index + 1),
        sequence: BigInt(index + 1),
        frameOffset: 0,
        type: 1,
        note: 36 + index,
        value: 1,
      })),
      ...Array.from({ length: 32 }, (_, index) => ({
        nodeId: 1n,
        noteId: BigInt(index + 1),
        sequence: BigInt(index + 34),
        frameOffset: 1,
        type: 2,
        note: 36 + index,
        value: 0,
      })),
      { nodeId: 1n, noteId: 33n, sequence: 66n, frameOffset: 2, type: 2, note: 68, value: 0 },
    ]),
    nativeWasmTolerance: 1e-5,
    assertOutput: (output) => finite(output) && sampleAt(output, 1) > 0 && closeTo(sampleAt(output, 7), 0),
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
        'windowShape': 'hann',
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
