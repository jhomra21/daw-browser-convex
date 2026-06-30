import type {
  ArpeggiatorParams,
  AudioEffectKind,
  CompressorParams,
  CompressorParamsInput,
  DelayParams,
  DelayParamsInput,
  EqParams,
  ReverbParamsInput,
  SaturatorParams,
  SaturatorParamsInput,
  SynthWave,
} from './effects-params'
import {
  isAudioEffectKind,
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
  normalizeSaturatorParams,
} from './effects-params'
import { normalizeAudioWarp, normalizeClipGain, type AudioWarpPayload } from './audio-warp'
import { normalizeMasterVolume } from './master-volume'
import {
  normalizeTrackInstrumentParams,
  type TrackInstrumentParams,
} from './instrument-params'
import type { AutomationPoint } from './automation'
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
  sends?: Array<{ targetId: string; amount: number }>
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

export type SharedTimelineOperation =
  | { kind: 'tracks.create'; payload: { index?: number; kind?: string; channelRole?: string; operationId?: string } }
  | { kind: 'tracks.lock'; payload: { trackId: string } }
  | { kind: 'tracks.unlock'; payload: { trackId: string } }
  | { kind: 'clips.create'; payload: SharedTimelineClipCreatePayload }
  | { kind: 'clips.createMany'; payload: { items: SharedTimelineClipCreatePayload[]; operationId?: string } }
  | { kind: 'clips.removeMany'; payload: { clipIds: string[] } }
  | { kind: 'clips.moveMany'; payload: { moves: MoveClipInput[] } }
  | { kind: 'clips.setAudioWarp'; payload: { clipId: string; audioWarp: AudioWarpPayload } }
  | { kind: 'clips.setGain'; payload: { clipId: string; gain: number } }
  | { kind: 'tracks.setRouting'; payload: { trackId: string; routing: TrackRouting } }
  | { kind: 'tracks.setVolume'; payload: { trackId: string; volume: number } }
  | { kind: 'tracks.setMix'; payload: { trackId: string; muted?: boolean; soloed?: boolean } }
  | { kind: 'mixer.setMasterVolume'; payload: { volume: number } }
  | { kind: 'effects.setEqParams'; payload: { trackId: string; params: EqParams } }
  | { kind: 'effects.setCompressorParams'; payload: { trackId: string; params: CompressorParams } }
  | { kind: 'effects.setSaturatorParams'; payload: { trackId: string; params: SaturatorParams } }
  | { kind: 'effects.setDelayParams'; payload: { trackId: string; params: DelayParams } }
  | { kind: 'effects.reorderAudioChain'; payload: { trackId: string; order: AudioEffectKind[] } }
  | { kind: 'effects.setReverbParams'; payload: { trackId: string; params: SharedReverbParams } }
  | { kind: 'effects.setSynthParams'; payload: { trackId: string; params: SharedSynthParams } }
  | { kind: 'instruments.setTrackInstrument'; payload: { trackId: string; instrument: TrackInstrumentParams } }
  | { kind: 'effects.setArpeggiatorParams'; payload: { trackId: string; params: ArpeggiatorParams } }
  | { kind: 'effects.setMasterEqParams'; payload: { params: EqParams } }
  | { kind: 'effects.setMasterCompressorParams'; payload: { params: CompressorParams } }
  | { kind: 'effects.setMasterSaturatorParams'; payload: { params: SaturatorParams } }
  | { kind: 'effects.setMasterDelayParams'; payload: { params: DelayParams } }
  | { kind: 'effects.setMasterReverbParams'; payload: { params: SharedReverbParams } }
  | { kind: 'effects.reorderMasterAudioChain'; payload: { order: AudioEffectKind[] } }
  | { kind: 'automation.setEnvelope'; payload: { targetKind: 'track' | 'master'; trackId?: string; parameterId: string; enabled: boolean; points: AutomationPoint[]; updatedAt: number } }
  | { kind: 'automation.deleteEnvelope'; payload: { targetKind: 'track' | 'master'; trackId?: string; parameterId: string } }

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

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readOptionalNumber = (value: unknown) => typeof value === 'number' ? value : undefined
const readOptionalBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined
const readOptionalString = (value: unknown) => typeof value === 'string' ? value : undefined

const readAudioWarp = (value: unknown) => normalizeAudioWarp(value)

const readStringArray = (value: unknown) => Array.isArray(value)
  ? value.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
  : []

const readAudioEffectOrder = (value: unknown): AudioEffectKind[] | null => {
  if (!Array.isArray(value)) return null
  const order: AudioEffectKind[] = []
  const seen = new Set<AudioEffectKind>()
  for (const entry of value) {
    if (!isAudioEffectKind(entry)) return null
    if (seen.has(entry)) continue
    seen.add(entry)
    order.push(entry)
  }
  return order
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

const readSends = (value: unknown) => Array.isArray(value)
  ? value.flatMap((entry) => (
      isRecord(entry)
      && typeof entry.targetId === 'string'
      && typeof entry.amount === 'number'
        ? [{ targetId: entry.targetId, amount: entry.amount }]
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

const parseTrackCreate = (payload: Record<string, unknown>): SharedTimelineOperation => ({
  kind: 'tracks.create',
  payload: {
    index: readOptionalNumber(payload.index),
    kind: readOptionalString(payload.kind),
    channelRole: readOptionalString(payload.channelRole),
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
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setEqParams', payload: { trackId: payload.trackId, params } } : null
}

const parseTrackReverb = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setReverbParams', payload: { trackId: payload.trackId, params } } : null
}

const parseTrackCompressor = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setCompressorParams', payload: { trackId: payload.trackId, params } } : null
}

const parseTrackSaturator = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setSaturatorParams', payload: { trackId: payload.trackId, params } } : null
}

const parseTrackDelay = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setDelayParams', payload: { trackId: payload.trackId, params } } : null
}

const parseTrackAudioChainReorder = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return typeof payload.trackId === 'string' && order ? { kind: 'effects.reorderAudioChain', payload: { trackId: payload.trackId, order } } : null
}

const parseTrackSynth = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSynthParams(payload.params)
  return typeof payload.trackId === 'string' && params ? { kind: 'effects.setSynthParams', payload: { trackId: payload.trackId, params } } : null
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
  return params ? { kind: 'effects.setMasterEqParams', payload: { params } } : null
}

const parseMasterReverb = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readReverbParams(payload.params)
  return params ? { kind: 'effects.setMasterReverbParams', payload: { params } } : null
}

const parseMasterCompressor = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readCompressorParams(payload.params)
  return params ? { kind: 'effects.setMasterCompressorParams', payload: { params } } : null
}

const parseMasterSaturator = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readSaturatorParams(payload.params)
  return params ? { kind: 'effects.setMasterSaturatorParams', payload: { params } } : null
}

const parseMasterDelay = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const params = readDelayParams(payload.params)
  return params ? { kind: 'effects.setMasterDelayParams', payload: { params } } : null
}

const parseMasterAudioChainReorder = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const order = readAudioEffectOrder(payload.order)
  return order ? { kind: 'effects.reorderMasterAudioChain', payload: { order } } : null
}

const readAutomationTargetKind = (value: unknown): 'track' | 'master' | null => (
  value === 'track' || value === 'master' ? value : null
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

const parseAutomationSetEnvelope = (payload: Record<string, unknown>): SharedTimelineOperation | null => {
  const targetKind = readAutomationTargetKind(payload.targetKind)
  if (!targetKind || typeof payload.parameterId !== 'string' || typeof payload.enabled !== 'boolean' || typeof payload.updatedAt !== 'number') return null
  if (targetKind === 'track' && typeof payload.trackId !== 'string') return null
  const trackId = targetKind === 'track' && typeof payload.trackId === 'string' ? payload.trackId : undefined
  if (!isAutomationParameterSupportedForTarget(payload.parameterId, targetKind)) return null
  const points = readAutomationPoints(payload.parameterId, payload.points)
  return points ? {
    kind: 'automation.setEnvelope',
    payload: {
      targetKind,
      trackId,
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
  if (!isAutomationParameterSupportedForTarget(payload.parameterId, targetKind)) return null
  return {
    kind: 'automation.deleteEnvelope',
    payload: {
      targetKind,
      trackId,
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
    kind: 'clips.setAudioWarp',
    parse: parseClipAudioWarp,
    targets: (payload) => isRecord(payload) && typeof payload.clipId === 'string' ? clipTargets([payload.clipId]) : emptyTargets(),
    durableQueue: true,
  },
  {
    kind: 'clips.setGain',
    parse: parseClipGain,
    targets: (payload) => isRecord(payload) && typeof payload.clipId === 'string' ? clipTargets([payload.clipId]) : emptyTargets(),
    durableQueue: true,
  },
  { kind: 'tracks.setRouting', parse: parseTrackRouting, targets: readRoutingTargets, durableQueue: true },
  { kind: 'tracks.setVolume', parse: parseTrackVolume, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'tracks.setMix', parse: parseTrackMix, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'mixer.setMasterVolume', parse: parseMasterVolume, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setEqParams', parse: parseTrackEq, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setCompressorParams', parse: parseTrackCompressor, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setSaturatorParams', parse: parseTrackSaturator, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setDelayParams', parse: parseTrackDelay, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.reorderAudioChain', parse: parseTrackAudioChainReorder, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setReverbParams', parse: parseTrackReverb, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setSynthParams', parse: parseTrackSynth, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'instruments.setTrackInstrument', parse: parseTrackInstrument, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setArpeggiatorParams', parse: parseTrackArpeggiator, targets: readTrackIdTargets, durableQueue: true },
  { kind: 'effects.setMasterEqParams', parse: parseMasterEq, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterCompressorParams', parse: parseMasterCompressor, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterSaturatorParams', parse: parseMasterSaturator, targets: emptyTargets, durableQueue: true },
  { kind: 'effects.setMasterDelayParams', parse: parseMasterDelay, targets: emptyTargets, durableQueue: true },
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
