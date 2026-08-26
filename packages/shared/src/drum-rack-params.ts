import {
  normalizeAudioSourceMetadataPatch,
  type AudioSourceKind,
} from './audio-source-rules'
import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from './json-value'

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

export type DrumRackPadSampleInput = JsonValue
export type DrumRackPadParamsInput = JsonValue
export type DrumRackParamsInput = JsonValue

export type DrumRackSampleAssignment = DrumRackPadSample

export const DRUM_RACK_PAD_COUNT = 16
export const DRUM_RACK_FIRST_NOTE = 36

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function readFiniteNumber(value: JsonValue | undefined): number | undefined {
  return isJsonNumber(value) && Number.isFinite(value) ? value : undefined
}

function normalizePadSample(input: JsonValue | undefined): DrumRackPadSample | undefined {
  const value = isJsonObject(input) ? input : undefined
  const source = value && isJsonObject(value.source) ? value.source : undefined
  const metadata = normalizeAudioSourceMetadataPatch({
    assetKey: value && isJsonString(value.assetKey) ? value.assetKey : undefined,
    sourceKind: value && isJsonString(value.sourceKind) ? value.sourceKind : undefined,
    durationSec: readFiniteNumber(source?.durationSec),
    sampleRate: readFiniteNumber(source?.sampleRate),
    channelCount: readFiniteNumber(source?.channelCount),
  })
  const url = value && isJsonString(value.url) ? value.url : undefined
  if (
    metadata.assetKey === undefined
    || url === undefined
    || metadata.sourceKind === undefined
    || metadata.durationSec === undefined
    || metadata.sampleRate === undefined
    || metadata.channelCount === undefined
  ) {
    return undefined
  }

  const name = value && isJsonString(value.name) && value.name ? value.name : undefined
  return {
    assetKey: metadata.assetKey,
    url,
    name,
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
  const inputValue = isJsonObject(input) ? input : {}
  const inputPads = Array.isArray(inputValue.pads) ? inputValue.pads : []
  const pads = defaults.pads.map((defaultPad, index) => {
    const inputPad = isJsonObject(inputPads[index]) ? inputPads[index] : undefined
    const sample = normalizePadSample(inputPad?.sample)
    const startSec = Math.max(0, readFiniteNumber(inputPad?.startSec) ?? defaultPad.startSec)
    const rawEndSec = readFiniteNumber(inputPad?.endSec)
    const endSec = rawEndSec !== undefined && rawEndSec > startSec ? rawEndSec : undefined

    return {
      ...defaultPad,
      name: isJsonString(inputPad?.name) && inputPad.name ? inputPad.name : undefined,
      sample,
      gain: clamp(readFiniteNumber(inputPad?.gain) ?? defaultPad.gain, 0, 2),
      pan: clamp(readFiniteNumber(inputPad?.pan) ?? defaultPad.pan, -1, 1),
      transpose: Math.round(clamp(readFiniteNumber(inputPad?.transpose) ?? defaultPad.transpose, -48, 48)),
      startSec,
      endSec,
      mute: isJsonBoolean(inputPad?.mute) ? inputPad.mute : defaultPad.mute,
      chokeGroup: Math.round(clamp(readFiniteNumber(inputPad?.chokeGroup) ?? defaultPad.chokeGroup, 0, 16)),
    }
  })
  const selectedPadId = isJsonString(inputValue.selectedPadId) && pads.some((pad) => pad.id === inputValue.selectedPadId)
    ? inputValue.selectedPadId
    : pads[0]?.id

  return { pads, selectedPadId }
}

export function serializeDrumRackParams(params: DrumRackParams): string {
  return JSON.stringify(params)
}
