import type {
  ArpeggiatorParams,
  AudioEffectInstance,
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
  SynthWave,
  TremoloParamsEnvelope,
  UtilityParamsEnvelope,
} from './effects-params'
import {
  audioEffectOrderItemKind,
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
import { normalizeClipColor } from './clip-color'
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
  midiOffsetBeats?: number
  color?: string
  midi?: {
    wave: string
    gain?: number
    notes: Array<{
      beat: number
      length: number
      pitch: number
      velocity?: number
    }>
  }
  clipKind?: string
  operationId?: string
}

type SharedSynthParams = {
  wave1: SynthWave
  wave2: SynthWave
  gain?: number
  attackMs?: number
  releaseMs?: number
}

type SharedReverbParams = Required<Pick<ReverbParamsInput, 'enabled' | 'wet' | 'decaySec' | 'preDelayMs'>> & Omit<ReverbParamsInput, 'enabled' | 'wet' | 'decaySec' | 'preDelayMs'>

export type SharedUngroupRestoreEffect = {
  type: AudioEffectKind | 'instrument' | 'synth' | 'arpeggiator'
  instanceId?: string
  index?: number
  params: unknown
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
  | { kind: 'tracks.create'; payload: { index?: number; kind?: string; channelRole?: string; collapsed?: boolean; color?: string; operationId?: string } }
  | { kind: 'tracks.lock'; payload: { trackId: string } }
  | { kind: 'tracks.unlock'; payload: { trackId: string } }
  | { kind: 'clips.create'; payload: SharedTimelineClipCreatePayload }
  | { kind: 'clips.createMany'; payload: { items: SharedTimelineClipCreatePayload[]; operationId?: string } }
  | { kind: 'clips.removeMany'; payload: { clipIds: string[] } }
  | { kind: 'clips.moveMany'; payload: { moves: MoveClipInput[] } }
  | { kind: 'clips.setTiming'; payload: { clipId: string; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number } }
  | { kind: 'clips.setTimingAndAudioWarp'; payload: { clipId: string; startSec: number; duration: number; leftPadSec?: number; bufferOffsetSec?: number; midiOffsetBeats?: number; audioWarp?: AudioWarpPayload } }
  | { kind: 'clips.setAudioWarp'; payload: { clipId: string; audioWarp: AudioWarpPayload } }
  | { kind: 'clips.setGain'; payload: { clipId: string; gain: number } }
  | { kind: 'clips.setColor'; payload: { clipId: string; color: string } }
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
        audioEffects: Array<{ id: string; kind: AudioEffectKind; params: unknown }>
        instrument?: TrackInstrumentParams
        arpeggiator?: ArpeggiatorParams
        operationId: string
      }
    }
  | { kind: 'effects.removeAudioEffect'; payload: { targetType: 'track'; trackId: string; effect: AudioEffectKind; instanceId: string } | { targetType: 'master'; effect: AudioEffectKind; instanceId: string } }
  | { kind: 'effects.setReverbParams'; payload: { trackId: string; params: SharedReverbParams; instanceId: string } }
  | { kind: 'effects.setSynthParams'; payload: { trackId: string; params: SharedSynthParams; instanceId: string } }
  | { kind: 'instruments.setTrackInstrument'; payload: { trackId: string; instrument: TrackInstrumentParams } }
  | { kind: 'effects.setArpeggiatorParams'; payload: { trackId: string; params: ArpeggiatorParams } }
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
  parse: (payload: Record<string, unknown>) => SharedTimelineOperation | null
  targets: (payload: unknown) => SharedTimelineOperationTargets
  durableQueue: boolean
}

const emptyTargets = (): SharedTimelineOperationTargets => ({ trackIds: new Set(), clipIds: new Set() })
const trackTargets = (trackId: string): SharedTimelineOperationTargets => ({ trackIds: new Set([trackId]), clipIds: new Set() })
const clipTargets = (clipIds: string[]): SharedTimelineOperationTargets => ({ trackIds: new Set(), clipIds: new Set(clipIds) })
const readClipIdTargets = (payload: unknown): SharedTimelineOperationTargets => (
  isRecord(payload) && typeof payload.clipId === 'string' ? clipTargets([payload.clipId]) : emptyTargets()
)
const readReorderAndGroupTargets = (payload: unknown): SharedTimelineOperationTargets => {
  if (!isRecord(payload) || !Array.isArray(payload.updates)) return emptyTargets()
  const trackIds = new Set<string>()
  for (const update of payload.updates) {
    if (!isRecord(update)) continue
    if (typeof update.trackId === 'string') trackIds.add(update.trackId)
    if (typeof update.groupId === 'string') trackIds.add(update.groupId)
    if (typeof update.outputTargetId === 'string') trackIds.add(update.outputTargetId)
  }
  return { trackIds, clipIds: new Set() }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readOptionalNumber = (value: unknown) => typeof value === 'number' ? value : undefined
const readOptionalBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined
const readOptionalString = (value: unknown) => typeof value === 'string' ? value : undefined
const readOptionalNullableString = (value: unknown) => typeof value === 'string' || value === null ? value : undefined

const readAudioWarp = (value: unknown) => normalizeAudioWarp(value)

const readStringArray = (value: unknown) => Array.isArray(value)
  ? value.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
  : []

const readAudioEffectOrder = (value: unknown): AudioEffectOrderItem[] | null => {
  if (!Array.isArray(value)) return null
  const order: AudioEffectOrderItem[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isAudioEffectKind(entry) && !isAudioEffectInstance(entry)) return null
    const id = typeof entry === 'string' ? entry : entry.id
    if (seen.has(id)) continue
    seen.add(id)
    order.push(entry)
  }
  return order
}

const readRequiredInstanceId = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
)

const readProcessorEnvelope = (
  kind: 'utility' | 'gate' | 'limiter',
  value: unknown,
): UtilityParamsEnvelope | GateParamsEnvelope | LimiterParamsEnvelope | null => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state)) return null
  return kind === 'utility'
    ? AUDIO_EFFECT_CONTRACTS.utility.normalizeParams({ version: 1, state: value.state })
    : kind === 'gate'
      ? AUDIO_EFFECT_CONTRACTS.gate.normalizeParams({ version: 1, state: value.state })
      : AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams({ version: 1, state: value.state })
}

const readModulationEnvelope = (effect: unknown, value: unknown): SharedModulationEffectEnvelope | null => {
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
  payload: Record<string, unknown>,
): { params: Params; instanceId: string } | null => {
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return instanceId ? { params, instanceId } : null
}

const readMoves = (value: unknown): MoveClipInput[] => Array.isArray(value)
  ? value.flatMap((entry) => (
      isRecord(entry)
      && typeof entry.clipId === 'string'
      && typeof entry.trackId === 'string'
      && typeof entry.startSec === 'number'
        ? [{ clipId: entry.clipId, trackId: entry.trackId, startSec: entry.startSec }]
        : []
    ))
  : []

const readSends = (value: unknown): TrackRouting['sends'] => Array.isArray(value)
  ? value.flatMap((entry) => (
      isRecord(entry)
      && typeof entry.targetId === 'string'
      && typeof entry.amount === 'number'
        ? [{
            targetId: entry.targetId,
            amount: entry.amount,
            ...(entry.tap === 'pre-fx' || entry.tap === 'pre-fader' || entry.tap === 'post-fader'
              ? { tap: entry.tap }
              : {}),
          }]
        : []
    ))
  : undefined

export const readSharedTimelineClipCreatePayload = (
  value: unknown,
  options?: { requireAudioSampleUrl?: boolean },
): SharedTimelineClipCreatePayload | null => {
  if (!isRecord(value) || typeof value.trackId !== 'string' || typeof value.startSec !== 'number' || typeof value.duration !== 'number') return null
  const midi = isRecord(value.midi) && Array.isArray(value.midi.notes) && typeof value.midi.wave === 'string'
    ? {
        wave: value.midi.wave,
        gain: readOptionalNumber(value.midi.gain),
        notes: value.midi.notes.flatMap((note) => (
          isRecord(note)
          && typeof note.beat === 'number'
          && typeof note.length === 'number'
          && typeof note.pitch === 'number'
            ? [{
                beat: note.beat,
                length: note.length,
                pitch: note.pitch,
                velocity: readOptionalNumber(note.velocity),
              }]
            : []
        )),
      }
    : undefined
  const isMidiClip = Boolean(midi) || value.clipKind === 'midi'
  if (!isMidiClip && (
    (options?.requireAudioSampleUrl !== false && typeof value.sampleUrl !== 'string')
    || typeof value.assetKey !== 'string'
    || typeof value.sourceKind !== 'string'
    || typeof value.durationSec !== 'number'
    || typeof value.sampleRate !== 'number'
    || typeof value.channelCount !== 'number'
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
    midiOffsetBeats: readOptionalNumber(value.midiOffsetBeats),
    color: normalizeClipColor(readOptionalString(value.color)),
    midi,
    clipKind: readOptionalString(value.clipKind),
    operationId: readOptionalString(value.operationId),
  }
}

const readEqParams = (value: unknown): EqParams | null => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.bands)) return null
  const bands = value.bands.flatMap((band) => {
    if (
      !isRecord(band)
      || typeof band.id !== 'string'
      || typeof band.frequency !== 'number'
      || typeof band.gainDb !== 'number'
      || typeof band.q !== 'number'
      || typeof band.enabled !== 'boolean'
    ) return []
    return isEqBandType(band.type)
      ? [{ id: band.id, type: band.type, frequency: band.frequency, gainDb: band.gainDb, q: band.q, enabled: band.enabled }]
      : []
  })
  return bands.length === value.bands.length ? normalizeEqParams({ enabled: value.enabled, channelMode: value.channelMode, bands }) : null
}

const readReverbParams = (value: unknown): SharedReverbParams | null => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  const params: ReverbParamsInput = {
    enabled: value.enabled,
    wet: readOptionalNumber(value.wet),
    decaySec: readOptionalNumber(value.decaySec),
    preDelayMs: readOptionalNumber(value.preDelayMs),
    reflections: readOptionalNumber(value.reflections),
    reflectionSpin: typeof value.reflectionSpin === 'boolean' ? value.reflectionSpin : undefined,
    reflectionModAmountMs: readOptionalNumber(value.reflectionModAmountMs),
    reflectionModRateHz: readOptionalNumber(value.reflectionModRateHz),
    reflectionShape: readOptionalNumber(value.reflectionShape),
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

const readCompressorParams = (value: unknown): CompressorParams | null => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (
    typeof value.thresholdDb !== 'number'
    || typeof value.ratio !== 'number'
    || typeof value.attackMs !== 'number'
    || typeof value.releaseMs !== 'number'
    || typeof value.autoRelease !== 'boolean'
    || typeof value.makeupDb !== 'number'
    || typeof value.outputDb !== 'number'
    || typeof value.dryWet !== 'number'
    || typeof value.kneeDb !== 'number'
    || typeof value.lookaheadMs !== 'number'
    || !isCompressorDetectorMode(value.detectorMode)
    || !isCompressorDynamicsMode(value.dynamicsMode)
    || !isCompressorEnvelopeCurve(value.envelopeCurve)
    || !isRecord(value.sidechain)
    || typeof value.sidechain.enabled !== 'boolean'
    || !isCompressorSidechainFilterType(value.sidechain.filterType)
    || typeof value.sidechain.frequencyHz !== 'number'
    || typeof value.sidechain.q !== 'number'
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

const readSaturatorParams = (value: unknown): SaturatorParams | null => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (
    typeof value.driveDb !== 'number'
    || !isSaturatorCurve(value.curve)
    || typeof value.color !== 'boolean'
    || typeof value.colorFrequencyHz !== 'number'
    || typeof value.colorAmount !== 'number'
    || typeof value.outputDb !== 'number'
    || typeof value.dryWet !== 'number'
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

const readDelayParams = (value: unknown): DelayParams | null => {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null
  if (
    !isDelayMode(value.mode)
    || typeof value.timeMs !== 'number'
    || !isDelaySyncDivision(value.syncDivision)
    || typeof value.feedback !== 'number'
    || typeof value.dryWet !== 'number'
    || typeof value.pingPong !== 'boolean'
    || typeof value.filterEnabled !== 'boolean'
    || typeof value.lowCutHz !== 'number'
    || typeof value.highCutHz !== 'number'
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

const readSynthWave = (value: unknown): SynthWave | null => (
  value === 'sine' || value === 'square' || value === 'sawtooth' || value === 'triangle' ? value : null
)

const readSynthParams = (value: unknown): SharedSynthParams | null => {
  if (!isRecord(value)) return null
  const wave1 = readSynthWave(value.wave1)
  const wave2 = readSynthWave(value.wave2)
  if (!wave1 || !wave2) return null
  const gain = readOptionalNumber(value.gain)
  const attackMs = readOptionalNumber(value.attackMs)
  const releaseMs = readOptionalNumber(value.releaseMs)
  return {
    wave1,
    wave2,
    ...(gain === undefined ? {} : { gain }),
    ...(attackMs === undefined ? {} : { attackMs }),
    ...(releaseMs === undefined ? {} : { releaseMs }),
  }
}

const readArpPattern = (value: unknown): ArpeggiatorParams['pattern'] | null => (
  value === 'up' || value === 'down' || value === 'updown' || value === 'random' ? value : null
)

const readArpRate = (value: unknown): ArpeggiatorParams['rate'] | null => (
  value === '1/4' || value === '1/8' || value === '1/16' || value === '1/32' ? value : null
)

const readArpeggiatorParams = (value: unknown): ArpeggiatorParams | null => {
  if (!isRecord(value)) return null
  const pattern = readArpPattern(value.pattern)
  const rate = readArpRate(value.rate)
  if (!pattern || !rate || typeof value.enabled !== 'boolean' || typeof value.octaves !== 'number' || typeof value.gate !== 'number' || typeof value.hold !== 'boolean') return null
  return { enabled: value.enabled, pattern, rate, octaves: value.octaves, gate: value.gate, hold: value.hold }
}

const readTrackIdTargets = (payload: unknown) => isRecord(payload) && typeof payload.trackId === 'string'
  ? trackTargets(payload.trackId)
  : emptyTargets()

const readRoutingTargets = (payload: unknown) => {
  if (!isRecord(payload) || typeof payload.trackId !== 'string' || !isRecord(payload.routing)) return emptyTargets()
  const targets = trackTargets(payload.trackId)
  if (typeof payload.routing.outputTargetId === 'string') targets.trackIds.add(payload.routing.outputTargetId)
  for (const send of readSends(payload.routing.sends) ?? []) targets.trackIds.add(send.targetId)
  return targets
}

const readTrackGroupTargets = (payload: unknown) => {
  if (!isRecord(payload) || typeof payload.trackId !== 'string') return emptyTargets()
  const targets = trackTargets(payload.trackId)
  if (typeof payload.groupId === 'string') targets.trackIds.add(payload.groupId)
  return targets
}

const parseTrackCreate = (payload: Record<string, unknown>): SharedTimelineOperation => ({
  kind: 'tracks.create',
  payload: {
    index: readOptionalNumber(payload.index),
    kind: readOptionalString(payload.kind),
    channelRole: readOptionalString(payload.channelRole),
    collapsed: readOptionalBoolean(payload.collapsed),
    color: readOptionalString(payload.color),
    operationId: readOptionalString(payload.operationId),
  },
})

const parseTrackLock = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string' ? { kind: 'tracks.lock', payload: { trackId: payload.trackId } } : null
)

const parseTrackUnlock = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string' ? { kind: 'tracks.unlock', payload: { trackId: payload.trackId } } : null
)

const parseClipCreate = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const clipPayload = readSharedTimelineClipCreatePayload(payload)
  return clipPayload ? { kind: 'clips.create', payload: clipPayload } : null
}

const parseClipCreateMany = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.items)) return null
  const items = payload.items.flatMap((item) => {
    const clipPayload = readSharedTimelineClipCreatePayload(item)
    return clipPayload ? [clipPayload] : []
  })
  return items.length === payload.items.length
    ? { kind: 'clips.createMany', payload: { items, operationId: readOptionalString(payload.operationId) } }
    : null
}

const parseClipRemoveMany = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const clipIds = readStringArray(payload.clipIds)
  return clipIds.length > 0 ? { kind: 'clips.removeMany', payload: { clipIds } } : null
}

const parseClipMoveMany = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const moves = readMoves(payload.moves)
  return moves.length > 0 ? { kind: 'clips.moveMany', payload: { moves } } : null
}

const readClipTimingPayload = (payload: Record<string, unknown>) => {
  if (
    typeof payload.clipId !== 'string'
    || typeof payload.startSec !== 'number'
    || typeof payload.duration !== 'number'
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
  }
}

const parseClipTiming = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const timing = readClipTimingPayload(payload)
  return timing ? { kind: 'clips.setTiming', payload: timing } : null
}

const parseClipTimingAndAudioWarp = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const timing = readClipTimingPayload(payload)
  if (!timing) return null
  const audioWarp = readAudioWarp(payload.audioWarp)
  return {
    kind: 'clips.setTimingAndAudioWarp',
    payload: audioWarp ? { ...timing, audioWarp } : timing,
  }
}

const parseClipAudioWarp = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const audioWarp = readAudioWarp(payload.audioWarp)
  return typeof payload.clipId === 'string' && audioWarp
    ? { kind: 'clips.setAudioWarp', payload: { clipId: payload.clipId, audioWarp } }
    : null
}

const parseClipGain = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.clipId === 'string' && typeof payload.gain === 'number'
    ? { kind: 'clips.setGain', payload: { clipId: payload.clipId, gain: normalizeClipGain(payload.gain) } }
    : null
)

const parseClipColor = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const color = normalizeClipColor(readOptionalString(payload.color))
  return typeof payload.clipId === 'string' && color
    ? { kind: 'clips.setColor', payload: { clipId: payload.clipId, color } }
    : null
}

const parseTrackRouting = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (typeof payload.trackId !== 'string' || !isRecord(payload.routing)) return null
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

const parseSidechainRoute = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.projectId === 'string'
  && typeof payload.sourceTrackId === 'string'
  && typeof payload.targetTrackId === 'string'
  && typeof payload.effectInstanceId === 'string'
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

const parseSidechainRemoval = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.projectId === 'string'
  && typeof payload.targetTrackId === 'string'
  && typeof payload.effectInstanceId === 'string'
  && payload.effectInstanceId.length > 0
    ? { kind: 'sidechains.removeRoute', payload: { projectId: payload.projectId, targetTrackId: payload.targetTrackId, effectInstanceId: payload.effectInstanceId } }
    : null
)

const parseTrackGroup = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string'
    ? { kind: 'tracks.setGroup', payload: { trackId: payload.trackId, groupId: readOptionalNullableString(payload.groupId) } }
    : null
)

const parseTrackReorderAndGroup = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.updates)) return null
  const updates = payload.updates.flatMap((update) => {
    if (!isRecord(update) || typeof update.trackId !== 'string' || typeof update.index !== 'number') return []
    return [{
      trackId: update.trackId,
      index: update.index,
      groupId: typeof update.groupId === 'string' || update.groupId === null ? update.groupId : undefined,
      outputTargetId: typeof update.outputTargetId === 'string' || update.outputTargetId === null ? update.outputTargetId : undefined,
    }]
  })
  return updates.length === payload.updates.length
    ? { kind: 'tracks.reorderAndGroup', payload: { updates } }
    : null
}

const isUngroupRestoreEffectType = (value: unknown): value is SharedUngroupRestoreEffect['type'] => (
  isAudioEffectKind(value)
  || value === 'instrument'
  || value === 'synth'
  || value === 'arpeggiator'
)

const readAutomationPoints = (parameterId: string, value: unknown): AutomationPoint[] | null => {
  const descriptor = getAutomationParameterDescriptor(parameterId)
  if (!descriptor || !Array.isArray(value)) return null
  const points: AutomationPoint[] = []
  for (const point of value) {
    if (
      isRecord(point)
      && typeof point.id === 'string'
      && typeof point.timeSec === 'number'
      && typeof point.value === 'number'
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

export const normalizeSharedUngroupRestoreEffects = (value: unknown): SharedUngroupRestoreEffect[] | null => {
  if (!Array.isArray(value)) return null
  const effects: SharedUngroupRestoreEffect[] = []
  const effectKeys = new Set<string>()
  for (const effect of value) {
    if (!isRecord(effect) || !isUngroupRestoreEffectType(effect.type) || !('params' in effect)) return null
    if (effect.instanceId !== undefined && (typeof effect.instanceId !== 'string' || effect.instanceId.length === 0)) return null
    if (effect.index !== undefined && (typeof effect.index !== 'number' || !Number.isInteger(effect.index) || effect.index < 0)) return null
    const instanceId = typeof effect.instanceId === 'string' ? effect.instanceId : undefined
    const index = typeof effect.index === 'number' ? effect.index : undefined
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

export const normalizeSharedUngroupRestoreAutomation = (value: unknown): SharedUngroupRestoreAutomation[] | null => {
  if (!Array.isArray(value)) return null
  const automation: SharedUngroupRestoreAutomation[] = []
  const targetKeys = new Set<string>()
  for (const envelope of value) {
    if (!isRecord(envelope) || typeof envelope.parameterId !== 'string' || typeof envelope.enabled !== 'boolean' || typeof envelope.updatedAt !== 'number' || !Array.isArray(envelope.points)) return null
    if (!isAutomationParameterSupportedForTarget(envelope.parameterId, 'track')) return null
    if (envelope.effectInstanceId !== undefined && (typeof envelope.effectInstanceId !== 'string' || envelope.effectInstanceId.length === 0)) return null
    const points = readAutomationPoints(envelope.parameterId, envelope.points)
    if (!points) return null
    const effectInstanceId = typeof envelope.effectInstanceId === 'string' ? envelope.effectInstanceId : undefined
    const targetKey = automationTargetKey({ kind: 'track', trackId: 'restore-group', effectInstanceId }, envelope.parameterId)
    if (targetKeys.has(targetKey)) return null
    targetKeys.add(targetKey)
    automation.push({ effectInstanceId, parameterId: envelope.parameterId, enabled: envelope.enabled, points, updatedAt: envelope.updatedAt })
  }
  return automation
}

const parseTrackUngroup = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.groupId === 'string'
    ? { kind: 'tracks.ungroup', payload: { groupId: payload.groupId, operationId: readOptionalString(payload.operationId) } }
    : null
)

const parseTrackRestoreUngroup = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (!isRecord(payload.group) || !Array.isArray(payload.children)) return null
  const group = payload.group
  if (typeof group.index !== 'number' || typeof group.volume !== 'number' || !Array.isArray(group.sends)) return null
  if (group.kind !== undefined && typeof group.kind !== 'string') return null
  if (group.historyRef !== undefined && typeof group.historyRef !== 'string') return null
  if (group.parentGroupId !== undefined && typeof group.parentGroupId !== 'string') return null
  if (group.collapsed !== undefined && typeof group.collapsed !== 'boolean') return null
  if (group.color !== undefined && typeof group.color !== 'string') return null
  if (group.muted !== undefined && typeof group.muted !== 'boolean') return null
  if (group.soloed !== undefined && typeof group.soloed !== 'boolean') return null
  if (group.outputTargetId !== undefined && typeof group.outputTargetId !== 'string') return null
  const sends = group.sends.flatMap((send) => (
    isRecord(send) && typeof send.targetId === 'string' && typeof send.amount === 'number'
      && (send.tap === undefined || send.tap === 'pre-fx' || send.tap === 'pre-fader' || send.tap === 'post-fader')
      ? [{ targetId: send.targetId, amount: send.amount, tap: send.tap }]
      : []
  ))
  if (sends.length !== group.sends.length) return null
  const children = payload.children.flatMap((child) => (
    isRecord(child) && typeof child.trackId === 'string' && typeof child.outputToGroup === 'boolean' && (child.outputTargetId === undefined || typeof child.outputTargetId === 'string')
      ? [{ trackId: child.trackId, outputTargetId: typeof child.outputTargetId === 'string' ? child.outputTargetId : undefined, outputToGroup: child.outputToGroup }]
      : []
  ))
  if (children.length !== payload.children.length) return null
  const effects = normalizeSharedUngroupRestoreEffects(payload.effects)
  const automation = normalizeSharedUngroupRestoreAutomation(payload.automation)
  if (!effects || !automation || (payload.sidechainRoutes !== undefined && !Array.isArray(payload.sidechainRoutes))) return null
  const sidechainRouteInput = Array.isArray(payload.sidechainRoutes) ? payload.sidechainRoutes : []
  const sidechainRoutes = sidechainRouteInput.flatMap((route) => (
    isRecord(route)
    && (route.sourceTrackId === undefined || typeof route.sourceTrackId === 'string')
    && (route.targetTrackId === undefined || typeof route.targetTrackId === 'string')
    && typeof route.effectInstanceId === 'string'
    && route.sourceTrackId !== route.targetTrackId
      ? [{
          sourceTrackId: typeof route.sourceTrackId === 'string' ? route.sourceTrackId : undefined,
          targetTrackId: typeof route.targetTrackId === 'string' ? route.targetTrackId : undefined,
          effectInstanceId: route.effectInstanceId,
        }]
      : []
  ))
  if (sidechainRoutes.length !== sidechainRouteInput.length) return null
  return {
    kind: 'tracks.restoreUngroup',
    payload: {
      group: {
        index: group.index,
        kind: typeof group.kind === 'string' ? group.kind : undefined,
        historyRef: typeof group.historyRef === 'string' ? group.historyRef : undefined,
        parentGroupId: typeof group.parentGroupId === 'string' ? group.parentGroupId : undefined,
        collapsed: typeof group.collapsed === 'boolean' ? group.collapsed : undefined,
        color: typeof group.color === 'string' ? group.color : undefined,
        volume: group.volume,
        muted: typeof group.muted === 'boolean' ? group.muted : undefined,
        soloed: typeof group.soloed === 'boolean' ? group.soloed : undefined,
        outputTargetId: typeof group.outputTargetId === 'string' ? group.outputTargetId : undefined,
        sends,
      },
      children,
      effects,
      automation,
      ...(payload.sidechainRoutes === undefined ? {} : { sidechainRoutes }),
      operationId: readOptionalString(payload.operationId),
    },
  }
}

const parseTrackCollapsed = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string' && typeof payload.collapsed === 'boolean'
    ? { kind: 'tracks.setCollapsed', payload: { trackId: payload.trackId, collapsed: payload.collapsed } }
    : null
)

const parseTrackColor = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string'
    ? { kind: 'tracks.setColor', payload: { trackId: payload.trackId, color: readOptionalString(payload.color) } }
    : null
)

const parseTrackColorCascade = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.rootTrackId === 'string' && typeof payload.cascadeClipColors === 'boolean'
    ? {
        kind: 'tracks.setColorCascade',
        payload: {
          rootTrackId: payload.rootTrackId,
          color: readOptionalNullableString(payload.color),
          cascadeClipColors: payload.cascadeClipColors,
        },
      }
    : null
)

const parseTrackColorBatch = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (!Array.isArray(payload.trackUpdates) || !Array.isArray(payload.clipUpdates)) return null
  const trackUpdates = payload.trackUpdates.flatMap((update) => (
    isRecord(update) && typeof update.trackId === 'string'
      ? [{ trackId: update.trackId, color: readOptionalNullableString(update.color) }]
      : []
  ))
  const clipUpdates = payload.clipUpdates.flatMap((update) => (
    isRecord(update) && typeof update.clipId === 'string' && typeof update.color === 'string' && normalizeClipColor(update.color)
      ? [{ clipId: update.clipId, color: update.color }]
      : []
  ))
  return trackUpdates.length === payload.trackUpdates.length && clipUpdates.length === payload.clipUpdates.length
    ? { kind: 'tracks.applyColorBatch', payload: { trackUpdates, clipUpdates } }
    : null
}

const parseTrackVolume = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string' && typeof payload.volume === 'number'
    ? { kind: 'tracks.setVolume', payload: { trackId: payload.trackId, volume: payload.volume } }
    : null
)

const parseTrackMix = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.trackId === 'string'
    ? {
        kind: 'tracks.setMix',
        payload: {
          trackId: payload.trackId,
          muted: typeof payload.muted === 'boolean' ? payload.muted : undefined,
          soloed: typeof payload.soloed === 'boolean' ? payload.soloed : undefined,
        },
      }
    : null
)

const parseMasterVolume = (payload: Record<string, unknown>): SharedTimelineOperation | null => (
  typeof payload.volume === 'number'
    ? { kind: 'mixer.setMasterVolume', payload: { volume: normalizeMasterVolume(payload.volume) } }
    : null
)

const parseTrackEq = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readEqParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return typeof payload.trackId === 'string' && identity ? { kind: 'effects.setEqParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackProcessor = (
  kind: 'utility' | 'gate' | 'limiter',
  operationKind: 'effects.setUtilityParams' | 'effects.setGateParams' | 'effects.setLimiterParams',
  payload: Record<string, unknown>,
): SharedTimelineOperation | null => {
  const params = readProcessorEnvelope(kind, payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  if (typeof payload.trackId !== 'string' || !params || !instanceId) return null
  return operationKind === 'effects.setUtilityParams'
    ? { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.utility.normalizeParams(params) } }
    : operationKind === 'effects.setGateParams'
      ? { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.gate.normalizeParams(params) } }
      : { kind: operationKind, payload: { trackId: payload.trackId, instanceId, params: AUDIO_EFFECT_CONTRACTS.limiter.normalizeParams(params) } }
}

const parseModulationEffect = (
  payload: Record<string, unknown>,
  target: 'track' | 'master',
): SharedTimelineOperation | null => {
  const instanceId = readRequiredInstanceId(payload.instanceId)
  const envelope = readModulationEnvelope(payload.effect, payload.params)
  if (!instanceId || !envelope) return null
  if (target === 'track') {
    if (typeof payload.trackId !== 'string') return null
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

const parseTrackReverb = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return typeof payload.trackId === 'string' && identity ? { kind: 'effects.setReverbParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackCompressor = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return typeof payload.trackId === 'string' && identity ? { kind: 'effects.setCompressorParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackSaturator = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return typeof payload.trackId === 'string' && identity ? { kind: 'effects.setSaturatorParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseTrackDelay = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return typeof payload.trackId === 'string' && identity ? { kind: 'effects.setDelayParams', payload: { trackId: payload.trackId, ...identity } } : null
}

const parseSpectralParams = (value: unknown): SpectralParamsEnvelope | null => {
  if (!isRecord(value)) return null
  const normalized = normalizeSpectralParamsEnvelope(value)
  return value.version === 1 && isRecord(value.state) ? normalized : null
}

const parseTrackSpectral = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = parseSpectralParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return typeof payload.trackId === 'string' && params && instanceId
    ? { kind: 'effects.setSpectralParams', payload: { trackId: payload.trackId, params, instanceId } }
    : null
}

const parseTrackAudioChainReorder = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return typeof payload.trackId === 'string' && order ? { kind: 'effects.reorderAudioChain', payload: { trackId: payload.trackId, order } } : null
}

const parseRestoreEffectChain = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (typeof payload.trackId !== 'string' || typeof payload.operationId !== 'string' || payload.operationId.length === 0 || !Array.isArray(payload.audioEffects)) return null
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
      ...(instrument ? { instrument } : {}),
      ...(arpeggiator ? { arpeggiator } : {}),
      operationId: payload.operationId,
    },
  }
}

const parseRemoveAudioEffect = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  if (!isAudioEffectKind(payload.effect)) return null
  const instanceId = readRequiredInstanceId(payload.instanceId)
  if (!instanceId) return null
  if (payload.targetType === 'master') {
    return { kind: 'effects.removeAudioEffect', payload: { targetType: 'master', effect: payload.effect, instanceId } }
  }
  if (payload.targetType === 'track' && typeof payload.trackId === 'string') {
    return { kind: 'effects.removeAudioEffect', payload: { targetType: 'track', trackId: payload.trackId, effect: payload.effect, instanceId } }
  }
  return null
}

const parseTrackSynth = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSynthParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return typeof payload.trackId === 'string' && params && instanceId
    ? { kind: 'effects.setSynthParams', payload: { trackId: payload.trackId, params, instanceId } }
    : null
}

const readTrackInstrumentParams = (value: unknown): TrackInstrumentParams | null => {
  return normalizeTrackInstrumentParams(value) ?? null
}

const parseTrackInstrument = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const instrument = readTrackInstrumentParams(payload.instrument)
  return typeof payload.trackId === 'string' && instrument
    ? { kind: 'instruments.setTrackInstrument', payload: { trackId: payload.trackId, instrument } }
    : null
}

const parseTrackArpeggiator = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readArpeggiatorParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setArpeggiatorParams', payload: { trackId: payload.trackId, params } } : null
}

const parseMasterEq = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readEqParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterEqParams', payload: identity } : null
}

const parseMasterProcessor = (
  kind: 'utility' | 'gate' | 'limiter',
  operationKind: 'effects.setMasterUtilityParams' | 'effects.setMasterGateParams' | 'effects.setMasterLimiterParams',
  payload: Record<string, unknown>,
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

const parseMasterReverb = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterReverbParams', payload: identity } : null
}

const parseMasterCompressor = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterCompressorParams', payload: identity } : null
}

const parseMasterSaturator = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterSaturatorParams', payload: identity } : null
}

const parseMasterDelay = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  const identity = params ? effectPayload(params, payload) : null
  return identity ? { kind: 'effects.setMasterDelayParams', payload: identity } : null
}

const parseMasterSpectral = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = parseSpectralParams(payload.params)
  const instanceId = readRequiredInstanceId(payload.instanceId)
  return params && instanceId
    ? { kind: 'effects.setMasterSpectralParams', payload: { params, instanceId } }
    : null
}

const parseMasterAudioChainReorder = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return order ? { kind: 'effects.reorderMasterAudioChain', payload: { order } } : null
}

const readAutomationTargetKind = (value: unknown): 'track' | 'master' | null => (
  value === 'track' || value === 'master' ? value : null
)

const parseAutomationSetEnvelope = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const targetKind = readAutomationTargetKind(payload.targetKind)
  if (!targetKind || typeof payload.parameterId !== 'string' || typeof payload.enabled !== 'boolean' || typeof payload.updatedAt !== 'number') return null
  if (targetKind === 'track' && typeof payload.trackId !== 'string') return null
  const trackId = targetKind === 'track' && typeof payload.trackId === 'string' ? payload.trackId : undefined
  const effectInstanceId = typeof payload.effectInstanceId === 'string' ? payload.effectInstanceId : undefined
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

const parseAutomationDeleteEnvelope = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const targetKind = readAutomationTargetKind(payload.targetKind)
  if (!targetKind || typeof payload.parameterId !== 'string') return null
  if (targetKind === 'track' && typeof payload.trackId !== 'string') return null
  const trackId = targetKind === 'track' && typeof payload.trackId === 'string' ? payload.trackId : undefined
  const effectInstanceId = typeof payload.effectInstanceId === 'string' ? payload.effectInstanceId : undefined
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
        if (isRecord(item) && typeof item.trackId === 'string') targets.trackIds.add(item.trackId)
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
  { kind: 'clips.setColor', parse: parseClipColor, targets: readClipIdTargets, durableQueue: true },
  { kind: 'tracks.setRouting', parse: parseTrackRouting, targets: readRoutingTargets, durableQueue: true },
  {
    kind: 'sidechains.setRoute',
    parse: parseSidechainRoute,
    targets: (payload) => {
      if (!isRecord(payload)) return emptyTargets()
      const trackIds = new Set<string>()
      if (typeof payload.sourceTrackId === 'string') trackIds.add(payload.sourceTrackId)
      if (typeof payload.targetTrackId === 'string') trackIds.add(payload.targetTrackId)
      return { trackIds, clipIds: new Set() }
    },
    durableQueue: true,
  },
  {
    kind: 'sidechains.removeRoute',
    parse: parseSidechainRemoval,
    targets: (payload) => {
      if (!isRecord(payload) || typeof payload.targetTrackId !== 'string') return emptyTargets()
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
    if (typeof group.parentGroupId === 'string') targets.trackIds.add(group.parentGroupId)
    if (typeof group.outputTargetId === 'string') targets.trackIds.add(group.outputTargetId)
    if (Array.isArray(group.sends)) for (const send of group.sends) if (isRecord(send) && typeof send.targetId === 'string') targets.trackIds.add(send.targetId)
    for (const child of payload.children) {
      if (!isRecord(child)) continue
      if (typeof child.trackId === 'string') targets.trackIds.add(child.trackId)
      if (typeof child.outputTargetId === 'string') targets.trackIds.add(child.outputTargetId)
    }
    if (Array.isArray(payload.sidechainRoutes)) for (const route of payload.sidechainRoutes) {
      if (!isRecord(route)) continue
      if (typeof route.sourceTrackId === 'string') targets.trackIds.add(route.sourceTrackId)
      if (typeof route.targetTrackId === 'string') targets.trackIds.add(route.targetTrackId)
    }
    return targets
  }, durableQueue: true },
  { kind: 'tracks.setCollapsed', parse: parseTrackCollapsed, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setColor', parse: parseTrackColor, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setColorCascade', parse: parseTrackColorCascade, targets: (payload) => isRecord(payload) && typeof payload.rootTrackId === 'string' ? trackTargets(payload.rootTrackId) : emptyTargets(), durableQueue: true },
  { kind: 'tracks.applyColorBatch', parse: parseTrackColorBatch, targets: (payload) => {
    if (!isRecord(payload) || !Array.isArray(payload.trackUpdates) || !Array.isArray(payload.clipUpdates)) return emptyTargets()
    const targets = emptyTargets()
    for (const update of payload.trackUpdates) if (isRecord(update) && typeof update.trackId === 'string') targets.trackIds.add(update.trackId)
    for (const update of payload.clipUpdates) if (isRecord(update) && typeof update.clipId === 'string') targets.clipIds.add(update.clipId)
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
  { kind: 'effects.setArpeggiatorParams', parse: parseTrackArpeggiator, targets: readTrackIdTargets, durableQueue: true },
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

const findSharedTimelineOperationDescriptor = (kind: unknown) => (
  isSharedTimelineOperationKind(kind)
    ? sharedTimelineOperationDescriptors.find((descriptor) => descriptor.kind === kind)
    : undefined
)

const isSharedTimelineOperationKind = (value: unknown): value is SharedTimelineOperationKind => (
  typeof value === 'string' && sharedTimelineOperationKinds.some((kind) => kind === value)
)

export const isDurableSharedTimelineOperationKind = (value: unknown): value is SharedTimelineOperationKind => (
  findSharedTimelineOperationDescriptor(value)?.durableQueue === true
)

export const readSharedTimelineOperationTargets = (operation: SharedTimelineOperation): SharedTimelineOperationTargets => (
  findSharedTimelineOperationDescriptor(operation.kind)?.targets(operation.payload) ?? emptyTargets()
)

export const parseSharedTimelineOperation = (value: unknown): SharedTimelineOperation | null => {
  if (!isRecord(value) || !isRecord(value.payload)) return null
  return findSharedTimelineOperationDescriptor(value.kind)?.parse(value.payload) ?? null
}
