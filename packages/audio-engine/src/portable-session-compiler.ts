import {
  audioCoreContractVersion,
  type AudioAssetRef,
  type AudioCoreGraphSnapshot,
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
  normalizeSamplerParams,
  MAX_SAMPLED_INSTRUMENT_VOICES,
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
  portableWasmMaxPendingEvents,
  parsePortableWasmControlMessage,
} from './portable-wasm-protocol'
import { portableWasmCapabilityMatrix } from './backends/portable-wasm-capabilities'
import type { ExportFx } from './export-types'
import { compilePortableSynthState, createPortableGraphSnapshot } from './mixer/graph-contract'
import type { ResolvedMixerGraph } from './mixer/types'
import type { ExternalSidechainRoute, Track } from '@daw-browser/timeline-core/types'
import {
  assertPortableFrameSchedule,
  type PortableFrameSchedule,
  type PortableFrameScheduleEvent,
} from './portable-frame-scheduling'
import {
  projectPortableClipEvents,
  type PortableProjectedSourceEvent,
} from './portable-clip-projector'
import type { PortablePreparedStretchAsset } from './portable-stretch-preparation'
import { resolveGraphProcessor } from './mixer/resolve-graph-processor'

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
  const asset = assetForSample(registry, zone.sample)
  const startFrame = frameAt(zone.startSec, asset.decoded.sampleRateHz)
  const endFrame = Math.min(
    asset.decoded.frameCount,
    frameAt(zone.endSec ?? zone.sample.source.durationSec, asset.decoded.sampleRateHz),
  )
  const loopStartFrame = zone.playbackMode !== 'one-shot'
    ? frameAt(zone.loopStartSec ?? zone.startSec, asset.decoded.sampleRateHz)
    : 0
  const loopEndFrame = zone.playbackMode !== 'one-shot'
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
    crossfadeFrameCount: zone.playbackMode === 'crossfade-loop'
      ? Math.min(
        frameAt(zone.crossfadeSec, asset.decoded.sampleRateHz),
        Math.floor((loopEndFrame - loopStartFrame) / 2),
      )
      : 0,
    chokeGroup: zone.chokeGroup,
  }
}

export const compilePortableSamplerConfiguration = (
  nodeId: string,
  instanceId: string,
  input: SamplerParams,
  registryInput: PortableAssetRegistryInput | undefined,
): PortableSamplerConfiguration => {
  const params = normalizeSamplerParams(input)
  const registry = indexPortableAssets(registryInput)
  if (params.zones.length > 0 && registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  if (params.zones.length > 32) throw new Error('Sampler exceeds the portable zone limit.')
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'sampler',
      voiceCapacity: Math.min(MAX_SAMPLED_INSTRUMENT_VOICES, params.polyphony),
      outputLayout: 'stereo',
      ampAttackMs: params.ampEnvelope.attackSec * 1000,
      ampDecayMs: params.ampEnvelope.decaySec * 1000,
      ampSustain: params.ampEnvelope.sustain,
      ampReleaseMs: params.ampEnvelope.releaseSec * 1000,
      filterEnabled: true,
      filterMode: params.filterMode,
      filterCutoffHz: params.filterFrequencyHz,
      filterResonance: params.filterQ,
      filterEnvelopeAmount: params.filterEnvelope.amount,
      filterAttackMs: params.filterEnvelope.attackSec * 1000,
      filterDecayMs: params.filterEnvelope.decaySec * 1000,
      filterSustain: params.filterEnvelope.sustain,
      filterReleaseMs: params.filterEnvelope.releaseSec * 1000,
      lfoEnabled: params.lfo.enabled,
      lfoRateHz: params.lfo.frequencyHz,
      lfoPitchCents: params.lfo.pitchCents,
      lfoFilterHz: params.lfo.filterHz,
      lfoAmplitude: params.lfo.amp,
      lfoPan: params.lfo.pan,
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
  const params = normalizeDrumRackParams(input)
  const registry = indexPortableAssets(registryInput)
  if (params.pads.some((pad) => pad.sample) && registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  const validatedPads = params.pads.flatMap((pad) => {
    if (!pad.sample) return []
    return [{ pad, sample: pad.sample, asset: assetForSample(registry, pad.sample) }]
  })
  const zones: AudioCoreSampleZone[] = validatedPads.flatMap(({ pad, sample, asset }) => {
    if (pad.mute) return []
    const startFrame = frameAt(pad.startSec, asset.decoded.sampleRateHz)
    const endFrame = Math.min(asset.decoded.frameCount, frameAt(pad.endSec ?? sample.source.durationSec, asset.decoded.sampleRateHz))
    if (endFrame <= startFrame) throw new Error(`${pad.id}: browser sample bounds resolve to an empty portable range.`)
    return [{
      assetId: asset.portableAssetId,
      keyLow: pad.note,
      keyHigh: pad.note,
      velocityLow: 1,
      velocityHigh: 127,
      rootNote: pad.note,
      tuneCents: pad.transpose * 100,
      gain: pad.gain,
      pan: pad.pan,
      roundRobinGroup: 0,
      roundRobinIndex: 0,
      playbackMode: 'one-shot',
      startFrame,
      endFrame,
      loopStartFrame: 0,
      loopEndFrame: 0,
      crossfadeFrameCount: 0,
      chokeGroup: pad.chokeGroup,
    }]
  })
  if (zones.length > 32) throw new Error('Drum rack exceeds the portable zone limit.')
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'drum-rack',
      voiceCapacity: MAX_SAMPLED_INSTRUMENT_VOICES,
      outputLayout: 'stereo',
      ampAttackMs: 0,
      ampDecayMs: 0,
      ampSustain: 1,
      ampReleaseMs: 6,
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
  const params = normalizeGranularParams(input)
  const registry = indexPortableAssets(registryInput)
  if (params.zone && registry.errors.length > 0) throw new Error(registry.errors.join(' '))
  const asset = params.zone ? assetForSample(registry, params.zone.sample) : undefined
  return {
    nodeId,
    instanceId,
    state: {
      version: audioCoreContractVersion,
      kind: 'granular',
      voiceCapacity: 2,
      outputLayout: 'stereo',
      assetId: asset?.portableAssetId ?? '',
      seed: params.seed,
      maxGrains: params.maxGrains,
      'windowShape': params['windowShape'],
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

/** Compiles the browser synth profile into the fixed portable synth ABI. */
export const compilePortableSynthConfiguration = (
  nodeId: string,
  instanceId: string,
  input: SynthParamsInput,
): PortableSynthConfiguration => {
  const state = compilePortableSynthState(input)
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

const mixerState = (id: string, gain: number, muted: boolean): AudioCoreMixerState => ({
  instanceId: id.split('').reduce((hash, character) => (Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0), 2166136261) || 1,
  gain,
  pan: 0,
  muted,
  soloed: false,
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
      `mixer:${entry.channel.id}`, entry.gain, entry.channel.muted,
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
    scheduleRange: {
      startFrame: number
      endFrame: number
    }
    assets: readonly AudioAssetRef[]
    sources: readonly PreparedPortableSource[]
    instruments: readonly (
      | PortableSynthConfiguration
      | PortableSamplerConfiguration
      | PortableDrumRackConfiguration
      | PortableGranularConfiguration
    )[]
    qualification: PortablePreparedQualification
  }
  | {
    supported: false
    reasons: readonly string[]
  }

export type PreparedPortableSessionInput = PortableSessionCompilerInput & {
  tracks: readonly Track[]
  revision: number
  sampleRateHz: number
  bpm: number
  sidechainRoutes: readonly ExternalSidechainRoute[]
  schedule: PortableFrameSchedule
  assetRegistry: PortableAssetRegistryInput
  preparedStretchAssets?: ReadonlyMap<string, PortablePreparedStretchAsset>
  sourceRangeEndSec: number
  sourceFirstSequence: number
}

type PortableInstrumentConfiguration = Exclude<PreparedPortableSession, { supported: false }>['instruments'][number]

export type PreparedPortableSource = PortableProjectedSourceEvent & {
  sourceIdentity: string
}

export type PortablePreparedQualification = {
  processorKinds: readonly string[]
  trackCount: number
  hasClips: boolean
  hasRouting: boolean
  hasAutomation: boolean
  hasExternalPlugins: boolean
  sampleRateHz: number
  inputBusCount: number
  channelCount: number
  hasSynthMidi: boolean
}

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
  if (!noteEvent && target.kind === 'parameter' && (
    target.parameterId.startsWith('synth-instrument:')
    || target.parameterId.startsWith('instrument:')
  )) {
    return [`${target.trackId}: scheduled instrument parameter "${target.parameterId}" is not portable.`]
  }
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
    const processor = resolveGraphProcessor(graph, target.effectInstanceId, node.id)
    return processor?.parameterTargets.has(target.parameterId)
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
  const reverbCount = graph.nodes.reduce((count, node) => count + [
    ...node.processorOrder,
  ].filter((processor) => processor.kind === 'reverb').length, 0)
  if (reverbCount > portableWasmCapabilityMatrix.maxReverbProcessors) {
    reasons.push(`The portable graph exceeds the ${portableWasmCapabilityMatrix.maxReverbProcessors}-Reverb processor capacity.`)
  }
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

const sourceFrameRange = (schedule: PortableFrameSchedule, rangeEndSec: number) => ({
  startFrame: schedule.timeOrigin.frame,
  endFrame: schedule.timeOrigin.frame + Math.round((rangeEndSec - schedule.timeOrigin.timelineSec) * schedule.sampleRateHz),
})

type PreparedPortableSources = {
  sources?: readonly PreparedPortableSource[]
  reasons: readonly string[]
}

const prepareSources = (
  input: PreparedPortableSessionInput,
  assets: readonly AudioAssetRef[],
  graph: AudioCoreGraphSnapshot,
): PreparedPortableSources => {
  if (!positiveSafeInteger(input.sourceFirstSequence)) {
    return { reasons: ['Portable source event sequence namespace is invalid.'] }
  }
  if (!Number.isFinite(input.sourceRangeEndSec) || input.sourceRangeEndSec <= input.schedule.timeOrigin.timelineSec) {
    return { reasons: ['Portable source scheduling range is invalid.'] }
  }
  const projection = projectPortableClipEvents({
    tracks: input.tracks,
    assets: new Map<string, AudioAssetRef>(
      input.assetRegistry.assets.map((asset) => [asset.projectAssetId, {
        version: audioCoreContractVersion,
        assetId: asset.portableAssetId,
        frameCount: asset.decoded.frameCount,
        sampleRateHz: asset.decoded.sampleRateHz,
        channelCount: asset.decoded.channelCount,
      }]),
    ),
    preparedStretchAssets: input.preparedStretchAssets,
    projectGeneration: input.assetRegistry.projectGeneration,
    bpm: input.bpm,
    sampleRateHz: input.sampleRateHz,
    rangeStartSec: input.schedule.timeOrigin.timelineSec,
    rangeEndSec: input.sourceRangeEndSec,
    epoch: input.schedule.transportEpoch,
    firstSequence: input.sourceFirstSequence,
    includeStableIdentity: true,
    allowInstruments: true,
  })
  if (!projection.supported) return { reasons: [...projection.reasons] }
  const frameRange = sourceFrameRange(input.schedule, input.sourceRangeEndSec)
  if (!Number.isSafeInteger(frameRange.endFrame) || frameRange.endFrame <= frameRange.startFrame) {
    return { reasons: ['Portable source scheduling range resolves to invalid frames.'] }
  }
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]))
  const identities = new Set<string>()
  const ordered = [...projection.events].sort((left, right) => (
    // Source ordering is canonical: timeline start frame, then the
    // project-domain track/clip identity. Source sequences are assigned only
    // after this ordering and never share the frame-schedule namespace.
    left.startFrame - right.startFrame
    || (left.sourceIdentity ?? '').localeCompare(right.sourceIdentity ?? '')
  ))
  if (ordered.length > 0
    && !Number.isSafeInteger(input.sourceFirstSequence + ordered.length - 1)) {
    return { reasons: ['Portable source event sequence namespace exceeds its safe integer range.'] }
  }
  const reasons: string[] = []
  const sources: PreparedPortableSource[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const event = ordered[index]
    if (!event) continue
    const identity = event.sourceIdentity
    if (!identity) {
      reasons.push('Portable source event is missing its stable identity.')
      continue
    }
    if (identities.has(identity)) {
      reasons.push(`${identity}: duplicate portable source identity.`)
      continue
    }
    identities.add(identity)
    const asset = assetById.get(event.assetId)
    if (!asset) {
      reasons.push(`${identity}: portable source asset "${event.assetId}" is absent from the asset manifest.`)
      continue
    }
    const sourceNode = graph.nodes.find((node) => node.id === event.sourceNodeId)
    if (!sourceNode || sourceNode.kind !== 'source') {
      reasons.push(`${identity}: portable source target "${event.sourceNodeId}" is absent from the graph snapshot.`)
      continue
    }
    if (event.epoch !== input.schedule.transportEpoch
      || event.startFrame < frameRange.startFrame
      || event.stopFrame <= event.startFrame
      || event.stopFrame > frameRange.endFrame
      || event.sourceOffsetFrame < 0
      || event.sourceOffsetFraction !== undefined && (
        !Number.isFinite(event.sourceOffsetFraction)
        || event.sourceOffsetFraction < 0
        || event.sourceOffsetFraction >= 1
      )
      || event.sourceFrameCount <= 0
      || event.sourceOffsetFrame + event.sourceFrameCount > asset.frameCount
      || event.fadeInStartFrame > event.fadeInEndFrame
      || event.fadeOutStartFrame > event.fadeOutEndFrame
      || !Number.isSafeInteger(event.fadeInStartFrame)
      || !Number.isSafeInteger(event.fadeInEndFrame)
      || !Number.isSafeInteger(event.fadeOutStartFrame)
      || !Number.isSafeInteger(event.fadeOutEndFrame)) {
      reasons.push(`${identity}: portable source event bounds or epoch are invalid.`)
      continue
    }
    sources.push({
      ...event,
      sourceIdentity: identity,
      sequence: input.sourceFirstSequence + index,
    })
  }
  if (sources.length > portableWasmMaxPendingEvents) {
    reasons.push(`Portable source schedule exceeds the ${portableWasmMaxPendingEvents}-event capacity.`)
  }
  return reasons.length > 0 ? { reasons } : { sources, reasons: [] }
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
  const assets = [
    ...assetRefs(compilation.portableAssets),
    ...(input.preparedStretchAssets
      ? [...input.preparedStretchAssets.values()].map((asset) => asset.asset)
      : []),
  ]
  let graph: AudioCoreGraphSnapshot
  try {
    graph = createPortableGraphSnapshot({
      graph: input.mixer,
      revision: input.revision,
      sampleRate: input.sampleRateHz,
      bpm: input.bpm,
      assets,
      sidechainRoutes: input.sidechainRoutes,
    })
  } catch (error) {
    return unsupported([error instanceof Error ? error.message : 'Portable graph projection failed.'])
  }
  const instruments = instrumentConfigurations(compilation)
  const withInstruments = graphWithInstruments(graph, instruments)
  if (!withInstruments.graph) return unsupported(withInstruments.reasons)
  graph = withInstruments.graph
  const sourceCompilation = prepareSources(input, assets, graph)
  if (!sourceCompilation.sources) return unsupported(sourceCompilation.reasons)
  const scheduleRange = sourceFrameRange(input.schedule, input.sourceRangeEndSec)
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
  const qualification: PortablePreparedQualification = {
    processorKinds: graph.nodes.flatMap((node) => [
      ...node.processorOrder,
    ].map((processor) => processor.kind)),
    trackCount: graph.nodes.length,
    hasClips: graph.assets.length > 0,
    hasRouting: graph.edges.length > 0,
    hasAutomation: input.schedule.events.length > 0,
    hasExternalPlugins: false,
    sampleRateHz: input.schedule.sampleRateHz,
    inputBusCount: 1,
    channelCount: 2,
    hasSynthMidi: input.schedule.events.some((event) => event.type === 'note-on' || event.type === 'note-off'),
  }
  return {
    supported: true,
    graph,
    schedule: input.schedule,
    scheduleRange,
    assets,
    sources: sourceCompilation.sources,
    instruments,
    qualification,
  }
}
