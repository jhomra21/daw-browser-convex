import {
  audioCoreContractVersion,
  type AudioAssetRef,
  type AudioCoreGraphSnapshot,
  synthParameterRegistry,
  type AudioCoreDrumRackState,
  type AudioCoreGranularState,
  type AudioCoreMixerState,
  type AudioCoreSampleZone,
  type AudioCoreSamplerState,
  type AudioCoreSynthState,
} from '../../audio-core-contract/src/index'
import {
  normalizeDrumRackParams,
  normalizeGranularParams,
  normalizeSynthParams,
  normalizeSamplerParams,
  parseSynthAutomationKey,
  type AutomationEnvelope,
  type DrumRackParams,
  type GranularParams,
  type SamplerParams,
  type SynthParamsInput,
} from '@daw-browser/shared'
import type { AudioAssetHandle } from './audio-asset-types'
import {
  portableWasmMaxAssets,
  portableWasmMaxGraphEdges,
  portableWasmMaxGraphNodes,
  parsePortableWasmControlMessage,
} from './portable-wasm-protocol'
import { portableWasmCapabilityMatrix } from './backends/portable-wasm-capabilities'
import type { ExportFx } from './export-types'
import { createPortableGraphSnapshot } from './mixer/graph-contract'
import type { ResolvedMixerGraph } from './mixer/types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'
import {
  assertPortableFrameSchedule,
  type PortableFrameSchedule,
  type PortableFrameScheduleEvent,
} from './portable-frame-scheduling'

export type PortableSynthConfiguration = {
  nodeId: string
  instanceId: string
  state: AudioCoreSynthState
  /** @deprecated Use state; retained as an identity alias for existing callers. */
  values: AudioCoreSynthState
}

export type PortableSessionCompilerInput = {
  mixer: ResolvedMixerGraph
  fx: ExportFx
  automationEnvelopes: readonly AutomationEnvelope[]
  assetRegistry?: PortableAssetRegistryInput
}

/**
 * Engine-owned registration facts. Browser state identifies an asset by its
 * project asset key; only an already-registered portable identity may enter
 * the portable instrument ABI.
 */
export type PortableAssetRegistryEntry = {
  projectAssetId: string
  portableAssetId: string
  projectGeneration: number
  handle: AudioAssetHandle
  decoded: {
    sampleRateHz: number
    channelCount: number
    frameCount: number
  }
}

export type PortableAssetRegistryInput = {
  projectGeneration: number
  assets: readonly PortableAssetRegistryEntry[]
}

type PortableAssetRegistry = {
  assets: ReadonlyMap<string, PortableAssetRegistryEntry>
  errors: readonly string[]
}

export type PortableSamplerConfiguration = {
  nodeId: string
  instanceId: string
  state: AudioCoreSamplerState
}

export type PortableDrumRackConfiguration = {
  nodeId: string
  instanceId: string
  state: AudioCoreDrumRackState
}

export type PortableGranularConfiguration = {
  nodeId: string
  instanceId: string
  state: AudioCoreGranularState
}

const positiveSafeInteger = (value: number) => Number.isSafeInteger(value) && value > 0
const nonnegativeSafeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0

const indexPortableAssets = (input: PortableAssetRegistryInput | undefined): PortableAssetRegistry => {
  if (!input) return { assets: new Map(), errors: ['No portable asset registry was provided.'] }
  if (!positiveSafeInteger(input.projectGeneration)) {
    return { assets: new Map(), errors: ['The portable asset registry project generation is invalid.'] }
  }
  const assets = new Map<string, PortableAssetRegistryEntry>()
  const portableIds = new Set<string>()
  const errors: string[] = []
  for (const entry of input.assets) {
    if (!entry.projectAssetId || !entry.portableAssetId) {
      errors.push('A portable asset registration has an empty identity.')
      continue
    }
    if (entry.projectGeneration !== input.projectGeneration) {
      errors.push(`${entry.projectAssetId}: portable asset registration is stale.`)
      continue
    }
    if (!nonnegativeSafeInteger(entry.handle.slot) || !positiveSafeInteger(entry.handle.generation)) {
      errors.push(`${entry.projectAssetId}: portable asset handle is invalid.`)
      continue
    }
    if (!positiveSafeInteger(entry.decoded.sampleRateHz)
      || !positiveSafeInteger(entry.decoded.channelCount)
      || !positiveSafeInteger(entry.decoded.frameCount)) {
      errors.push(`${entry.projectAssetId}: decoded portable asset metadata is invalid.`)
      continue
    }
    if (assets.has(entry.projectAssetId) || portableIds.has(entry.portableAssetId)) {
      errors.push(`${entry.projectAssetId}: portable asset registration is ambiguous.`)
      continue
    }
    assets.set(entry.projectAssetId, entry)
    portableIds.add(entry.portableAssetId)
  }
  return { assets, errors }
}

const assetForSample = (
  registry: PortableAssetRegistry,
  sample: { assetKey: string; source: { durationSec: number; sampleRate: number; channelCount: number } },
) => {
  const entry = registry.assets.get(sample.assetKey)
  if (!entry) throw new Error(`Sample asset "${sample.assetKey}" is not registered for the portable session.`)
  if (entry.decoded.sampleRateHz !== sample.source.sampleRate
    || entry.decoded.channelCount !== sample.source.channelCount
    || entry.decoded.frameCount !== frameAt(sample.source.durationSec, sample.source.sampleRate)) {
    throw new Error(`Sample asset "${sample.assetKey}" decoded metadata does not match its browser configuration.`)
  }
  return entry
}

const frameAt = (seconds: number, sampleRate: number) => Math.round(seconds * sampleRate)

const samplerZone = (
  zone: SamplerParams['zones'][number],
  registry: PortableAssetRegistry,
): AudioCoreSampleZone => {
  if (zone.playbackMode === 'crossfade-loop') {
    throw new Error(`${zone.id}: crossfade-loop playback is not supported by the portable ABI.`)
  }
  const asset = assetForSample(registry, zone.sample)
  const startFrame = frameAt(zone.startSec, asset.decoded.sampleRateHz)
  const endFrame = Math.min(
    asset.decoded.frameCount,
    frameAt(zone.endSec ?? zone.sample.source.durationSec, asset.decoded.sampleRateHz),
  )
  const loopStartFrame = zone.playbackMode === 'forward-loop'
    ? frameAt(zone.loopStartSec ?? zone.startSec, asset.decoded.sampleRateHz)
    : 0
  const loopEndFrame = zone.playbackMode === 'forward-loop'
    ? Math.min(asset.decoded.frameCount, frameAt(zone.loopEndSec ?? zone.endSec ?? zone.sample.source.durationSec, asset.decoded.sampleRateHz))
    : 0
  if (endFrame <= startFrame || loopEndFrame > 0 && loopEndFrame <= loopStartFrame) {
    throw new Error(`${zone.id}: browser sample bounds resolve to an empty portable range.`)
  }
  return {
    assetId: asset.portableAssetId,
    keyLow: zone.keyLow,
    keyHigh: zone.keyHigh,
    velocityLow: zone.velocityLow,
    velocityHigh: zone.velocityHigh,
    rootNote: zone.rootNote,
    tuneCents: zone.tuneCents,
    gain: zone.gain,
    pan: zone.pan,
    roundRobinGroup: zone.roundRobinGroup,
    roundRobinIndex: zone.roundRobinIndex,
    playbackMode: zone.playbackMode,
    startFrame,
    endFrame,
    loopStartFrame,
    loopEndFrame,
    chokeGroup: zone.chokeGroup,
  }
}

export const compilePortableSamplerConfiguration = (
  nodeId: string,
  instanceId: string,
  input: SamplerParams,
  registryInput: PortableAssetRegistryInput | undefined,
): PortableSamplerConfiguration => {
  const registry = indexPortableAssets(registryInput)
  if (registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  const params = normalizeSamplerParams(input)
  if (params.zones.length === 0) throw new Error('Sampler has no portable zones.')
  if (params.zones.length > 32) throw new Error('Sampler exceeds the portable zone limit.')
  if (params.filterMode !== 'lowpass' && params.filterMode !== 'highpass') {
    throw new Error(`Sampler filter mode "${params.filterMode}" is not supported by the portable ABI.`)
  }
  if (params.filterEnvelope.amount !== 0) {
    throw new Error('Sampler filter envelopes are not supported by the portable ABI.')
  }
  if (params.lfo.enabled || params.lfo.pitchCents !== 0 || params.lfo.filterHz !== 0 || params.lfo.amp !== 0 || params.lfo.pan !== 0) {
    throw new Error('Sampler LFO modulation is not supported by the portable ABI.')
  }
  if (params.filterQ < 0.05) {
    throw new Error('Sampler filter resonance is below the portable ABI minimum.')
  }
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'sampler',
      voiceCapacity: Math.min(32, params.polyphony),
      outputLayout: 'stereo',
      ampAttackMs: params.ampEnvelope.attackSec * 1000,
      ampDecayMs: params.ampEnvelope.decaySec * 1000,
      ampSustain: params.ampEnvelope.sustain,
      ampReleaseMs: params.ampEnvelope.releaseSec * 1000,
      filterEnabled: true,
      filterMode: params.filterMode,
      filterCutoffHz: params.filterFrequencyHz,
      filterResonance: params.filterQ,
      retrigger: params.retrigger,
      zones: params.zones.map((zone) => samplerZone(zone, registry)),
    },
  }
}

export const compilePortableDrumRackConfiguration = (
  nodeId: string,
  instanceId: string,
  input: DrumRackParams,
  registryInput: PortableAssetRegistryInput | undefined,
): PortableDrumRackConfiguration => {
  const registry = indexPortableAssets(registryInput)
  if (registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  const params = normalizeDrumRackParams(input)
  const zones: AudioCoreSampleZone[] = params.pads.flatMap((pad) => {
    if (pad.mute || !pad.sample) return []
    const asset = assetForSample(registry, pad.sample)
    const startFrame = frameAt(pad.startSec, asset.decoded.sampleRateHz)
    const endFrame = Math.min(asset.decoded.frameCount, frameAt(pad.endSec ?? pad.sample.source.durationSec, asset.decoded.sampleRateHz))
    if (endFrame <= startFrame) throw new Error(`${pad.id}: browser sample bounds resolve to an empty portable range.`)
    return [{
      assetId: asset.portableAssetId,
      keyLow: pad.note,
      keyHigh: pad.note,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: pad.note - pad.transpose,
      tuneCents: 0,
      gain: pad.gain,
      pan: pad.pan,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startFrame,
      endFrame,
      loopStartFrame: 0,
      loopEndFrame: 0,
      chokeGroup: pad.chokeGroup,
    }]
  })
  if (zones.length === 0) throw new Error('Drum rack has no portable pads.')
  if (zones.length > 32) throw new Error('Drum rack exceeds the portable zone limit.')
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'drum-rack',
      voiceCapacity: Math.min(32, zones.length),
      outputLayout: 'stereo',
      ampAttackMs: 0,
      ampDecayMs: 0,
      ampSustain: 1,
      ampReleaseMs: 6,
      filterEnabled: false,
      filterMode: 'lowpass',
      filterCutoffHz: 20_000,
      filterResonance: 0.7,
      retrigger: false,
      zones,
    },
  }
}

export const compilePortableGranularConfiguration = (
  nodeId: string,
  instanceId: string,
  input: GranularParams,
  registryInput: PortableAssetRegistryInput | undefined,
): PortableGranularConfiguration => {
  const registry = indexPortableAssets(registryInput)
  if (registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  const params = normalizeGranularParams(input)
  if (!params.zone) throw new Error('Granular instrument has no portable sample zone.')
  const asset = assetForSample(registry, params.zone.sample)
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'granular',
      voiceCapacity: 2,
      outputLayout: 'stereo',
      assetId: asset.portableAssetId,
      seed: params.seed,
      maxGrains: params.maxGrains,
      windowShape: params.windowShape,
      freeze: params.freeze,
      grainSizeMs: params.grainSizeMs,
      densityHz: params.densityHz,
      position: params.position,
      spray: params.spray,
      pitchSemitones: params.pitchSemitones,
      reverseProbability: params.reverseProbability,
      stereoSpread: params.stereoSpread,
    },
  }
}

const waveform = (value: 'sine' | 'square' | 'sawtooth' | 'triangle'): 0 | 1 | 2 | 3 =>
  value === 'square' ? 1 : value === 'sawtooth' ? 2 : value === 'triangle' ? 3 : 0

const filterMode = (value: 'lowpass' | 'highpass' | 'bandpass' | 'notch'): 0 | 1 =>
  value === 'highpass' ? 1 : 0

/** Compiles the browser synth profile into the fixed portable synth ABI. */
export const compilePortableSynthConfiguration = (
  nodeId: string,
  instanceId: string,
  input: SynthParamsInput,
): PortableSynthConfiguration => {
  const params = normalizeSynthParams(input)
  const state: AudioCoreSynthState = {
    version: audioCoreContractVersion,
    kind: 'synth',
    voiceCapacity: Math.min(32, params.polyphony),
    outputLayout: 'stereo',
    parameterTargets: synthParameterRegistry
      .filter((entry) => !entry.tombstone)
      .map(({ id, target }) => ({ id, target })),
    oscillators: params.oscillators.map((oscillator) => ({
      enabled: oscillator.enabled,
      waveform: waveform(oscillator.wave),
      level: oscillator.level,
      octave: oscillator.octave,
      semitone: oscillator.semitone,
      detuneCents: oscillator.detuneCents,
    })),
    noiseEnabled: params.noise.enabled,
    noiseLevel: params.noise.level,
    filterEnabled: params.filter.enabled,
    filterMode: filterMode(params.filter.mode),
    filterCutoffHz: params.filter.frequencyHz,
    filterResonance: params.filter.q,
    filterKeyTracking: params.filter.keyTracking,
    filterEnvelopeAmountOctaves: params.filter.envelopeAmountOctaves,
    filterAttackMs: params.filter.envelope.attackSec * 1000,
    filterDecayMs: params.filter.envelope.decaySec * 1000,
    filterSustain: params.filter.envelope.sustain,
    filterReleaseMs: params.filter.envelope.releaseSec * 1000,
    ampAttackMs: params.ampEnvelope.attackSec * 1000,
    ampDecayMs: params.ampEnvelope.decaySec * 1000,
    ampSustain: params.ampEnvelope.sustain,
    ampReleaseMs: params.ampEnvelope.releaseSec * 1000,
    lfoEnabled: params.lfo.enabled,
    lfoWaveform: waveform(params.lfo.wave),
    lfoRateHz: params.lfo.frequencyHz,
    lfoPitchCents: params.lfo.pitchCents,
    lfoFilterOctaves: params.lfo.filterOctaves,
    lfoAmplitude: params.lfo.amp,
    lfoPan: params.lfo.pan,
    outputGain: params.gain,
    outputPan: params.pan,
  }
  return {
    nodeId,
    instanceId,
    state,
    values: state,
  }
}

type PortableSampledConfiguration =
  | PortableSamplerConfiguration
  | PortableDrumRackConfiguration
  | PortableGranularConfiguration

const compileSampledInstrument = (
  trackId: string,
  instrument: Exclude<NonNullable<NonNullable<ExportFx['trackFx']>[string]['instrument']>, { kind: 'synth' }>,
  assetRegistry: PortableAssetRegistryInput | undefined,
): { configuration: PortableSampledConfiguration } | { reason: string } => {
  try {
    if (instrument.kind === 'sampler') {
      return { configuration: compilePortableSamplerConfiguration(trackId, instrument.instanceId, instrument.params, assetRegistry) }
    }
    if (instrument.kind === 'drum-rack') {
      return { configuration: compilePortableDrumRackConfiguration(trackId, instrument.instanceId, instrument.params, assetRegistry) }
    }
    return { configuration: compilePortableGranularConfiguration(trackId, instrument.instanceId, instrument.params, assetRegistry) }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : 'portable instrument compilation failed.' }
  }
}

const mixerState = (id: string, gain: number, muted: boolean, soloed: boolean): AudioCoreMixerState => ({
  instanceId: id.split('').reduce((hash, character) => (Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0), 2166136261) || 1,
  gain,
  pan: 0,
  muted,
  soloed,
  parameterTargets: [
    { id: 'mixer.gain', target: 26, minValue: 0, maxValue: 4 },
    { id: 'mixer.pan', target: 27, minValue: -1, maxValue: 1 },
    { id: 'mixer.mute', target: 28, minValue: 0, maxValue: 1 },
    { id: 'mixer.solo', target: 29, minValue: 0, maxValue: 1 },
  ],
})

export const compilePortableSessionInput = (input: PortableSessionCompilerInput) => {
  const assets = input.assetRegistry
    ? indexPortableAssets(input.assetRegistry)
    : { assets: new Map<string, PortableAssetRegistryEntry>(), errors: [] }
  const sampled = Object.entries(input.fx.trackFx ?? {}).flatMap(([trackId, fx]) => {
    const instrument = fx.instrument
    return !instrument || instrument.kind === 'synth' ? [] : [{ trackId, ...compileSampledInstrument(trackId, instrument, input.assetRegistry) }]
  })
  const sampledConfigurations = sampled.flatMap((entry) => 'configuration' in entry ? [entry.configuration] : [])
  const unsupportedInstruments = [
    ...sampled.flatMap((entry) => 'reason' in entry ? [`${entry.trackId}: ${entry.reason}`] : []),
    ...assets.errors.filter((error) => !sampled.some((entry) => 'reason' in entry && entry.reason === error)),
  ]
  return {
    portableAssets: [...assets.assets.values()],
    mixers: input.mixer.channels.map((entry) => mixerState(
      `mixer:${entry.channel.id}`, entry.gain, entry.channel.muted, entry.channel.soloed,
    )),
    synths: Object.entries(input.fx.trackFx ?? {}).flatMap(([trackId, fx]) => {
      const instrument = fx.instrument
      if (instrument?.kind === 'synth') return [compilePortableSynthConfiguration(trackId, instrument.instanceId, instrument.params)]
      return fx.synth === undefined ? [] : [compilePortableSynthConfiguration(trackId, `legacy-synth:${trackId}`, fx.synth)]
    }),
    samplers: sampledConfigurations.flatMap((configuration) => configuration.state.kind === 'sampler' ? [configuration] : []),
    drumRacks: sampledConfigurations.flatMap((configuration) => configuration.state.kind === 'drum-rack' ? [configuration] : []),
    granulars: sampledConfigurations.flatMap((configuration) => configuration.state.kind === 'granular' ? [configuration] : []),
    unsupportedInstruments,
    synthAutomation: input.automationEnvelopes.flatMap((envelope) => {
    const target = parseSynthAutomationKey(envelope.parameterId)
    return target === undefined || !envelope.enabled ? [] : [{ trackId: target.trackId, instanceId: target.instanceId, parameterId: target.parameterId, points: envelope.points }]
    }),
  }
}

export type PreparedPortableSession =
  | {
    supported: true
    graph: AudioCoreGraphSnapshot
    schedule: PortableFrameSchedule
    assets: readonly PortableAssetRegistryEntry[]
    instruments: readonly (
      | PortableSynthConfiguration
      | PortableSamplerConfiguration
      | PortableDrumRackConfiguration
      | PortableGranularConfiguration
    )[]
  }
  | {
    supported: false
    reasons: readonly string[]
  }

export type PreparedPortableSessionInput = PortableSessionCompilerInput & {
  revision: number
  sampleRateHz: number
  bpm: number
  sidechainRoutes: readonly ExternalSidechainRoute[]
  schedule: PortableFrameSchedule
  assetRegistry: PortableAssetRegistryInput
}

type PortableInstrumentConfiguration = Exclude<PreparedPortableSession, { supported: false }>['instruments'][number]

const assetRefs = (assets: readonly PortableAssetRegistryEntry[]): AudioAssetRef[] => assets.map((asset) => ({
  version: audioCoreContractVersion,
  assetId: asset.portableAssetId,
  frameCount: asset.decoded.frameCount,
  sampleRateHz: asset.decoded.sampleRateHz,
  channelCount: asset.decoded.channelCount,
}))

const unsupported = (reasons: readonly string[]): PreparedPortableSession => ({
  supported: false,
  reasons,
})

export const instrumentConfigurations = (
  compilation: ReturnType<typeof compilePortableSessionInput>,
): readonly PortableInstrumentConfiguration[] => [
  ...compilation.synths,
  ...compilation.samplers,
  ...compilation.drumRacks,
  ...compilation.granulars,
]

export const graphWithInstruments = (
  graph: AudioCoreGraphSnapshot,
  instruments: readonly PortableInstrumentConfiguration[],
): { graph?: AudioCoreGraphSnapshot; reasons: readonly string[] } => {
  const byNodeId = new Map<string, PortableInstrumentConfiguration>()
  const reasons: string[] = []
  for (const instrument of instruments) {
    if (byNodeId.has(instrument.nodeId)) reasons.push(`${instrument.nodeId}: multiple portable instruments target the same mixer node.`)
    byNodeId.set(instrument.nodeId, instrument)
  }
  const nodes = graph.nodes.map((node) => {
    const instrument = byNodeId.get(node.id)
    if (!instrument) return node
    if (node.kind !== 'source') {
      reasons.push(`${node.id}: portable instruments require a source mixer node.`)
      return node
    }
    if (node.inputLayout !== 'stereo' || node.outputLayout !== 'stereo') {
      reasons.push(`${node.id}: portable instruments require stereo mixer layouts.`)
      return node
    }
    const instrumentNode: AudioCoreGraphSnapshot['nodes'][number] = {
      ...node,
      kind: 'instrument',
      instrument: instrument.state,
    }
    return instrumentNode
  })
  for (const instrument of instruments) {
    if (!graph.nodes.some((node) => node.id === instrument.nodeId)) {
      reasons.push(`${instrument.nodeId}: portable instrument target is absent from the graph snapshot.`)
    }
  }
  return reasons.length > 0 ? { reasons } : { graph: { ...graph, nodes }, reasons: [] }
}

const targetReasons = (
  event: PortableFrameScheduleEvent,
  graph: AudioCoreGraphSnapshot,
): readonly string[] => {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const target = event.target
  const noteEvent = event.type === 'note-on' || event.type === 'note-off'
  if (noteEvent && target.kind !== 'instrument') {
    return ['Portable note events must target an instrument node.']
  }
  if (!noteEvent && target.kind !== 'parameter') {
    return ['Portable parameter events must target a mixer or processor parameter.']
  }
  if (target.kind === 'instrument') {
    const node = nodeById.get(target.trackId)
    return node?.kind === 'instrument' && node.instrument
      ? []
      : [`${target.trackId}: scheduled note targets no portable instrument.`]
  }
  const nodeId = target.scope === 'master' ? graph.masterNodeId : target.trackId
  const node = nodeId === undefined ? undefined : nodeById.get(nodeId)
  if (!node) return [`${nodeId ?? 'unknown'}: scheduled parameter targets no graph node.`]
  if (target.effectInstanceId) {
    const processor = node.processorOrder.find((candidate) => candidate.id === target.effectInstanceId)
    return processor?.parameterTargets.some((parameter) => parameter.id === target.parameterId)
      ? []
      : [`${target.effectInstanceId}: scheduled parameter "${target.parameterId}" is not portable.`]
  }
  return node.mixer?.parameterTargets.some((parameter) => parameter.id === target.parameterId)
    ? []
    : [`${node.id}: scheduled mixer parameter "${target.parameterId}" is not portable.`]
}

const capabilityReasons = (
  graph: AudioCoreGraphSnapshot,
  schedule: PortableFrameSchedule,
): readonly string[] => {
  const reasons: string[] = []
  if (!portableWasmCapabilityMatrix.sampleRatesHz.includes(schedule.sampleRateHz)) {
    reasons.push(`The portable core does not support ${schedule.sampleRateHz} Hz.`)
  }
  if (graph.nodes.length > portableWasmMaxGraphNodes) reasons.push('The portable graph exceeds the node capacity.')
  if (graph.edges.length > portableWasmMaxGraphEdges) reasons.push('The portable graph exceeds the edge capacity.')
  if (graph.assets.length > portableWasmMaxAssets) reasons.push('The portable graph exceeds the asset capacity.')
  for (const node of graph.nodes) {
    for (const processor of node.processorOrder) {
      if (!portableWasmCapabilityMatrix.processorKinds.includes(processor.kind)) {
        reasons.push(`${processor.id}: processor "${processor.kind}" is not fixture-proven for portable sessions.`)
      }
    }
    if (node.instrument?.kind !== undefined && node.instrument.kind !== 'synth' && !portableWasmCapabilityMatrix.sampledInstruments) {
      reasons.push(`${node.id}: sampled instruments are not fixture-proven for portable sessions.`)
    }
  }
  if (graph.edges.some((edge) => edge.sidechain) && !portableWasmCapabilityMatrix.sidechains) {
    reasons.push('Portable sidechains are not fixture-proven.')
  }
  for (const event of schedule.events) {
    reasons.push(...targetReasons(event, graph))
    if (event.target.kind === 'instrument') {
      const instrument = graph.nodes.find((node) => node.id === event.target.trackId)?.instrument
      if (instrument?.kind === 'synth' && !portableWasmCapabilityMatrix.synthMidi) {
        reasons.push(`${event.target.trackId}: synth MIDI is not fixture-proven.`)
      }
      if (instrument !== undefined && instrument.kind !== 'synth' && !portableWasmCapabilityMatrix.sampledInstruments) {
        reasons.push(`${event.target.trackId}: sampled instrument MIDI is not fixture-proven.`)
      }
    } else if (event.target.effectInstanceId) {
      if (!portableWasmCapabilityMatrix.processorEvents || !portableWasmCapabilityMatrix.fullBlockAutomation) {
        reasons.push('Portable processor automation is not fixture-proven.')
      }
    } else if (!portableWasmCapabilityMatrix.mixerAutomation || !portableWasmCapabilityMatrix.fullBlockAutomation) {
      reasons.push('Portable mixer automation is not fixture-proven.')
    }
  }
  return reasons
}

/**
 * Produces the single immutable session payload that a future portable
 * runtime can prepare atomically. Routing stays wholly inside the canonical
 * graph projection; this compiler only joins validated portable state to it.
 */
export const compilePreparedPortableSession = (
  input: PreparedPortableSessionInput,
): PreparedPortableSession => {
  try {
    assertPortableFrameSchedule(input.schedule)
  } catch (error) {
    return unsupported([error instanceof Error ? error.message : 'Portable frame schedule is invalid.'])
  }
  if (input.schedule.revision !== input.revision
    || input.schedule.sampleRateHz !== input.sampleRateHz
    || input.schedule.bpm !== input.bpm) {
    return unsupported(['Portable graph and frame schedule identities do not match.'])
  }
  const compilation = compilePortableSessionInput(input)
  if (compilation.unsupportedInstruments.length > 0) return unsupported(compilation.unsupportedInstruments)
  const assets = compilation.portableAssets
  let graph: AudioCoreGraphSnapshot
  try {
    graph = createPortableGraphSnapshot({
      graph: input.mixer,
      revision: input.revision,
      sampleRate: input.sampleRateHz,
      bpm: input.bpm,
      assets: assetRefs(assets),
      sidechainRoutes: input.sidechainRoutes,
    })
  } catch (error) {
    return unsupported([error instanceof Error ? error.message : 'Portable graph projection failed.'])
  }
  const instruments = instrumentConfigurations(compilation)
  const withInstruments = graphWithInstruments(graph, instruments)
  if (!withInstruments.graph) return unsupported(withInstruments.reasons)
  graph = withInstruments.graph
  const reasons = capabilityReasons(graph, input.schedule)
  if (reasons.length > 0) return unsupported(reasons)
  if (parsePortableWasmControlMessage({
    version: 1,
    type: 'prepare-graph',
    requestId: 1,
    snapshot: graph,
  }) === null) {
    return unsupported(['Portable graph snapshot does not satisfy the portable protocol.'])
  }
  return { supported: true, graph, schedule: input.schedule, assets, instruments }
}
