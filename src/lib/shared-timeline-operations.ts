import type {
  ArpeggiatorParams,
  EqBandParams,
  EqParams,
  ReverbParams,
  SynthWave,
} from '~/lib/effects/params'
import type { MoveClipInput } from '~/lib/timeline-repository/types'
import type { TrackRouting } from '~/types/timeline'
import { z } from 'zod'

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

export type SharedTimelineOperation =
  | { kind: 'tracks.create'; payload: { index?: number; kind?: string; channelRole?: string; operationId?: string } }
  | { kind: 'tracks.lock'; payload: { trackId: string } }
  | { kind: 'tracks.unlock'; payload: { trackId: string } }
  | { kind: 'clips.create'; payload: SharedTimelineClipCreatePayload }
  | { kind: 'clips.createMany'; payload: { items: SharedTimelineClipCreatePayload[]; operationId?: string } }
  | { kind: 'clips.removeMany'; payload: { clipIds: string[] } }
  | { kind: 'clips.moveMany'; payload: { moves: MoveClipInput[] } }
  | { kind: 'tracks.setRouting'; payload: { trackId: string; routing: TrackRouting } }
  | { kind: 'tracks.setVolume'; payload: { trackId: string; volume: number } }
  | { kind: 'tracks.setMix'; payload: { trackId: string; muted?: boolean; soloed?: boolean } }
  | { kind: 'effects.setEqParams'; payload: { trackId: string; params: EqParams } }
  | { kind: 'effects.setReverbParams'; payload: { trackId: string; params: ReverbParams } }
  | { kind: 'effects.setSynthParams'; payload: { trackId: string; params: SharedSynthParams } }
  | { kind: 'effects.setArpeggiatorParams'; payload: { trackId: string; params: ArpeggiatorParams } }
  | { kind: 'effects.setMasterEqParams'; payload: { params: EqParams } }
  | { kind: 'effects.setMasterReverbParams'; payload: { params: ReverbParams } }

export type SharedTimelineOperationKind = SharedTimelineOperation['kind']

type SharedTimelineOperationTargets = {
  trackIds: Set<string>
  clipIds: Set<string>
}

const sharedTimelineOperationTargets = (): SharedTimelineOperationTargets => ({ trackIds: new Set(), clipIds: new Set() })

const sharedTimelineTrackTargets = (trackId: string): SharedTimelineOperationTargets => ({
  trackIds: new Set([trackId]),
  clipIds: new Set(),
})

export const readSharedTimelineOperationTargets = (operation: SharedTimelineOperation): SharedTimelineOperationTargets => {
  switch (operation.kind) {
    case 'tracks.lock':
    case 'tracks.unlock':
    case 'tracks.setVolume':
    case 'tracks.setMix':
      return sharedTimelineTrackTargets(operation.payload.trackId)
    case 'tracks.setRouting': {
      const targets = sharedTimelineTrackTargets(operation.payload.trackId)
      if (operation.payload.routing.outputTargetId) targets.trackIds.add(operation.payload.routing.outputTargetId)
      for (const send of operation.payload.routing.sends ?? []) {
        targets.trackIds.add(send.targetId)
      }
      return targets
    }
    case 'clips.removeMany':
      return { trackIds: new Set(), clipIds: new Set(operation.payload.clipIds) }
    case 'clips.moveMany': {
      const targets = sharedTimelineOperationTargets()
      for (const move of operation.payload.moves) {
        if (move.trackId) targets.trackIds.add(move.trackId)
        targets.clipIds.add(move.clipId)
      }
      return targets
    }
    case 'clips.create':
      return sharedTimelineTrackTargets(operation.payload.trackId)
    case 'clips.createMany': {
      const targets = sharedTimelineOperationTargets()
      for (const item of operation.payload.items) {
        targets.trackIds.add(item.trackId)
      }
      return targets
    }
    case 'effects.setEqParams':
    case 'effects.setReverbParams':
    case 'effects.setSynthParams':
    case 'effects.setArpeggiatorParams':
      return sharedTimelineTrackTargets(operation.payload.trackId)
    case 'tracks.create':
    case 'effects.setMasterEqParams':
    case 'effects.setMasterReverbParams':
      return sharedTimelineOperationTargets()
  }
}

const sharedTimelineOperationKinds: SharedTimelineOperationKind[] = [
  'tracks.create',
  'tracks.lock',
  'tracks.unlock',
  'clips.create',
  'clips.createMany',
  'clips.removeMany',
  'clips.moveMany',
  'tracks.setRouting',
  'tracks.setVolume',
  'tracks.setMix',
  'effects.setEqParams',
  'effects.setReverbParams',
  'effects.setSynthParams',
  'effects.setArpeggiatorParams',
  'effects.setMasterEqParams',
  'effects.setMasterReverbParams',
]

const sharedTimelineOperationKindSet = new Set<string>(sharedTimelineOperationKinds)

export const isSharedTimelineOperationKind = (value: unknown): value is SharedTimelineOperationKind => (
  typeof value === 'string' && sharedTimelineOperationKindSet.has(value)
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readOptionalNumber = (value: unknown) => typeof value === 'number' ? value : undefined

const readStringArray = (value: unknown) => Array.isArray(value)
  ? value.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
  : []

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

export const readSharedTimelineClipCreatePayload = (value: unknown): SharedTimelineClipCreatePayload | null => {
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
    typeof value.sampleUrl !== 'string'
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
    name: typeof value.name === 'string' ? value.name : undefined,
    sampleUrl: typeof value.sampleUrl === 'string' ? value.sampleUrl : undefined,
    assetKey: typeof value.assetKey === 'string' ? value.assetKey : undefined,
    sourceKind: typeof value.sourceKind === 'string' ? value.sourceKind : undefined,
    durationSec: readOptionalNumber(value.durationSec),
    sampleRate: readOptionalNumber(value.sampleRate),
    channelCount: readOptionalNumber(value.channelCount),
    leftPadSec: readOptionalNumber(value.leftPadSec),
    bufferOffsetSec: readOptionalNumber(value.bufferOffsetSec),
    midiOffsetBeats: readOptionalNumber(value.midiOffsetBeats),
    midi,
    clipKind: typeof value.clipKind === 'string' ? value.clipKind : undefined,
    operationId: typeof value.operationId === 'string' ? value.operationId : undefined,
  }
}

const readEqBandType = (value: unknown): EqBandParams['type'] | null => {
  if (
    value === 'allpass'
    || value === 'bandpass'
    || value === 'highpass'
    || value === 'highshelf'
    || value === 'lowpass'
    || value === 'lowshelf'
    || value === 'notch'
    || value === 'peaking'
  ) {
    return value
  }
  return null
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
    ) {
      return []
    }
    const type = readEqBandType(band.type)
    return type ? [{ id: band.id, type, frequency: band.frequency, gainDb: band.gainDb, q: band.q, enabled: band.enabled }] : []
  })
  return bands.length === value.bands.length ? { enabled: value.enabled, bands } : null
}

const readReverbParams = (value: unknown): ReverbParams | null => (
  isRecord(value)
  && typeof value.enabled === 'boolean'
  && typeof value.wet === 'number'
  && typeof value.decaySec === 'number'
  && typeof value.preDelayMs === 'number'
    ? { enabled: value.enabled, wet: value.wet, decaySec: value.decaySec, preDelayMs: value.preDelayMs }
    : null
)

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

const parseSharedTimelineOperation = (value: unknown): SharedTimelineOperation | null => {
  if (!isRecord(value) || typeof value.kind !== 'string' || !isRecord(value.payload)) return null
  if (value.kind === 'tracks.create') {
    return {
      kind: value.kind,
      payload: {
        index: readOptionalNumber(value.payload.index),
        kind: typeof value.payload.kind === 'string' ? value.payload.kind : undefined,
        channelRole: typeof value.payload.channelRole === 'string' ? value.payload.channelRole : undefined,
        operationId: typeof value.payload.operationId === 'string' ? value.payload.operationId : undefined,
      },
    }
  }
  if (value.kind === 'tracks.lock' || value.kind === 'tracks.unlock') {
    return typeof value.payload.trackId === 'string'
      ? { kind: value.kind, payload: { trackId: value.payload.trackId } }
      : null
  }
  if (value.kind === 'clips.create') {
    const payload = readSharedTimelineClipCreatePayload(value.payload)
    return payload ? { kind: value.kind, payload } : null
  }
  if (value.kind === 'clips.createMany') {
    if (!Array.isArray(value.payload.items)) return null
    const items = value.payload.items.flatMap((item) => {
      const payload = readSharedTimelineClipCreatePayload(item)
      return payload ? [payload] : []
    })
    return items.length === value.payload.items.length
      ? { kind: value.kind, payload: { items, operationId: typeof value.payload.operationId === 'string' ? value.payload.operationId : undefined } }
      : null
  }
  if (value.kind === 'clips.removeMany') {
    const clipIds = readStringArray(value.payload.clipIds)
    return clipIds.length > 0 ? { kind: value.kind, payload: { clipIds } } : null
  }
  if (value.kind === 'clips.moveMany') {
    const moves = readMoves(value.payload.moves)
    return moves.length > 0 ? { kind: value.kind, payload: { moves } } : null
  }
  if (value.kind === 'tracks.setRouting') {
    if (typeof value.payload.trackId !== 'string' || !isRecord(value.payload.routing)) return null
    return {
      kind: value.kind,
      payload: {
        trackId: value.payload.trackId,
        routing: {
          outputTargetId: typeof value.payload.routing.outputTargetId === 'string' ? value.payload.routing.outputTargetId : undefined,
          sends: readSends(value.payload.routing.sends),
        },
      },
    }
  }
  if (value.kind === 'tracks.setVolume') {
    return typeof value.payload.trackId === 'string' && typeof value.payload.volume === 'number'
      ? { kind: value.kind, payload: { trackId: value.payload.trackId, volume: value.payload.volume } }
      : null
  }
  if (value.kind === 'tracks.setMix') {
    return typeof value.payload.trackId === 'string'
      ? {
          kind: value.kind,
          payload: {
            trackId: value.payload.trackId,
            muted: typeof value.payload.muted === 'boolean' ? value.payload.muted : undefined,
            soloed: typeof value.payload.soloed === 'boolean' ? value.payload.soloed : undefined,
          },
        }
      : null
  }
  if (value.kind === 'effects.setEqParams') {
    const params = readEqParams(value.payload.params)
    return typeof value.payload.trackId === 'string' && params ? { kind: value.kind, payload: { trackId: value.payload.trackId, params } } : null
  }
  if (value.kind === 'effects.setReverbParams') {
    const params = readReverbParams(value.payload.params)
    return typeof value.payload.trackId === 'string' && params ? { kind: value.kind, payload: { trackId: value.payload.trackId, params } } : null
  }
  if (value.kind === 'effects.setSynthParams') {
    const params = readSynthParams(value.payload.params)
    return typeof value.payload.trackId === 'string' && params ? { kind: value.kind, payload: { trackId: value.payload.trackId, params } } : null
  }
  if (value.kind === 'effects.setArpeggiatorParams') {
    const params = readArpeggiatorParams(value.payload.params)
    return typeof value.payload.trackId === 'string' && params ? { kind: value.kind, payload: { trackId: value.payload.trackId, params } } : null
  }
  if (value.kind === 'effects.setMasterEqParams') {
    const params = readEqParams(value.payload.params)
    return params ? { kind: value.kind, payload: { params } } : null
  }
  if (value.kind === 'effects.setMasterReverbParams') {
    const params = readReverbParams(value.payload.params)
    return params ? { kind: value.kind, payload: { params } } : null
  }
  return null
}

export const sharedTimelineOperationSchema = z.preprocess(
  parseSharedTimelineOperation,
  z.custom<SharedTimelineOperation>((value) => value !== null),
)
