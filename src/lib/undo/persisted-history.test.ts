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

const synthInstrument: TrackInstrumentParams = { kind: 'synth', instanceId: 'instrument:synth-test', params: createDefaultSynthParams() }
const drumRackInstrument: TrackInstrumentParams = { kind: 'drum-rack', instanceId: 'instrument:drum-test', params: createDefaultDrumRackParams() }

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

const automationEntry: HistoryEntry = {
  type: 'automation-envelope-change',
  projectId: 'project-1',
  data: {
    before: null,
    after: {
      id: 'automation-1',
      projectId: 'project-1',
      target: { kind: 'master' },
      targetKey: 'master:volume',
      parameterId: 'volume',
      enabled: true,
      points: [{ id: 'point-1', timeSec: 0, value: 0.5, interpolation: 'linear' }],
      updatedAt: 1,
    },
  },
}

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

  test('keeps effect instance ids on parameter entries', () => {
    const entry: HistoryEntry = {
      type: 'effect-params',
      projectId: 'project-1',
      data: {
        trackRef: 'track-ref-1',
        effect: 'compressor',
        instanceId: 'compressor-instance-1',
        from: compressorParams,
        to: { ...compressorParams, thresholdDb: -30 },
      },
    }

    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [entry],
      redo: [],
    }))).toEqual({
      undo: [entry],
      redo: [],
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

  test('keeps readable version 2 effect and track entries', () => {
    const trackVolumeEntry: HistoryEntry = {
      type: 'track-volume',
      projectId: 'project-1',
      data: {
        trackRef: 'track-ref-1',
        scope: 'local',
        from: 0.5,
        to: 0.75,
      },
    }

    expect(normalizePersistedHistory({
      version: 2,
      undo: [compressorEntry],
      redo: [trackVolumeEntry],
    })).toEqual({
      undo: [compressorEntry],
      redo: [trackVolumeEntry],
    })
  })

  test('round-trips version 3 automation entries', () => {
    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [automationEntry],
      redo: [],
    }))).toEqual({
      undo: [automationEntry],
      redo: [],
    })
  })

  test('keeps collapsed state on track-create entries', () => {
    const entry: HistoryEntry = {
      type: 'track-create',
      projectId: 'project-1',
      data: {
        trackRef: 'return-ref',
        index: 2,
        channelRole: 'return',
        collapsed: true,
      },
    }
    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [entry],
      redo: [],
    }))).toEqual({
      undo: [entry],
      redo: [],
    })
  })

  test('keeps track group and ungroup entries', () => {
    const groupEntry: HistoryEntry = {
      type: 'track-group',
      projectId: 'project-1',
      data: {
        groupTrackRef: 'group-ref',
        currentGroupTrackId: 'group-1',
        groupTrack: { index: 0, name: 'Group', color: 'green' },
        childUpdates: [{
          trackRef: 'track-ref-1',
          previousGroupRef: 'old-group-ref',
          previousOutputTargetRef: 'old-output-ref',
          nextOutputTargetRef: 'group-ref',
        }],
      },
    }
    const ungroupEntry: HistoryEntry = {
      type: 'track-ungroup',
      projectId: 'project-1',
      data: {
        groupTrackRef: 'group-ref',
        sourceGroupTrackId: 'group-1',
        restoreOperationId: 'restore-op-1',
        groupTrack: {
          trackRef: 'group-ref',
          index: 0,
          name: 'Group',
          volume: 0.8,
          channelRole: 'group',
          routing: { sends: [] },
        },
        childSnapshots: [{
          trackRef: 'track-ref-1',
          previousGroupRef: 'group-ref',
          previousOutputTargetRef: 'group-ref',
          nextOutputTargetRef: 'custom-output-ref',
        }],
      },
    }

    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [groupEntry],
      redo: [ungroupEntry],
    }))).toEqual({
      undo: [groupEntry],
      redo: [ungroupEntry],
    })
  })

  test('keeps legacy version 3 ungroup entries without restore snapshots', () => {
    const entry: HistoryEntry = {
      type: 'track-ungroup',
      projectId: 'project-1',
      data: {
        groupTrackRef: 'group-ref',
        childSnapshots: [{
          trackRef: 'track-ref-1',
          previousGroupRef: 'group-ref',
        }],
      },
    }

    expect(normalizePersistedHistory({
      version: 3,
      undo: [entry],
      redo: [],
    })).toEqual({ undo: [entry], redo: [] })
  })

  test('keeps section edit entries with valid child history entries', () => {
    const sectionEntry: HistoryEntry = {
      type: 'section-edit',
      projectId: 'project-1',
      data: { entries: [compressorEntry, automationEntry] },
    }

    expect(normalizePersistedHistory(serializePersistedHistory({
      undo: [sectionEntry],
      redo: [],
    }))).toEqual({
      undo: [sectionEntry],
      redo: [],
    })
  })

  test('rejects malformed section edit entries safely', () => {
    const validSectionEntry: HistoryEntry = {
      type: 'section-edit',
      projectId: 'project-1',
      data: { entries: [compressorEntry] },
    }

    expect(normalizePersistedHistory({
      version: 3,
      undo: [
        { type: 'section-edit', projectId: 'project-1', data: { entries: 'invalid' } },
        {
          type: 'section-edit',
          projectId: 'project-1',
          data: {
            entries: [{
              type: 'section-edit',
              projectId: 'project-1',
              data: { entries: [compressorEntry] },
            }],
          },
        },
        validSectionEntry,
      ],
      redo: [],
    })).toEqual({
      undo: [validSectionEntry],
      redo: [],
    })
  })
})
