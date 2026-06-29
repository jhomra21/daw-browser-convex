import { describe, expect, test } from 'bun:test'
import {
  assignSampleToDrumRackPad,
  createDefaultDrumRackParams,
  DRUM_RACK_FIRST_NOTE,
  DRUM_RACK_PAD_COUNT,
  findDrumRackPadByNote,
  getDrumRackPadNoteLabel,
  INSTRUMENT_CONTRACTS,
  isInstrumentKind,
  normalizeDrumRackParams,
  serializeDrumRackParams,
  type DrumRackSampleAssignment,
} from './index'

describe('Drum Rack params', () => {
  test('creates sixteen default pads starting at MIDI note 36', () => {
    const params = createDefaultDrumRackParams()

    expect(params.pads).toHaveLength(DRUM_RACK_PAD_COUNT)
    expect(params.pads[0]?.note).toBe(DRUM_RACK_FIRST_NOTE)
    expect(params.pads[0]?.id).toBe('pad-36')
    expect(params.selectedPadId).toBe('pad-36')
    expect(params.pads[15]?.note).toBe(51)
  })

  test('normalizes pad values and drops invalid sample payloads', () => {
    const normalized = normalizeDrumRackParams({
      selectedPadId: 'missing',
      pads: [{
        id: '',
        note: 999,
        name: '',
        gain: 99,
        pan: -99,
        transpose: 99,
        startSec: -1,
        endSec: -2,
        mute: true,
        chokeGroup: 99,
        sample: {
          assetKey: '',
          url: 'https://example.com/kick.wav',
          sourceKind: 'upload',
          source: { durationSec: 1, sampleRate: 48000, channelCount: 2 },
        },
      }],
    })

    expect(normalized.selectedPadId).toBe('pad-36')
    expect(normalized.pads[0]).toEqual({
      id: 'pad-36',
      note: 36,
      name: undefined,
      sample: undefined,
      gain: 2,
      pan: -1,
      transpose: 48,
      startSec: 0,
      endSec: undefined,
      mute: true,
      chokeGroup: 16,
    })
  })

  test('keeps canonical pad ids and notes during normalization', () => {
    const normalized = normalizeDrumRackParams({
      selectedPadId: 'duplicate',
      pads: [
        { id: 'duplicate', note: 50 },
        { id: 'duplicate', note: 50 },
      ],
    })

    expect(normalized.selectedPadId).toBe('pad-36')
    expect(normalized.pads[0]?.id).toBe('pad-36')
    expect(normalized.pads[1]?.id).toBe('pad-37')
    expect(normalized.pads[0]?.note).toBe(36)
    expect(normalized.pads[1]?.note).toBe(37)
  })

  test('preserves valid sample identity fields without audio buffers', () => {
    const normalized = normalizeDrumRackParams({
      selectedPadId: 'pad-36',
      pads: [{
        id: 'kick',
        note: 36,
        name: 'Kick',
        sample: {
          assetKey: 'samples/kick.wav',
          url: 'blob:sample',
          name: 'kick.wav',
          sourceKind: 'upload',
          source: { durationSec: 0.5, sampleRate: 44100, channelCount: 1 },
        },
      }],
    })

    expect(normalized.selectedPadId).toBe('pad-36')
    expect(normalized.pads[0]?.sample).toEqual({
      assetKey: 'samples/kick.wav',
      url: 'blob:sample',
      name: 'kick.wav',
      sourceKind: 'upload',
      source: { durationSec: 0.5, sampleRate: 44100, channelCount: 1 },
    })
  })

  test('assigns sample data to a pad and selects it', () => {
    const params = createDefaultDrumRackParams()
    const updated = assignSampleToDrumRackPad(params, 'pad-37', {
      assetKey: 'samples/snare.wav',
      url: 'blob:snare',
      name: 'snare.wav',
      sourceKind: 'upload',
      source: { durationSec: 0.4, sampleRate: 44100, channelCount: 2 },
    })

    expect(updated.selectedPadId).toBe('pad-37')
    expect(updated.pads[1]?.name).toBe('snare.wav')
    expect(updated.pads[1]?.sample?.assetKey).toBe('samples/snare.wav')
  })

  test('sample assignment preserves existing sample drag identity fields', () => {
    const sample: DrumRackSampleAssignment = {
      assetKey: 'samples/kick.wav',
      url: 'blob:kick',
      name: 'kick.wav',
      sourceKind: 'upload',
      source: { durationSec: 0.5, sampleRate: 48000, channelCount: 2 },
    }
    const updated = assignSampleToDrumRackPad(createDefaultDrumRackParams(), 'pad-36', sample)

    expect(updated.pads[0]?.sample).toEqual(sample)
  })

  test('ignores sample assignment for missing pads', () => {
    const params = createDefaultDrumRackParams()
    const updated = assignSampleToDrumRackPad(params, 'missing', {
      assetKey: 'samples/snare.wav',
      url: 'blob:snare',
      name: 'snare.wav',
      sourceKind: 'upload',
      source: { durationSec: 0.4, sampleRate: 44100, channelCount: 2 },
    })

    expect(updated).toBe(params)
  })

  test('provides note helpers', () => {
    const params = createDefaultDrumRackParams()

    expect(getDrumRackPadNoteLabel(36)).toBe('C1')
    expect(getDrumRackPadNoteLabel(60)).toBe('C3')
    expect(findDrumRackPadByNote(params, 38)?.id).toBe('pad-38')
    expect(findDrumRackPadByNote(params, 99)).toBeUndefined()
  })

  test('serializes through the instrument contract', () => {
    const normalized = INSTRUMENT_CONTRACTS['drum-rack'].normalizeParams({ pads: [{ gain: 99 }] })

    expect(isInstrumentKind('drum-rack')).toBe(true)
    expect(isInstrumentKind('sampler')).toBe(false)
    expect(INSTRUMENT_CONTRACTS.synth.kind).toBe('synth')
    expect(INSTRUMENT_CONTRACTS['drum-rack'].serializeParams(normalized)).toBe(serializeDrumRackParams(normalized))
  })
})
