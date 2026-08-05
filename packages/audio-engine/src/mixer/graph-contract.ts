import {
  audioCoreContractVersion,
  encodeAutoPanProcessorState,
  encodeAutoFilterProcessorState,
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
  type AudioAssetRef,
  type AudioCoreGraphProcessorDto,
  type AudioCoreGraphSnapshot,
  type AudioCoreMixerState,
  type AudioCoreInstrumentState,
} from '../../../audio-core-contract/src/index'
import { portableGraphContractHash } from '../../../audio-core-contract/src/generated/processor-contract-metadata'
import { createEqBandParameterId, normalizeDelayParams, normalizeLoFiParamsEnvelope, normalizeReverbParams } from '@daw-browser/shared'
import { getEffectChainTiming, getEffectTiming } from '../effects/timing'
import { compilePortableSynthConfiguration } from '../portable-session-compiler'
import { getMixerChannelRole } from './channels'
import {
  MASTER_ROUTE_TARGET,
  mixerRouteKey,
  resolveMixerTiming,
  type ExternalNodeLatencyFrames,
} from './resolve-timing'
import type { ResolvedMixerGraph } from './types'
import type { ExternalSidechainRoute } from '@daw-browser/timeline-core/types'

type MixerRoutingPlan = {
  channels: readonly {
    channelId: string
    gain: number
    outputGain: number
    outputTargetId?: string
    sends: readonly { targetId: string; amount: number; tap: 'pre-fx' | 'pre-fader' | 'post-fader' }[]
  }[]
  masterVolume: number
}

export const createMixerRoutingPlan = (graph: ResolvedMixerGraph): MixerRoutingPlan => ({
  channels: graph.channels.map((entry) => ({
    channelId: entry.channel.id,
    gain: entry.gain,
    outputGain: entry.outputGain,
    outputTargetId: entry.outputTargetId,
    sends: entry.sends.map((send) => ({
      targetId: send.targetId,
      amount: send.amount,
      tap: send.tap ?? 'post-fader',
    })),
  })),
  masterVolume: graph.master.volume,
})

type CreatePortableGraphSnapshotOptions = {
  graph: ResolvedMixerGraph
  revision: number
  sampleRate: number
  bpm?: number
  assets?: readonly AudioAssetRef[]
  sidechainRoutes?: readonly ExternalSidechainRoute[]
  includeInstruments?: boolean
  externalLatencyFrames?: ExternalNodeLatencyFrames
}

const toPortableNodeKind = (
  channel: Pick<ResolvedMixerGraph['channels'][number]['channel'], 'kind' | 'role'>,
  includeInstruments: boolean,
) => {
  if (includeInstruments && channel.kind === 'instrument' && getMixerChannelRole(channel) === 'track') {
    return 'instrument' as const
  }
  const role = getMixerChannelRole(channel)
  if (role === 'group' || role === 'return') return role
  return 'source' as const
}

const processorInstanceId = (id: string) => {
  let value = 2166136261
  for (const character of id) value = Math.imul(value ^ character.charCodeAt(0), 16777619)
  return (value >>> 0) || 1
}

const EQ_BAND_PARAMETER_TARGET_BASE = 45
const EQ_BAND_PARAMETER_TARGET_STRIDE = 3
const eqBandParameterTarget = (bandIndex: number, propertyOffset: number) =>
  EQ_BAND_PARAMETER_TARGET_BASE + bandIndex * EQ_BAND_PARAMETER_TARGET_STRIDE + propertyOffset

const toPortableMixerState = (
  id: string,
  gain: number,
  muted: boolean,
): AudioCoreMixerState => ({
  instanceId: processorInstanceId(`mixer:${id}`),
  gain,
  pan: 0,
  muted,
  // Static solo topology is already resolved by resolveMixerGraph.outputGain
  // and active sends. Only explicit mixer.solo automation may affect playback.
  soloed: false,
  parameterTargets: [
    { id: 'mixer.gain', target: 26, minValue: 0, maxValue: 4 },
    { id: 'mixer.pan', target: 27, minValue: -1, maxValue: 1 },
    { id: 'mixer.mute', target: 28, minValue: 0, maxValue: 1 },
    { id: 'mixer.solo', target: 29, minValue: 0, maxValue: 1 },
  ],
})

const toPortableInstrument = (
  instrument: NonNullable<NonNullable<ResolvedMixerGraph['channels'][number]['fx']>['instrument']>,
): AudioCoreInstrumentState => {
  if (instrument.kind !== 'synth') {
    throw new Error(`Native instrument "${instrument.kind}" is not supported by the portable graph.`)
  }
  return compilePortableSynthConfiguration(
    instrument.instanceId,
    instrument.instanceId,
    instrument.params,
  ).state
}

export const resolvePortableDelayMs = (
  params: ReturnType<typeof normalizeDelayParams>,
  bpm: number,
) => {
  if (params.mode === 'time') return params.timeMs
  const beats = params.syncDivision === '1/16' ? 0.25
    : params.syncDivision === '1/8' ? 0.5
      : params.syncDivision === '1/4' ? 1
        : params.syncDivision === '1/2' ? 2
          : 4
  return Math.min(3_000, beats * 60_000 / Math.max(1, bpm))
}

const toPortableProcessor = (
  instance: ResolvedMixerGraph['master']['instances'][number],
  sampleRate: number,
  bpm: number,
): AudioCoreGraphProcessorDto => {
  const timing = getEffectTiming(instance, sampleRate, bpm)
  const common: Pick<AudioCoreGraphProcessorDto, 'id' | 'instanceId' | 'stateVersion' | 'latencyFrames' | 'tailFrames'> = {
    id: instance.id,
    instanceId: processorInstanceId(instance.id),
    stateVersion: audioCoreContractVersion,
    latencyFrames: timing.latencyFrames,
    tailFrames: timing.tail.kind === 'finite' ? timing.tail.frames : 0,
    ...(timing.tail.kind === 'unbounded' ? { tailKind: 'unbounded' as const } : {}),
  }
  if (instance.kind === 'utility') {
    return {
      ...common,
      kind: 'utility',
      kindId: 1,
      state: encodeUtilityProcessorState(instance.params.state),
      parameterTargets: [
        { id: 'utility.gainDb', target: 1 },
        { id: 'utility.pan', target: 2 },
        { id: 'utility.balance', target: 3 },
        { id: 'utility.width', target: 4 },
      ],
      bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'autofilter') {
    const params = instance.params.state
    return {
      ...common, kind: 'autofilter', kindId: 16, state: encodeAutoFilterProcessorState(params),
      parameterTargets: [
        { id: 'autofilter.frequencyHz', target: 30 },
        { id: 'autofilter.resonance', target: 31 },
        { id: 'autofilter.driveDb', target: 32 },
        { id: 'autofilter.mix', target: 33 },
        { id: 'autofilter.envelope.amountOctaves', target: 34 },
        { id: 'autofilter.envelope.attackMs', target: 35 },
        { id: 'autofilter.envelope.releaseMs', target: 36 },
        { id: 'autofilter.lfo.rateHz', target: 37 },
        { id: 'autofilter.lfo.depthOctaves', target: 38 },
        { id: 'autofilter.lfo.phaseOffset', target: 39 },
        { id: 'autofilter.lfo.stereoPhase', target: 40 },
      ],
      bypassed: !params.enabled,
    }
  }
  if (instance.kind === 'saturator') {
    return {
      ...common,
      kind: 'saturator',
      kindId: 2,
      state: encodeSaturatorProcessorState(instance.params),
      parameterTargets: [],
      bypassed: !instance.params.enabled,
    }
  }
  if (instance.kind === 'eq') {
    return {
      ...common,
      kind: 'eq',
      kindId: 3,
      state: encodeEqProcessorState({
        enabled: instance.params.enabled,
        channelMode: instance.params.channelMode,
        bands: instance.params.bands.map((band) => ({
          enabled: band.enabled,
          type: band.type,
          frequency: band.frequency,
          gainDb: band.gainDb,
          q: band.q,
        })),
      }),
      parameterTargets: instance.params.bands.flatMap((band, index) => [
        { id: createEqBandParameterId(band.id, 'frequencyHz'), target: eqBandParameterTarget(index, 0) },
        { id: createEqBandParameterId(band.id, 'gainDb'), target: eqBandParameterTarget(index, 1) },
        { id: createEqBandParameterId(band.id, 'q'), target: eqBandParameterTarget(index, 2) },
      ]),
      bypassed: !instance.params.enabled,
    }
  }
  if (instance.kind === 'chorus' || instance.kind === 'flanger') {
    const kindId = instance.kind === 'chorus' ? 4 : 5
    return {
      ...common,
      kind: instance.kind,
      kindId,
      state: instance.kind === 'chorus'
        ? encodeChorusProcessorState(instance.params.state)
        : encodeFlangerProcessorState(instance.params.state),
      parameterTargets: [],
      bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'phaser') {
    return {
      ...common, kind: 'phaser', kindId: 6, state: encodePhaserProcessorState(instance.params.state),
      parameterTargets: [], bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'tremolo' || instance.kind === 'autopan') {
    const kindId = instance.kind === 'tremolo' ? 7 : 8
    return {
      ...common, kind: instance.kind, kindId,
      state: instance.kind === 'tremolo'
        ? encodeTremoloProcessorState(instance.params.state)
        : encodeAutoPanProcessorState(instance.params.state),
      parameterTargets: [], bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'ensemble') {
    return {
      ...common, kind: 'ensemble', kindId: 9, state: encodeEnsembleProcessorState(instance.params.state),
      parameterTargets: [], bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'gate') {
    return {
      ...common, kind: 'gate', kindId: 10, state: encodeGateProcessorState(instance.params.state),
      parameterTargets: [], bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'compressor') {
    const state = instance.params.enabled
      ? instance.params
      : { ...instance.params, makeupDb: 0, outputDb: 0 }
    return {
      ...common, kind: 'compressor', kindId: 11, state: encodeCompressorProcessorState(state),
      parameterTargets: [], bypassed: !instance.params.enabled,
    }
  }
  if (instance.kind === 'limiter') {
    return {
      ...common, kind: 'limiter', kindId: 12, state: encodeLimiterProcessorState(instance.params.state),
      parameterTargets: [], bypassed: !instance.params.state.enabled,
    }
  }
  if (instance.kind === 'lofi') {
    const params = normalizeLoFiParamsEnvelope(instance.params).state
    return {
      ...common, kind: 'lofi', kindId: 17, state: encodeLoFiProcessorState(params),
      parameterTargets: [
        { id: 'lofi.sampleRateRatio', target: 41 },
        { id: 'lofi.jitter', target: 42 },
        { id: 'lofi.noiseDb', target: 43 },
        { id: 'lofi.mix', target: 44 },
      ],
      bypassed: !params.enabled,
    }
  }
  if (instance.kind === 'delay') {
    const params = normalizeDelayParams(instance.params)
    return {
      ...common, kind: 'delay', kindId: 13, state: encodeDelayProcessorState({
        enabled: params.enabled,
        delayMs: resolvePortableDelayMs(params, bpm),
        feedback: params.feedback,
        dryWet: params.dryWet,
        pingPong: params.pingPong,
        filterEnabled: params.filterEnabled,
        lowCutHz: params.lowCutHz,
        highCutHz: params.highCutHz,
      }),
      parameterTargets: [
        { id: 'delay.timeMs', target: 5 },
        { id: 'delay.feedback', target: 6 },
        { id: 'delay.dryWet', target: 7 },
        { id: 'delay.lowCutHz', target: 8 },
        { id: 'delay.highCutHz', target: 9 },
      ],
      bypassed: !params.enabled,
    }
  }
  if (instance.kind === 'reverb') {
    const params = normalizeReverbParams(instance.params)
    return {
      ...common, kind: 'reverb', kindId: 14, state: encodeReverbProcessorState(params),
      parameterTargets: [
        { id: 'reverb.wet', target: 10 },
        { id: 'reverb.preDelayMs', target: 11 },
        { id: 'reverb.lowCutHz', target: 12 },
        { id: 'reverb.highCutHz', target: 13 },
        { id: 'reverb.stereoWidth', target: 14 },
      ],
      bypassed: !params.enabled,
    }
  }
  if (instance.kind === 'spectral') {
    const params = instance.params.state
    return {
      ...common, kind: 'spectral', kindId: 15, state: encodeSpectralProcessorState(params),
      parameterTargets: [
        { id: 'spectral.freeze', target: 15 },
        { id: 'spectral.gateThresholdDb', target: 16 },
        { id: 'spectral.gateAttackMs', target: 17 },
        { id: 'spectral.gateReleaseMs', target: 18 },
        { id: 'spectral.morph', target: 19 },
        { id: 'spectral.binShift', target: 20 },
        { id: 'spectral.blur', target: 21 },
        { id: 'spectral.harmonicPercussiveBalance', target: 22 },
        { id: 'spectral.noiseReduction', target: 23 },
        { id: 'spectral.profileLearn', target: 24 },
        { id: 'spectral.mix', target: 25 },
      ],
      bypassed: !params.enabled,
    }
  }
  throw new Error('Portable processor is not implemented.')
}

/**
 * A transport-only projection: project routing and timing remain owned by
 * resolve-routing.ts and resolve-timing.ts. The portable core receives only
 * stable topology, declared latency, and already-normalized layouts.
 */
export const createPortableGraphSnapshot = ({
  graph,
  revision,
  sampleRate,
  bpm = 120,
  assets = [],
  sidechainRoutes = [],
  includeInstruments = false,
  externalLatencyFrames = new Map(),
}: CreatePortableGraphSnapshotOptions): AudioCoreGraphSnapshot => {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error('Portable graph revisions must be positive safe integers.')
  const timing = resolveMixerTiming(graph, sampleRate, bpm, externalLatencyFrames)
  const nodes = graph.channels.map((entry) => {
    return {
      id: entry.channel.id,
      kind: toPortableNodeKind(entry.channel, includeInstruments),
      inputLayout: entry.inputLayout,
      outputLayout: entry.outputLayout,
      processorOrder: (entry.fx?.instances ?? []).map((instance) => toPortableProcessor(instance, sampleRate, bpm)),
      ...(externalLatencyFrames.has(entry.channel.id)
        ? { externalLatencyFrames: externalLatencyFrames.get(entry.channel.id) ?? 0 }
        : {}),
      latencyFrames: getEffectChainTiming(entry.fx?.instances ?? [], sampleRate, bpm).latencyFrames,
      ...(includeInstruments && entry.channel.kind === 'instrument' && entry.fx?.instrument
        ? { instrument: toPortableInstrument(entry.fx.instrument) }
        : {}),
      mixer: toPortableMixerState(entry.channel.id, entry.gain, !!entry.channel.muted),
    }
  })
  const edges: AudioCoreGraphSnapshot['edges'][number][] = []
  for (const entry of graph.channels) {
    const outputTargetId = entry.outputTargetId ?? MASTER_ROUTE_TARGET
    edges.push({
      version: audioCoreContractVersion,
      id: mixerRouteKey(entry.channel.id, outputTargetId, 'output'),
      fromNodeId: entry.channel.id,
      toNodeId: outputTargetId,
      gain: entry.outputGain,
      kind: 'output' as const,
      tap: 'post-fader' as const,
      sidechain: false,
      pdcDelayFrames: timing.routeDelayFrames.get(mixerRouteKey(entry.channel.id, outputTargetId, 'output')) ?? 0,
    })
    for (const send of entry.sends) {
      edges.push({
        version: audioCoreContractVersion,
        id: mixerRouteKey(entry.channel.id, send.targetId, 'send', send.tap),
        fromNodeId: entry.channel.id,
        toNodeId: send.targetId,
        gain: send.amount,
        kind: 'send' as const,
        tap: send.tap ?? 'post-fader',
        sidechain: false,
        pdcDelayFrames: timing.routeDelayFrames.get(mixerRouteKey(entry.channel.id, send.targetId, 'send', send.tap)) ?? 0,
      })
    }
  }
  const channelIds = new Set(graph.channels.map((entry) => entry.channel.id))
  for (const route of sidechainRoutes) {
    if (!channelIds.has(route.sourceTrackId) || !channelIds.has(route.targetTrackId)) {
      throw new Error('Portable sidechain routes must reference resolved mixer channels.')
    }
    const target = graph.channels
      .find((entry) => entry.channel.id === route.targetTrackId)
      ?.fx?.instances.find((instance) => instance.id === route.effectInstanceId)
    if (target?.kind !== 'compressor' && target?.kind !== 'gate' && target?.kind !== 'spectral') {
      throw new Error(`Portable sidechain target "${route.effectInstanceId}" is not a supported detector processor.`)
    }
    if (target.kind === 'gate' && !target.params.state.sidechain.enabled) {
      throw new Error(`Portable Gate sidechain target "${route.effectInstanceId}" requires its detector filter to be enabled for legacy parity.`)
    }
    edges.push({
      version: audioCoreContractVersion,
      id: `sidechain:${JSON.stringify([route.sourceTrackId, route.targetTrackId, route.effectInstanceId])}`,
      fromNodeId: route.sourceTrackId,
      toNodeId: route.targetTrackId,
      gain: 1,
      kind: 'send',
      tap: 'post-fader',
      sidechain: true,
      targetProcessorId: route.effectInstanceId,
      pdcDelayFrames: 0,
    })
  }
  return {
    version: audioCoreContractVersion,
    revision,
    contractHash: portableGraphContractHash,
    nodes: [
      ...nodes,
      {
        id: MASTER_ROUTE_TARGET,
        kind: 'master',
        inputLayout: graph.master.inputLayout,
        outputLayout: graph.master.outputLayout,
        processorOrder: graph.master.instances.map((instance) => toPortableProcessor(instance, sampleRate, bpm)),
        latencyFrames: getEffectChainTiming(graph.master.instances, sampleRate, bpm).latencyFrames,
        mixer: toPortableMixerState(MASTER_ROUTE_TARGET, graph.master.volume, false),
      },
    ],
    edges,
    masterNodeId: MASTER_ROUTE_TARGET,
    assets,
  }
}
