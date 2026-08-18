import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from './json-value'
import type {
  ArpeggiatorParams,
  AudioEffectKind,
  AudioEffectOrderItem,
  AutoFilterParamsEnvelope,
  AutoPanParamsEnvelope,
  ChorusParamsEnvelope,
  CompressorParams,
  CompressorParamsInput,
  DelayParams,
  DelayParamsInput,
  EqParams,
  EnsembleParamsEnvelope,
  FlangerParamsEnvelope,
  GateParamsEnvelope,
  LimiterParamsEnvelope,
  LoFiParamsEnvelope,
  PhaserParamsEnvelope,
  ReverbParamsInput,
  SaturatorParams,
  SaturatorParamsInput,
  TremoloParamsEnvelope,
  UtilityParamsEnvelope,
} from './effects-params'
import { parseStrictSynthParams, type SynthParams } from './synth-params'
import { normalizeLegacyMidiClip, normalizeMidiClip, type LegacyMidiClip, type MidiClip } from './midi'
import {
  isAudioEffectKind,
  isAudioEffectInstance,
  isCompressorDetectorMode,
  isCompressorDynamicsMode,
  isCompressorEnvelopeCurve,
  isCompressorSidechainFilterType,
  isDelayMode,
  isDelaySyncDivision,
  isEqBandType,
  isSaturatorCurve,
  normalizeCompressorParams,
  normalizeDelayParams,
  normalizeEqParams,
  AUDIO_EFFECT_CONTRACTS,
  normalizeSaturatorParams,
} from './effects-params'
import { normalizeSpectralParamsEnvelope, type SpectralParamsEnvelope } from './spectral-params'
import { normalizeAudioWarp, normalizeClipGain, type AudioWarpPayload } from './audio-warp'
import { normalizeClipColor, normalizeTrackColor } from './clip-color'
import { normalizeClipTimingPatch } from './clip-timing'
import { normalizeMasterVolume } from './master-volume'
import {
  normalizeTrackInstrumentParams,
  type TrackInstrumentParams,
} from './instrument-params'
import { automationTargetKey, type AutomationPoint } from './automation'
import {
  getAutomationParameterDescriptor,
  isAutomationParameterSupportedForTarget,
  normalizeAutomationPoints,
} from './automation-parameters'

export type MoveClipInput = {
  clipId: string
  trackId: string
  startSec: number
}

export type SharedClipFades = {
  fadeInStartSec: number
  fadeInSec: number
  fadeOutSec: number
  fadeOutEndSec: number
  fadeInCurve: number
  fadeOutCurve: number
  fadeInCurvePosition: number
  fadeOutCurvePosition: number
}

export type SharedClipFadesInput = Omit<SharedClipFades, 'fadeInStartSec' | 'fadeOutEndSec' | 'fadeInCurvePosition' | 'fadeOutCurvePosition'>
  & Partial<Pick<SharedClipFades, 'fadeInStartSec' | 'fadeOutEndSec' | 'fadeInCurvePosition' | 'fadeOutCurvePosition'>>

export type TrackRouting = {
  outputTargetId?: string
  sends?: Array<{ targetId: string; amount: number; tap?: 'pre-fx' | 'pre-fader' | 'post-fader' }>
}

export type SharedTimelineClipCreatePayload = {
  trackId: string
  startSec: number
  duration: number
  name?: string
  sampleUrl?: string
  assetKey?: string
  sourceKind?: string
  durationSec?: number
  sampleRate?: number
  channelCount?: number
  leftPadSec?: number
  bufferOffsetSec?: number
  audioWarp?: AudioWarpPayload
  gain?: number
  fades?: SharedClipFadesInput
  midiOffsetBeats?: number
  color?: string
  midi?: LegacyMidiClip
  clipKind?: string
  operationId?: string
}

type SharedReverbParams = Required<Pick<ReverbParamsInput, 'enabled' | 'wet' | 'decaySec' | 'preDelayMs'>> & Omit<ReverbParamsInput, 'enabled' | 'wet' | 'decaySec' | 'preDelayMs'>

export type SharedUngroupRestoreEffect = {
  type: AudioEffectKind | 'instrument' | 'synth' | 'arpeggiator'
  instanceId?: string
  index?: number
  params: JsonValue
}

export type SharedUngroupRestoreAutomation = {
  effectInstanceId?: string
  parameterId: string
  enabled: boolean
  points: AutomationPoint[]
  updatedAt: number
}

type SharedModulationEffectPayload =
  | { effect: 'autofilter'; instanceId: string; params: AutoFilterParamsEnvelope }
  | { effect: 'chorus'; instanceId: string; params: ChorusParamsEnvelope }
  | { effect: 'flanger'; instanceId: string; params: FlangerParamsEnvelope }
  | { effect: 'phaser'; instanceId: string; params: PhaserParamsEnvelope }
  | { effect: 'tremolo'; instanceId: string; params: TremoloParamsEnvelope }
  | { effect: 'autopan'; instanceId: string; params: AutoPanParamsEnvelope }
  | { effect: 'ensemble'; instanceId: string; params: EnsembleParamsEnvelope }
  | { effect: 'lofi'; instanceId: string; params: LoFiParamsEnvelope }

type SharedModulationEffectEnvelope =
  | { effect: 'autofilter'; params: AutoFilterParamsEnvelope }
  | { effect: 'chorus'; params: ChorusParamsEnvelope }
  | { effect: 'flanger'; params: FlangerParamsEnvelope }
  | { effect: 'phaser'; params: PhaserParamsEnvelope }
  | { effect: 'tremolo'; params: TremoloParamsEnvelope }
  | { effect: 'autopan'; params: AutoPanParamsEnvelope }
  | { effect: 'ensemble'; params: EnsembleParamsEnvelope }
  | { effect: 'lofi'; params: LoFiParamsEnvelope }

export type SharedTimelineOperation =
  | { kind: 'tracks.create'; payload: { name?: string; index?: number; kind?: string; channelRole?: string; collapsed?: boolean; color?: string; operationId?: string } }
  | { kind: 'tracks.lock'; payload: { trackId: string } }
  | { kind: 'tracks.unlock'; payload: { trackId: string } }
  | { kind: 'clips.create'; payload: SharedTimelineClipCreatePayload }
  | { kind: 'clips.createMany'; payload: { items: SharedTimelineClipCreatePayload[]; operationId?: string } }
  | { kind: 'clips.removeMany'; payload: { clipIds: string[]; operationId: string } }
  | { kind: 'clips.moveMany'; payload: { moves: MoveClipInput[] } }
  | { kind: 'clips.setTiming'; payload: { clipId: string; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number; fades?: SharedClipFades } }
  | { kind: 'clips.setTimingAndAudioWarp'; payload: { clipId: string; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number; audioWarp?: AudioWarpPayload; fades?: SharedClipFades } }
  | { kind: 'clips.setAudioWarp'; payload: { clipId: string; audioWarp: AudioWarpPayload } }
  | { kind: 'clips.setGain'; payload: { clipId: string; gain: number } }
  | { kind: 'clips.setFades'; payload: { clipId: string; fades: SharedClipFades } }
  | { kind: 'clips.setColor'; payload: { clipId: string; color: string } }
  | { kind: 'clips.setMidi'; payload: { clipId: string; midi: MidiClip; operationId: string } }
  | { kind: 'clips.setMidiAndTiming'; payload: { clipId: string; startSec: number; duration: number; midi: MidiClip; operationId: string } }
  | { kind: 'tracks.setRouting'; payload: { trackId: string; routing: TrackRouting } }
  | { kind: 'sidechains.setRoute'; payload: { projectId: string; sourceTrackId: string; targetTrackId: string; effectInstanceId: string } }
  | { kind: 'sidechains.removeRoute'; payload: { projectId: string; targetTrackId: string; effectInstanceId: string } }
  | { kind: 'tracks.setGroup'; payload: { trackId: string; groupId?: string | null } }
  | { kind: 'tracks.reorderAndGroup'; payload: { updates: Array<{ trackId: string; index: number; groupId?: string | null; outputTargetId?: string | null }> } }
  | { kind: 'tracks.ungroup'; payload: { groupId: string; operationId?: string } }
  | {
      kind: 'tracks.restoreUngroup'
      payload: {
        group: {
          name?: string
          index: number
          kind?: string
          historyRef?: string
          parentGroupId?: string
          collapsed?: boolean
          color?: string
          volume: number
          muted?: boolean
          soloed?: boolean
          outputTargetId?: string
          sends: Array<{ targetId: string; amount: number }>
        }
        children: Array<{ trackId: string; outputTargetId?: string; outputToGroup: boolean }>
        effects: SharedUngroupRestoreEffect[]
        automation: SharedUngroupRestoreAutomation[]
        sidechainRoutes?: Array<{ sourceTrackId?: string; targetTrackId?: string; effectInstanceId: string }>
        operationId?: string
      }
    }
  | { kind: 'tracks.setCollapsed'; payload: { trackId: string; collapsed: boolean } }
  | { kind: 'tracks.setColor'; payload: { trackId: string; color?: string } }
  | { kind: 'tracks.setColorCascade'; payload: { rootTrackId: string; color?: string | null; cascadeClipColors: boolean } }
  | { kind: 'tracks.applyColorBatch'; payload: { trackUpdates: Array<{ trackId: string; color?: string | null }>; clipUpdates: Array<{ clipId: string; color: string }> } }
  | { kind: 'tracks.setVolume'; payload: { trackId: string; volume: number } }
  | { kind: 'tracks.setMix'; payload: { trackId: string; muted?: boolean; soloed?: boolean } }
  | { kind: 'mixer.setMasterVolume'; payload: { volume: number } }
  | { kind: 'effects.setEqParams'; payload: { trackId: string; params: EqParams; instanceId: string } }
  | { kind: 'effects.setUtilityParams'; payload: { trackId: string; params: UtilityParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setGateParams'; payload: { trackId: string; params: GateParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setLimiterParams'; payload: { trackId: string; params: LimiterParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setModulationParams'; payload: SharedModulationEffectPayload & { trackId: string } }
  | { kind: 'effects.setCompressorParams'; payload: { trackId: string; params: CompressorParams; instanceId: string } }
  | { kind: 'effects.setSaturatorParams'; payload: { trackId: string; params: SaturatorParams; instanceId: string } }
  | { kind: 'effects.setDelayParams'; payload: { trackId: string; params: DelayParams; instanceId: string } }
  | { kind: 'effects.setSpectralParams'; payload: { trackId: string; params: SpectralParamsEnvelope; instanceId: string } }
  | { kind: 'effects.reorderAudioChain'; payload: { trackId: string; order: AudioEffectOrderItem[] } }
  | {
      kind: 'effects.restoreChain'
      payload: {
        trackId: string
        audioEffects: Array<{ id: string; kind: AudioEffectKind; params: JsonValue }>
        instrument?: TrackInstrumentParams
        arpeggiator?: ArpeggiatorParams
        operationId: string
      }
    }
  | { kind: 'effects.removeAudioEffect'; payload: { targetType: 'track'; trackId: string; effect: AudioEffectKind; instanceId: string } | { targetType: 'master'; effect: AudioEffectKind; instanceId: string } }
  | { kind: 'effects.setReverbParams'; payload: { trackId: string; params: SharedReverbParams; instanceId: string } }
  | { kind: 'effects.setSynthParams'; payload: { trackId: string; params: SynthParams; instanceId: string } }
  | { kind: 'instruments.setTrackInstrument'; payload: { trackId: string; instrument: TrackInstrumentParams } }
  | { kind: 'instruments.removeTrackInstrument'; payload: { trackId: string; operationId: string } }
  | { kind: 'effects.setArpeggiatorParams'; payload: { trackId: string; params: ArpeggiatorParams } }
  | { kind: 'effects.removeArpeggiator'; payload: { trackId: string; operationId: string } }
  | { kind: 'effects.setMasterEqParams'; payload: { params: EqParams; instanceId: string } }
  | { kind: 'effects.setMasterUtilityParams'; payload: { params: UtilityParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setMasterGateParams'; payload: { params: GateParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setMasterLimiterParams'; payload: { params: LimiterParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setMasterModulationParams'; payload: SharedModulationEffectPayload }
  | { kind: 'effects.setMasterCompressorParams'; payload: { params: CompressorParams; instanceId: string } }
  | { kind: 'effects.setMasterSaturatorParams'; payload: { params: SaturatorParams; instanceId: string } }
  | { kind: 'effects.setMasterDelayParams'; payload: { params: DelayParams; instanceId: string } }
  | { kind: 'effects.setMasterSpectralParams'; payload: { params: SpectralParamsEnvelope; instanceId: string } }
  | { kind: 'effects.setMasterReverbParams'; payload: { params: SharedReverbParams; instanceId: string } }
  | { kind: 'effects.reorderMasterAudioChain'; payload: { order: AudioEffectOrderItem[] } }
  | { kind: 'automation.setEnvelope'; payload: { targetKind: 'track' | 'master'; trackId?: string; effectInstanceId?: string; parameterId: string; enabled: boolean; points: AutomationPoint[]; updatedAt: number } }
  | { kind: 'automation.deleteEnvelope'; payload: { targetKind: 'track' | 'master'; trackId?: string; effectInstanceId?: string; parameterId: string } }

export type SharedTimelineOperationKind = SharedTimelineOperation['kind']

type SharedTimelineOperationTargets = {
  trackIds: Set<string>
  clipIds: Set<string>
}

type OperationDescriptor = {
  kind: SharedTimelineOperationKind
  parse: (payload: JsonObject) => SharedTimelineOperation | null
  targets: (payload: JsonValue) => SharedTimelineOperationTargets
  durableQueue: boolean
}

const emptyTargets = (): SharedTimelineOperationTargets => ({ trackIds: new Set(), clipIds: new Set() })
const trackTargets = (trackId: string): SharedTimelineOperationTargets => ({ trackIds: new Set([trackId]), clipIds: new Set() })
const clipTargets = (clipIds: string[]): SharedTimelineOperationTargets => ({ trackIds: new Set(), clipIds: new Set(clipIds) })
const readClipIdTargets = (payload: JsonValue): SharedTimelineOperationTargets => (
  isRecord(payload) && isJsonString(payload.clipId) ? clipTargets([payload.clipId]) : emptyTargets()
)
const readReorderAndGroupTargets = (payload: JsonValue): SharedTimelineOperationTargets => {
  if (!isRecord(payload) || !Array.isArray(payload.updates)) return emptyTargets()
  const trackIds = new Set<string>()
  for (const update of payload.updates) {
    if (!isRecord(update)) continue
    if (isJsonString(update.trackId)) trackIds.add(update.trackId)
    if (isJsonString(update.groupId)) trackIds.add(update.groupId)
    if (isJsonString(update.outputTargetId)) trackIds.add(update.outputTargetId)
  }
  return { trackIds, clipIds: new Set() }
}

const isRecord = isJsonObject

const readOptionalNumber = (value: JsonValue) => isJsonNumber(value) ? value : undefined
const readOptionalBoolean = (value: JsonValue) => isJsonBoolean(value) ? value : undefined
const readOptionalString = (value: JsonValue) => isJsonString(value) ? value : undefined
const readOptionalNullableString = (value: JsonValue) => isJsonString(value) || value === null ? value : undefined

const readAudioWarp = (value: JsonValue) => normalizeAudioWarp(value)

const readClipFades = (value: JsonValue) => {
  if (!isRecord(value)) return undefined
  if (
    !isJsonNumber(value.fadeInSec)
    || !isJsonNumber(value.fadeOutSec)
    || !isJsonNumber(value.fadeInCurve)
    || !isJsonNumber(value.fadeOutCurve)
  ) return undefined
  return {
    fadeInStartSec: isJsonNumber(value.fadeInStartSec) ? value.fadeInStartSec : 0,
    fadeInSec: value.fadeInSec,
    fadeOutSec: value.fadeOutSec,
    fadeOutEndSec: isJsonNumber(value.fadeOutEndSec) ? value.fadeOutEndSec : 0,
    fadeInCurve: value.fadeInCurve,
    fadeOutCurve: value.fadeOutCurve,
    fadeInCurvePosition: isJsonNumber(value.fadeInCurvePosition) ? value.fadeInCurvePosition : 0.5,
    fadeOutCurvePosition: isJsonNumber(value.fadeOutCurvePosition) ? value.fadeOutCurvePosition : 0.5,
  }
}

const readStringArray = (value: JsonValue) => Array.isArray(value)
  ? value.flatMap((entry) => isJsonString(entry) ? [entry] : [])
  : []

const readAudioEffectOrder = (value: JsonValue): AudioEffectOrderItem[] | null => {
  if (!Array.isArray(value)) return null
  const order: AudioEffectOrderItem[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isAudioEffectKind(entry) && !isAudioEffectInstance(entry)) return null
    const id = isJsonString(entry) ? entry : entry.id
    if (seen.has(id)) continue
    seen.add(id)
    order.push(entry)
  }
  return order
}

const readRequiredInstanceId = (value: JsonValue | undefined): string | null => (
  isJsonString(value) && value.length > 0 ? value : null
)

const readProcessorEnvelope = (
  kind: 'utility' | 'gate' | 'limiter',
  value: JsonValue,
): UtilityParamsEnvelope | GateParamsEnvelope | LimiterParamsEnvelope | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state)) return null
  return kind === 'utility'
    ? AUDIO_EFFECT_CONTRACTS.utility.normalizeParams({ version: 1, state: value.state })
    : kind === 'gate'
      ? AUDIO_EFFECT_CONTRACTS.gate.normalizeParams({ version: 1, state: value.state })
      : AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams({ version: 1, state: value.state })
}

const readModulationEnvelope = (effect: JsonValue, value: JsonValue): SharedModulationEffectEnvelope | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state)) return null
  if (effect === 'autofilter') return { effect, params: AUDIO_EFFECT_CONTRACTS.autofilter.normalizeParams(value) }
  if (effect === 'chorus') return { effect, params: AUDIO_EFFECT_CONTRACTS.chorus.normalizeParams(value) }
  if (effect === 'flanger') return { effect, params: AUDIO_EFFECT_CONTRACTS.flanger.normalizeParams(value) }
  if (effect === 'phaser') return { effect, params: AUDIO_EFFECT_CONTRACTS.phaser.normalizeParams(value) }
  if (effect === 'tremolo') return { effect, params: AUDIO_EFFECT_CONTRACTS.tremolo.normalizeParams(value) }
  if (effect === 'autopan') return { effect, params: AUDIO_EFFECT_CONTRACTS.autopan.normalizeParams(value) }
  if (effect === 'ensemble') return { effect, params: AUDIO_EFFECT_CONTRACTS.ensemble.normalizeParams(value) }
  if (effect === 'lofi') return { effect, params: AUDIO_EFFECT_CONTRACTS.lofi.normalizeParams(value) }
  return null
}

const effectPayload = <Params>(
  params: Params,
  payload: { instanceId?: JsonValue },
): { params: Params; instanceId: string } | null => {
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return instanceId ? { params, instanceId } : null
}

const readMoves = (value: JsonValue): MoveClipInput[] => Array.isArray(value)
  ? value.flatMap((entry) => (
      isRecord(entry)
      && isJsonString(entry.clipId)
      && isJsonString(entry.trackId)
      && isJsonNumber(entry.startSec)
        ? [{ clipId: entry.clipId, trackId: entry.trackId, startSec: entry.startSec }]
        : []
    ))
  : []

const readSends = (value: JsonValue): TrackRouting['sends'] => Array.isArray(value)
  ? value.flatMap((entry) => (
      isRecord(entry)
      && isJsonString(entry.targetId)
      && isJsonNumber(entry.amount)
        ? [{
            targetId: entry.targetId,
            amount: entry.amount,
            tap: entry.tap === 'pre-fx' || entry.tap === 'pre-fader' || entry.tap === 'post-fader' ? entry.tap : undefined,
          }]
        : []
    ))
  : undefined

export const readSharedTimelineClipCreatePayload = (
  value: JsonValue,
  options?: { requireAudioSampleUrl?: boolean; durable?: boolean },
): SharedTimelineClipCreatePayload | null => {
  if (!isRecord(value) || !isJsonString(value.trackId) || !isJsonNumber(value.startSec) || !isJsonNumber(value.duration)) return null
  if (value.midi !== undefined && !isRecord(value.midi)) return null
  let midi: MidiClip | LegacyMidiClip | undefined
  try {
    midi = value.midi === undefined
      ? undefined
      : options?.durable ? normalizeLegacyMidiClip(value.midi) : normalizeMidiClip(value.midi)
  } catch {
    return null
  }
  const isMidiClip = Boolean(midi) || value.clipKind === 'midi'
  if (!isMidiClip && (
    (options?.requireAudioSampleUrl !== false && !isJsonString(value.sampleUrl))
    || !isJsonString(value.assetKey)
    || !isJsonString(value.sourceKind)
    || !isJsonNumber(value.durationSec)
    || !isJsonNumber(value.sampleRate)
    || !isJsonNumber(value.channelCount)
  )) return null
  return {
    trackId: value.trackId,
    startSec: value.startSec,
    duration: value.duration,
    name: readOptionalString(value.name),
    sampleUrl: readOptionalString(value.sampleUrl),
    assetKey: readOptionalString(value.assetKey),
    sourceKind: readOptionalString(value.sourceKind),
    durationSec: readOptionalNumber(value.durationSec),
    sampleRate: readOptionalNumber(value.sampleRate),
    channelCount: readOptionalNumber(value.channelCount),
    leftPadSec: readOptionalNumber(value.leftPadSec),
    bufferOffsetSec: readOptionalNumber(value.bufferOffsetSec),
    audioWarp: readAudioWarp(value.audioWarp),
    gain: readOptionalNumber(value.gain),
    fades: readClipFades(value.fades),
    midiOffsetBeats: readOptionalNumber(value.midiOffsetBeats),
    color: normalizeClipColor(readOptionalString(value.color)),
    midi,
    clipKind: readOptionalString(value.clipKind),
    operationId: readOptionalString(value.operationId),
  }
}

const readEqParams = (value: JsonValue): EqParams | null => {
  if (!isRecord(value) || !isJsonBoolean(value.enabled) || !Array.isArray(value.bands)) return null
  const bands = value.bands.flatMap((band) => {
    if (
      !isRecord(band)
      || !isJsonString(band.id)
      || !isJsonNumber(band.frequency)
      || !isJsonNumber(band.gainDb)
      || !isJsonNumber(band.q)
      || !isJsonBoolean(band.enabled)
    ) return []
    return isEqBandType(band.type)
      ? [{ id: band.id, type: band.type, frequency: band.frequency, gainDb: band.gainDb, q: band.q, enabled: band.enabled }]
      : []
  })
  return bands.length === value.bands.length ? normalizeEqParams({ enabled: value.enabled, channelMode: value.channelMode, bands }) : null
}

const readReverbParams = (value: JsonValue): SharedReverbParams | null => {
  if (!isRecord(value) || !isJsonBoolean(value.enabled)) return null
  const params: ReverbParamsInput = {
    enabled: value.enabled,
    wet: readOptionalNumber(value.wet),
    decaySec: readOptionalNumber(value.decaySec),
    preDelayMs: readOptionalNumber(value.preDelayMs),
    reflections: readOptionalNumber(value.reflections),
    reflectionSpin: isJsonBoolean(value.reflectionSpin) ? value.reflectionSpin : undefined,
    reflectionModAmountMs: readOptionalNumber(value.reflectionModAmountMs),
    reflectionModRateHz: readOptionalNumber(value.reflectionModRateHz),
    'reflectionShape': readOptionalNumber(value['reflectionShape']),
    diffuse: readOptionalNumber(value.diffuse),
    size: readOptionalNumber(value.size),
    diffusion: readOptionalNumber(value.diffusion),
    density: readOptionalNumber(value.density),
    lowCutHz: readOptionalNumber(value.lowCutHz),
    highCutHz: readOptionalNumber(value.highCutHz),
    diffusionLowCutHz: readOptionalNumber(value.diffusionLowCutHz),
    diffusionHighCutHz: readOptionalNumber(value.diffusionHighCutHz),
    stereoWidth: readOptionalNumber(value.stereoWidth),
  }
  if (params.wet === undefined || params.decaySec === undefined || params.preDelayMs === undefined) return null
  return {
    ...params,
    enabled: value.enabled,
    wet: params.wet,
    decaySec: params.decaySec,
    preDelayMs: params.preDelayMs,
  }
}

const readCompressorParams = (value: JsonValue): CompressorParams | null => {
  if (!isRecord(value) || !isJsonBoolean(value.enabled)) return null
  if (
    !isJsonNumber(value.thresholdDb)
    || !isJsonNumber(value.ratio)
    || !isJsonNumber(value.attackMs)
    || !isJsonNumber(value.releaseMs)
    || !isJsonBoolean(value.autoRelease)
    || !isJsonNumber(value.makeupDb)
    || !isJsonNumber(value.outputDb)
    || !isJsonNumber(value.dryWet)
    || !isJsonNumber(value.kneeDb)
    || !isJsonNumber(value.lookaheadMs)
    || !isCompressorDetectorMode(value.detectorMode)
    || !isCompressorDynamicsMode(value.dynamicsMode)
    || !isCompressorEnvelopeCurve(value.envelopeCurve)
    || !isRecord(value.sidechain)
    || !isJsonBoolean(value.sidechain.enabled)
    || !isCompressorSidechainFilterType(value.sidechain.filterType)
    || !isJsonNumber(value.sidechain.frequencyHz)
    || !isJsonNumber(value.sidechain.q)
  ) return null
  const params: CompressorParamsInput = {
    enabled: value.enabled,
    thresholdDb: value.thresholdDb,
    ratio: value.ratio,
    attackMs: value.attackMs,
    releaseMs: value.releaseMs,
    autoRelease: value.autoRelease,
    makeupDb: value.makeupDb,
    outputDb: value.outputDb,
    dryWet: value.dryWet,
    kneeDb: value.kneeDb,
    lookaheadMs: value.lookaheadMs,
    detectorMode: value.detectorMode,
    dynamicsMode: value.dynamicsMode,
    envelopeCurve: value.envelopeCurve,
    sidechain: {
      enabled: value.sidechain.enabled,
      filterType: value.sidechain.filterType,
      frequencyHz: value.sidechain.frequencyHz,
      q: value.sidechain.q,
    },
  }
  return normalizeCompressorParams(params)
}

const readSaturatorParams = (value: JsonValue): SaturatorParams | null => {
  if (!isRecord(value) || !isJsonBoolean(value.enabled)) return null
  if (
    !isJsonNumber(value.driveDb)
    || !isSaturatorCurve(value.curve)
    || !isJsonBoolean(value.color)
    || !isJsonNumber(value.colorFrequencyHz)
    || !isJsonNumber(value.colorAmount)
    || !isJsonNumber(value.outputDb)
    || !isJsonNumber(value.dryWet)
  ) return null
  const params: SaturatorParamsInput = {
    enabled: value.enabled,
    driveDb: value.driveDb,
    curve: value.curve,
    color: value.color,
    colorFrequencyHz: value.colorFrequencyHz,
    colorAmount: value.colorAmount,
    outputDb: value.outputDb,
    dryWet: value.dryWet,
  }
  return normalizeSaturatorParams(params)
}

const readDelayParams = (value: JsonValue): DelayParams | null => {
  if (!isRecord(value) || !isJsonBoolean(value.enabled)) return null
  if (
    !isDelayMode(value.mode)
    || !isJsonNumber(value.timeMs)
    || !isDelaySyncDivision(value.syncDivision)
    || !isJsonNumber(value.feedback)
    || !isJsonNumber(value.dryWet)
    || !isJsonBoolean(value.pingPong)
    || !isJsonBoolean(value.filterEnabled)
    || !isJsonNumber(value.lowCutHz)
    || !isJsonNumber(value.highCutHz)
  ) return null
  const params: DelayParamsInput = {
    enabled: value.enabled,
    mode: value.mode,
    timeMs: value.timeMs,
    syncDivision: value.syncDivision,
    feedback: value.feedback,
    dryWet: value.dryWet,
    pingPong: value.pingPong,
    filterEnabled: value.filterEnabled,
    lowCutHz: value.lowCutHz,
    highCutHz: value.highCutHz,
  }
  return normalizeDelayParams(params)
}

const readSynthParams = (value: JsonValue): SynthParams | null => parseStrictSynthParams(value) ?? null

const readArpPattern = (value: JsonValue): ArpeggiatorParams['pattern'] | null => (
  value === 'up' || value === 'down' || value === 'updown' || value === 'random' ? value : null
)

const readArpRate = (value: JsonValue): ArpeggiatorParams['rate'] | null => (
  value === '1/4' || value === '1/8' || value === '1/16' || value === '1/32' ? value : null
)

const readArpeggiatorParams = (value: JsonValue): ArpeggiatorParams | null => {
  if (!isRecord(value)) return null
  const pattern = readArpPattern(value.pattern)
  const rate = readArpRate(value.rate)
  if (!pattern || !rate || !isJsonBoolean(value.enabled) || !isJsonNumber(value.octaves) || !isJsonNumber(value.gate) || !isJsonBoolean(value.hold)) return null
  return { enabled: value.enabled, pattern, rate, octaves: value.octaves, gate: value.gate, hold: value.hold }
}

const readTrackIdTargets = (payload: JsonValue) => isRecord(payload) && isJsonString(payload.trackId)
  ? trackTargets(payload.trackId)
  : emptyTargets()

const readRoutingTargets = (payload: JsonValue) => {
  if (!isRecord(payload) || !isJsonString(payload.trackId) || !isRecord(payload.routing)) return emptyTargets()
  const targets = trackTargets(payload.trackId)
  if (isJsonString(payload.routing.outputTargetId)) targets.trackIds.add(payload.routing.outputTargetId)
  for (const send of readSends(payload.routing.sends) ?? []) targets.trackIds.add(send.targetId)
  return targets
}

const readTrackGroupTargets = (payload: JsonValue) => {
  if (!isRecord(payload) || !isJsonString(payload.trackId)) return emptyTargets()
  const targets = trackTargets(payload.trackId)
  if (isJsonString(payload.groupId)) targets.trackIds.add(payload.groupId)
  return targets
}

const parseTrackCreate = (payload: JsonObject): SharedTimelineOperation | null => {
  const color = normalizeTrackColor(readOptionalString(payload.color))
  if (payload.color !== undefined && !color) return null
  return {
    kind: 'tracks.create',
    payload: {
      name: readOptionalString(payload.name),
      index: readOptionalNumber(payload.index),
      kind: readOptionalString(payload.kind),
      channelRole: readOptionalString(payload.channelRole),
      collapsed: readOptionalBoolean(payload.collapsed),
      color,
      operationId: readOptionalString(payload.operationId),
    },
  }
}

const parseTrackLock = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId) ? { kind: 'tracks.lock', payload: { trackId: payload.trackId } } : null
)

const parseTrackUnlock = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId) ? { kind: 'tracks.unlock', payload: { trackId: payload.trackId } } : null
)

const parseClipCreate = (payload: JsonObject): SharedTimelineOperation | null => {
  const clipPayload = readSharedTimelineClipCreatePayload(payload)
  return clipPayload ? { kind: 'clips.create', payload: clipPayload } : null
}

const parseDurableClipCreate = (payload: JsonObject): SharedTimelineOperation | null => {
  const clipPayload = readSharedTimelineClipCreatePayload(payload, { durable: true })
  return clipPayload ? { kind: 'clips.create', payload: clipPayload } : null
}

const parseClipCreateMany = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.items)) return null
  const items = payload.items.flatMap((item) => {
    const clipPayload = readSharedTimelineClipCreatePayload(item)
    return clipPayload ? [clipPayload] : []
  })
  return items.length === payload.items.length
    ? { kind: 'clips.createMany', payload: { items, operationId: readOptionalString(payload.operationId) } }
    : null
}
const parseDurableClipCreateMany = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.items)) return null
  const items = payload.items.flatMap((item) => {
    const clipPayload = readSharedTimelineClipCreatePayload(item, { durable: true })
    return clipPayload ? [clipPayload] : []
  })
  return items.length === payload.items.length
    ? { kind: 'clips.createMany', payload: { items, operationId: readOptionalString(payload.operationId) } }
    : null
}

const parseClipRemoveMany = (payload: JsonObject): SharedTimelineOperation | null => {
  const clipIds = readStringArray(payload.clipIds)
  const operationId = readOptionalString(payload.operationId)
  return clipIds.length > 0 && operationId
    ? { kind: 'clips.removeMany', payload: { clipIds, operationId } }
    : null
}

const parseClipMoveMany = (payload: JsonObject): SharedTimelineOperation | null => {
  const moves = readMoves(payload.moves)
  return moves.length > 0 ? { kind: 'clips.moveMany', payload: { moves } } : null
}

const readClipTimingPayload = (payload: JsonObject) => {
  if (
    !isJsonString(payload.clipId)
    || !isJsonNumber(payload.startSec)
    || !isJsonNumber(payload.duration)
  ) return null
  return {
    clipId: payload.clipId,
    ...normalizeClipTimingPatch({
      startSec: payload.startSec,
      duration: payload.duration,
      leftPadSec: readOptionalNumber(payload.leftPadSec),
      bufferOffsetSec: readOptionalNumber(payload.bufferOffsetSec),
      midiOffsetBeats: readOptionalNumber(payload.midiOffsetBeats),
    }),
    fades: readClipFades(payload.fades),
  }
}

const parseClipTiming = (payload: JsonObject): SharedTimelineOperation | null => {
  const timing = readClipTimingPayload(payload)
  return timing ? { kind: 'clips.setTiming', payload: timing } : null
}

const parseClipTimingAndAudioWarp = (payload: JsonObject): SharedTimelineOperation | null => {
  const timing = readClipTimingPayload(payload)
  if (!timing) return null
  const audioWarp = readAudioWarp(payload.audioWarp)
  return {
    kind: 'clips.setTimingAndAudioWarp',
    payload: audioWarp ? { ...timing, audioWarp } : timing,
  }
}

const parseClipAudioWarp = (payload: JsonObject): SharedTimelineOperation | null => {
  const audioWarp = readAudioWarp(payload.audioWarp)
  return isJsonString(payload.clipId) && audioWarp
    ? { kind: 'clips.setAudioWarp', payload: { clipId: payload.clipId, audioWarp } }
    : null
}

const parseClipGain = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.clipId) && isJsonNumber(payload.gain)
    ? { kind: 'clips.setGain', payload: { clipId: payload.clipId, gain: normalizeClipGain(payload.gain) } }
    : null
)

const parseClipFades = (payload: JsonObject): SharedTimelineOperation | null => {
  const fades = readClipFades(payload.fades)
  return isJsonString(payload.clipId) && fades
    ? { kind: 'clips.setFades', payload: { clipId: payload.clipId, fades } }
    : null
}

const parseClipColor = (payload: JsonObject): SharedTimelineOperation | null => {
  const color = normalizeClipColor(readOptionalString(payload.color))
  return isJsonString(payload.clipId) && color
    ? { kind: 'clips.setColor', payload: { clipId: payload.clipId, color } }
    : null
}

const parseClipMidi = (payload: JsonObject): SharedTimelineOperation | null => {
  if (
    !isJsonString(payload.clipId)
    || !isJsonString(payload.operationId)
    || payload.operationId.length === 0
    || !isRecord(payload.midi)
    || Object.keys(payload).some((key) => key !== 'clipId' && key !== 'midi' && key !== 'operationId')
  ) return null
  let midi: MidiClip
  try {
    midi = normalizeMidiClip(payload.midi)
  } catch {
    return null
  }
  return {
    kind: 'clips.setMidi',
    payload: {
      clipId: payload.clipId,
      operationId: payload.operationId,
      midi,
    },
  }
}

const parseClipMidiAndTiming = (payload: JsonObject): SharedTimelineOperation | null => {
  if (
    !isJsonString(payload.clipId)
    || !isJsonNumber(payload.startSec)
    || !isJsonNumber(payload.duration)
    || !isJsonString(payload.operationId)
    || payload.operationId.length === 0
    || !isRecord(payload.midi)
    || Object.keys(payload).some((key) => !['clipId', 'startSec', 'duration', 'midi', 'operationId'].includes(key))
  ) return null
  try {
    return {
      kind: 'clips.setMidiAndTiming',
      payload: {
        clipId: payload.clipId,
        startSec: payload.startSec,
        duration: payload.duration,
        midi: normalizeMidiClip(payload.midi),
        operationId: payload.operationId,
      },
    }
  } catch {
    return null
  }
}

const parseTrackRouting = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!isJsonString(payload.trackId) || !isRecord(payload.routing)) return null
  return {
    kind: 'tracks.setRouting',
    payload: {
      trackId: payload.trackId,
      routing: {
        outputTargetId: readOptionalString(payload.routing.outputTargetId),
        sends: readSends(payload.routing.sends),
      },
    },
  }
}

const parseSidechainRoute = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.projectId)
  && isJsonString(payload.sourceTrackId)
  && isJsonString(payload.targetTrackId)
  && isJsonString(payload.effectInstanceId)
  && payload.effectInstanceId.length > 0
    ? {
        kind: 'sidechains.setRoute',
        payload: {
          projectId: payload.projectId,
          sourceTrackId: payload.sourceTrackId,
          targetTrackId: payload.targetTrackId,
          effectInstanceId: payload.effectInstanceId,
        },
      }
    : null
)

const parseSidechainRemoval = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.projectId)
  && isJsonString(payload.targetTrackId)
  && isJsonString(payload.effectInstanceId)
  && payload.effectInstanceId.length > 0
    ? { kind: 'sidechains.removeRoute', payload: { projectId: payload.projectId, targetTrackId: payload.targetTrackId, effectInstanceId: payload.effectInstanceId } }
    : null
)

const parseTrackGroup = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId)
    ? { kind: 'tracks.setGroup', payload: { trackId: payload.trackId, groupId: readOptionalNullableString(payload.groupId) } }
    : null
)

const parseTrackReorderAndGroup = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.updates)) return null
  const updates = payload.updates.flatMap((update) => {
    if (!isRecord(update) || !isJsonString(update.trackId) || !isJsonNumber(update.index)) return []
    return [{
      trackId: update.trackId,
      index: update.index,
      groupId: isJsonString(update.groupId) || update.groupId === null ? update.groupId : undefined,
      outputTargetId: isJsonString(update.outputTargetId) || update.outputTargetId === null ? update.outputTargetId : undefined,
    }]
  })
  return updates.length === payload.updates.length
    ? { kind: 'tracks.reorderAndGroup', payload: { updates } }
    : null
}

const isUngroupRestoreEffectType = (value: JsonValue): value is SharedUngroupRestoreEffect['type'] => (
  isAudioEffectKind(value)
  || value === 'instrument'
  || value === 'synth'
  || value === 'arpeggiator'
)

const readAutomationPoints = (parameterId: string, value: JsonValue): AutomationPoint[] | null => {
  const descriptor = getAutomationParameterDescriptor(parameterId)
  if (!descriptor || !Array.isArray(value)) return null
  const points: AutomationPoint[] = []
  for (const point of value) {
    if (
      isRecord(point)
      && isJsonString(point.id)
      && isJsonNumber(point.timeSec)
      && isJsonNumber(point.value)
    ) {
      points.push({
        id: point.id,
        timeSec: point.timeSec,
        value: point.value,
        interpolation: point.interpolation === 'hold' ? 'hold' : 'linear',
      })
    }
  }
  return normalizeAutomationPoints(points, descriptor)
}

export const normalizeSharedUngroupRestoreEffects = (value: JsonValue): SharedUngroupRestoreEffect[] | null => {
  if (!Array.isArray(value)) return null
  const effects: SharedUngroupRestoreEffect[] = []
  const effectKeys = new Set<string>()
  for (const effect of value) {
    if (!isRecord(effect) || !isUngroupRestoreEffectType(effect.type) || !('params' in effect)) return null
    if (effect.instanceId !== undefined && (!isJsonString(effect.instanceId) || effect.instanceId.length === 0)) return null
    if (effect.index !== undefined && (!isJsonNumber(effect.index) || !Number.isInteger(effect.index) || effect.index < 0)) return null
    const instanceId = isJsonString(effect.instanceId) ? effect.instanceId : undefined
    const index = isJsonNumber(effect.index) ? effect.index : undefined
    if (!isAudioEffectKind(effect.type) && (instanceId !== undefined || index !== undefined)) return null
    const params = (() => {
      switch (effect.type) {
        case 'utility':
          return readProcessorEnvelope('utility', effect.params)
        case 'eq':
          return readEqParams(effect.params)
        case 'autofilter':
        case 'lofi':
        case 'chorus':
        case 'flanger':
        case 'phaser':
        case 'tremolo':
        case 'autopan':
        case 'ensemble':
          return readModulationEnvelope(effect.type, effect.params)?.params ?? null
        case 'gate':
          return readProcessorEnvelope('gate', effect.params)
        case 'limiter':
          return readProcessorEnvelope('limiter', effect.params)
        case 'compressor':
          return readCompressorParams(effect.params)
        case 'saturator':
          return readSaturatorParams(effect.params)
        case 'delay':
          return readDelayParams(effect.params)
        case 'reverb':
          return readReverbParams(effect.params)
        case 'spectral':
          return parseSpectralParams(effect.params)
        case 'instrument':
          return readTrackInstrumentParams(effect.params)
        case 'synth':
          return readSynthParams(effect.params)
        case 'arpeggiator':
          return readArpeggiatorParams(effect.params)
      }
    })()
    if (!params) return null
    const effectKey = `${effect.type}:${instanceId ?? ''}`
    if (effectKeys.has(effectKey)) return null
    effectKeys.add(effectKey)
    effects.push({
      type: effect.type,
      instanceId,
      index,
      params,
    })
  }
  return effects
}

export const normalizeSharedUngroupRestoreAutomation = (value: JsonValue): SharedUngroupRestoreAutomation[] | null => {
  if (!Array.isArray(value)) return null
  const automation: SharedUngroupRestoreAutomation[] = []
  const targetKeys = new Set<string>()
  for (const envelope of value) {
    if (!isRecord(envelope) || !isJsonString(envelope.parameterId) || !isJsonBoolean(envelope.enabled) || !isJsonNumber(envelope.updatedAt) || !Array.isArray(envelope.points)) return null
    if (!isAutomationParameterSupportedForTarget(envelope.parameterId, 'track')) return null
    if (envelope.effectInstanceId !== undefined && (!isJsonString(envelope.effectInstanceId) || envelope.effectInstanceId.length === 0)) return null
    const points = readAutomationPoints(envelope.parameterId, envelope.points)
    if (!points) return null
    const effectInstanceId = isJsonString(envelope.effectInstanceId) ? envelope.effectInstanceId : undefined
    const targetKey = automationTargetKey({ kind: 'track', trackId: 'restore-group', effectInstanceId }, envelope.parameterId)
    if (targetKeys.has(targetKey)) return null
    targetKeys.add(targetKey)
    automation.push({ effectInstanceId, parameterId: envelope.parameterId, enabled: envelope.enabled, points, updatedAt: envelope.updatedAt })
  }
  return automation
}

const parseTrackUngroup = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.groupId)
    ? { kind: 'tracks.ungroup', payload: { groupId: payload.groupId, operationId: readOptionalString(payload.operationId) } }
    : null
)

const parseTrackRestoreUngroup = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!isRecord(payload.group) || !Array.isArray(payload.children)) return null
  const group = payload.group
  if (!isJsonNumber(group.index) || !isJsonNumber(group.volume) || !Array.isArray(group.sends)) return null
  if (group.kind !== undefined && !isJsonString(group.kind)) return null
  if (group.name !== undefined && !isJsonString(group.name)) return null
  if (group.historyRef !== undefined && !isJsonString(group.historyRef)) return null
  if (group.parentGroupId !== undefined && !isJsonString(group.parentGroupId)) return null
  if (group.collapsed !== undefined && !isJsonBoolean(group.collapsed)) return null
  if (group.color !== undefined && (!isJsonString(group.color) || !normalizeTrackColor(group.color))) return null
  if (group.muted !== undefined && !isJsonBoolean(group.muted)) return null
  if (group.soloed !== undefined && !isJsonBoolean(group.soloed)) return null
  if (group.outputTargetId !== undefined && !isJsonString(group.outputTargetId)) return null
  const sends = group.sends.flatMap((send) => (
    isRecord(send) && isJsonString(send.targetId) && isJsonNumber(send.amount)
      && (send.tap === undefined || send.tap === 'pre-fx' || send.tap === 'pre-fader' || send.tap === 'post-fader')
      ? [{ targetId: send.targetId, amount: send.amount, tap: send.tap }]
      : []
  ))
  if (sends.length !== group.sends.length) return null
  const children = payload.children.flatMap((child) => (
    isRecord(child) && isJsonString(child.trackId) && isJsonBoolean(child.outputToGroup) && (child.outputTargetId === undefined || isJsonString(child.outputTargetId))
      ? [{ trackId: child.trackId, outputTargetId: isJsonString(child.outputTargetId) ? child.outputTargetId : undefined, outputToGroup: child.outputToGroup }]
      : []
  ))
  if (children.length !== payload.children.length) return null
  const effects = normalizeSharedUngroupRestoreEffects(payload.effects)
  const automation = normalizeSharedUngroupRestoreAutomation(payload.automation)
  if (!effects || !automation || (payload.sidechainRoutes !== undefined && !Array.isArray(payload.sidechainRoutes))) return null
  const sidechainRouteInput = Array.isArray(payload.sidechainRoutes) ? payload.sidechainRoutes : []
  const sidechainRoutes = sidechainRouteInput.flatMap((route) => (
    isRecord(route)
    && (route.sourceTrackId === undefined || isJsonString(route.sourceTrackId))
    && (route.targetTrackId === undefined || isJsonString(route.targetTrackId))
    && isJsonString(route.effectInstanceId)
    && route.sourceTrackId !== route.targetTrackId
      ? [{
          sourceTrackId: isJsonString(route.sourceTrackId) ? route.sourceTrackId : undefined,
          targetTrackId: isJsonString(route.targetTrackId) ? route.targetTrackId : undefined,
          effectInstanceId: route.effectInstanceId,
        }]
      : []
  ))
  if (sidechainRoutes.length !== sidechainRouteInput.length) return null
  return {
    kind: 'tracks.restoreUngroup',
    payload: {
      group: {
        name: isJsonString(group.name) ? group.name : undefined,
        index: group.index,
        kind: isJsonString(group.kind) ? group.kind : undefined,
        historyRef: isJsonString(group.historyRef) ? group.historyRef : undefined,
        parentGroupId: isJsonString(group.parentGroupId) ? group.parentGroupId : undefined,
        collapsed: isJsonBoolean(group.collapsed) ? group.collapsed : undefined,
        color: isJsonString(group.color) ? normalizeTrackColor(group.color) : undefined,
        volume: group.volume,
        muted: isJsonBoolean(group.muted) ? group.muted : undefined,
        soloed: isJsonBoolean(group.soloed) ? group.soloed : undefined,
        outputTargetId: isJsonString(group.outputTargetId) ? group.outputTargetId : undefined,
        sends,
      },
      children,
      effects,
      automation,
      sidechainRoutes: payload.sidechainRoutes === undefined ? undefined : sidechainRoutes,
      operationId: readOptionalString(payload.operationId),
    },
  }
}

const parseTrackCollapsed = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId) && isJsonBoolean(payload.collapsed)
    ? { kind: 'tracks.setCollapsed', payload: { trackId: payload.trackId, collapsed: payload.collapsed } }
    : null
)

const parseTrackColor = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId)
    && (payload.color === undefined || normalizeTrackColor(readOptionalString(payload.color)))
    ? { kind: 'tracks.setColor', payload: { trackId: payload.trackId, color: normalizeTrackColor(readOptionalString(payload.color)) } }
    : null
)

const parseTrackColorCascade = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.rootTrackId) && isJsonBoolean(payload.cascadeClipColors)
    && (payload.color === null || payload.color === undefined || normalizeTrackColor(readOptionalString(payload.color)))
    ? {
        kind: 'tracks.setColorCascade',
        payload: {
          rootTrackId: payload.rootTrackId,
          color: payload.color === null ? null : normalizeTrackColor(readOptionalString(payload.color)),
          cascadeClipColors: payload.cascadeClipColors,
        },
      }
    : null
)

const parseTrackColorBatch = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.trackUpdates) || !Array.isArray(payload.clipUpdates)) return null
  const trackUpdates = payload.trackUpdates.flatMap((update) => (
    isRecord(update) && isJsonString(update.trackId)
      && (update.color === null || update.color === undefined || normalizeTrackColor(readOptionalString(update.color)))
      ? [{ trackId: update.trackId, color: update.color === null ? null : normalizeTrackColor(readOptionalString(update.color)) }]
      : []
  ))
  const clipUpdates = payload.clipUpdates.flatMap((update) => (
    isRecord(update) && isJsonString(update.clipId) && isJsonString(update.color) && normalizeClipColor(update.color)
      ? [{ clipId: update.clipId, color: update.color }]
      : []
  ))
  return trackUpdates.length === payload.trackUpdates.length && clipUpdates.length === payload.clipUpdates.length
    ? { kind: 'tracks.applyColorBatch', payload: { trackUpdates, clipUpdates } }
    : null
}

const parseTrackVolume = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId) && isJsonNumber(payload.volume)
    ? { kind: 'tracks.setVolume', payload: { trackId: payload.trackId, volume: payload.volume } }
    : null
)

const parseTrackMix = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonString(payload.trackId)
    ? {
        kind: 'tracks.setMix',
        payload: {
          trackId: payload.trackId,
          muted: isJsonBoolean(payload.muted) ? payload.muted : undefined,
          soloed: isJsonBoolean(payload.soloed) ? payload.soloed : undefined,
        },
      }
    : null
)

const parseMasterVolume = (payload: JsonObject): SharedTimelineOperation | null => (
  isJsonNumber(payload.volume)
    ? { kind: 'mixer.setMasterVolume', payload: { volume: normalizeMasterVolume(payload.volume) } }
    : null
)

const parseTrackEq = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readEqParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return isJsonString(payload.trackId) && identity ? { kind: 'effects.setEqParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackProcessor = (
  kind: 'utility' | 'gate' | 'limiter',
  operationKind: 'effects.setUtilityParams' | 'effects.setGateParams' | 'effects.setLimiterParams',
  payload: JsonObject,
): SharedTimelineOperation | null => {
  const params = readProcessorEnvelope(kind, payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  if (!isJsonString(payload.trackId) || !params || !instanceId) return null
  return operationKind === 'effects.setUtilityParams'
    ? { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(params) } }
    : operationKind === 'effects.setGateParams'
      ? { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(params) } }
      : { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(params) } }
}

const parseModulationEffect = (
  payload: JsonObject,
  target: 'track' | 'master',
): SharedTimelineOperation | null => {
  const instanceId = readRequiredInstanceId(payload.instanceId)
  const envelope = readModulationEnvelope(payload.effect, payload.params)
  if (!instanceId || !envelope) return null
  if (target === 'track') {
    if (!isJsonString(payload.trackId)) return null
    if (envelope.effect === 'autofilter') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    if (envelope.effect === 'chorus') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    if (envelope.effect === 'flanger') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    if (envelope.effect === 'phaser') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    if (envelope.effect === 'tremolo') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    if (envelope.effect === 'autopan') return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
    return { kind: 'effects.setModulationParams', payload: { ...envelope, instanceId, trackId: payload.trackId } }
  }
  if (envelope.effect === 'autofilter') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  if (envelope.effect === 'chorus') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  if (envelope.effect === 'flanger') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  if (envelope.effect === 'phaser') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  if (envelope.effect === 'tremolo') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  if (envelope.effect === 'autopan') return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
  return { kind: 'effects.setMasterModulationParams', payload: { ...envelope, instanceId } }
}

const parseTrackReverb = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return isJsonString(payload.trackId) && identity ? { kind: 'effects.setReverbParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackCompressor = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return isJsonString(payload.trackId) && identity ? { kind: 'effects.setCompressorParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackSaturator = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return isJsonString(payload.trackId) && identity ? { kind: 'effects.setSaturatorParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackDelay = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return isJsonString(payload.trackId) && identity ? { kind: 'effects.setDelayParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseSpectralParams = (value: JsonValue): SpectralParamsEnvelope | null => {
  if (!isRecord(value)) return null
  const normalized = normalizeSpectralParamsEnvelope(value)
  return value.version === 1 && isRecord(value.state) ? normalized : null
}

const parseTrackSpectral = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = parseSpectralParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return isJsonString(payload.trackId) && params && instanceId
    ? { kind: 'effects.setSpectralParams', payload: { trackId: payload.trackId, params, instanceId } }
    : null
}

const parseTrackAudioChainReorder = (payload: JsonObject): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return isJsonString(payload.trackId) && order ? { kind: 'effects.reorderAudioChain', payload: { trackId: payload.trackId, order } } : null
}

const parseRestoreEffectChain = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!isJsonString(payload.trackId) || !isJsonString(payload.operationId) || payload.operationId.length === 0 || !Array.isArray(payload.audioEffects)) return null
  const restored = normalizeSharedUngroupRestoreEffects(payload.audioEffects.map((effect) => (
    isRecord(effect) ? { type: effect.kind, instanceId: effect.id, params: effect.params } : effect
  )))
  if (!restored || restored.length !== payload.audioEffects.length) return null
  const audioEffects = restored.flatMap((effect) => (
    isAudioEffectKind(effect.type) && effect.instanceId
      ? [{ id: effect.instanceId, kind: effect.type, params: effect.params }]
      : []
  ))
  if (audioEffects.length !== restored.length) return null
  const instrument = payload.instrument === undefined ? undefined : readTrackInstrumentParams(payload.instrument)
  const arpeggiator = payload.arpeggiator === undefined ? undefined : readArpeggiatorParams(payload.arpeggiator)
  if ((payload.instrument !== undefined && !instrument) || (payload.arpeggiator !== undefined && !arpeggiator)) return null
  return {
    kind: 'effects.restoreChain',
    payload: {
      trackId: payload.trackId,
      audioEffects,
      instrument: instrument ? instrument : undefined,
      arpeggiator: arpeggiator ? arpeggiator : undefined,
      operationId: payload.operationId,
    },
  }
}

const parseRemoveAudioEffect = (payload: JsonObject): SharedTimelineOperation | null => {
  if (!isAudioEffectKind(payload.effect)) return null
  const instanceId = readRequiredInstanceId(payload.instanceId)
  if (!instanceId) return null
  if (payload.targetType === 'master') {
    return { kind: 'effects.removeAudioEffect', payload: { targetType: 'master', effect: payload.effect, instanceId } }
  }
  if (payload.targetType === 'track' && isJsonString(payload.trackId)) {
    return { kind: 'effects.removeAudioEffect', payload: { targetType: 'track', trackId: payload.trackId, effect: payload.effect, instanceId } }
  }
  return null
}

const parseTrackSynth = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readSynthParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return isJsonString(payload.trackId) && params && instanceId
    ? { kind: 'effects.setSynthParams', payload: { trackId: payload.trackId, params, instanceId } }
    : null
}

const readTrackInstrumentParams = (value: JsonValue): TrackInstrumentParams | null => {
  if (
    isRecord(value)
    && value.kind === 'synth'
    && isJsonString(value.instanceId)
    && value.instanceId
  ) {
    const params = readSynthParams(value.params)
    return params ? { kind: 'synth', instanceId: value.instanceId, params } : null
  }
  return normalizeTrackInstrumentParams(value) ?? null
}

const parseTrackInstrument = (payload: JsonObject): SharedTimelineOperation | null => {
  const instrument = readTrackInstrumentParams(payload.instrument)
  return isJsonString(payload.trackId) && instrument
    ? { kind: 'instruments.setTrackInstrument', payload: { trackId: payload.trackId, instrument } }
    : null
}

const parseTrackDeviceRemoval = (
  kind: 'instruments.removeTrackInstrument' | 'effects.removeArpeggiator',
  payload: JsonObject,
): SharedTimelineOperation | null => (
  isJsonString(payload.trackId)
  && isJsonString(payload.operationId)
  && payload.operationId.length > 0
  && Object.keys(payload).every((key) => key === 'trackId' || key === 'operationId')
    ? { kind, payload: { trackId: payload.trackId, operationId: payload.operationId } }
    : null
)

const parseTrackArpeggiator = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readArpeggiatorParams(payload.params)
  return isJsonString(payload.trackId) && params ? { kind: 'effects.setArpeggiatorParams', payload: { trackId: payload.trackId, params } } : null
}

const parseMasterEq = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readEqParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterEqParams', payload: identity } : null
}

const parseMasterProcessor = (
  kind: 'utility' | 'gate' | 'limiter',
  operationKind: 'effects.setMasterUtilityParams' | 'effects.setMasterGateParams' | 'effects.setMasterLimiterParams',
  payload: JsonObject,
): SharedTimelineOperation | null => {
  const params = readProcessorEnvelope(kind, payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  if (!params || !instanceId) return null
  return operationKind === 'effects.setMasterUtilityParams'
    ? { kind: operationKind, payload: { instanceId, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(params) } }
    : operationKind === 'effects.setMasterGateParams'
      ? { kind: operationKind, payload: { instanceId, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(params) } }
      : { kind: operationKind, payload: { instanceId, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(params) } }
}

const parseMasterReverb = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterReverbParams', payload: identity } : null
}

const parseMasterCompressor = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterCompressorParams', payload: identity } : null
}

const parseMasterSaturator = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterSaturatorParams', payload: identity } : null
}

const parseMasterDelay = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterDelayParams', payload: identity } : null
}

const parseMasterSpectral = (payload: JsonObject): SharedTimelineOperation | null => {
  const params = parseSpectralParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return params && instanceId
    ? { kind: 'effects.setMasterSpectralParams', payload: { params, instanceId } }
    : null
}

const parseMasterAudioChainReorder = (payload: JsonObject): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return order ? { kind: 'effects.reorderMasterAudioChain', payload: { order } } : null
}

const readAutomationTargetKind = (value: JsonValue): 'track' | 'master' | null => (
  value === 'track' || value === 'master' ? value : null
)

const parseAutomationSetEnvelope = (payload: JsonObject): SharedTimelineOperation | null => {
  const targetKind = readAutomationTargetKind(payload.targetKind)
  if (!targetKind || !isJsonString(payload.parameterId) || !isJsonBoolean(payload.enabled) || !isJsonNumber(payload.updatedAt)) return null
  if (targetKind === 'track' && !isJsonString(payload.trackId)) return null
  const trackId = targetKind === 'track' && isJsonString(payload.trackId) ? payload.trackId : undefined
  const effectInstanceId = isJsonString(payload.effectInstanceId) ? payload.effectInstanceId : undefined
  if (!isAutomationParameterSupportedForTarget(payload.parameterId, targetKind)) return null
  const points = readAutomationPoints(payload.parameterId, payload.points)
  return points ? {
    kind: 'automation.setEnvelope',
    payload: {
      targetKind,
      trackId,
      effectInstanceId,
      parameterId: payload.parameterId,
      enabled: payload.enabled,
      points,
      updatedAt: payload.updatedAt,
    },
  } : null
}

const parseAutomationDeleteEnvelope = (payload: JsonObject): SharedTimelineOperation | null => {
  const targetKind = readAutomationTargetKind(payload.targetKind)
  if (!targetKind || !isJsonString(payload.parameterId)) return null
  if (targetKind === 'track' && !isJsonString(payload.trackId)) return null
  const trackId = targetKind === 'track' && isJsonString(payload.trackId) ? payload.trackId : undefined
  const effectInstanceId = isJsonString(payload.effectInstanceId) ? payload.effectInstanceId : undefined
  if (!isAutomationParameterSupportedForTarget(payload.parameterId, targetKind)) return null
  return {
    kind: 'automation.deleteEnvelope',
    payload: {
      targetKind,
      trackId,
      effectInstanceId,
      parameterId: payload.parameterId,
    },
  }
}

const sharedTimelineOperationDescriptors: OperationDescriptor[] = [
  { kind: 'tracks.create', parse: parseTrackCreate, targets: emptyTargets, durableQueue: true },
  { kind: 'tracks.lock', parse: parseTrackLock, targets: readTrackIdTargets, durableQueue: false },
  { kind: 'tracks.unlock', parse: parseTrackUnlock, targets: readTrackIdTargets, durableQueue: false },
  { kind: 'clips.create', parse: parseClipCreate, targets: readTrackIdTargets, durableQueue: true },
  {
    kind: 'clips.createMany',
    parse: parseClipCreateMany,
    targets: (payload) => {
      if (!isRecord(payload) || !Array.isArray(payload.items)) return emptyTargets()
      const targets = emptyTargets()
      for (const item of payload.items) {
        if (isRecord(item) && isJsonString(item.trackId)) targets.trackIds.add(item.trackId)
      }
      return targets
    },
    durableQueue: true,
  },
  {
    kind: 'clips.removeMany',
    parse: parseClipRemoveMany,
    targets: (payload) => isRecord(payload) ? clipTargets(readStringArray(payload.clipIds)) : emptyTargets(),
    durableQueue: true,
  },
  {
    kind: 'clips.moveMany',
    parse: parseClipMoveMany,
    targets: (payload) => {
      if (!isRecord(payload)) return emptyTargets()
      const targets = emptyTargets()
      for (const move of readMoves(payload.moves)) {
        targets.trackIds.add(move.trackId)
        targets.clipIds.add(move.clipId)
      }
      return targets
    },
    durableQueue: true,
  },
  {
    kind: 'clips.setTiming',
    parse: parseClipTiming,
    targets: readClipIdTargets,
    durableQueue: true,
  },
  {
    kind: 'clips.setTimingAndAudioWarp',
    parse: parseClipTimingAndAudioWarp,
    targets: readClipIdTargets,
    durableQueue: true,
  },
  {
    kind: 'clips.setAudioWarp',
    parse: parseClipAudioWarp,
    targets: readClipIdTargets,
    durableQueue: true,
  },
  {
    kind: 'clips.setGain',
    parse: parseClipGain,
    targets: readClipIdTargets,
    durableQueue: true,
  },
  {
    kind: 'clips.setFades',
    parse: parseClipFades,
    targets: readClipIdTargets,
    durableQueue: true,
  },
  { kind: 'clips.setColor', parse: parseClipColor, targets: readClipIdTargets, durableQueue: true },
  { kind: 'clips.setMidi', parse: parseClipMidi, targets: readClipIdTargets, durableQueue: true },
  { kind: 'clips.setMidiAndTiming', parse: parseClipMidiAndTiming, targets: readClipIdTargets, durableQueue: true },
  { kind: 'tracks.setRouting', parse: parseTrackRouting, targets: readRoutingTargets, durableQueue: true },
  {
    kind: 'sidechains.setRoute',
    parse: parseSidechainRoute,
    targets: (payload) => {
      if (!isRecord(payload)) return emptyTargets()
      const trackIds = new Set<string>()
      if (isJsonString(payload.sourceTrackId)) trackIds.add(payload.sourceTrackId)
      if (isJsonString(payload.targetTrackId)) trackIds.add(payload.targetTrackId)
      return { trackIds, clipIds: new Set() }
    },
    durableQueue: true,
  },
  {
    kind: 'sidechains.removeRoute',
    parse: parseSidechainRemoval,
    targets: (payload) => {
      if (!isRecord(payload) || !isJsonString(payload.targetTrackId)) return emptyTargets()
      return { trackIds: new Set([payload.targetTrackId]), clipIds: new Set() }
    },
    durableQueue: true,
  },
  { kind: 'tracks.setGroup', parse: parseTrackGroup, targets: readTrackGroupTargets, durableQueue: true },
  { kind: 'tracks.reorderAndGroup', parse: parseTrackReorderAndGroup, targets: readReorderAndGroupTargets, durableQueue: true },
  { kind: 'tracks.ungroup', parse: parseTrackUngroup, targets: emptyTargets, durableQueue: true },
  { kind: 'tracks.restoreUngroup', parse: parseTrackRestoreUngroup, targets: (payload) => {
    if (!isRecord(payload) || !isRecord(payload.group) || !Array.isArray(payload.children)) return emptyTargets()
    const targets = emptyTargets()
    const group = payload.group
    if (isJsonString(group.parentGroupId)) targets.trackIds.add(group.parentGroupId)
    if (isJsonString(group.outputTargetId)) targets.trackIds.add(group.outputTargetId)
    if (Array.isArray(group.sends)) for (const send of group.sends) if (isRecord(send) && isJsonString(send.targetId)) targets.trackIds.add(send.targetId)
    for (const child of payload.children) {
      if (!isRecord(child)) continue
      if (isJsonString(child.trackId)) targets.trackIds.add(child.trackId)
      if (isJsonString(child.outputTargetId)) targets.trackIds.add(child.outputTargetId)
    }
    if (Array.isArray(payload.sidechainRoutes)) for (const route of payload.sidechainRoutes) {
      if (!isRecord(route)) continue
      if (isJsonString(route.sourceTrackId)) targets.trackIds.add(route.sourceTrackId)
      if (isJsonString(route.targetTrackId)) targets.trackIds.add(route.targetTrackId)
    }
    return targets
  }, durableQueue: true },
  { kind: 'tracks.setCollapsed', parse: parseTrackCollapsed, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setColor', parse: parseTrackColor, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setColorCascade', parse: parseTrackColorCascade, targets: (payload) => isRecord(payload) && isJsonString(payload.rootTrackId) ? trackTargets(payload.rootTrackId) : emptyTargets(), durableQueue: true },
  { kind: 'tracks.applyColorBatch', parse: parseTrackColorBatch, targets: (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.trackUpdates) || !Array.isArray(payload.clipUpdates)) return emptyTargets()
    const targets = emptyTargets()
    for (const update of payload.trackUpdates) if (isRecord(update) && isJsonString(update.trackId)) targets.trackIds.add(update.trackId)
    for (const update of payload.clipUpdates) if (isRecord(update) && isJsonString(update.clipId)) targets.clipIds.add(update.clipId)
    return targets
  }, durableQueue: true },
  { kind: 'tracks.setVolume', parse: parseTrackVolume, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setMix', parse: parseTrackMix, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'mixer.setMasterVolume', parse: parseMasterVolume, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setEqParams', parse: parseTrackEq, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setUtilityParams', parse: (payload) => parseTrackProcessor('utility', 'effects.setUtilityParams', payload), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setLimiterParams', parse: (payload) => parseTrackProcessor('limiter', 'effects.setLimiterParams', payload), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setModulationParams', parse: (payload) => parseModulationEffect(payload, 'track'), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setGateParams', parse: (payload) => parseTrackProcessor('gate', 'effects.setGateParams', payload), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setCompressorParams', parse: parseTrackCompressor, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setSaturatorParams', parse: parseTrackSaturator, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setDelayParams', parse: parseTrackDelay, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setSpectralParams', parse: parseTrackSpectral, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.reorderAudioChain', parse: parseTrackAudioChainReorder, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.restoreChain', parse: parseRestoreEffectChain, targets: readTrackIdTargets, durableQueue: true },
  {
    kind: 'effects.removeAudioEffect',
    parse: parseRemoveAudioEffect,
    targets: readTrackIdTargets,
    durableQueue: true,
  },
  { kind: 'effects.setReverbParams', parse: parseTrackReverb, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setSynthParams', parse: parseTrackSynth, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'instruments.setTrackInstrument', parse: parseTrackInstrument, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'instruments.removeTrackInstrument', parse: (payload) => parseTrackDeviceRemoval('instruments.removeTrackInstrument', payload), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setArpeggiatorParams', parse: parseTrackArpeggiator, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.removeArpeggiator', parse: (payload) => parseTrackDeviceRemoval('effects.removeArpeggiator', payload), targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setMasterEqParams', parse: parseMasterEq, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterUtilityParams', parse: (payload) => parseMasterProcessor('utility', 'effects.setMasterUtilityParams', payload), targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterLimiterParams', parse: (payload) => parseMasterProcessor('limiter', 'effects.setMasterLimiterParams', payload), targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterModulationParams', parse: (payload) => parseModulationEffect(payload, 'master'), targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterGateParams', parse: (payload) => parseMasterProcessor('gate', 'effects.setMasterGateParams', payload), targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterCompressorParams', parse: parseMasterCompressor, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterSaturatorParams', parse: parseMasterSaturator, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterDelayParams', parse: parseMasterDelay, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterSpectralParams', parse: parseMasterSpectral, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterReverbParams', parse: parseMasterReverb, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.reorderMasterAudioChain', parse: parseMasterAudioChainReorder, targets: emptyTargets, durableQueue: true },
  { kind: 'automation.setEnvelope', parse: parseAutomationSetEnvelope, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'automation.deleteEnvelope', parse: parseAutomationDeleteEnvelope, targets: readTrackIdTargets, durableQueue: true },
]

const sharedTimelineOperationKinds = sharedTimelineOperationDescriptors.map((descriptor) => descriptor.kind)

const findSharedTimelineOperationDescriptor = (kind: JsonValue) => (
  isSharedTimelineOperationKind(kind)
    ? sharedTimelineOperationDescriptors.find((descriptor) => descriptor.kind === kind)
    : undefined
)

const isSharedTimelineOperationKind = (value: JsonValue): value is SharedTimelineOperationKind => (
  isJsonString(value) && sharedTimelineOperationKinds.some((kind) => kind === value)
)

export const isDurableSharedTimelineOperationKind = (value: JsonValue): value is SharedTimelineOperationKind => (
  findSharedTimelineOperationDescriptor(value)?.durableQueue === true
)

export const readSharedTimelineOperationTargets = (operation: SharedTimelineOperation): SharedTimelineOperationTargets => (
  findSharedTimelineOperationDescriptor(operation.kind)?.targets(operation.payload) ?? emptyTargets()
)

export const parseSharedTimelineOperation = (value: JsonValue): SharedTimelineOperation | null => {
  if (!isRecord(value) || !isRecord(value.payload)) return null
  return findSharedTimelineOperationDescriptor(value.kind)?.parse(value.payload) ?? null
}

/** Parses only operations loaded from the durable local outbox. */
export const parseDurableSharedTimelineOperation = (value: JsonValue): SharedTimelineOperation | null => {
  if (!isRecord(value) || !isRecord(value.payload)) return null
  if (value.kind === 'clips.create') return parseDurableClipCreate(value.payload)
  if (value.kind === 'clips.createMany') return parseDurableClipCreateMany(value.payload)
  return findSharedTimelineOperationDescriptor(value.kind)?.parse(value.payload) ?? null
}
