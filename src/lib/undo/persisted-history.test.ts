import { describe, expect, test } from 'bun:test'
import { createDefaultCompressorParams, createDefaultDrumRackParams, createDefaultSynthParams, type TrackInstrumentParams } from '@daw-browser/shared'
import { normalizePersistedHistory, serializePersistedHistory } from './persisted-history'
import type { HistoryEntry } from './types'

const compressorParams = createDefaultCompressorParams()

const compressorEntry: HistoryEntry = {
  type: 'effect-params',
  projectId: 'project-1',
  data: {
    trackRef: 'track-ref-1',
    effect: 'compressor',
    from: compressorParams,
    to: { ...compressorParams, thresholdDb: -30 },
  },
}

const masterCompressorEntry: HistoryEntry = {
  type: 'effect-params',
  projectId: 'project-1',
  data: {
    effect: 'master-compressor',
    from: compressorParams,
    to: { ...compressorParams, thresholdDb: -30 },
  },
}

const synthInstrument: TrackInstrumentParams = { kind: 'synth', params: createDefaultSynthParams() }
const drumRackInstrument: TrackInstrumentParams = { kind: 'drum-rack', params: createDefaultDrumRackParams() }

const createInstrumentEntry = (from: TrackInstrumentParams, to: TrackInstrumentParams): HistoryEntry => ({
  type: 'effect-params',
  projectId: 'project-1',
  data: {
    trackRef: 'track-ref-1',
    effect: 'instrument',
    from,
    to,
  },
})

describe('persisted undo history', () => {
  test('keeps compressor effect parameter entries', () => {
    const serialized = serializePersistedHistory({
      undo: [compressorEntry],
      redo: [masterCompressorEntry],
    })

    expect(normalizePersistedHistory(serialized)).toEqual({
      undo: [compressorEntry],
      redo: [masterCompressorEntry],
    })
  })

  test('keeps Synth and Drum Rack instrument parameter entries', () => {
    const synthEntry = createInstrumentEntry(synthInstrument, drumRackInstrument)
    const drumRackEntry = createInstrumentEntry(drumRackInstrument, synthInstrument)

    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [synthEntry],
      redo: [drumRackEntry],
    }))).toEqual({
      undo: [synthEntry],
      redo: [drumRackEntry],
    })
  })

  test('keeps track delete automation snapshots', () => {
    const trackDeleteEntry: HistoryEntry = {
      type: 'track-delete',
      projectId: 'project-1',
      data: {
        track: {
          trackRef: 'track-ref-1',
          index: 0,
          name: 'Audio 1',
          volume: 0.75,
          routing: { sends: [] },
        },
        clips: [],
        automation: [{
          id: 'automation-1',
          projectId: 'project-1',
          target: { kind: 'track', trackId: 'track-1' },
          targetKey: 'track:track-1:volume',
          parameterId: 'volume',
          enabled: true,
          points: [{ id: 'point-1', timeSec: 0, value: 0.5, interpolation: 'linear' }],
          updatedAt: 1,
        }],
      },
    }

    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [trackDeleteEntry],
      redo: [],
    }))).toEqual({
      undo: [trackDeleteEntry],
      redo: [],
    })
  })
})
