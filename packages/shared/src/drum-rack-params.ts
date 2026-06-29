import {
  normalizeAudioSourceMetadataPatch,
  type AudioSourceKind,
} from './audio-source-rules'

export type DrumRackPadSample = {
  assetKey: string
  url: string
  name?: string
  sourceKind: AudioSourceKind
  source: {
    durationSec: number
    sampleRate: number
    channelCount: number
  }
}

export type DrumRackPadParams = {
  id: string
  note: number
  name?: string
  sample?: DrumRackPadSample
  gain: number
  pan: number
  transpose: number
  startSec: number
  endSec?: number
  mute: boolean
  chokeGroup: number
}

export type DrumRackParams = {
  pads: DrumRackPadParams[]
  selectedPadId?: string
}

export type DrumRackPadSampleInput = Partial<Omit<DrumRackPadSample, 'sourceKind' | 'source'>> & {
  sourceKind?: unknown
  source?: {
    durationSec?: unknown
    sampleRate?: unknown
    channelCount?: unknown
  }
}

export type DrumRackPadParamsInput = Partial<Omit<DrumRackPadParams, 'sample'>> & {
  sample?: DrumRackPadSampleInput
}

export type DrumRackParamsInput = {
  pads?: DrumRackPadParamsInput[]
  selectedPadId?: unknown
}

export type DrumRackSampleAssignment = DrumRackPadSample

export const DRUM_RACK_PAD_COUNT = 16
export const DRUM_RACK_FIRST_NOTE = 36

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizePadSample(input: DrumRackPadSampleInput | undefined): DrumRackPadSample | undefined {
  const metadata = normalizeAudioSourceMetadataPatch({
    assetKey: input?.assetKey,
    sourceKind: typeof input?.sourceKind === 'string' ? input.sourceKind : undefined,
    durationSec: readFiniteNumber(input?.source?.durationSec),
    sampleRate: readFiniteNumber(input?.source?.sampleRate),
    channelCount: readFiniteNumber(input?.source?.channelCount),
  })
  if (
    metadata.assetKey === undefined
    || typeof input?.url !== 'string'
    || !input.url
    || metadata.sourceKind === undefined
    || metadata.durationSec === undefined
    || metadata.sampleRate === undefined
    || metadata.channelCount === undefined
  ) {
    return undefined
  }

  return {
    assetKey: metadata.assetKey,
    url: input.url,
    name: typeof input.name === 'string' && input.name ? input.name : undefined,
    sourceKind: metadata.sourceKind,
    source: {
      durationSec: metadata.durationSec,
      sampleRate: metadata.sampleRate,
      channelCount: metadata.channelCount,
    },
  }
}

export function createDefaultDrumRackPad(index: number): DrumRackPadParams {
  const note = DRUM_RACK_FIRST_NOTE + index
  return {
    id: `pad-${note}`,
    note,
    gain: 1,
    pan: 0,
    transpose: 0,
    startSec: 0,
    mute: false,
    chokeGroup: 0,
  }
}

export function createDefaultDrumRackParams(): DrumRackParams {
  const pads = Array.from({ length: DRUM_RACK_PAD_COUNT }, (_, index) => createDefaultDrumRackPad(index))
  return {
    pads,
    selectedPadId: pads[0]?.id,
  }
}

export function getMidiNoteLabel(note: number): string {
  const noteName = NOTE_NAMES[((note % 12) + 12) % 12]
  const octave = Math.floor(note / 12) - 1
  return `${noteName}${octave}`
}

export function getDrumRackPadNoteLabel(note: number): string {
  return getMidiNoteLabel(note)
}

export function findDrumRackPadByNote(params: DrumRackParams, note: number): DrumRackPadParams | undefined {
  return params.pads.find((pad) => pad.note === note)
}

export function assignSampleToDrumRackPad(
  params: DrumRackParams,
  padId: string,
  sample: DrumRackSampleAssignment,
): DrumRackParams {
  if (!params.pads.some((pad) => pad.id === padId)) return params

  return {
    ...params,
    pads: params.pads.map((pad) => (
      pad.id === padId
        ? {
          ...pad,
          name: sample.name ?? pad.name,
          sample: {
            assetKey: sample.assetKey,
            url: sample.url,
            name: sample.name,
            sourceKind: sample.sourceKind,
            source: sample.source,
          },
        }
        : pad
    )),
    selectedPadId: padId,
  }
}

export function normalizeDrumRackParams(input: DrumRackParamsInput): DrumRackParams {
  const defaults = createDefaultDrumRackParams()
  const inputPads = input.pads ?? []
  const pads = defaults.pads.map((defaultPad, index) => {
    const inputPad = inputPads[index]
    const sample = normalizePadSample(inputPad?.sample)
    const startSec = Math.max(0, readFiniteNumber(inputPad?.startSec) ?? defaultPad.startSec)
    const rawEndSec = readFiniteNumber(inputPad?.endSec)
    const endSec = rawEndSec !== undefined && rawEndSec > startSec ? rawEndSec : undefined

    return {
      ...defaultPad,
      name: typeof inputPad?.name === 'string' && inputPad.name ? inputPad.name : undefined,
      sample,
      gain: clamp(readFiniteNumber(inputPad?.gain) ?? defaultPad.gain, 0, 2),
      pan: clamp(readFiniteNumber(inputPad?.pan) ?? defaultPad.pan, -1, 1),
      transpose: Math.round(clamp(readFiniteNumber(inputPad?.transpose) ?? defaultPad.transpose, -48, 48)),
      startSec,
      endSec,
      mute: typeof inputPad?.mute === 'boolean' ? inputPad.mute : defaultPad.mute,
      chokeGroup: Math.round(clamp(readFiniteNumber(inputPad?.chokeGroup) ?? defaultPad.chokeGroup, 0, 16)),
    }
  })
  const selectedPadId = typeof input.selectedPadId === 'string' && pads.some((pad) => pad.id === input.selectedPadId)
    ? input.selectedPadId
    : pads[0]?.id

  return { pads, selectedPadId }
}

export function serializeDrumRackParams(params: DrumRackParams): string {
  return JSON.stringify(params)
}
